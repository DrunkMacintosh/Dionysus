import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "undici";
import type { Identity } from "../identity.js";
import { prisma } from "../db.js";
import { computeCostUsd } from "../lib/pricing.js";
import { gateBudget, type GateErrorBody } from "./budget-gate.js";
import { usageFromJson, type GatewayUsage } from "./usage.js";

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

    const upstreamRes = await request(`${cfg.upstreamUrl}${COMPLETIONS_PATH}`, {
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
    await recordGatewayCall(identity, model, usage);
    res.writeHead(upstreamRes.statusCode, {
      "content-type": String(upstreamRes.headers["content-type"] ?? "application/json"),
    });
    res.end(text);
  }

  // Implemented in Task 4 — placeholder keeps Task 3 compiling and failing loudly if hit.
  async function handleStream(
    res: ServerResponse,
    upstreamRes: Awaited<ReturnType<typeof request>>,
    _model: string,
  ): Promise<void> {
    await upstreamRes.body.dump();
    sendJson(res, 501, errorBody("not_implemented", "Streaming lands in the next task."));
  }

  return (req, res) => {
    void handle(req, res).catch((e) => {
      if (!res.headersSent) {
        sendJson(res, 502, errorBody("upstream_error", e instanceof Error ? e.message : String(e)));
      } else {
        res.end();
      }
    });
  };
}
