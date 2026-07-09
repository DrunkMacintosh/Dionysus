import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "undici";
import type { Identity } from "../identity.js";
import { prisma } from "../db.js";
import { computeCostUsd } from "../lib/pricing.js";
import { gateBudget, type GateErrorBody } from "./budget-gate.js";
import { usageFromJson, createSseUsageScanner, type GatewayUsage } from "./usage.js";

export type GatewayConfig = {
  port: number;
  upstreamUrl: string;
  upstreamKey?: string;
  inboundToken?: string;
};

const MAX_BODY_BYTES = 10_000_000;
const COMPLETIONS_PATH = "/v1/chat/completions";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorBody(type: string, message: string): GateErrorBody {
  return { error: { type, message } };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function recordGatewayCall(
  identity: Identity,
  model: string,
  usage: GatewayUsage,
): Promise<void> {
  await prisma.llmCall.create({
    data: {
      businessId: identity.businessId,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: computeCostUsd(model, usage.inputTokens, usage.outputTokens),
      note: usage.usageMissing ? "gateway:usage_missing" : "gateway",
    },
  });
}

/**
 * Write the ledger entry, making a failed write OBSERVABLE rather than silent.
 * A dropped write means unmetered spend (the daily cap under-counts), so on
 * failure we emit a structured, greppable stderr line and report recorded:false
 * to the caller — which decides the safe fail-direction (withhold on the
 * non-streaming path; the log is the only record once bytes are already sent).
 */
export async function recordOrReport(
  identity: Identity,
  model: string,
  usage: GatewayUsage,
  writeFn: typeof recordGatewayCall = recordGatewayCall,
): Promise<{ recorded: boolean }> {
  try {
    await writeFn(identity, model, usage);
    return { recorded: true };
  } catch (e) {
    console.error(
      JSON.stringify({
        evt: "gateway:ledger_write_failed",
        businessId: identity.businessId,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        err: String(e),
      }),
    );
    return { recorded: false };
  }
}

export function createGatewayHandler(
  identity: Identity,
  cfg: GatewayConfig,
): (req: IncomingMessage, res: ServerResponse) => void {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET" && req.url === "/healthz") {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method !== "POST" || req.url !== COMPLETIONS_PATH) {
      return sendJson(res, 404, errorBody("not_found", "Only POST /v1/chat/completions (and GET /healthz)."));
    }

    // Inbound auth (optional shared secret). Caller auth is NEVER forwarded.
    if (cfg.inboundToken) {
      if (req.headers.authorization !== `Bearer ${cfg.inboundToken}`) {
        return sendJson(res, 401, errorBody("unauthorized", "Missing or wrong gateway token."));
      }
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      return sendJson(res, 413, errorBody("payload_too_large", `Body exceeds ${MAX_BODY_BYTES} bytes.`));
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return sendJson(res, 400, errorBody("bad_request", "Request body is not valid JSON."));
    }
    const model = typeof parsed["model"] === "string" ? (parsed["model"] as string) : "unknown";
    const isStream = parsed["stream"] === true;

    // HARD GATE (D28): budget is checked before any upstream contact; fail-closed.
    const gate = await gateBudget(identity);
    if (!gate.ok) {
      return sendJson(res, gate.status, gate.body);
    }

    const upstreamRes = await request(`${cfg.upstreamUrl.replace(/\/+$/, "")}${COMPLETIONS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.upstreamKey ? { authorization: `Bearer ${cfg.upstreamKey}` } : {}),
      },
      body: raw,
    });

    if (isStream) {
      return handleStream(res, upstreamRes, model);
    }

    const text = await upstreamRes.body.text();
    let usage: GatewayUsage;
    try {
      usage = usageFromJson(JSON.parse(text));
    } catch {
      usage = { inputTokens: 0, outputTokens: 0, usageMissing: true };
    }
    // Write BEFORE responding: at-most-once accounting, deterministic tests.
    // A failed write is unmetered spend — withhold the response (client may
    // retry; the retry re-gates) rather than serve un-accounted-for tokens.
    const { recorded } = await recordOrReport(identity, model, usage);
    if (!recorded) {
      return sendJson(
        res,
        502,
        errorBody(
          "metering_failed",
          "Upstream call succeeded but the usage could not be recorded; response withheld.",
        ),
      );
    }
    res.writeHead(upstreamRes.statusCode, {
      "content-type": String(upstreamRes.headers["content-type"] ?? "application/json"),
    });
    res.end(text);
  }

  async function handleStream(
    res: ServerResponse,
    upstreamRes: Awaited<ReturnType<typeof request>>,
    model: string,
  ): Promise<void> {
    // Client-abort guard: if the client disconnects mid-stream, stop pumping a
    // dead connection. Destroying the upstream body makes the for-await below
    // throw, which lands in the catch-all (headersSent → res.end()).
    res.on("close", () => {
      if (!res.writableEnded) upstreamRes.body.destroy();
    });
    res.writeHead(upstreamRes.statusCode, {
      "content-type": String(upstreamRes.headers["content-type"] ?? "text/event-stream"),
    });
    const scanner = createSseUsageScanner();
    for await (const chunk of upstreamRes.body) {
      const buf = chunk as Buffer;
      scanner.push(buf.toString("utf8"));
      res.write(buf);
    }
    // Write BEFORE ending the response: the client observing stream-end
    // may immediately assert on the ledger (and accounting is at-most-once).
    // Bytes are already sent, so a metering failure here cannot withhold the
    // response — the structured stderr log from recordOrReport is the record.
    await recordOrReport(identity, model, scanner.result());
    res.end();
  }

  return (req, res) => {
    void handle(req, res).catch((e) => {
      // Log the real error server-side; never echo upstream host / DB internals
      // back to the client.
      console.error(JSON.stringify({ evt: "gateway:handler_error", err: String(e) }));
      if (!res.headersSent) {
        sendJson(res, 502, errorBody("upstream_error", "Upstream request failed."));
      } else {
        res.end();
      }
    });
  };
}
