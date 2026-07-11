# Analytics Measurement (Stage 5d / D21) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a founder connect a real analytics source so Dionysus measures real outcomes — flipping the CMO report's `analyticsConnected` from a hardcoded `false` to a real, per-business check, and supplying a real `metricDeltaPct` so the honesty grader's **measured** verdicts become reachable from real data (never fabricated).

**Architecture:** A `secret-box` (AES-256-GCM, key from env, fail-closed) encrypts integration credentials at rest. An `Integration` row holds a connected analytics source (encrypted config); a `MetricSnapshot` row is one real measured reading over time. A provider-agnostic `AnalyticsProvider` reads the current metric value through an injectable, SSRF-guarded transport (degrade-to-null on any failure) and `ingestMetrics` persists a snapshot. `buildCmoReport` then reports `analyticsConnected` from a real Integration query and computes `metricDeltaPct` from real snapshots (baseline-at-route-start vs latest) — feeding the already-built, already-tested honesty grader. A cockpit surface lets the founder connect/disconnect and shows the measured verdict.

**Tech Stack:** TypeScript (dionysus-mcp on TS 7 / cockpit on TS ~5.8), Prisma 6 + SQLite (`db push`, no migrations), `node:crypto` (no new deps), vitest, Next 15 / React 19. Reuses the stage-1 SSRF-guarded fetch and the existing `gradeObjective` honesty engine.

## Global Constraints

