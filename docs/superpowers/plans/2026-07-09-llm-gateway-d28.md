# D28 LLM Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-business LLM gateway — the container's only model endpoint — that enforces the daily token cap BEFORE forwarding (fail-closed), proxies OpenAI-compatible chat completions to a configured upstream, and writes `LlmCall` rows itself from real usage (no agent self-reporting), including streaming.

**Architecture:** A second entrypoint in the existing `packages/dionysus-mcp` package (`src/gateway-index.ts` → `dist/gateway-index.js`), sharing the Prisma client, pricing table, and ambient identity from stage 1. Pure logic lives in `src/gateway/usage.ts` (usage extraction) and `src/gateway/budget-gate.ts` (pre-flight gate, reusing `checkBudget`); `src/gateway/proxy.ts` is the node `http` handler; config comes from env, fail-closed. The gateway binds **127.0.0.1 only** — it is a local per-container proxy, never exposed.

**Tech Stack:** Node ≥22, TypeScript strict, `undici` (already a dependency — no new deps), Prisma 6 (pinned), vitest.

## Global Constraints

- **D28 (spec §8b):** the gateway writes `LlmCall` itself and hard-stops at the cap with a structured "budget exhausted" error; `check_budget` stays advisory; the kill switch is stopping the process / revoking its upstream key.
- **D27.1:** identity is ambient (`DIONYSUS_BUSINESS_ID` via `loadIdentity()`); `businessId` never appears in any request or config surface.
- **Fail-closed (spec §14):** missing `GATEWAY_UPSTREAM_URL` → refuse to start; budget check error → block (503), never forward; over cap → 429, upstream is NEVER contacted.
- **No fabricated numbers (spec §11):** if the upstream response carries no usage, record `inputTokens: 0, outputTokens: 0` with note `gateway:usage_missing` — never estimate. Unknown model → `costUsd: null` (existing `computeCostUsd`).
- **Ordering for at-most-once accounting + test determinism:** the `LlmCall` write is awaited BEFORE the response is completed (non-streaming: before responding; streaming: before `res.end()`).
- **Security:** bind `127.0.0.1` only; the caller's inbound `Authorization` header is NEVER forwarded upstream (replaced by the configured upstream key or omitted); optional inbound shared secret `GATEWAY_TOKEN`.
- **No new dependencies.** Reuse `undici`, `prisma`, existing `src/identity.ts`, `src/lib/pricing.ts`, `src/tools/cost-budget.ts`.
- **Testing:** TDD; test servers on ephemeral `127.0.0.1` ports. Full suite must stay green (`pnpm test`); `pnpm build` clean.
- **Commits:** conventional format, no attribution footer.
- **Shell:** Windows/PowerShell; pnpm 9.15.0; Node v24. Work from `packages/dionysus-mcp`.

---

### Task 1: Usage extraction (pure)

**Files:**
- Create: `packages/dionysus-mcp/src/gateway/usage.ts`
- Test: `packages/dionysus-mcp/test/gateway-usage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type GatewayUsage = { inputTokens: number; outputTokens: number; usageMissing: boolean }`; `usageFromJson(body: unknown): GatewayUsage`; `createSseUsageScanner(): { push(text: string): void; result(): GatewayUsage }`. Tasks 3–4 consume these — do not rename.

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/gateway-usage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { usageFromJson, createSseUsageScanner } from "../src/gateway/usage.js";

describe("usageFromJson", () => {
  it("extracts OpenAI-compatible usage", () => {
    const u = usageFromJson({ usage: { prompt_tokens: 120, completion_tokens: 45 } });
    expect(u).toEqual({ inputTokens: 120, outputTokens: 45, usageMissing: false });
  });

  it("marks usage missing (zeros, never estimates) when absent or malformed", () => {
    expect(usageFromJson({})).toEqual({ inputTokens: 0, outputTokens: 0, usageMissing: true });
    expect(usageFromJson(null)).toEqual({ inputTokens: 0, outputTokens: 0, usageMissing: true });
    expect(usageFromJson({ usage: { prompt_tokens: "x" } })).toEqual({
      inputTokens: 0, outputTokens: 0, usageMissing: true,
    });
  });
});

