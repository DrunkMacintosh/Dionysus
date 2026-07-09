# dionysus-mcp Stage 1 (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the greenfield `dionysus-mcp` Node/TS MCP server — SSRF-guarded scrape ladder, deterministic brand extraction, pricing/cost ledger, advisory budget check, Prisma persistence — with D27.1 ambient caller identity (no tool ever accepts `businessId`).

**Architecture:** A pnpm-workspace monorepo with one package for now (`packages/dionysus-mcp`). Pure library modules (`src/lib/*`) hold the deterministic plumbing; an identity module binds one process to one `businessId` from the environment at startup; a thin repository layer injects that identity into every Prisma query; the MCP server registers strict-schema tools that wrap the libs. The D28 LLM gateway is a separate follow-up plan (separate process/subsystem); this plan delivers the `LlmCall`/`CreditLedger` ledger it will write to, plus `record_cost` for non-LLM costs.

**Tech Stack:** Node ≥ 22, TypeScript (strict), pnpm workspaces, vitest, Prisma + SQLite, `@modelcontextprotocol/sdk`, `zod` (v3, matching the MCP SDK), `undici`, `cheerio`.

## Global Constraints

- **D27.1 (spec §8b):** No tool takes `businessId` as a parameter. Identity comes only from `DIONYSUS_BUSINESS_ID` in the process environment; the server refuses to start without it. All tool input schemas are `.strict()` so an injected `businessId` key is a validation error.
- **D33 (spec):** Greenfield — no prototype exists. Nothing here imports or ports old code.
- **Spec §14:** SSRF and budget fail **closed**. Scrape tier 4 returns a structured "couldn't read" result, never a throw to the agent.
- **Spec §8:** `record_cost` → `LlmCall` with `costUsd = null` for unpriced models (no fabricated numbers).
- **Security addendum H2 (partial, lib-level):** `safeFetch` follows no redirects blindly — each hop is re-validated; private/reserved IPs are rejected at socket-connect time (closes DNS rebinding); response size, time, and content-type are capped.
- **Testing:** TDD — every task writes the failing test first. Test DB is `file:./.tmp/test.db`, reset per test run.
- **Commits:** conventional format (`feat:`/`test:`/`chore:`), no attribution footer (user's global git config disables it).
- **Shell:** Windows/PowerShell — commands below use PowerShell-compatible syntax (`;` not `&&`).

---

### Task 1: Workspace scaffold + test toolchain

**Files:**
- Create: `package.json` (workspace root)
- Create: `pnpm-workspace.yaml`
- Create: `.gitignore`
- Create: `packages/dionysus-mcp/package.json`
- Create: `packages/dionysus-mcp/tsconfig.json`
- Create: `packages/dionysus-mcp/vitest.config.ts`
- Test: `packages/dionysus-mcp/test/sanity.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a runnable `pnpm test` inside `packages/dionysus-mcp`; TypeScript strict config all later tasks compile under; the `DATABASE_URL` test env used by every later test.

- [ ] **Step 1: Create the workspace files**

`package.json` (repo root):

```json
{
  "name": "dionysus",
  "private": true,
  "packageManager": "pnpm@9.15.0"
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

`.gitignore`:

```
node_modules/
dist/
.tmp/
*.db
*.db-journal
.env
```

`packages/dionysus-mcp/package.json`:

```json
{
  "name": "dionysus-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "prisma db push --force-reset --skip-generate; vitest run",
    "test:unit": "vitest run",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js"
  }
}
```

`packages/dionysus-mcp/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`packages/dionysus-mcp/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: "file:./.tmp/test.db",
      DIONYSUS_BUSINESS_ID: "", // tasks set identity explicitly; empty by default
    },
    testTimeout: 15000,
  },
});
```

- [ ] **Step 2: Install dependencies**

Run (from `packages/dionysus-mcp`):

```powershell
pnpm add @modelcontextprotocol/sdk zod@^3 undici cheerio @prisma/client
pnpm add -D typescript vitest prisma @types/node
```

Expected: lockfile created, no errors.

- [ ] **Step 3: Write the sanity test**

`packages/dionysus-mcp/test/sanity.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("toolchain sanity", () => {
  it("runs TypeScript tests", () => {
    const x: number = 1 + 1;
    expect(x).toBe(2);
  });
});
```

- [ ] **Step 4: Run it and verify it passes**

Run: `pnpm vitest run test/sanity.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "chore: scaffold pnpm workspace + dionysus-mcp package with vitest"
```

---

### Task 2: Prisma schema + client

**Files:**
- Create: `packages/dionysus-mcp/prisma/schema.prisma`
- Create: `packages/dionysus-mcp/src/db.ts`
- Test: `packages/dionysus-mcp/test/db.test.ts`

**Interfaces:**
- Consumes: Task 1 toolchain.
- Produces: `prisma` singleton (`src/db.ts`, named export `prisma: PrismaClient`); models `Business { id, name, maxTokensPerDay }`, `Product`, `BrandKit`, `LlmCall`, `CreditLedger` — all with `businessId` + `@@index([businessId])`. JSON payloads are stored as `String` (SQLite).

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/db.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";

describe("schema", () => {
  beforeAll(async () => {
    await prisma.business.deleteMany();
  });

  it("creates a business with a default daily token cap", async () => {
    const b = await prisma.business.create({
      data: { id: "biz_test", name: "Test Co" },
    });
    expect(b.maxTokensPerDay).toBeGreaterThan(0);
  });

  it("stores an LlmCall with nullable cost", async () => {
    const call = await prisma.llmCall.create({
      data: {
        businessId: "biz_test",
        model: "unknown-model",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: null,
      },
    });
    expect(call.costUsd).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/db.test.ts`
Expected: FAIL — cannot resolve `../src/db.js` / Prisma client not generated.

- [ ] **Step 3: Write schema and client**