*(Every task's requirements implicitly include this section.)*

- **HONESTY (§3 / D21) — the spine.** A `measured-working` verdict (`claimsMetricMoved: true`, "your number is up X%") is reachable ONLY when (a) a real connected analytics `Integration` exists AND (b) a real positive `metricDeltaPct` is computed from real `MetricSnapshot` rows. NO fabricated number can reach the report. A business with no connected source, or a connected source with no ingested data, stays on an unmeasured verdict that leads with the honest gap. `metricDeltaPct` is derived ONLY from persisted snapshot values, never invented.
- **Attribution honesty (spec §16 line 202).** Marketing attribution is noisy (small N, confounders, delayed effects). The `measured-working` **headline** states the measured temporal fact ("up X% since this work went live"); the **recommendation** must NOT assert proven causation — it acknowledges attribution uncertainty. (This is a deliberate refinement of the 4f grader now that measured states are reachable.)
- **Secrets encrypted at rest (D21, §10).** Integration `config` (API keys / tokens) is stored ONLY as an AES-256-GCM ciphertext blob. The plaintext is never persisted, never logged, never returned to the client. The encryption key comes from env `DIONYSUS_CONFIG_KEY` (base64 of 32 bytes); a missing/malformed key is fail-closed (throws — never a silent plaintext fallback).
- **SSRF (stage-1) on the analytics endpoint.** The analytics endpoint is founder-provided (semi-trusted). All ingestion fetches go through the stage-1 SSRF-guarded fetch (`safeFetch`) — never a raw `fetch`. The transport is injectable for tests; its production default is `safeFetch`.
- **Degrade-safe ingestion.** A fetch/parse failure persists NOTHING and never throws to the caller (mirrors the radar HN-source + draftWaypoint best-effort patterns). Honest: no reading → no snapshot → no delta → unmeasured verdict.
- **D27.1 ambient identity / scoping.** No new function takes a `businessId` param; identity is ambient. Every read/write is `businessId`-scoped. A cross-tenant id is a not-found.
- **NOT MCP — whitelist stays 11.** `encryptSecret`/`decryptSecret`, `connectIntegration`/`disconnectIntegration`/`getConnectedAnalytics`/`listIntegrations`, `AnalyticsProvider`/`ingestMetrics`, and the cockpit actions are ALL non-MCP. Do NOT register a tool in `server.ts`. `TOOL_SCHEMAS` stays exactly 11. (Auto/scheduled ingestion trigger + live-vendor OAuth flows are deferred to 6a / per-provider follow-ups.)
- **Additive only.** No existing signature changes incompatibly. `buildCmoReport` keeps its `CmoReport` shape; `gradeObjective` keeps its `Verdict` shape and the `claimsMetricMoved` invariant.
- **No `console.log`** in production code (`console.error` on a best-effort catch only). **No mutation** — immutable updates. **Immutability**: `applyMetricName`-style pure transforms return new objects.
- **Ops (verified):** use **PowerShell** (Git Bash broken). dionysus-mcp tests: `$env:DATABASE_URL="file:./.tmp/test.db"` (+ `$env:DIONYSUS_CONFIG_KEY` for the 5d suites — the test files set it in-process, see below). After a `schema.prisma` change run `pnpm prisma generate; node scripts/reset-test-db.mjs` (NOTE: the reset script is at `scripts/reset-test-db.mjs`). department imports the BUILT dist of dionysus-mcp → `pnpm build` dionysus-mcp before the dept suite. cockpit tests need `$env:DATABASE_URL` AND `$env:COCKPIT_SESSION_SECRET="test-secret"` (and, for the connect flow, `$env:DIONYSUS_CONFIG_KEY`).
- **Baselines at stage start:** mcp **263**, department **81**, cockpit **53**. Every task keeps all three green.

---

## File Structure

**dionysus-mcp**
- Create: `packages/dionysus-mcp/src/lib/secret-box.ts` — `encryptSecret`/`decryptSecret` (AES-256-GCM, env key, fail-closed). Pure crypto, no DB.
- Create: `packages/dionysus-mcp/src/tools/integration.ts` — `connectIntegration`/`disconnectIntegration`/`getConnectedAnalytics`/`listIntegrations` (scoped, config encrypted).
- Create: `packages/dionysus-mcp/src/tools/analytics.ts` — `AnalyticsProvider` (provider-agnostic reference reader) + `ingestMetrics` (SSRF-guarded, degrade-safe, persists a `MetricSnapshot`).
- Modify: `packages/dionysus-mcp/prisma/schema.prisma` — `Integration` + `MetricSnapshot` models.
- Modify: `packages/dionysus-mcp/src/lib/cmo-verdict.ts` — refine the `measured-working` recommendation (attribution honesty). Signature unchanged.
- Modify: `packages/dionysus-mcp/src/tools/cmo-report.ts` — real `analyticsConnected` + real `metricDeltaPct`.
- Test: `test/secret-box.test.ts` (T1), `test/integration.test.ts` (T3), `test/analytics.test.ts` (T4), `test/cmo-report.test.ts` extend (T5), `test/measurement-eval.e2e.test.ts` (T7).

**cockpit**
- Modify: `packages/cockpit/src/lib/review.ts` — `getIntegrations` reader.
- Create: `packages/cockpit/src/lib/integration-actions.ts` — `connectAnalyticsAction`/`disconnectAnalyticsAction` (session-authed server actions).
- Create: `packages/cockpit/src/app/connect/page.tsx` — connect/disconnect UI; nav link.
- Test: `packages/cockpit/test/review.test.ts` extend (T6).

---

## Task 1: `secret-box` — encrypt integration secrets at rest

**Files:**
- Create: `packages/dionysus-mcp/src/lib/secret-box.ts`
- Test: `packages/dionysus-mcp/test/secret-box.test.ts`

**Interfaces:**
- Produces:
  - `encryptSecret(plaintext: string, env?: Record<string, string | undefined>): string` — returns a self-describing base64 blob (`v1.<ivB64>.<tagB64>.<ctB64>`).
  - `decryptSecret(blob: string, env?: Record<string, string | undefined>): string` — inverse; throws on a tampered/malformed blob or a bad key.
  - `const CONFIG_KEY_ENV = "DIONYSUS_CONFIG_KEY"`

- [ ] **Step 1: Write the failing test**

Create `packages/dionysus-mcp/test/secret-box.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret, CONFIG_KEY_ENV } from "../src/lib/secret-box.js";

// A deterministic 32-byte key, base64-encoded (AES-256).
const KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const env = { [CONFIG_KEY_ENV]: KEY };

describe("secret-box", () => {
  it("round-trips a secret through encrypt → decrypt", () => {
    const secret = JSON.stringify({ apiKey: "plausible-abc123", endpoint: "https://plausible.io/api" });
    const blob = encryptSecret(secret, env);
    expect(decryptSecret(blob, env)).toBe(secret);
  });

  it("never emits the plaintext in the ciphertext blob", () => {
    const blob = encryptSecret("super-secret-token", env);
    expect(blob).not.toContain("super-secret-token");
    expect(blob.startsWith("v1.")).toBe(true);
  });

  it("produces a DIFFERENT ciphertext each call (random IV) for the same plaintext", () => {
    const a = encryptSecret("same", env);
    const b = encryptSecret("same", env);
    expect(a).not.toBe(b); // fresh IV per encryption
    expect(decryptSecret(a, env)).toBe("same");
    expect(decryptSecret(b, env)).toBe("same");
  });

  it("rejects a tampered ciphertext (GCM auth tag) — no silent plaintext", () => {
    const blob = encryptSecret("secret", env);
    const parts = blob.split(".");
    // Flip a byte in the ciphertext segment.
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] = ct[0]! ^ 0xff;
    const tampered = [parts[0], parts[1], parts[2], ct.toString("base64")].join(".");
    expect(() => decryptSecret(tampered, env)).toThrow();
  });

  it("is fail-closed when the key is missing", () => {
    expect(() => encryptSecret("x", {})).toThrow(/DIONYSUS_CONFIG_KEY/);
    const blob = encryptSecret("x", env);
    expect(() => decryptSecret(blob, {})).toThrow(/DIONYSUS_CONFIG_KEY/);
  });

  it("is fail-closed when the key is the wrong length (not 32 bytes)", () => {
    const shortKey = { [CONFIG_KEY_ENV]: Buffer.from("too-short").toString("base64") };
    expect(() => encryptSecret("x", shortKey)).toThrow(/32/);
  });

  it("cannot decrypt with a different key", () => {
    const blob = encryptSecret("secret", env);
    const otherKey = { [CONFIG_KEY_ENV]: Buffer.from("fedcba9876543210fedcba9876543210").toString("base64") };
    expect(() => decryptSecret(blob, otherKey)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it FAILS**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/secret-box.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/secret-box.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/dionysus-mcp/src/lib/secret-box.ts`:

```typescript
// D21 / §10 — secrets encrypted at rest. AES-256-GCM authenticated encryption for
// Integration credentials. The key comes from env DIONYSUS_CONFIG_KEY (base64 of 32
// bytes); a missing/malformed key is FAIL-CLOSED (throws — never a silent plaintext
// fallback). Each encryption uses a fresh random 12-byte IV; the 16-byte GCM auth tag
// makes any tamper a decrypt failure. Blob format: `v1.<ivB64>.<tagB64>.<ctB64>`.
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export const CONFIG_KEY_ENV = "DIONYSUS_CONFIG_KEY";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const VERSION = "v1";

/** Load + validate the 32-byte key from env. Fail-closed: throws on missing/wrong-length. */
function loadKey(env: Record<string, string | undefined>): Buffer {
  const raw = env[CONFIG_KEY_ENV];
  if (!raw) throw new Error(`${CONFIG_KEY_ENV} is not set — cannot encrypt/decrypt integration secrets.`);
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`${CONFIG_KEY_ENV} is not valid base64.`);
  }
  if (key.length !== KEY_BYTES) throw new Error(`${CONFIG_KEY_ENV} must decode to ${KEY_BYTES} bytes (got ${key.length}).`);
  return key;
}

export function encryptSecret(plaintext: string, env: Record<string, string | undefined> = process.env): string {
  const key = loadKey(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(blob: string, env: Record<string, string | undefined> = process.env): string {
  const key = loadKey(env);
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Malformed secret blob.");
  const iv = Buffer.from(parts[1]!, "base64");
  const tag = Buffer.from(parts[2]!, "base64");
  const ct = Buffer.from(parts[3]!, "base64");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"); // .final() throws on a bad tag
}
```

- [ ] **Step 4: Run to verify it PASSES**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/secret-box.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/dionysus-mcp/src/lib/secret-box.ts packages/dionysus-mcp/test/secret-box.test.ts
git commit -m "feat: secret-box - AES-256-GCM encryption for integration secrets, fail-closed on a missing key"
```

---

## Task 2: `Integration` + `MetricSnapshot` schema

**Files:**
- Modify: `packages/dionysus-mcp/prisma/schema.prisma`
- (No test — the models are exercised by Tasks 3-5; a schema-only task is folded into its first consumer's verification.)

**Interfaces:**
- Produces (Prisma models):
  - `Integration { id, businessId, kind, provider, metric, configEnc, status, createdAt }` — `configEnc` is the secret-box blob; `kind` ∈ analytics|platform_oauth; `status` ∈ connected|disconnected; `metric` = which objective metric this source measures.
  - `MetricSnapshot { id, businessId, integrationId, metric, value, capturedAt }` — one real measured reading.

- [ ] **Step 1: Add the models**

In `packages/dionysus-mcp/prisma/schema.prisma`, add (after `MemoryEdge`):

```prisma
model Integration {
  id         String   @id @default(cuid())
  businessId String
  business   Business @relation(fields: [businessId], references: [id])
  kind       String   // "analytics" | "platform_oauth"
  provider   String   // e.g. "http-json" (reference), later "ga4" | "gsc" | "plausible"
  metric     String   // the objective metric this source measures (e.g. "signups")
  configEnc  String   // secret-box ciphertext blob (never plaintext)
  status     String   // "connected" | "disconnected"
  createdAt  DateTime @default(now())

  @@unique([businessId, kind, provider])
  @@index([businessId])
}

model MetricSnapshot {
  id            String   @id @default(cuid())
  businessId    String
  business      Business @relation(fields: [businessId], references: [id])
  integrationId String
  metric        String
  value         Float
  capturedAt    DateTime @default(now())

  @@index([businessId])
}
```

Add the back-relations on `Business` (find the `model Business` block and add these two lines alongside its other relation fields, e.g. next to `magicLinks`):

```prisma
  integrations    Integration[]
  metricSnapshots MetricSnapshot[]
```

- [ ] **Step 2: Regenerate + reset the test DB**

Run: `cd D:\Dionysus\packages\dionysus-mcp; pnpm prisma generate; node scripts/reset-test-db.mjs`
Expected: client regenerated; test DB re-pushed with both new tables, no error.

- [ ] **Step 3: Verify the client typechecks**

Run: `cd D:\Dionysus\packages\dionysus-mcp; pnpm build`
Expected: `tsc` clean (the generated client now carries `Integration`/`MetricSnapshot`).

- [ ] **Step 4: Commit**

```bash
git add packages/dionysus-mcp/prisma/schema.prisma
git commit -m "feat: Integration + MetricSnapshot models - connected analytics + real measured readings"
```

---

## Task 3: `integration.ts` — connect/disconnect a source (encrypted config, scoped)

**Files:**
- Create: `packages/dionysus-mcp/src/tools/integration.ts`
- Test: `packages/dionysus-mcp/test/integration.test.ts`

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` from `../lib/secret-box.js`; `prisma`; `Identity`.
- Produces:
  - `type IntegrationConfig = Record<string, unknown>` (the provider-specific config; JSON-serialized then encrypted)
  - `type ConnectedIntegration = { id: string; kind: string; provider: string; metric: string; status: string; createdAt: Date }` (NEVER includes config)
  - `connectIntegration(identity, input: { kind: string; provider: string; metric: string; config: IntegrationConfig }): Promise<{ integrationId: string }>` — encrypts config, upserts (by `businessId,kind,provider`), status `connected`.
  - `disconnectIntegration(identity, input: { integrationId: string }): Promise<void>` — scoped; sets status `disconnected`.
  - `getConnectedAnalytics(identity): Promise<ConnectedIntegration | null>` — the connected `analytics` integration, or null.
  - `getDecryptedConfig(identity, integrationId): Promise<IntegrationConfig | null>` — scoped; decrypts config for ingestion (internal use).
  - `listIntegrations(identity): Promise<ConnectedIntegration[]>` — all, config-free.

- [ ] **Step 1: Write the failing test**

Create `packages/dionysus-mcp/test/integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { CONFIG_KEY_ENV } from "../src/lib/secret-box.js";
import { connectIntegration, disconnectIntegration, getConnectedAnalytics, getDecryptedConfig, listIntegrations } from "../src/tools/integration.js";

const BIZ = "biz_integ_a";
const OTHER = "biz_integ_b";

beforeAll(() => {
  process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
});

beforeEach(async () => {
  for (const id of [BIZ, OTHER]) {
    await prisma.metricSnapshot.deleteMany({ where: { businessId: id } });
    await prisma.integration.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
});

describe("integration", () => {
  it("connects an analytics source, storing config ONLY as ciphertext (never plaintext)", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, {
      kind: "analytics", provider: "http-json", metric: "signups",
      config: { endpoint: "https://plausible.io/api/x", apiKey: "sekret-key-xyz" } });

    const row = await prisma.integration.findUnique({ where: { id: integrationId } });
    expect(row?.status).toBe("connected");
    expect(row?.configEnc).not.toContain("sekret-key-xyz"); // encrypted at rest
    expect(row?.configEnc.startsWith("v1.")).toBe(true);
    // The decrypted config round-trips for ingestion.
    const cfg = await getDecryptedConfig({ businessId: BIZ }, integrationId);
    expect(cfg).toMatchObject({ endpoint: "https://plausible.io/api/x", apiKey: "sekret-key-xyz" });
  });

  it("getConnectedAnalytics returns the connected source WITHOUT config; null when disconnected", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, {
      kind: "analytics", provider: "http-json", metric: "signups", config: { apiKey: "k" } });
    const connected = await getConnectedAnalytics({ businessId: BIZ });
    expect(connected?.metric).toBe("signups");
    expect(connected).not.toHaveProperty("configEnc");
    expect(connected).not.toHaveProperty("config");

    await disconnectIntegration({ businessId: BIZ }, { integrationId });
    expect(await getConnectedAnalytics({ businessId: BIZ })).toBeNull();
  });

  it("re-connecting the same (kind, provider) updates in place (upsert), re-encrypting", async () => {
    const first = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { apiKey: "old" } });
    const second = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { apiKey: "new" } });
    expect(second.integrationId).toBe(first.integrationId);
    const rows = await prisma.integration.findMany({ where: { businessId: BIZ } });
    expect(rows).toHaveLength(1);
    expect((await getDecryptedConfig({ businessId: BIZ }, first.integrationId))).toMatchObject({ apiKey: "new" });
  });

  it("is scoped — another tenant cannot read or decrypt this integration", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { apiKey: "k" } });
    expect(await getConnectedAnalytics({ businessId: OTHER })).toBeNull();
    expect(await getDecryptedConfig({ businessId: OTHER }, integrationId)).toBeNull();
    await disconnectIntegration({ businessId: OTHER }, { integrationId }); // no-op cross-tenant
    expect((await getConnectedAnalytics({ businessId: BIZ }))?.status).toBe("connected"); // untouched
  });
});
```

- [ ] **Step 2: Run to verify it FAILS**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/integration.test.ts`
Expected: FAIL — `Cannot find module '../src/tools/integration.js'`.

- [ ] **Step 3: Write the implementation**

Create `packages/dionysus-mcp/src/tools/integration.ts`:

```typescript
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { encryptSecret, decryptSecret } from "../lib/secret-box.js";

export type IntegrationConfig = Record<string, unknown>;
export type ConnectedIntegration = { id: string; kind: string; provider: string; metric: string; status: string; createdAt: Date };

/** Project a row to the config-FREE view (config never leaves this module in plaintext). */
function toView(row: { id: string; kind: string; provider: string; metric: string; status: string; createdAt: Date }): ConnectedIntegration {
  return { id: row.id, kind: row.kind, provider: row.provider, metric: row.metric, status: row.status, createdAt: row.createdAt };
}

/**
 * Connect (or re-connect) an integration. The config is JSON-serialized then AES-256-GCM
 * encrypted (secret-box) BEFORE it touches the DB — the plaintext is never persisted.
 * Upsert on (businessId, kind, provider): re-connecting re-encrypts + flips status connected.
 */
export async function connectIntegration(
  identity: Identity,
  input: { kind: string; provider: string; metric: string; config: IntegrationConfig },
): Promise<{ integrationId: string }> {
  const configEnc = encryptSecret(JSON.stringify(input.config)); // throws fail-closed if the key is absent
  const existing = await prisma.integration.findFirst({
    where: { businessId: identity.businessId, kind: input.kind, provider: input.provider } });
  if (existing) {
    await prisma.integration.update({ where: { id: existing.id },
      data: { metric: input.metric, configEnc, status: "connected" } });
    return { integrationId: existing.id };
  }
  const row = await prisma.integration.create({ data: {
    businessId: identity.businessId, kind: input.kind, provider: input.provider,
    metric: input.metric, configEnc, status: "connected" } });
  return { integrationId: row.id };
}

/** Disconnect (scoped): flip status. A cross-tenant id matches nothing (no-op). */
export async function disconnectIntegration(identity: Identity, input: { integrationId: string }): Promise<void> {
  await prisma.integration.updateMany({
    where: { id: input.integrationId, businessId: identity.businessId },
    data: { status: "disconnected" } });
}

/** The connected analytics integration (config-free), or null. */
export async function getConnectedAnalytics(identity: Identity): Promise<ConnectedIntegration | null> {
  const row = await prisma.integration.findFirst({
    where: { businessId: identity.businessId, kind: "analytics", status: "connected" },
    orderBy: { createdAt: "desc" } });
  return row ? toView(row) : null;
}

/** Decrypt the config for ingestion (scoped). Null if not found in scope or on a decrypt failure. */
export async function getDecryptedConfig(identity: Identity, integrationId: string): Promise<IntegrationConfig | null> {
  const row = await prisma.integration.findFirst({ where: { id: integrationId, businessId: identity.businessId } });
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(decryptSecret(row.configEnc));
    return typeof parsed === "object" && parsed !== null ? (parsed as IntegrationConfig) : null;
  } catch {
    return null; // malformed/tampered/undecryptable — degrade, never throw config internals to the caller
  }
}