describe("createSseUsageScanner", () => {
  it("captures usage from the final SSE chunk (OpenAI include_usage style)", () => {
    const s = createSseUsageScanner();
    s.push('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    s.push('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    s.push('data: {"usage":{"prompt_tokens":9,"completion_tokens":2},"choices":[]}\n\n');
    s.push("data: [DONE]\n\n");
    expect(s.result()).toEqual({ inputTokens: 9, outputTokens: 2, usageMissing: false });
  });

  it("handles a data line split across two pushes (line buffering)", () => {
    const s = createSseUsageScanner();
    s.push('data: {"usage":{"prompt_tokens":7,');
    s.push('"completion_tokens":3},"choices":[]}\n\ndata: [DONE]\n\n');
    expect(s.result()).toEqual({ inputTokens: 7, outputTokens: 3, usageMissing: false });
  });

  it("reports usage missing when the stream never carried usage", () => {
    const s = createSseUsageScanner();
    s.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    expect(s.result()).toEqual({ inputTokens: 0, outputTokens: 0, usageMissing: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/gateway-usage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/dionysus-mcp/src/gateway/usage.ts`:

```ts
export type GatewayUsage = {
  inputTokens: number;
  outputTokens: number;
  usageMissing: boolean;
};

const MISSING: GatewayUsage = { inputTokens: 0, outputTokens: 0, usageMissing: true };

function fromUsageObject(usage: unknown): GatewayUsage | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = u["prompt_tokens"];
  const output = u["completion_tokens"];
  if (typeof input !== "number" || typeof output !== "number") return null;
  return { inputTokens: input, outputTokens: output, usageMissing: false };
}

export function usageFromJson(body: unknown): GatewayUsage {
  if (typeof body !== "object" || body === null) return MISSING;
  return fromUsageObject((body as Record<string, unknown>)["usage"]) ?? MISSING;
}

/** Line-buffered scanner over SSE text. Keeps the LAST usage object seen
 *  (OpenAI include_usage sends it in the final data chunk before [DONE]). */
export function createSseUsageScanner(): {
  push(text: string): void;
  result(): GatewayUsage;
} {
  let buffer = "";
  let captured: GatewayUsage | null = null;

  function scanLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]" || payload === "") return;
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      const usage = fromUsageObject(obj["usage"]);
      if (usage) captured = usage;
    } catch {
      // partial or non-JSON data line — ignore; fail toward usageMissing
    }
  }

  return {
    push(text: string): void {
      buffer += text;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        scanLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    result(): GatewayUsage {
      if (buffer.length > 0) {
        scanLine(buffer); // flush trailing line without newline
        buffer = "";
      }
      return captured ?? MISSING;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/gateway-usage.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: gateway usage extraction - json + line-buffered sse, missing means zeros never estimates"
```

---

### Task 2: Budget gate (pre-flight, fail-closed)

**Files:**
- Create: `packages/dionysus-mcp/src/gateway/budget-gate.ts`
- Test: `packages/dionysus-mcp/test/gateway-budget-gate.test.ts`

**Interfaces:**
- Consumes: `checkBudget` (src/tools/cost-budget.js — `(identity) => Promise<{ allowed, tokensUsedToday, maxTokensPerDay, reason? }>`); `Identity` (src/identity.js).
- Produces: `type GateResult = { ok: true } | { ok: false; status: number; body: GateErrorBody }` with `type GateErrorBody = { error: { type: string; message: string; tokensUsedToday?: number; maxTokensPerDay?: number } }`; `gateBudget(identity: Identity, checkFn?): Promise<GateResult>`. Task 3 consumes these.

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/gateway-budget-gate.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { gateBudget } from "../src/gateway/budget-gate.js";
import { prisma } from "../src/db.js";
import { recordCost } from "../src/tools/cost-budget.js";

describe("gateBudget", () => {
  beforeAll(async () => {
    await prisma.llmCall.deleteMany({ where: { businessId: "biz_gate" } });
    await prisma.business.upsert({
      where: { id: "biz_gate" },
      create: { id: "biz_gate", name: "Gate Co", maxTokensPerDay: 500 },
      update: { maxTokensPerDay: 500 },
    });
  });

  it("passes while under the cap", async () => {
    const r = await gateBudget({ businessId: "biz_gate" });
    expect(r.ok).toBe(true);
  });

  it("blocks with a structured 429 once over the cap", async () => {
    await recordCost(
      { businessId: "biz_gate" },
      { model: "claude-haiku-4-5", inputTokens: 400, outputTokens: 200 },
    );
    const r = await gateBudget({ businessId: "biz_gate" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(429);
      expect(r.body.error.type).toBe("budget_exhausted");
      expect(r.body.error.tokensUsedToday).toBe(600);
      expect(r.body.error.maxTokensPerDay).toBe(500);
    }
  });

  it("blocks unknown businesses (fail-closed) with 429", async () => {
    const r = await gateBudget({ businessId: "biz_gate_ghost" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.body.error.type).toBe("budget_exhausted");
  });

  it("fails CLOSED with 503 when the budget check itself errors", async () => {
    const boom = async () => {
      throw new Error("db down");
    };
    const r = await gateBudget({ businessId: "biz_gate" }, boom as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.body.error.type).toBe("budget_check_failed");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/gateway-budget-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/dionysus-mcp/src/gateway/budget-gate.ts`:

```ts
import type { Identity } from "../identity.js";
import { checkBudget } from "../tools/cost-budget.js";

export type GateErrorBody = {
  error: {
    type: string;
    message: string;
    tokensUsedToday?: number;
    maxTokensPerDay?: number;
  };
};

export type GateResult =
  | { ok: true }
  | { ok: false; status: number; body: GateErrorBody };

type CheckFn = typeof checkBudget;

export async function gateBudget(
  identity: Identity,
  checkFn: CheckFn = checkBudget,
): Promise<GateResult> {
  let budget: Awaited<ReturnType<CheckFn>>;
  try {
    budget = await checkFn(identity);
  } catch (e) {
    return {
      ok: false,
      status: 503,
      body: {
        error: {
          type: "budget_check_failed",
          message: `Budget check errored — failing closed (spec §14): ${
            e instanceof Error ? e.message : String(e)
          }`,
        },
      },
    };
  }
  if (budget.allowed) return { ok: true };
  return {
    ok: false,
    status: 429,
    body: {
      error: {
        type: "budget_exhausted",
        message: budget.reason ?? "Daily token budget exhausted.",
        tokensUsedToday: budget.tokensUsedToday,
        maxTokensPerDay: budget.maxTokensPerDay,
      },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/gateway-budget-gate.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: gateway budget gate - structured 429 over cap, 503 fail-closed on check error"
```

---

### Task 3: Proxy core (non-streaming)

**Files:**
- Create: `packages/dionysus-mcp/src/gateway/proxy.ts`
- Test: `packages/dionysus-mcp/test/gateway-proxy.test.ts`

**Interfaces:**
- Consumes: `gateBudget`/`GateErrorBody` (Task 2); `usageFromJson`/`createSseUsageScanner` (Task 1 — scanner used in Task 4); `computeCostUsd` (src/lib/pricing.js); `prisma` (src/db.js); `Identity` (src/identity.js); `undici` `request`.
- Produces: `type GatewayConfig = { port: number; upstreamUrl: string; upstreamKey?: string; inboundToken?: string }`; `createGatewayHandler(identity: Identity, cfg: GatewayConfig): (req: IncomingMessage, res: ServerResponse) => void`. Task 4 extends this file with streaming; Task 5's entrypoint consumes both.

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/gateway-proxy.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { request } from "undici";
import { createGatewayHandler, type GatewayConfig } from "../src/gateway/proxy.js";
import { prisma } from "../src/db.js";

const IDENTITY = { businessId: "biz_proxy" };
let upstream: http.Server;
let gateway: http.Server;
let upstreamHits = 0;
let lastUpstreamAuth: string | undefined;
let gwUrl: string;

beforeAll(async () => {
  await prisma.llmCall.deleteMany({ where: { businessId: "biz_proxy" } });
  await prisma.business.upsert({
    where: { id: "biz_proxy" },
    create: { id: "biz_proxy", name: "Proxy Co", maxTokensPerDay: 100000 },
    update: { maxTokensPerDay: 100000 },
  });

  upstream = http.createServer((req, res) => {
    upstreamHits++;
    lastUpstreamAuth = req.headers.authorization;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "cmpl-1",
        choices: [{ message: { role: "assistant", content: "hello" } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;

  const cfg: GatewayConfig = {
    port: 0,
    upstreamUrl: `http://127.0.0.1:${upPort}`,
    upstreamKey: "sk-upstream-secret",
    inboundToken: "local-token",
  };
  gateway = http.createServer(createGatewayHandler(IDENTITY, cfg));
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  gwUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
});

afterAll(() => {
  upstream.close();
  gateway.close();
});

function post(path: string, body: unknown, token?: string) {
  return request(`${gwUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("gateway proxy (non-streaming)", () => {
  it("forwards a completion, returns the upstream body, and records real usage", async () => {
    const res = await post("/v1/chat/completions", {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
    }, "local-token");
    expect(res.statusCode).toBe(200);
    const body = (await res.body.json()) as { choices: unknown[] };
    expect(body.choices).toHaveLength(1);

    const rows = await prisma.llmCall.findMany({ where: { businessId: "biz_proxy" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputTokens).toBe(100);
    expect(rows[0]!.outputTokens).toBe(50);
    expect(rows[0]!.costUsd).not.toBeNull(); // claude-haiku-4-5 is priced
    expect(rows[0]!.note).toBe("gateway");
  });

  it("never forwards the caller's Authorization — replaces it with the upstream key", () => {
    expect(lastUpstreamAuth).toBe("Bearer sk-upstream-secret");
  });

  it("records costUsd null for unknown models (no fabricated numbers)", async () => {
    await post("/v1/chat/completions", { model: "mystery-9000", messages: [] }, "local-token");
    const row = await prisma.llmCall.findFirst({
      where: { businessId: "biz_proxy", model: "mystery-9000" },
    });
    expect(row?.costUsd).toBeNull();
  });

  it("rejects a missing/wrong inbound token with 401 and does not contact upstream", async () => {
    const before = upstreamHits;
    const res = await post("/v1/chat/completions", { model: "m", messages: [] }, "wrong");
    expect(res.statusCode).toBe(401);
    await res.body.dump();
    expect(upstreamHits).toBe(before);
  });

  it("404s unknown paths and 400s malformed JSON", async () => {
    const notFound = await post("/v1/other", {}, "local-token");
    expect(notFound.statusCode).toBe(404);
    await notFound.body.dump();

    const bad = await request(`${gwUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer local-token" },
      body: "{not json",
    });
    expect(bad.statusCode).toBe(400);
    await bad.body.dump();
  });

  it("blocks over-cap requests with the structured 429 BEFORE contacting upstream", async () => {
    await prisma.business.update({ where: { id: "biz_proxy" }, data: { maxTokensPerDay: 1 } });
    const before = upstreamHits;
    const res = await post("/v1/chat/completions", { model: "claude-haiku-4-5", messages: [] }, "local-token");
    expect(res.statusCode).toBe(429);
    const body = (await res.body.json()) as { error: { type: string } };
    expect(body.error.type).toBe("budget_exhausted");
    expect(upstreamHits).toBe(before);
    await prisma.business.update({ where: { id: "biz_proxy" }, data: { maxTokensPerDay: 100000 } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/gateway-proxy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/dionysus-mcp/src/gateway/proxy.ts`:

```ts
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
  return (req, res) => {
    void handle(req, res).catch((e) => {
      if (!res.headersSent) {
        sendJson(res, 502, errorBody("upstream_error", e instanceof Error ? e.message : String(e)));
      } else {
        res.end();
      }
    });
  };

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
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/gateway-proxy.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: gateway proxy core - hard budget gate before upstream, real-usage LlmCall writes, auth replacement"
```

---

### Task 4: Streaming pass-through with usage capture

**Files:**
- Modify: `packages/dionysus-mcp/src/gateway/proxy.ts` (replace the `handleStream` placeholder)
- Test: `packages/dionysus-mcp/test/gateway-stream.test.ts`

**Interfaces:**
- Consumes: `createSseUsageScanner` (Task 1); everything in proxy.ts (Task 3).
- Produces: streaming behavior on the same `createGatewayHandler` — chunks piped to the client as they arrive; `LlmCall` written (awaited) from the scanner's captured usage BEFORE `res.end()`.

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/gateway-stream.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { request } from "undici";
import { createGatewayHandler, type GatewayConfig } from "../src/gateway/proxy.js";
import { prisma } from "../src/db.js";

const IDENTITY = { businessId: "biz_stream" };
let upstream: http.Server;
let gateway: http.Server;
let gwUrl: string;

const SSE_CHUNKS = [
  'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"lo!"}}]}\n\n',
  'data: {"usage":{"prompt_tokens":11,"completion_tokens":4},"choices":[]}\n\n',
  "data: [DONE]\n\n",
];

beforeAll(async () => {
  await prisma.llmCall.deleteMany({ where: { businessId: "biz_stream" } });
  await prisma.business.upsert({
    where: { id: "biz_stream" },
    create: { id: "biz_stream", name: "Stream Co", maxTokensPerDay: 100000 },
    update: { maxTokensPerDay: 100000 },
  });

  upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const c of SSE_CHUNKS) res.write(c);
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;

  const cfg: GatewayConfig = { port: 0, upstreamUrl: `http://127.0.0.1:${upPort}` };
  gateway = http.createServer(createGatewayHandler(IDENTITY, cfg));
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  gwUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
});

afterAll(() => {
  upstream.close();
  gateway.close();
});

describe("gateway streaming", () => {
  it("pipes the full SSE stream to the client and records captured usage", async () => {
    const res = await request(`${gwUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", stream: true, messages: [] }),
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/event-stream");
    const text = await res.body.text();
    expect(text).toBe(SSE_CHUNKS.join(""));

    // Response ended => the write already happened (write-before-end ordering).
    const rows = await prisma.llmCall.findMany({ where: { businessId: "biz_stream" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputTokens).toBe(11);
    expect(rows[0]!.outputTokens).toBe(4);
    expect(rows[0]!.note).toBe("gateway");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/gateway-stream.test.ts`
Expected: FAIL — 501 not_implemented from the placeholder (assertion on statusCode/body).

- [ ] **Step 3: Replace the `handleStream` placeholder in `src/gateway/proxy.ts`**

Add the import at the top of the file (with the existing usage.js import):

```ts
import { usageFromJson, createSseUsageScanner, type GatewayUsage } from "./usage.js";
```

Replace the whole placeholder `handleStream` function with:

```ts
  async function handleStream(
    res: ServerResponse,
    upstreamRes: Awaited<ReturnType<typeof request>>,
    model: string,
  ): Promise<void> {
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
    await recordGatewayCall(identity, model, scanner.result());
    res.end();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/gateway-stream.test.ts`
Expected: 1 passed. Then re-run Task 3's file too: `pnpm vitest run test/gateway-proxy.test.ts` — still 6 passed.

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: gateway streaming pass-through with sse usage capture, ledger write before stream end"
```

---

### Task 5: Config loader + entrypoint (localhost-only)

**Files:**
- Create: `packages/dionysus-mcp/src/gateway/config.ts`
- Create: `packages/dionysus-mcp/src/gateway-index.ts`
- Modify: `packages/dionysus-mcp/package.json` (add script `"start:gateway": "node dist/gateway-index.js"`)
- Test: `packages/dionysus-mcp/test/gateway-config.test.ts`

**Interfaces:**
- Consumes: `GatewayConfig` (Task 3); `loadIdentity` (src/identity.js); `createGatewayHandler` (Task 3/4).
- Produces: `loadGatewayConfig(env?: Record<string, string | undefined>): GatewayConfig` — throws if `GATEWAY_UPSTREAM_URL` missing (fail-closed start); `GATEWAY_PORT` default `8787`; trailing slash stripped from the upstream URL; `GATEWAY_UPSTREAM_KEY`/`GATEWAY_TOKEN` optional. Entry binds `127.0.0.1` ONLY.

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/gateway-config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadGatewayConfig } from "../src/gateway/config.js";

describe("loadGatewayConfig", () => {
  it("loads a full config with defaults", () => {
    const cfg = loadGatewayConfig({ GATEWAY_UPSTREAM_URL: "https://api.example.com" });
    expect(cfg).toEqual({
      port: 8787,
      upstreamUrl: "https://api.example.com",
      upstreamKey: undefined,
      inboundToken: undefined,
    });
  });

  it("strips a trailing slash from the upstream URL and honors overrides", () => {
    const cfg = loadGatewayConfig({
      GATEWAY_UPSTREAM_URL: "https://api.example.com/",
      GATEWAY_PORT: "9911",
      GATEWAY_UPSTREAM_KEY: "sk-1",
      GATEWAY_TOKEN: "tok",
    });
    expect(cfg.upstreamUrl).toBe("https://api.example.com");
    expect(cfg.port).toBe(9911);
    expect(cfg.upstreamKey).toBe("sk-1");
    expect(cfg.inboundToken).toBe("tok");
  });

  it("refuses to start without an upstream URL (fail-closed)", () => {
    expect(() => loadGatewayConfig({})).toThrow(/GATEWAY_UPSTREAM_URL/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/gateway-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/dionysus-mcp/src/gateway/config.ts`:

```ts
import type { GatewayConfig } from "./proxy.js";

export function loadGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
  const upstreamUrl = env["GATEWAY_UPSTREAM_URL"];
  if (!upstreamUrl) {
    throw new Error(
      "GATEWAY_UPSTREAM_URL is not set — refusing to start (fail-closed, D28).",
    );
  }
  return {
    port: env["GATEWAY_PORT"] ? Number(env["GATEWAY_PORT"]) : 8787,
    upstreamUrl: upstreamUrl.replace(/\/$/, ""),
    upstreamKey: env["GATEWAY_UPSTREAM_KEY"] || undefined,
    inboundToken: env["GATEWAY_TOKEN"] || undefined,
  };
}
```

`packages/dionysus-mcp/src/gateway-index.ts`:

```ts
import http from "node:http";
import { loadIdentity } from "./identity.js";
import { loadGatewayConfig } from "./gateway/config.js";
import { createGatewayHandler } from "./gateway/proxy.js";

const identity = loadIdentity();
const cfg = loadGatewayConfig();
const server = http.createServer(createGatewayHandler(identity, cfg));

// 127.0.0.1 ONLY — the gateway is a local per-container proxy, never exposed.
server.listen(cfg.port, "127.0.0.1", () => {
  console.error(
    `llm-gateway up for ${identity.businessId} on 127.0.0.1:${cfg.port} -> ${cfg.upstreamUrl} (D28 hard cap active)`,
  );
});
```

`packages/dionysus-mcp/package.json` — add to `scripts`:

```json
"start:gateway": "node dist/gateway-index.js"
```

- [ ] **Step 4: Run test + build**

Run: `pnpm vitest run test/gateway-config.test.ts; pnpm build`
Expected: 3 passed; tsc clean (gateway-index.js emitted to dist/).

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: gateway config (fail-closed start) + localhost-only entrypoint + start script"
```

---

### Task 6: Gateway e2e — the D28 exit gate

**Files:**
- Test: `packages/dionysus-mcp/test/gateway.e2e.test.ts`

**Interfaces:**
- Consumes: everything above. No new production code expected; if an assertion fails, the fix goes in the offending module, test-first.

- [ ] **Step 1: Write the test**

`packages/dionysus-mcp/test/gateway.e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { request } from "undici";
import { createGatewayHandler, type GatewayConfig } from "../src/gateway/proxy.js";
import { checkBudget } from "../src/tools/cost-budget.js";
import { prisma } from "../src/db.js";

const A = { businessId: "biz_gwe_a" };
let upstream: http.Server;
let gatewayA: http.Server;
let hits = 0;
let urlA: string;

beforeAll(async () => {
  for (const id of ["biz_gwe_a", "biz_gwe_b"]) {
    await prisma.llmCall.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({
      where: { id },
      create: { id, name: id, maxTokensPerDay: 200 },
      update: { maxTokensPerDay: 200 },
    });
  }
  upstream = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 150, completion_tokens: 100 } }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = (upstream.address() as { port: number }).port;
  const cfg: GatewayConfig = { port: 0, upstreamUrl: `http://127.0.0.1:${upPort}` };
  gatewayA = http.createServer(createGatewayHandler(A, cfg));
  await new Promise<void>((r) => gatewayA.listen(0, "127.0.0.1", r));
  urlA = `http://127.0.0.1:${(gatewayA.address() as { port: number }).port}`;
});

afterAll(() => {
  upstream.close();
  gatewayA.close();
});

async function callA() {
  return request(`${urlA}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
  });
}

describe("D28 exit gate — the loop closes", () => {
  it("first call passes; the recorded usage then trips the hard cap on the second call, upstream untouched", async () => {
    const r1 = await callA();
    expect(r1.statusCode).toBe(200);
    await r1.body.dump();
    expect(hits).toBe(1); // 150+100 = 250 tokens recorded > 200 cap

    const r2 = await callA();
    expect(r2.statusCode).toBe(429);
    const body = (await r2.body.json()) as { error: { type: string } };
    expect(body.error.type).toBe("budget_exhausted");
    expect(hits).toBe(1); // upstream NEVER contacted on the blocked call
  });

  it("the advisory check_budget now reflects gateway-metered spend (no self-reporting)", async () => {
    const b = await checkBudget(A);
    expect(b.allowed).toBe(false);
    expect(b.tokensUsedToday).toBe(250);
  });

  it("gateway writes are scoped to the ambient identity — the other tenant is untouched", async () => {
    const other = await prisma.llmCall.findMany({ where: { businessId: "biz_gwe_b" } });
    expect(other).toHaveLength(0);
    const b = await checkBudget({ businessId: "biz_gwe_b" });
    expect(b.allowed).toBe(true);
    expect(b.tokensUsedToday).toBe(0);
  });
});
```

- [ ] **Step 2: Run the full suite**

Run: `pnpm test`
Expected: all files green (~76 tests across 15 files: 61 stage-1 + ~15 gateway). If an exit-gate assertion fails, fix the offending gateway module test-first; never weaken this gate.

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: clean.

- [ ] **Step 4: Commit**

```powershell
git add -A; git commit -m "test: gateway e2e - hard cap trips from gateway-metered usage, tenant-scoped, D28 exit gate"
```

---

## Out of Scope (recorded, deliberate)

- **CreditLedger enforcement** — the spec pairs it with the token cap, but no credits are issued until billing lands (platform stage 4); enforcing a zero balance now would block everything. The gate enforces `maxTokensPerDay` only; `CreditLedger` enforcement rides in with Stripe.
- **Anthropic-native API shape** — prototyping upstreams (Nous Portal, NVIDIA-free) are OpenAI-compatible; an Anthropic adapter is added when a role actually uses one (YAGNI).
- **Per-request client abort propagation and retry policy** — stage-2 concerns once Hermes is the real caller.
- The stage-1.1 hardening batch (recorded in `.superpowers/sdd/progress.md`) remains separate.

## Self-Review Notes

- **Spec coverage (D28, §8b):** only-model-endpoint (entrypoint + localhost bind, Task 5) ✓; writes LlmCall itself from real usage incl. streaming (Tasks 3–4) ✓; hard-stop with structured error before upstream (Tasks 2–3, proven in e2e) ✓; `check_budget` advisory consistency (e2e test 2 closes the loop) ✓; kill switch = process stop / key revocation (documented, no code needed) ✓.
- **Type consistency:** `GatewayUsage`/`GateResult`/`GatewayConfig` names match across Tasks 1–6; `recordGatewayCall` is defined in Task 3 and reused verbatim by Task 4's replacement code.
- **Known judgment call:** the Task 3 `handleStream` placeholder returns 501 so streaming requests fail loudly (never silently mis-metered) between Tasks 3 and 4.