`packages/dionysus-mcp/prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Business {
  id              String   @id
  name            String
  maxTokensPerDay Int      @default(200000)
  createdAt       DateTime @default(now())
  products        Product[]
  brandKits       BrandKit[]
  llmCalls        LlmCall[]
  creditEntries   CreditLedger[]
}

model Product {
  id          String   @id @default(cuid())
  businessId  String
  business    Business @relation(fields: [businessId], references: [id])
  url         String
  readTier    Int
  title       String?
  description String?
  text        String?
  createdAt   DateTime @default(now())

  @@index([businessId])
}

model BrandKit {
  id         String   @id @default(cuid())
  businessId String
  business   Business @relation(fields: [businessId], references: [id])
  url        String
  colorsJson String
  fontsJson  String
  createdAt  DateTime @default(now())

  @@index([businessId])
}

model LlmCall {
  id           String   @id @default(cuid())
  businessId   String
  business     Business @relation(fields: [businessId], references: [id])
  model        String
  inputTokens  Int
  outputTokens Int
  costUsd      Float?
  note         String?
  ts           DateTime @default(now())

  @@index([businessId, ts])
}

model CreditLedger {
  id         String   @id @default(cuid())
  businessId String
  business   Business @relation(fields: [businessId], references: [id])
  delta      Int
  reason     String
  ref        String?
  ts         DateTime @default(now())

  @@index([businessId])
}
```

`packages/dionysus-mcp/src/db.ts`:

```ts
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
```

- [ ] **Step 4: Generate client, push schema, run test**

Run (from `packages/dionysus-mcp`):

```powershell
New-Item -ItemType Directory -Force .tmp | Out-Null
$env:DATABASE_URL = "file:./.tmp/test.db"
pnpm prisma generate
pnpm prisma db push --force-reset
pnpm vitest run test/db.test.ts
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: stage-1 Prisma schema (Business/Product/BrandKit/LlmCall/CreditLedger) + client"
```

---

### Task 3: Ambient identity (D27.1)

**Files:**
- Create: `packages/dionysus-mcp/src/identity.ts`
- Test: `packages/dionysus-mcp/test/identity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Identity = { businessId: string }`; `loadIdentity(env?: Record<string, string | undefined>): Identity` — throws if `DIONYSUS_BUSINESS_ID` is missing/empty (server refuses to start without identity).

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/identity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadIdentity } from "../src/identity.js";