export async function listIntegrations(identity: Identity): Promise<ConnectedIntegration[]> {
  const rows = await prisma.integration.findMany({
    where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
  return rows.map(toView);
}
```

- [ ] **Step 4: Run to verify it PASSES**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/integration.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/dionysus-mcp/src/tools/integration.ts packages/dionysus-mcp/test/integration.test.ts
git commit -m "feat: connectIntegration - scoped connect/disconnect with config encrypted at rest, config-free views"
```

---

## Task 4: `analytics.ts` — read a real metric (SSRF-guarded, degrade-safe) + ingest a snapshot

**Files:**
- Create: `packages/dionysus-mcp/src/tools/analytics.ts`
- Test: `packages/dionysus-mcp/test/analytics.test.ts`

**Interfaces:**
- Consumes: `getConnectedAnalytics`/`getDecryptedConfig` from `./integration.js`; `prisma`; `Identity`.
- Produces:
  - `type MetricTransport = (url: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>`
  - `fetchCurrentMetric(config: Record<string, unknown>, transport: MetricTransport): Promise<number | null>` — reads a numeric metric from `config.endpoint` (+ optional `config.apiKey` bearer), at the JSON path `config.valuePath` (default `"value"`). Degrades to `null` on any failure.
  - `ingestMetrics(identity, deps: { transport: MetricTransport }): Promise<{ snapshotId: string | null }>` — for the connected analytics integration, fetch + persist ONE `MetricSnapshot` (real value only). Null when there is no connected source or the fetch degrades.
  - The production transport default is the stage-1 SSRF-guarded fetch (wire it in `ingestMetrics`'s call site / cockpit; the function stays injectable).

- [ ] **Step 1: Write the failing test**

Create `packages/dionysus-mcp/test/analytics.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { CONFIG_KEY_ENV } from "../src/lib/secret-box.js";
import { connectIntegration } from "../src/tools/integration.js";
import { fetchCurrentMetric, ingestMetrics, type MetricTransport } from "../src/tools/analytics.js";

const BIZ = "biz_analytics_a";

beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });
beforeEach(async () => {
  await prisma.metricSnapshot.deleteMany({ where: { businessId: BIZ } });
  await prisma.integration.deleteMany({ where: { businessId: BIZ } });
  await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: BIZ }, update: {} });
});

const okTransport = (value: unknown): MetricTransport => async () => ({ ok: true, status: 200, json: async () => ({ value }) });
const failTransport: MetricTransport = async () => { throw new Error("network down"); };

describe("fetchCurrentMetric", () => {
  it("reads the numeric value at the default path", async () => {
    expect(await fetchCurrentMetric({ endpoint: "https://x/api" }, okTransport(42))).toBe(42);
  });
  it("degrades to null on a transport throw / non-200 / non-numeric body", async () => {
    expect(await fetchCurrentMetric({ endpoint: "https://x/api" }, failTransport)).toBeNull();
    expect(await fetchCurrentMetric({ endpoint: "https://x/api" }, async () => ({ ok: false, status: 500, json: async () => ({}) }))).toBeNull();
    expect(await fetchCurrentMetric({ endpoint: "https://x/api" }, okTransport("not-a-number"))).toBeNull();
  });
  it("degrades to null when endpoint is missing", async () => {
    expect(await fetchCurrentMetric({}, okTransport(1))).toBeNull();
  });
});

describe("ingestMetrics", () => {
  it("persists ONE real snapshot for the connected analytics source", async () => {
    await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x/api", apiKey: "k" } });
    const { snapshotId } = await ingestMetrics({ businessId: BIZ }, { transport: okTransport(120) });
    expect(snapshotId).not.toBeNull();
    const snaps = await prisma.metricSnapshot.findMany({ where: { businessId: BIZ } });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.value).toBe(120);
    expect(snaps[0]?.metric).toBe("signups");
  });

  it("persists NOTHING when there is no connected source", async () => {
    const { snapshotId } = await ingestMetrics({ businessId: BIZ }, { transport: okTransport(1) });
    expect(snapshotId).toBeNull();
    expect(await prisma.metricSnapshot.count({ where: { businessId: BIZ } })).toBe(0);
  });

  it("persists NOTHING when the fetch degrades (honest: no reading → no snapshot)", async () => {
    await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x/api" } });
    const { snapshotId } = await ingestMetrics({ businessId: BIZ }, { transport: failTransport });
    expect(snapshotId).toBeNull();
    expect(await prisma.metricSnapshot.count({ where: { businessId: BIZ } })).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it FAILS**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/analytics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `packages/dionysus-mcp/src/tools/analytics.ts`:

```typescript
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { getConnectedAnalytics, getDecryptedConfig, type IntegrationConfig } from "./integration.js";

// The transport is injectable (tests) and defaults, at the call site, to the stage-1
// SSRF-guarded fetch — the analytics endpoint is founder-provided (semi-trusted).
export type MetricTransport = (url: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Read a numeric value out of an unknown JSON body at a dotted path (default "value"). */
function readNumberAtPath(body: unknown, path: string): number | null {
  let cur: unknown = body;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : null;
}

/**
 * Read the current metric value from a provider endpoint. Provider-agnostic reference reader:
 * GET config.endpoint (optional `Authorization: Bearer config.apiKey`), parse the number at
 * config.valuePath (default "value"). DEGRADES to null on any failure (missing endpoint,
 * transport throw, non-200, non-numeric body) — honest: no reading, no snapshot.
 */
export async function fetchCurrentMetric(config: IntegrationConfig, transport: MetricTransport): Promise<number | null> {
  const endpoint = typeof config.endpoint === "string" ? config.endpoint : "";
  if (!endpoint) return null;
  const headers: Record<string, string> = {};
  if (typeof config.apiKey === "string" && config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
  const valuePath = typeof config.valuePath === "string" && config.valuePath ? config.valuePath : "value";
  try {
    const res = await transport(endpoint, headers);
    if (!res.ok || res.status !== 200) return null;
    const body = await res.json();
    return readNumberAtPath(body, valuePath);
  } catch {
    return null;
  }
}

/**
 * Ingest ONE real metric snapshot for the business's connected analytics source. Reads the
 * decrypted config, fetches the current value (SSRF-guarded transport), and persists a
 * MetricSnapshot ONLY if a real number came back. No connected source or a degraded fetch →
 * persists nothing, returns { snapshotId: null }. Scoped; never throws to the caller.
 */
export async function ingestMetrics(identity: Identity, deps: { transport: MetricTransport }): Promise<{ snapshotId: string | null }> {
  const connected = await getConnectedAnalytics(identity);
  if (!connected) return { snapshotId: null };
  const config = await getDecryptedConfig(identity, connected.id);
  if (!config) return { snapshotId: null };
  const value = await fetchCurrentMetric(config, deps.transport);
  if (value === null) return { snapshotId: null };
  const snap = await prisma.metricSnapshot.create({ data: {
    businessId: identity.businessId, integrationId: connected.id, metric: connected.metric, value } });
  return { snapshotId: snap.id };
}
```

*(Production-wiring note — NOT built in 5d: `ingestMetrics` has NO production caller this stage (the scheduled/auto ingestion trigger is 6a, like the radar trigger). It is exercised only by tests via the injectable transport. When 6a (or an interim "refresh now" button) wires a real caller, the transport MUST be the stage-1 SSRF-guarded fetch in `src/lib/ssrf.ts` (`safeFetch`, as used by send-verify) adapted to the `MetricTransport` shape — never a raw `fetch`, because the endpoint is founder-provided. Do NOT wire a production caller in 5d.)*

- [ ] **Step 4: Run to verify it PASSES**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/analytics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dionysus-mcp/src/tools/analytics.ts packages/dionysus-mcp/test/analytics.test.ts
git commit -m "feat: analytics ingestion - provider-agnostic SSRF-guarded metric read, degrade-safe snapshot persist"
```

---

## Task 5: Flip `buildCmoReport` to real measurement (+ attribution-honest recommendation)

**Files:**
- Modify: `packages/dionysus-mcp/src/lib/cmo-verdict.ts` (measured-working recommendation)
- Modify: `packages/dionysus-mcp/src/tools/cmo-report.ts` (real `analyticsConnected` + real `metricDeltaPct`)
- Test: `packages/dionysus-mcp/test/cmo-report.test.ts` (extend)

**Interfaces:**
- Consumes: `getConnectedAnalytics` from `./integration.js`; `prisma`.
- Produces: no signature change. `buildCmoReport` now returns a real `analyticsConnected` and, when computable, drives the grader's measured branch.

- [ ] **Step 1: Write the failing test — extend `cmo-report.test.ts`**

Add a describe block (reuse the file's existing tenant/seed helpers; set the config key):

```typescript
import { CONFIG_KEY_ENV } from "../src/lib/secret-box.js";
import { connectIntegration } from "../src/tools/integration.js";

describe("buildCmoReport measured (5d)", () => {
  const M = { businessId: "biz_cmo_measured" };
  const NOW = new Date("2026-07-11T00:00:00.000Z");
  const weeksAgo = (n: number) => new Date(NOW.getTime() - n * 7 * 24 * 60 * 60 * 1000);

  beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });

  beforeEach(async () => {
    await prisma.metricSnapshot.deleteMany({ where: { businessId: M.businessId } });
    await prisma.integration.deleteMany({ where: { businessId: M.businessId } });
    await prisma.routeAction.deleteMany({ where: { businessId: M.businessId } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: M.businessId } });
    await prisma.route.deleteMany({ where: { businessId: M.businessId } });
    await prisma.objective.deleteMany({ where: { businessId: M.businessId } });
    await prisma.business.upsert({ where: { id: M.businessId }, create: { id: M.businessId, name: M.businessId }, update: {} });
    // An objective + a route that started 6 weeks ago + at least one verified send (so the loop is past getting-started/not stalled).
    await prisma.objective.create({ data: { businessId: M.businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
    const route = await prisma.route.create({ data: { businessId: M.businessId, objectiveId: (await prisma.objective.findFirst({ where: { businessId: M.businessId } }))!.id, source: "composed", status: "active", createdAt: weeksAgo(6) } });
    const wp = await prisma.routeWaypoint.create({ data: { businessId: M.businessId, routeId: route.id, order: 1, title: "W", goal: "g", status: "active" } });
    await prisma.routeAction.create({ data: { businessId: M.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "executed", verifiedAt: weeksAgo(1) } });
  });

  it("stays UNMEASURED (no metric-move claim) when no analytics source is connected", async () => {
    const report = await buildCmoReport(M, NOW);
    expect(report.analyticsConnected).toBe(false);
    expect(report.verdict.claimsMetricMoved).toBe(false);
    expect(report.verdict.state).not.toMatch(/^measured/);
  });

  it("reports MEASURED-WORKING with a REAL positive delta from real snapshots", async () => {
    const { integrationId } = await connectIntegration(M, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x", apiKey: "k" } });
    // Real snapshots: baseline 100 at route start, current 130 now → +30%.
    await prisma.metricSnapshot.create({ data: { businessId: M.businessId, integrationId, metric: "signups", value: 100, capturedAt: weeksAgo(6) } });
    await prisma.metricSnapshot.create({ data: { businessId: M.businessId, integrationId, metric: "signups", value: 130, capturedAt: weeksAgo(0) } });

    const report = await buildCmoReport(M, NOW);
    expect(report.analyticsConnected).toBe(true);
    expect(report.verdict.state).toBe("measured-working");
    expect(report.verdict.claimsMetricMoved).toBe(true);
    expect(report.verdict.headline).toContain("30"); // the REAL delta, not a fabricated number
    // Attribution honesty: the recommendation does not assert proven causation.
    expect(report.verdict.recommendation.toLowerCase()).toMatch(/attribution|can't be sure|not proven|may be/);
  });

  it("reports MEASURED-FLAT when connected but the real delta is not positive", async () => {
    const { integrationId } = await connectIntegration(M, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    await prisma.metricSnapshot.create({ data: { businessId: M.businessId, integrationId, metric: "signups", value: 100, capturedAt: weeksAgo(6) } });
    await prisma.metricSnapshot.create({ data: { businessId: M.businessId, integrationId, metric: "signups", value: 100, capturedAt: weeksAgo(0) } });
    const report = await buildCmoReport(M, NOW);
    expect(report.verdict.state).toBe("measured-flat");
    expect(report.verdict.claimsMetricMoved).toBe(false);
  });

  it("stays unmeasured when connected but only ONE snapshot exists (no delta computable — no fabrication)", async () => {
    const { integrationId } = await connectIntegration(M, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    await prisma.metricSnapshot.create({ data: { businessId: M.businessId, integrationId, metric: "signups", value: 100, capturedAt: weeksAgo(0) } });
    const report = await buildCmoReport(M, NOW);
    expect(report.analyticsConnected).toBe(true);
    expect(report.verdict.claimsMetricMoved).toBe(false); // no baseline → no delta → no measured-working
  });
});
```

- [ ] **Step 2: Run to verify it FAILS**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/cmo-report.test.ts`
Expected: FAIL — `analyticsConnected` is hardcoded false / recommendation lacks the attribution hedge.

- [ ] **Step 3a: Refine the measured-working recommendation in `cmo-verdict.ts`**

Replace the `measured-working` return's `recommendation` (currently "Keep the current route — it is moving the metric. Double down on what shipped.") with an attribution-honest version:

```typescript
      return {
        state: "measured-working",
        headline: `Your number is up ${metricDeltaPct}% since this objective's work went live.`,
        recommendation:
          "Your number rose while this work was live — attribution isn't proven at this scale, but it's worth doubling down on what shipped and watching whether the trend holds.",
        claimsMetricMoved: true,
      };
```

*(The headline stays a measured temporal FACT; `claimsMetricMoved` stays true — it means "reports a real measured move". Only the recommendation is softened to not assert proven causation, per spec §16 line 202.)*

- [ ] **Step 3b: Wire real inputs in `cmo-report.ts`**

Add the import:

```typescript
import { getConnectedAnalytics } from "./integration.js";
```

Replace the hardcoded seam:

```typescript
  // §3 honesty seam: analytics is stage 5. Hardcoded false here.
  // TODO stage-5: analyticsConnected = (count(Integration where kind=analytics) > 0).
  const analyticsConnected = false;
```

with a real check + a real delta computed from snapshots since the objective's route began:

```typescript
  // §3 / D21: analytics is REAL now. analyticsConnected reflects a connected analytics
  // Integration; metricDeltaPct is computed ONLY from real MetricSnapshot rows (baseline at/
  // after the route start vs the latest) — never fabricated. No connection, or fewer than two
  // real readings, leaves metricDeltaPct undefined → the grader stays on an unmeasured verdict.
  const connected = await getConnectedAnalytics(identity);
  const analyticsConnected = connected !== null;
  let metricDeltaPct: number | undefined;
  if (connected && earliestRoute) {
    const snapshots = await prisma.metricSnapshot.findMany({
      where: { businessId, metric: connected.metric }, orderBy: { capturedAt: "asc" } });
    // Baseline = the first snapshot at/after the route began (the measurement window start);
    // current = the latest. A real, positive baseline is required to compute a percentage.
    const baseline = snapshots.find((s) => s.capturedAt >= earliestRoute.createdAt) ?? snapshots[0];
    const latest = snapshots.length ? snapshots[snapshots.length - 1] : undefined;
    if (baseline && latest && baseline.id !== latest.id && baseline.value > 0) {
      metricDeltaPct = Math.round(((latest.value - baseline.value) / baseline.value) * 100);
    }
  }
```

Then add `metricDeltaPct` to the `stats` object:

```typescript
  const stats: ObjectiveStats = {
    weeksActive,
    executedTotal,
    executedRecent,
    executedThisWeek,
    inFlight,
    proposedPending,
    analyticsConnected,
    metricDeltaPct,
  };
```

*(The `CmoReport.analyticsConnected` field now carries the real value automatically — no shape change.)*

- [ ] **Step 4: Run to verify it PASSES + the full mcp suite**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/cmo-report.test.ts`  → PASS
Then confirm the honesty invariant tests + the 4f cmo-eval gate still pass (analyticsConnected=false path unchanged for unconnected businesses): `pnpm vitest run test/cmo-verdict.test.ts test/cmo-eval.e2e.test.ts`  → PASS
Then `pnpm build` → tsc clean (department imports the dist).

- [ ] **Step 5: Commit**

```bash
git add packages/dionysus-mcp/src/lib/cmo-verdict.ts packages/dionysus-mcp/src/tools/cmo-report.ts packages/dionysus-mcp/test/cmo-report.test.ts
git commit -m "feat: CMO report measures real outcomes - analyticsConnected + metricDeltaPct from real snapshots, attribution-honest"
```

---

## Task 6: Cockpit — connect an analytics source + show the measured verdict

**Files:**
- Modify: `packages/cockpit/src/lib/review.ts` (add `getIntegrations`)
- Create: `packages/cockpit/src/lib/integration-actions.ts` (`connectAnalyticsAction`, `disconnectAnalyticsAction`)
- Create: `packages/cockpit/src/app/connect/page.tsx` (+ nav link in `layout.tsx`)
- Test: `packages/cockpit/test/review.test.ts` (extend)

**Interfaces:**
- Consumes: `listIntegrations`, `connectIntegration`, `disconnectIntegration` from `dionysus-mcp/tools/integration`; `requireSession`.
- Produces: `getIntegrations(identity): Promise<ConnectedIntegration[]>`; session-authed server actions that connect/disconnect; a `/connect` page.

- [ ] **Step 1: Write the failing test — extend `review.test.ts`**

```typescript
import { getIntegrations } from "../src/lib/review";
import { connectIntegration } from "dionysus-mcp/tools/integration";
import { CONFIG_KEY_ENV } from "dionysus-mcp/lib/secret-box";

describe("getIntegrations", () => {
  beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });
  beforeEach(async () => {
    await prisma.integration.deleteMany({ where: { businessId: A.businessId } });
    await prisma.integration.deleteMany({ where: { businessId: B.businessId } });
  });

  it("returns the identity's integrations WITHOUT any config, scoped", async () => {
    await connectIntegration(A, { kind: "analytics", provider: "http-json", metric: "signups", config: { apiKey: "sekret" } });
    await connectIntegration(B, { kind: "analytics", provider: "http-json", metric: "x", config: { apiKey: "other" } });
    const list = await getIntegrations(A);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("configEnc");
    expect(JSON.stringify(list)).not.toContain("sekret"); // config never surfaces
    expect(list.some((i) => i.metric === "x")).toBe(false); // B scoped out
  });
});
```

*(Reuse `review.test.ts`'s `A`/`B` tenants. Confirm the `dionysus-mcp/lib/secret-box` import path resolves — if the package exports map only exposes `tools/*`, import `CONFIG_KEY_ENV` from `dionysus-mcp/tools/integration` by re-exporting it there, or set `process.env[CONFIG_KEY_ENV]` with the literal string `"DIONYSUS_CONFIG_KEY"`.)*

- [ ] **Step 2: Run to verify it FAILS**

Run: `cd D:\Dionysus\packages\cockpit; $env:DATABASE_URL="file:./.tmp/test.db"; $env:COCKPIT_SESSION_SECRET="test-secret"; pnpm vitest run test/review.test.ts`
Expected: FAIL — `getIntegrations` not exported.

- [ ] **Step 3: Add `getIntegrations` to `review.ts`**

```typescript
import { listIntegrations, type ConnectedIntegration } from "dionysus-mcp/tools/integration";

export type { ConnectedIntegration };

export async function getIntegrations(identity: Identity): Promise<ConnectedIntegration[]> {
  return listIntegrations(identity);
}
```

- [ ] **Step 4: Create the server actions**

Create `packages/cockpit/src/lib/integration-actions.ts` (mirror the existing cockpit server-action pattern — `requireSession` outside any try so `NEXT_REDIRECT` propagates; `revalidatePath` on success):

```typescript
"use server";
import { revalidatePath } from "next/cache";
import { requireSession } from "./auth";
import { connectIntegration, disconnectIntegration } from "dionysus-mcp/tools/integration";

export type ActionResult = { ok: boolean; message: string };

export async function connectAnalyticsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const endpoint = String(formData.get("endpoint") ?? "").trim();
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const metric = String(formData.get("metric") ?? "").trim();
  if (!endpoint || !metric) return { ok: false, message: "Endpoint and metric are required." };
  try {
    await connectIntegration(identity, { kind: "analytics", provider: "http-json", metric, config: { endpoint, apiKey } });
    revalidatePath("/connect");
    return { ok: true, message: "Analytics connected. Real measurement will appear in your report as data arrives." };
  } catch {
    return { ok: false, message: "Could not connect — check the endpoint and try again." };
  }
}

export async function disconnectAnalyticsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const integrationId = String(formData.get("integrationId") ?? "");
  if (!integrationId) return { ok: false, message: "Missing integration." };
  await disconnectIntegration(identity, { integrationId });
  revalidatePath("/connect");
  return { ok: true, message: "Analytics disconnected." };
}
```

- [ ] **Step 5: Create the page + nav link**

Create `packages/cockpit/src/app/connect/page.tsx`:

```tsx
import { requireSession } from "../../lib/auth";
import { getIntegrations } from "../../lib/review";

export const dynamic = "force-dynamic";

export default async function ConnectPage() {
  const session = await requireSession();
  const integrations = await getIntegrations({ businessId: session.businessId });
  const analytics = integrations.filter((i) => i.kind === "analytics" && i.status === "connected");
  return (
    <main>
      <h2>Connect analytics</h2>
      <p style={{ color: "#666" }}>
        Connect a read-only analytics source so your report can grade <strong>real</strong> outcomes, not just what shipped.
        Until you connect one, the report stays honest — it never claims a number moved that it can&apos;t measure.
        Your credentials are encrypted at rest.
      </p>
      {analytics.length > 0 ? (
        <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <strong>Connected:</strong> {analytics[0]!.provider} · measuring <em>{analytics[0]!.metric}</em>
        </div>
      ) : (
        <p>No analytics connected yet.</p>
      )}
      <form action="/connect" method="get" style={{ display: "none" }} />
      <ConnectForm />
    </main>
  );
}

// Minimal client form using the server action; mirror the existing useActionState card pattern.
import { ConnectForm } from "./connect-form";
```

Create `packages/cockpit/src/app/connect/connect-form.tsx`:

```tsx
"use client";
import { useActionState } from "react";
import { connectAnalyticsAction, type ActionResult } from "../../lib/integration-actions";

export function ConnectForm() {
  const [result, action] = useActionState<ActionResult | null, FormData>(connectAnalyticsAction, null);
  return (
    <form action={action}>
      <div><label>Metric name <input name="metric" placeholder="signups" required /></label></div>
      <div><label>Stats endpoint (JSON) <input name="endpoint" placeholder="https://…" required /></label></div>
      <div><label>API key (optional) <input name="apiKey" type="password" /></label></div>
      <button type="submit">Connect analytics</button>
      {result && <p style={{ color: result.ok ? "green" : "crimson" }}>{result.message}</p>}
    </form>
  );
}
```

Add the nav link in `layout.tsx` (after `Report`):

```tsx
          <a href="/report">Report</a>
          <a href="/connect">Connect</a>
```

- [ ] **Step 6: Run the cockpit test + build**

Run: `cd D:\Dionysus\packages\cockpit; $env:DATABASE_URL="file:./.tmp/test.db"; $env:COCKPIT_SESSION_SECRET="test-secret"; pnpm vitest run test/review.test.ts`  → PASS
Then: `$env:DIONYSUS_CONFIG_KEY="c2VjcmV0LXRlc3Qta2V5LXNlY3JldC10ZXN0LWtleTMy"; pnpm exec next build`  → clean; `/connect` emitted as `ƒ` (dynamic). *(If the build statically evaluates the action module and needs the key, the value above is any base64-of-32-bytes; otherwise the build does not need it.)*

- [ ] **Step 7: Commit**

```bash
git add packages/cockpit/src/lib/review.ts packages/cockpit/src/lib/integration-actions.ts packages/cockpit/src/app/connect packages/cockpit/src/app/layout.tsx packages/cockpit/test/review.test.ts
git commit -m "feat: cockpit /connect - connect a real analytics source (encrypted), report grades measured outcomes"
```

---

## Task 7: §15 eval gate — measurement is real, honest, encrypted, scoped

**Files:**
- Create: `packages/dionysus-mcp/test/measurement-eval.e2e.test.ts`

The gate pins the honesty invariants NON-VACUOUSLY.

- [ ] **Step 1: Write the eval gate**

Create `packages/dionysus-mcp/test/measurement-eval.e2e.test.ts`:

```typescript
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { CONFIG_KEY_ENV } from "../src/lib/secret-box.js";
import { connectIntegration, getDecryptedConfig } from "../src/tools/integration.js";
import { ingestMetrics, type MetricTransport } from "../src/tools/analytics.js";
import { buildCmoReport } from "../src/tools/cmo-report.js";
import { TOOL_SCHEMAS } from "../src/server.js";

const BIZ = "biz_measeval_a";
const GHOST = "biz_measeval_b";
const NOW = new Date("2026-07-11T00:00:00.000Z");
const weeksAgo = (n: number) => new Date(NOW.getTime() - n * 7 * 24 * 60 * 60 * 1000);
const okTransport = (v: number): MetricTransport => async () => ({ ok: true, status: 200, json: async () => ({ value: v }) });

beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });

async function seedShippedBusiness(businessId: string) {
  await prisma.metricSnapshot.deleteMany({ where: { businessId } });
  await prisma.integration.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
  await prisma.business.upsert({ where: { id: businessId }, create: { id: businessId, name: businessId }, update: {} });
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active", createdAt: weeksAgo(6) } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "W", goal: "g", status: "active" } });
  await prisma.routeAction.create({ data: { businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "executed", verifiedAt: weeksAgo(1) } });
}

describe("measurement eval gate (§15)", () => {
  beforeEach(() => seedShippedBusiness(BIZ));

  it("inv1 — an UNCONNECTED business never claims a metric moved (claimsMetricMoved false, unmeasured state)", async () => {
    const report = await buildCmoReport({ businessId: BIZ }, NOW);
    expect(report.analyticsConnected).toBe(false);
    expect(report.verdict.claimsMetricMoved).toBe(false);
    expect(report.verdict.state).not.toMatch(/^measured/);
  });

  it("inv2 — measured-working requires BOTH a real connection AND a real positive delta (the honesty invariant end-to-end)", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    // Connected but ZERO snapshots → still no claim.
    let report = await buildCmoReport({ businessId: BIZ }, NOW);
    expect(report.analyticsConnected).toBe(true);
    expect(report.verdict.claimsMetricMoved).toBe(false);
    // Two REAL snapshots (100 → 125) → measured-working with the REAL 25%.
    await prisma.metricSnapshot.create({ data: { businessId: BIZ, integrationId, metric: "signups", value: 100, capturedAt: weeksAgo(6) } });
    await prisma.metricSnapshot.create({ data: { businessId: BIZ, integrationId, metric: "signups", value: 125, capturedAt: weeksAgo(0) } });
    report = await buildCmoReport({ businessId: BIZ }, NOW);
    expect(report.verdict.state).toBe("measured-working");
    expect(report.verdict.claimsMetricMoved).toBe(true);
    expect(report.verdict.headline).toContain("25");
  });

  it("inv3 — the delta is REAL: it changes with the snapshot data (not a constant / fabricated)", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    await prisma.metricSnapshot.create({ data: { businessId: BIZ, integrationId, metric: "signups", value: 200, capturedAt: weeksAgo(6) } });
    await prisma.metricSnapshot.create({ data: { businessId: BIZ, integrationId, metric: "signups", value: 300, capturedAt: weeksAgo(0) } });
    const report = await buildCmoReport({ businessId: BIZ }, NOW);
    expect(report.verdict.headline).toContain("50"); // (300-200)/200 = 50%, tracks the real rows
  });

  it("inv4 — config is encrypted at rest: the DB column never holds the plaintext key, but it round-trips", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x", apiKey: "TOP-SECRET-KEY" } });
    const row = await prisma.integration.findUnique({ where: { id: integrationId } });
    expect(row?.configEnc).not.toContain("TOP-SECRET-KEY");
    expect(await getDecryptedConfig({ businessId: BIZ }, integrationId)).toMatchObject({ apiKey: "TOP-SECRET-KEY" });
  });

  it("inv5 — ingestMetrics persists ONLY real fetched values; a degraded fetch fabricates nothing", async () => {
    await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    const failTransport: MetricTransport = async () => { throw new Error("down"); };
    const degraded = await ingestMetrics({ businessId: BIZ }, { transport: failTransport });
    expect(degraded.snapshotId).toBeNull();
    expect(await prisma.metricSnapshot.count({ where: { businessId: BIZ } })).toBe(0);
    const real = await ingestMetrics({ businessId: BIZ }, { transport: okTransport(77) });
    expect(real.snapshotId).not.toBeNull();
    const snaps = await prisma.metricSnapshot.findMany({ where: { businessId: BIZ } });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.value).toBe(77);
  });

  it("inv6 — scoped: a ghost tenant's connection + snapshots never affect this business's report", async () => {
    await seedShippedBusiness(GHOST);
    const { integrationId } = await connectIntegration({ businessId: GHOST }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
    await prisma.metricSnapshot.create({ data: { businessId: GHOST, integrationId, metric: "signups", value: 1, capturedAt: weeksAgo(6) } });
    await prisma.metricSnapshot.create({ data: { businessId: GHOST, integrationId, metric: "signups", value: 999, capturedAt: weeksAgo(0) } });
    // BIZ has no connection of its own.
    const report = await buildCmoReport({ businessId: BIZ }, NOW);
    expect(report.analyticsConnected).toBe(false);
    expect(report.verdict.claimsMetricMoved).toBe(false);
    // Ghost genuinely measures (proves the scope filter is load-bearing, not vacuous).
    const ghostReport = await buildCmoReport({ businessId: GHOST }, NOW);
    expect(ghostReport.verdict.state).toBe("measured-working");
  });

  it("inv7 — measurement is NOT MCP: whitelist stays exactly 11, no integration/analytics tool", () => {
    const toolNames = Object.keys(TOOL_SCHEMAS);
    expect(toolNames.length).toBe(11);
    for (const forbidden of ["connect_integration", "ingest_metrics", "record_metric", "disconnect_integration"]) {
      expect(toolNames).not.toContain(forbidden);
    }
  });
});
```

- [ ] **Step 2: Run the gate + full mcp suite**

Run: `cd D:\Dionysus\packages\dionysus-mcp; $env:DATABASE_URL="file:./.tmp/test.db"; pnpm vitest run test/measurement-eval.e2e.test.ts`  → PASS (7 invariants)
Then: `pnpm vitest run`  → all green.

- [ ] **Step 3: Commit**

```bash
git add packages/dionysus-mcp/test/measurement-eval.e2e.test.ts
git commit -m "test: stage-5d eval gate - measurement is real, honesty-gated, encrypted, degrade-safe, scoped, non-MCP"
```

---

## Self-Review

**1. Spec coverage.** D21 (real-outcome measurement via a connected `Integration`, config encrypted at rest, honest until connected) — delivered. §10 `Integration` model — delivered (+ `MetricSnapshot` for the trajectory/delta). The 4f `analyticsConnected` seam (`cmo-report.ts:144-146`) — flipped to real. The grader's measured branch (`cmo-verdict.ts`) — now reachable from real data, with an attribution-honest recommendation (§16 line 202). Open-question 375 (which providers) — the reference connector is provider-agnostic; concrete live-vendor OAuth (GA4/GSC) + a scheduled ingestion trigger are deferred (see Out of Scope).

**2. Placeholder scan.** Every code step carries complete code. The two "confirm the import path" notes (T4 `safeFetch`, T6 `secret-box` package export) point at concrete existing modules; they are wiring confirmations, not vague instructions.

**3. Type consistency.** `IntegrationConfig`/`ConnectedIntegration`/`MetricTransport` defined once and consumed unchanged. `connectIntegration`/`ingestMetrics`/`getConnectedAnalytics` signatures identical across definition and call sites. `buildCmoReport`/`gradeObjective` keep their shapes; `ObjectiveStats.metricDeltaPct` already exists (defined at 4f, unused until now).

## Out of Scope (deferred, with rationale)

- **Live-vendor OAuth flows (GA4 / GSC / OAuth2 providers)** → per-provider follow-on. The `AnalyticsProvider` abstraction + the encrypted `Integration` accommodate them; 5d ships the provider-agnostic reference reader (API-key / endpoint) which is production-real for any JSON-metric endpoint (incl. a future first-party Dionysus snippet). Open-question 375's concrete provider choice can be made when a specific connector is built.
- **Scheduled/auto ingestion trigger** → 6a platform layer (D30 cron/wake), exactly like the radar trigger. 5d's `ingestMetrics` is callable and tested; production auto-run lands with the platform. (A cockpit "refresh now" button could call it manually as an interim — not in this stage.)
- **Performance beliefs from measured signal** (extending the 5c belief layer with measured outcomes weighted highest) → a follow-on. The belief machinery exists; measured `MetricSnapshot`/`caused`-outcome signal plugs into `deriveBeliefs` later.
- **Step-up MFA for connect (H3)** → needs MFA infra. The connect action is session-authed + Next origin-enforced; MFA is a later security hardening.
- **Proxy-metric tracking (clicks / waitlist / click redirector L1)** → separate. 5d measures REAL conversions via the analytics integration; the proxy-metric path is its own plumbing.

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — fresh Opus subagent per task, review between tasks, whole-branch review at the end. **T1 (secret-box) gets a security-lensed review** (crypto correctness: IV uniqueness, authenticated encryption, key handling, fail-closed, no key leakage).
2. **Inline Execution** — execute in this session with checkpoints.