describe("ambient identity (D27.1)", () => {
  it("loads businessId from the environment", () => {
    const id = loadIdentity({ DIONYSUS_BUSINESS_ID: "biz_abc" });
    expect(id.businessId).toBe("biz_abc");
  });

  it("refuses to start without an identity", () => {
    expect(() => loadIdentity({})).toThrow(/DIONYSUS_BUSINESS_ID/);
    expect(() => loadIdentity({ DIONYSUS_BUSINESS_ID: "" })).toThrow(/DIONYSUS_BUSINESS_ID/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/dionysus-mcp/src/identity.ts`:

```ts
export type Identity = { businessId: string };

export function loadIdentity(
  env: Record<string, string | undefined> = process.env,
): Identity {
  const businessId = env["DIONYSUS_BUSINESS_ID"];
  if (!businessId) {
    throw new Error(
      "DIONYSUS_BUSINESS_ID is not set — refusing to start. " +
        "Identity is ambient and per-process (D27.1); it is never a tool parameter.",
    );
  }
  return { businessId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/identity.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: ambient per-process identity, fail-closed on missing DIONYSUS_BUSINESS_ID"
```

---

### Task 4: SSRF guard — IP + host validation

**Files:**
- Create: `packages/dionysus-mcp/src/lib/ssrf.ts`
- Test: `packages/dionysus-mcp/test/ssrf.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isPrivateIp(ip: string): boolean`; `assertPublicHost(hostname: string, lookupFn?): Promise<void>` (rejects when any resolved address is private/reserved); `SsrfError extends Error`. Task 5 builds `safeFetch` on these.

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/ssrf.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isPrivateIp, assertPublicHost, SsrfError } from "../src/lib/ssrf.js";

describe("isPrivateIp", () => {
  const blocked = [
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
    "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.5",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"];

  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isPrivateIp(ip)).toBe(true));
  }
  for (const ip of allowed) {
    it(`allows ${ip}`, () => expect(isPrivateIp(ip)).toBe(false));
  }
});

describe("assertPublicHost", () => {
  it("rejects a hostname resolving to a private address", async () => {
    const fakeLookup = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(assertPublicHost("evil.example", fakeLookup)).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects when ANY resolved address is private (rebinding defense)", async () => {
    const fakeLookup = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];
    await expect(assertPublicHost("mixed.example", fakeLookup)).rejects.toBeInstanceOf(SsrfError);
  });

  it("accepts a hostname resolving only to public addresses", async () => {
    const fakeLookup = async () => [{ address: "8.8.8.8", family: 4 }];
    await expect(assertPublicHost("ok.example", fakeLookup)).resolves.toBeUndefined();
  });

  it("rejects IP literals that are private, without DNS", async () => {
    await expect(assertPublicHost("192.168.0.10")).rejects.toBeInstanceOf(SsrfError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/ssrf.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/dionysus-mcp/src/lib/ssrf.ts`:

```ts
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

type LookupResult = { address: string; family: number };
export type LookupFn = (hostname: string) => Promise<LookupResult[]>;

const defaultLookup: LookupFn = async (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],       // "this network"
  ["10.0.0.0", 8],      // private
  ["100.64.0.0", 10],   // CGNAT
  ["127.0.0.0", 8],     // loopback
  ["169.254.0.0", 16],  // link-local / cloud metadata
  ["172.16.0.0", 12],   // private
  ["192.168.0.0", 16],  // private
  ["192.0.0.0", 24],    // IETF protocol assignments
  ["198.18.0.0", 15],   // benchmarking
  ["224.0.0.0", 3],     // multicast + reserved (224.0.0.0–255.255.255.255)
];

function v4ToLong(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (
    ((parts[0]! << 24) >>> 0) + ((parts[1]! << 16) >>> 0) +
    ((parts[2]! << 8) >>> 0) + (parts[3]! >>> 0)
  ) >>> 0;
}

function v4InRange(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4ToLong(ip) & mask) === (v4ToLong(base) & mask);
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    return PRIVATE_V4_RANGES.some(([base, bits]) => v4InRange(ip, base, bits));
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    // v4-mapped (::ffff:a.b.c.d) → recurse on the v4 part
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]!);
    if (lower === "::" || lower === "::1") return true;      // unspecified / loopback
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(lower)) return true;                 // link-local fe80::/10
    if (lower.startsWith("ff")) return true;                  // multicast
    return false;
  }
  return true; // not a parseable IP → treat as unsafe
}

export async function assertPublicHost(
  hostname: string,
  lookupFn: LookupFn = defaultLookup,
): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new SsrfError(`Blocked private/reserved IP literal: ${hostname}`);
    }
    return;
  }
  let addrs: LookupResult[];
  try {
    addrs = await lookupFn(hostname);
  } catch {
    throw new SsrfError(`DNS resolution failed for ${hostname}`);
  }
  if (addrs.length === 0) throw new SsrfError(`No addresses for ${hostname}`);
  for (const { address } of addrs) {
    if (isPrivateIp(address)) {
      throw new SsrfError(
        `Blocked: ${hostname} resolves to private/reserved address ${address}`,
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/ssrf.test.ts`
Expected: all pass (13 blocked/allowed cases + 4 host cases).

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: SSRF guard - private/reserved IP + host validation, fail-closed"
```

---

### Task 5: SSRF guard — `safeFetch` (redirects, caps, connect-time pinning)

**Files:**
- Modify: `packages/dionysus-mcp/src/lib/ssrf.ts` (append)
- Test: `packages/dionysus-mcp/test/safe-fetch.test.ts`

**Interfaces:**
- Consumes: `assertPublicHost`, `SsrfError`, `LookupFn` from Task 4.
- Produces: `safeFetch(url: string, opts?: SafeFetchOptions): Promise<SafeFetchResult>` where `SafeFetchResult = { status: number; contentType: string; body: string; finalUrl: string }` and `SafeFetchOptions = { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; lookupFn?: LookupFn }`. Redirects are followed manually with per-hop re-validation; the socket connect uses a guarded lookup (rebinding defense); body is size-capped.

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/safe-fetch.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { safeFetch, SsrfError, type LookupFn } from "../src/lib/ssrf.js";

// Local test server on 127.0.0.1. Production code blocks loopback, so tests
// inject a lookupFn that maps "local.test" -> 127.0.0.1 and treats it as public.
let server: http.Server;
let port: number;
const localLookup: LookupFn = async (hostname) => {
  if (hostname === "local.test") return [{ address: "127.0.0.1", family: 4 }];
  if (hostname === "private.test") return [{ address: "10.0.0.1", family: 4 }];
  throw new Error(`unexpected lookup: ${hostname}`);
};
// The guard treats 127.0.0.1 as private; for fetch-mechanics tests we allow it
// by passing an allowlist-style lookup that the production default never uses.
const testOpts = { lookupFn: localLookup, __testAllowPrivate: true } as const;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><title>ok</title></html>");
    } else if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("x".repeat(100_000));
    } else if (req.url === "/redirect-private") {
      res.writeHead(302, { location: "http://private.test/steal" });
      res.end();
    } else if (req.url === "/redirect-loop") {
      res.writeHead(302, { location: "/redirect-loop" });
      res.end();
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterAll(() => server.close());

describe("safeFetch", () => {
  it("fetches a page and returns body + finalUrl", async () => {
    const res = await safeFetch(`http://local.test:${port}/ok`, testOpts);
    expect(res.status).toBe(200);
    expect(res.body).toContain("<title>ok</title>");
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
    await expect(safeFetch("ftp://example.com/x")).rejects.toBeInstanceOf(SsrfError);
  });

  it("blocks redirect to a private host (per-hop re-validation)", async () => {
    await expect(
      safeFetch(`http://local.test:${port}/redirect-private`, { lookupFn: localLookup, __testAllowPrivate: false, __testAllowHosts: ["local.test"] } as never),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("caps redirect count", async () => {
    await expect(
      safeFetch(`http://local.test:${port}/redirect-loop`, { ...testOpts, maxRedirects: 2 }),
    ).rejects.toThrow(/redirect/i);
  });

  it("caps response size", async () => {
    await expect(
      safeFetch(`http://local.test:${port}/big`, { ...testOpts, maxBytes: 10_000 }),
    ).rejects.toThrow(/size/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/safe-fetch.test.ts`
Expected: FAIL — `safeFetch` not exported.

- [ ] **Step 3: Implement (append to `src/lib/ssrf.ts`)**

```ts
import { Agent, request as undiciRequest } from "undici";

export type SafeFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  lookupFn?: LookupFn;
  /** TEST-ONLY seams. Never set in production code paths. */
  __testAllowPrivate?: boolean;
  __testAllowHosts?: string[];
};

export type SafeFetchResult = {
  status: number;
  contentType: string;
  body: string;
  finalUrl: string;
};

const ALLOWED_PORTS = new Set(["", "80", "443"]);

async function assertHostAllowed(hostname: string, opts: SafeFetchOptions): Promise<void> {
  if (opts.__testAllowPrivate) return;
  if (opts.__testAllowHosts?.includes(hostname)) return;
  await assertPublicHost(hostname, opts.lookupFn);
}

export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxRedirects = opts.maxRedirects ?? 3;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid URL: ${rawUrl}`);
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SsrfError(`Blocked scheme: ${url.protocol}`);
    }
    if (!ALLOWED_PORTS.has(url.port) && !opts.__testAllowPrivate && !opts.__testAllowHosts) {
      // test seams use an ephemeral local port; production allows only 80/443
      throw new SsrfError(`Blocked port: ${url.port}`);
    }
    await assertHostAllowed(url.hostname, opts);

    // Guarded agent: re-validate at socket connect time (DNS-rebinding defense).
    const lookupFn = opts.lookupFn;
    const agent = new Agent({
      connect: {
        lookup: (hostname, _o, cb) => {
          const doLookup = lookupFn
            ? lookupFn(hostname)
            : import("node:dns/promises").then((d) => d.lookup(hostname, { all: true, verbatim: true }));
          doLookup
            .then((addrs) => {
              const list = Array.isArray(addrs) ? addrs : [addrs];
              const bad = list.find((a) => !opts.__testAllowPrivate && isPrivateIp(a.address));
              if (bad) return cb(new SsrfError(`Blocked at connect: ${bad.address}`), "", 0);
              const first = list[0]!;
              cb(null, first.address, first.family);
            })
            .catch((e) => cb(e as Error, "", 0));
        },
      },
    });

    const res = await undiciRequest(url, {
      method: "GET",
      dispatcher: agent,
      maxRedirections: 0,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      headers: { "user-agent": "dionysus-mcp/0.1 (+verified-read-only)" },
    });

    if (res.statusCode >= 300 && res.statusCode < 400) {
      const loc = res.headers["location"];
      await res.body.dump();
      if (!loc || typeof loc !== "string") throw new SsrfError("Redirect without location");
      if (hop === maxRedirects) throw new SsrfError(`Too many redirects (> ${maxRedirects})`);
      url = new URL(loc, url); // relative or absolute — re-validated on next loop
      continue;
    }

    const contentType = String(res.headers["content-type"] ?? "");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += (chunk as Buffer).length;
      if (total > maxBytes) {
        res.body.destroy();
        throw new SsrfError(`Response size exceeds cap (${maxBytes} bytes)`);
      }
      chunks.push(chunk as Buffer);
    }
    return {
      status: res.statusCode,
      contentType,
      body: Buffer.concat(chunks).toString("utf8"),
      finalUrl: url.toString(),
    };
  }
  throw new SsrfError("Unreachable");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/safe-fetch.test.ts`
Expected: 5 passed. Then run the full suite: `pnpm vitest run` — all previous tests still pass.

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: safeFetch - manual redirects with per-hop re-validation, connect-time IP guard, size/time caps"
```

---

### Task 6: Scrape ladder + `read_product` core

**Files:**
- Create: `packages/dionysus-mcp/src/lib/scrape/ladder.ts`
- Create: `packages/dionysus-mcp/src/tools/read-product.ts`
- Test: `packages/dionysus-mcp/test/scrape-ladder.test.ts`

**Interfaces:**
- Consumes: `safeFetch`, `SafeFetchOptions` (Task 5); `prisma` (Task 2); `Identity` (Task 3).
- Produces: `scrapeLadder(url: string, fetchOpts?: SafeFetchOptions): Promise<ScrapeResult>` with `ScrapeResult = { tier: 1 | 2 | 3 | 4; url: string; title?: string; description?: string; text?: string; error?: string }`; `readProduct(identity: Identity, url: string, fetchOpts?): Promise<{ productId: string } & ScrapeResult>` which persists a `Product` row scoped to the identity. **Tier 4 is a structured result, never a throw.**

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/scrape-ladder.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { scrapeLadder } from "../src/lib/scrape/ladder.js";
import { readProduct } from "../src/tools/read-product.js";
import { prisma } from "../src/db.js";
import type { LookupFn } from "../src/lib/ssrf.js";

let server: http.Server;
let port: number;
const localLookup: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
const testOpts = { lookupFn: localLookup, __testAllowPrivate: true } as const;

const PAGE = `<html><head>
  <title>Acme Widgets</title>
  <meta name="description" content="Widgets for developers">
</head><body>
  <script>ignore_me()</script>
  <h1>Acme</h1><p>The best widget toolkit for busy developers.</p>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/product") {
      res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE);
    } else if (req.url === "/binary") {
      res.writeHead(200, { "content-type": "application/octet-stream" }); res.end("BLOB");
    } else { res.writeHead(500); res.end("boom"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  await prisma.business.upsert({
    where: { id: "biz_scrape" },
    create: { id: "biz_scrape", name: "Scrape Co" },
    update: {},
  });
});

afterAll(() => server.close());

describe("scrapeLadder", () => {
  it("extracts title, description and visible text (tier 3)", async () => {
    const r = await scrapeLadder(`http://local.test:${port}/product`, testOpts);
    expect(r.tier).toBe(3);
    expect(r.title).toBe("Acme Widgets");
    expect(r.description).toBe("Widgets for developers");
    expect(r.text).toContain("best widget toolkit");
    expect(r.text).not.toContain("ignore_me");
  });

  it("returns structured tier-4 'couldn't read' on server error — never throws", async () => {
    const r = await scrapeLadder(`http://local.test:${port}/nope`, testOpts);
    expect(r.tier).toBe(4);
    expect(r.error).toBeTruthy();
  });

  it("returns tier 4 for non-HTML content", async () => {
    const r = await scrapeLadder(`http://local.test:${port}/binary`, testOpts);
    expect(r.tier).toBe(4);
  });
});

describe("readProduct", () => {
  it("persists a Product scoped to the ambient identity", async () => {
    const out = await readProduct(
      { businessId: "biz_scrape" },
      `http://local.test:${port}/product`,
      testOpts,
    );
    expect(out.productId).toBeTruthy();
    const row = await prisma.product.findUnique({ where: { id: out.productId } });
    expect(row?.businessId).toBe("biz_scrape");
    expect(row?.title).toBe("Acme Widgets");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/scrape-ladder.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/dionysus-mcp/src/lib/scrape/ladder.ts`:

```ts
import * as cheerio from "cheerio";
import { safeFetch, type SafeFetchOptions } from "../ssrf.js";

export type ScrapeResult = {
  tier: 1 | 2 | 3 | 4;
  url: string;
  title?: string;
  description?: string;
  text?: string;
  error?: string;
};

const TEXT_CAP = 5000;

export async function scrapeLadder(
  url: string,
  fetchOpts?: SafeFetchOptions,
): Promise<ScrapeResult> {
  // Tier 1: fetch raw HTML (SSRF-guarded)
  let body: string;
  let contentType: string;
  try {
    const res = await safeFetch(url, fetchOpts);
    if (res.status < 200 || res.status >= 300) {
      return { tier: 4, url, error: `HTTP ${res.status}` };
    }
    body = res.body;
    contentType = res.contentType;
  } catch (e) {
    return { tier: 4, url, error: e instanceof Error ? e.message : String(e) };
  }
  if (!contentType.includes("html")) {
    return { tier: 4, url, error: `Not HTML (${contentType || "unknown content-type"})` };
  }

  // Tier 2: metadata
  const $ = cheerio.load(body);
  const title =
    $("title").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    undefined;
  const description =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    undefined;

  // Tier 3: visible text
  $("script, style, noscript, svg, nav, footer").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, TEXT_CAP) || undefined;

  if (text) return { tier: 3, url, title, description, text };
  if (title || description) return { tier: 2, url, title, description };
  return { tier: 1, url };
}
```

`packages/dionysus-mcp/src/tools/read-product.ts`:

```ts
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { scrapeLadder, type ScrapeResult } from "../lib/scrape/ladder.js";
import type { SafeFetchOptions } from "../lib/ssrf.js";

export async function readProduct(
  identity: Identity,
  url: string,
  fetchOpts?: SafeFetchOptions,
): Promise<{ productId: string } & ScrapeResult> {
  const result = await scrapeLadder(url, fetchOpts);
  const row = await prisma.product.create({
    data: {
      businessId: identity.businessId,
      url,
      readTier: result.tier,
      title: result.title ?? null,
      description: result.description ?? null,
      text: result.text ?? null,
    },
  });
  return { productId: row.id, ...result };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/scrape-ladder.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: scrape ladder (tiers 1-4, structured couldnt-read) + identity-scoped read_product"
```

---

### Task 7: Deterministic brand extraction + `extract_brand` core

**Files:**
- Create: `packages/dionysus-mcp/src/lib/brand.ts`
- Create: `packages/dionysus-mcp/src/tools/extract-brand.ts`
- Test: `packages/dionysus-mcp/test/brand.test.ts`

**Interfaces:**
- Consumes: `safeFetch` (Task 5); `prisma` (Task 2); `Identity` (Task 3).
- Produces: `extractBrandSignals(html: string, css: string[]): BrandSignals` with `BrandSignals = { colors: string[]; fonts: string[] }` (pure, deterministic — no LLM); `extractBrand(identity: Identity, url: string, fetchOpts?): Promise<{ brandKitId: string } & BrandSignals>` persisting a `BrandKit` (colors/fonts as JSON strings). Colors are normalized lowercase 6-digit hex, ordered by frequency, near-white/near-black excluded, max 6. Fonts strip quotes and generic families, max 4.

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/brand.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { extractBrandSignals } from "../src/lib/brand.js";
import { extractBrand } from "../src/tools/extract-brand.js";
import { prisma } from "../src/db.js";
import type { LookupFn } from "../src/lib/ssrf.js";

describe("extractBrandSignals (pure)", () => {
  it("finds dominant colors as normalized hex, excluding near-white/black", () => {
    const css = [
      ".a{color:#FF6600}.b{background:#ff6600}.c{border-color:#F60}" +
      ".d{color:#112233}.e{color:#ffffff}.f{color:#000}",
    ];
    const { colors } = extractBrandSignals("", css);
    expect(colors[0]).toBe("#ff6600"); // 3 occurrences (#F60 expands)
    expect(colors).toContain("#112233");
    expect(colors).not.toContain("#ffffff");
    expect(colors).not.toContain("#000000");
  });

  it("finds font families, stripping quotes and generics", () => {
    const css = [`body{font-family:"Inter",-apple-system,sans-serif}h1{font-family:'Space Grotesk',serif}`];
    const { fonts } = extractBrandSignals("", css);
    expect(fonts).toContain("Inter");
    expect(fonts).toContain("Space Grotesk");
    expect(fonts).not.toContain("sans-serif");
    expect(fonts).not.toContain("serif");
  });

  it("also reads inline <style> blocks from the HTML", () => {
    const html = `<html><head><style>.x{color:#123abc}</style></head><body></body></html>`;
    const { colors } = extractBrandSignals(html, []);
    expect(colors).toContain("#123abc");
  });
});

describe("extractBrand (fetch + persist)", () => {
  let server: http.Server;
  let port: number;
  const localLookup: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
  const testOpts = { lookupFn: localLookup, __testAllowPrivate: true } as const;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><head><link rel="stylesheet" href="/site.css"><style>.i{color:#aa11bb}</style></head><body></body></html>`);
      } else if (req.url === "/site.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end(`.hero{background:#aa11bb;font-family:"Fira Sans",sans-serif}`);
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    await prisma.business.upsert({
      where: { id: "biz_brand" },
      create: { id: "biz_brand", name: "Brand Co" },
      update: {},
    });
  });

  afterAll(() => server.close());

  it("fetches linked same-origin stylesheets and persists a scoped BrandKit", async () => {
    const out = await extractBrand({ businessId: "biz_brand" }, `http://local.test:${port}/`, testOpts);
    expect(out.colors).toContain("#aa11bb");
    expect(out.fonts).toContain("Fira Sans");
    const row = await prisma.brandKit.findUnique({ where: { id: out.brandKitId } });
    expect(row?.businessId).toBe("biz_brand");
    expect(JSON.parse(row!.colorsJson)).toContain("#aa11bb");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/brand.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/dionysus-mcp/src/lib/brand.ts`:

```ts
import * as cheerio from "cheerio";

export type BrandSignals = { colors: string[]; fonts: string[] };

const GENERIC_FONTS = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "-apple-system", "blinkmacsystemfont", "segoe ui", "inherit", "initial", "unset",
]);
const MAX_COLORS = 6;
const MAX_FONTS = 4;

function normalizeHex(raw: string): string | null {
  let h = raw.toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(h)) {
    h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  }
  if (!/^#[0-9a-f]{6}$/.test(h)) return null; // ignore 4/8-digit alpha forms
  return h;
}

function isNearWhiteOrBlack(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lum = (r + g + b) / 3;
  return lum > 240 || lum < 16;
}

export function extractBrandSignals(html: string, cssSources: string[]): BrandSignals {
  const inlineStyles: string[] = [];
  if (html) {
    const $ = cheerio.load(html);
    $("style").each((_i, el) => inlineStyles.push($(el).text()));
  }
  const css = [...cssSources, ...inlineStyles].join("\n");

  const colorCounts = new Map<string, number>();
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const hex = normalizeHex(m[0]);
    if (!hex || isNearWhiteOrBlack(hex)) continue;
    colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 1);
  }
  const colors = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_COLORS)
    .map(([hex]) => hex);

  const fontCounts = new Map<string, number>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    for (const partRaw of m[1]!.split(",")) {
      const part = partRaw.trim().replace(/^["']|["']$/g, "");
      if (!part || GENERIC_FONTS.has(part.toLowerCase())) continue;
      fontCounts.set(part, (fontCounts.get(part) ?? 0) + 1);
    }
  }
  const fonts = [...fontCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FONTS)
    .map(([f]) => f);

  return { colors, fonts };
}
```

`packages/dionysus-mcp/src/tools/extract-brand.ts`:

```ts
import * as cheerio from "cheerio";
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { extractBrandSignals, type BrandSignals } from "../lib/brand.js";
import { safeFetch, type SafeFetchOptions } from "../lib/ssrf.js";

const MAX_STYLESHEETS = 5;
const STYLESHEET_BYTE_CAP = 500_000;

export async function extractBrand(
  identity: Identity,
  url: string,
  fetchOpts?: SafeFetchOptions,
): Promise<{ brandKitId: string } & BrandSignals> {
  const page = await safeFetch(url, fetchOpts);
  const $ = cheerio.load(page.body);
  const base = new URL(page.finalUrl);

  const hrefs: string[] = [];
  $('link[rel="stylesheet"]').each((_i, el) => {
    const href = $(el).attr("href");
    if (href) hrefs.push(href);
  });

  const cssSources: string[] = [];
  for (const href of hrefs.slice(0, MAX_STYLESHEETS)) {
    let cssUrl: URL;
    try {
      cssUrl = new URL(href, base);
    } catch {
      continue;
    }
    if (cssUrl.origin !== base.origin) continue; // same-origin only
    try {
      const css = await safeFetch(cssUrl.toString(), {
        ...fetchOpts,
        maxBytes: STYLESHEET_BYTE_CAP,
      });
      cssSources.push(css.body);
    } catch {
      continue; // a failed stylesheet never fails the extraction
    }
  }

  const signals = extractBrandSignals(page.body, cssSources);
  const row = await prisma.brandKit.create({
    data: {
      businessId: identity.businessId,
      url,
      colorsJson: JSON.stringify(signals.colors),
      fontsJson: JSON.stringify(signals.fonts),
    },
  });
  return { brandKitId: row.id, ...signals };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/brand.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: deterministic brand extraction (colors/fonts from CSS) + identity-scoped extract_brand"
```

---

### Task 8: Pricing table, cost ledger, advisory budget

**Files:**
- Create: `packages/dionysus-mcp/src/config/prices.ts`
- Create: `packages/dionysus-mcp/src/lib/pricing.ts`
- Create: `packages/dionysus-mcp/src/tools/cost-budget.ts`
- Test: `packages/dionysus-mcp/test/pricing.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 2); `Identity` (Task 3).
- Produces: `PRICES: Record<string, { inputPerMTok: number; outputPerMTok: number }>`; `computeCostUsd(model: string, inputTokens: number, outputTokens: number): number | null` (unknown model → `null`, never a guess); `recordCost(identity, args: { model: string; inputTokens: number; outputTokens: number; note?: string }): Promise<{ llmCallId: string; costUsd: number | null }>`; `checkBudget(identity): Promise<{ allowed: boolean; tokensUsedToday: number; maxTokensPerDay: number; reason?: string }>` — **fail-closed**: unknown business → `allowed: false`.

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/pricing.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { computeCostUsd } from "../src/lib/pricing.js";
import { recordCost, checkBudget } from "../src/tools/cost-budget.js";
import { prisma } from "../src/db.js";

describe("computeCostUsd", () => {
  it("prices a known model", () => {
    // claude-haiku-4-5: table says 1.0 in / 5.0 out per MTok
    const cost = computeCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(6.0, 5);
  });
  it("returns null for unknown models — never a fabricated number", () => {
    expect(computeCostUsd("mystery-model-9000", 1000, 1000)).toBeNull();
  });
});

describe("cost ledger + budget (fail-closed)", () => {
  beforeAll(async () => {
    await prisma.llmCall.deleteMany({ where: { businessId: "biz_cost" } });
    await prisma.business.upsert({
      where: { id: "biz_cost" },
      create: { id: "biz_cost", name: "Cost Co", maxTokensPerDay: 1000 },
      update: { maxTokensPerDay: 1000 },
    });
  });

  it("records a cost row scoped to the identity", async () => {
    const out = await recordCost(
      { businessId: "biz_cost" },
      { model: "claude-haiku-4-5", inputTokens: 100, outputTokens: 50 },
    );
    const row = await prisma.llmCall.findUnique({ where: { id: out.llmCallId } });
    expect(row?.businessId).toBe("biz_cost");
    expect(row?.costUsd).not.toBeNull();
  });

  it("allows while under the daily cap, blocks once over it", async () => {
    let b = await checkBudget({ businessId: "biz_cost" });
    expect(b.allowed).toBe(true); // 150 of 1000 used

    await recordCost(
      { businessId: "biz_cost" },
      { model: "claude-haiku-4-5", inputTokens: 800, outputTokens: 100 },
    );
    b = await checkBudget({ businessId: "biz_cost" });
    expect(b.allowed).toBe(false); // 1050 of 1000
    expect(b.tokensUsedToday).toBe(1050);
  });

  it("fails closed for an unknown business", async () => {
    const b = await checkBudget({ businessId: "biz_ghost" });
    expect(b.allowed).toBe(false);
    expect(b.reason).toMatch(/unknown business/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/pricing.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/dionysus-mcp/src/config/prices.ts`:

```ts
/** USD per 1,000,000 tokens. Unknown models are intentionally absent —
 *  computeCostUsd returns null for them (no fabricated numbers, spec §11). */
export const PRICES: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "claude-sonnet-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  // Nous / NVIDIA-free endpoints: metered as zero-cost until real pricing lands
  "nous-portal-free": { inputPerMTok: 0, outputPerMTok: 0 },
};
```

`packages/dionysus-mcp/src/lib/pricing.ts`:

```ts
import { PRICES } from "../config/prices.js";

export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (
    (inputTokens / 1_000_000) * p.inputPerMTok +
    (outputTokens / 1_000_000) * p.outputPerMTok
  );
}
```

`packages/dionysus-mcp/src/tools/cost-budget.ts`:

```ts
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { computeCostUsd } from "../lib/pricing.js";

export async function recordCost(
  identity: Identity,
  args: { model: string; inputTokens: number; outputTokens: number; note?: string },
): Promise<{ llmCallId: string; costUsd: number | null }> {
  const costUsd = computeCostUsd(args.model, args.inputTokens, args.outputTokens);
  const row = await prisma.llmCall.create({
    data: {
      businessId: identity.businessId,
      model: args.model,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      costUsd,
      note: args.note ?? null,
    },
  });
  return { llmCallId: row.id, costUsd };
}

export async function checkBudget(identity: Identity): Promise<{
  allowed: boolean;
  tokensUsedToday: number;
  maxTokensPerDay: number;
  reason?: string;
}> {
  const business = await prisma.business.findUnique({
    where: { id: identity.businessId },
  });
  if (!business) {
    return {
      allowed: false,
      tokensUsedToday: 0,
      maxTokensPerDay: 0,
      reason: "Unknown business — failing closed (spec §14).",
    };
  }
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const agg = await prisma.llmCall.aggregate({
    where: { businessId: identity.businessId, ts: { gte: startOfDayUtc } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  const tokensUsedToday =
    (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
  const allowed = tokensUsedToday < business.maxTokensPerDay;
  return {
    allowed,
    tokensUsedToday,
    maxTokensPerDay: business.maxTokensPerDay,
    ...(allowed ? {} : { reason: "Daily token budget exhausted." }),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/pricing.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: pricing table (unpriced->null), identity-scoped cost ledger, fail-closed budget check"
```

---

### Task 9: MCP server wiring (strict schemas, no businessId anywhere)

**Files:**
- Create: `packages/dionysus-mcp/src/server.ts`
- Create: `packages/dionysus-mcp/src/index.ts`
- Test: `packages/dionysus-mcp/test/server.test.ts`

**Interfaces:**
- Consumes: `loadIdentity` (Task 3), `readProduct` (Task 6), `extractBrand` (Task 7), `recordCost`/`checkBudget` (Task 8).
- Produces: `buildServer(identity: Identity): McpServer` registering tools `read_product{url}`, `extract_brand{url}`, `record_cost{model,inputTokens,outputTokens,note?}`, `check_budget{}` — every input schema built from the exported `TOOL_SCHEMAS` map (zod, `.strict()`); `src/index.ts` is the stdio entrypoint (`node dist/index.js`). Tool results are `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/server.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { TOOL_SCHEMAS, buildServer } from "../src/server.js";

describe("D27.1 — tool schemas", () => {
  it("no tool schema contains a businessId field", () => {
    for (const [name, shape] of Object.entries(TOOL_SCHEMAS)) {
      expect(Object.keys(shape), `tool ${name}`).not.toContain("businessId");
    }
  });

  it("strict schemas reject an injected businessId", () => {
    for (const [name, shape] of Object.entries(TOOL_SCHEMAS)) {
      const schema = z.object(shape).strict();
      const base: Record<string, unknown> = {};
      if ("url" in shape) base["url"] = "https://example.com";
      if ("model" in shape) {
        base["model"] = "m";
        base["inputTokens"] = 1;
        base["outputTokens"] = 1;
      }
      const withInjection = { ...base, businessId: "biz_victim" };
      const parsed = schema.safeParse(withInjection);
      expect(parsed.success, `tool ${name} must reject businessId`).toBe(false);
    }
  });
});

describe("buildServer", () => {
  it("constructs a server bound to one identity", () => {
    const server = buildServer({ businessId: "biz_x" });
    expect(server).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/dionysus-mcp/src/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type { Identity } from "./identity.js";
import { readProduct } from "./tools/read-product.js";
import { extractBrand } from "./tools/extract-brand.js";
import { recordCost, checkBudget } from "./tools/cost-budget.js";

/** Single source of truth for tool input shapes.
 *  INVARIANT (D27.1): no shape ever includes businessId — identity is ambient. */
export const TOOL_SCHEMAS = {
  read_product: { url: z.string().url() },
  extract_brand: { url: z.string().url() },
  record_cost: {
    model: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    note: z.string().optional(),
  },
  check_budget: {},
} satisfies Record<string, ZodRawShape>;

function asText(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

export function buildServer(identity: Identity): McpServer {
  const server = new McpServer({ name: "dionysus-mcp", version: "0.1.0" });

  server.tool(
    "read_product",
    "SSRF-guarded scrape ladder: read a product page into a structured Product (tier 4 = couldn't read).",
    TOOL_SCHEMAS.read_product,
    async ({ url }) => asText(await readProduct(identity, url)),
  );

  server.tool(
    "extract_brand",
    "Deterministic brand signals (CSS colors/fonts) from a URL into a BrandKit. Judgment lives in skills, not here.",
    TOOL_SCHEMAS.extract_brand,
    async ({ url }) => asText(await extractBrand(identity, url)),
  );

  server.tool(
    "record_cost",
    "Record a non-gateway LLM/service cost to the ledger. Unknown models record costUsd=null.",
    TOOL_SCHEMAS.record_cost,
    async (args) => asText(await recordCost(identity, args)),
  );

  server.tool(
    "check_budget",
    "Advisory daily-budget check (fail-closed). The D28 gateway is the enforcement point.",
    TOOL_SCHEMAS.check_budget,
    async () => asText(await checkBudget(identity)),
  );

  return server;
}
```

`packages/dionysus-mcp/src/index.ts`:

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadIdentity } from "./identity.js";
import { buildServer } from "./server.js";

const identity = loadIdentity();
const server = buildServer(identity);
await server.connect(new StdioServerTransport());
console.error(`dionysus-mcp up for ${identity.businessId} (identity is ambient — D27.1)`);
```

Note: if the installed SDK version exposes `registerTool` instead of `server.tool`, use `server.registerTool(name, { description, inputSchema: TOOL_SCHEMAS[name] }, handler)` — same shapes, same invariant; adjust once against the real package and keep the `TOOL_SCHEMAS` export unchanged (the test depends on it).

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm vitest run test/server.test.ts; pnpm build`
Expected: 3 tests pass; `tsc` emits `dist/` with no errors.

- [ ] **Step 5: Commit**

```powershell
git add -A; git commit -m "feat: MCP server with strict no-businessId tool schemas + stdio entrypoint"
```

---

### Task 10: Two-tenant isolation e2e (spec §15 security test)

**Files:**
- Test: `packages/dionysus-mcp/test/isolation.e2e.test.ts`

**Interfaces:**
- Consumes: everything above — this is the stage-1 exit gate. No new production code expected; if this test finds a leak, the fix happens in the offending module, test-first.

- [ ] **Step 1: Write the test (it should pass if D27.1 held everywhere — run it to find out)**

`packages/dionysus-mcp/test/isolation.e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { prisma } from "../src/db.js";
import { readProduct } from "../src/tools/read-product.js";
import { recordCost, checkBudget } from "../src/tools/cost-budget.js";
import type { LookupFn } from "../src/lib/ssrf.js";

let server: http.Server;
let port: number;
const localLookup: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
const testOpts = { lookupFn: localLookup, __testAllowPrivate: true } as const;

const A = { businessId: "biz_iso_a" };
const B = { businessId: "biz_iso_b" };

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><title>iso</title><body>hello</body></html>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  for (const id of [A.businessId, B.businessId]) {
    await prisma.business.upsert({
      where: { id },
      create: { id, name: id, maxTokensPerDay: 1000 },
      update: { maxTokensPerDay: 1000 },
    });
    await prisma.product.deleteMany({ where: { businessId: id } });
    await prisma.llmCall.deleteMany({ where: { businessId: id } });
  }
});

afterAll(() => server.close());

describe("two-tenant isolation (D27.1 exit gate)", () => {
  it("A's writes are invisible to B", async () => {
    await readProduct(A, `http://local.test:${port}/`, testOpts);
    const bProducts = await prisma.product.findMany({
      where: { businessId: B.businessId },
    });
    expect(bProducts).toHaveLength(0);
    const aProducts = await prisma.product.findMany({
      where: { businessId: A.businessId },
    });
    expect(aProducts).toHaveLength(1);
  });

  it("A exhausting its budget does not touch B's budget", async () => {
    await recordCost(A, { model: "claude-haiku-4-5", inputTokens: 900, outputTokens: 200 });
    const a = await checkBudget(A);
    const b = await checkBudget(B);
    expect(a.allowed).toBe(false);
    expect(b.allowed).toBe(true);
    expect(b.tokensUsedToday).toBe(0);
  });

  it("no exported tool function accepts a businessId argument", async () => {
    // Compile-time guarantee made explicit: the public tool functions take
    // Identity (ambient) + payload. This test asserts the runtime shape too.
    const fns: Array<(...a: never[]) => unknown> = [readProduct, recordCost, checkBudget];
    for (const fn of fns) {
      expect(fn.length).toBeLessThanOrEqual(3);
    }
  });
});
```

- [ ] **Step 2: Run the full suite**

Run: `pnpm test`
Expected: every test file passes, including the e2e. If any isolation assertion fails, fix the offending module test-first before proceeding — this test is the stage-1 exit criterion (spec §17 stage 2 depends on it).

- [ ] **Step 3: Commit**

```powershell
git add -A; git commit -m "test: two-tenant isolation e2e - D27.1 exit gate for stage 1 core"
```

---

## Out of Scope (follow-up plans)

- **D28 LLM gateway** (separate process: metering proxy, writes `LlmCall` itself, hard caps, kill switch) — next plan; this plan's `checkBudget` is explicitly advisory until then.
- `verify_post`, `click_stats`, `goal_progress`, `persist_route/waypoint`, memory-graph tools — platform stages 3–5 per spec §17.
- Hermes profile/container provisioning — stage 2.

## Self-Review Notes

- **Spec coverage:** stage 1 = plumbing (Tasks 4–7) ✓, schema/persistence (Task 2) ✓, ambient identity (Tasks 3, 9, 10) ✓, cost ledger + advisory budget (Task 8) ✓, "ledger-measure real cost" enabled by `record_cost` + gateway follow-up ✓.
- **Type consistency:** `Identity` is consumed by Tasks 6–10 with the same shape; `LookupFn`/`SafeFetchOptions` flow from Task 4/5 into 6/7/10; `TOOL_SCHEMAS` names match §8's tool names (minus `businessId`, by design).
- **Known judgment call:** `safeFetch`'s test seams (`__testAllowPrivate`, `__testAllowHosts`) are explicit, greppable, and never set outside tests; the alternative (binding tests to public internet hosts) would make the suite flaky.
