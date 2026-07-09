# Stage 4a — Cockpit Foundation (Magic-Link Auth + Draft Review) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the D29 approval lifecycle its human: a Next.js cockpit with hardened magic-link auth (H3: single-use, short-TTL) and a draft-review view where the founder approves/rejects proposed drafts — the first real caller of `approveAction`/`rejectAction`.

**Architecture:** New workspace package `packages/cockpit` (Next.js 15 App Router). All logic lives in a vitest-testable service layer (`src/lib`); route handlers, server actions, and pages are thin wrappers. The cockpit reads authoritative state from Prisma via `dionysus-mcp/db` and calls the stage-3c lifecycle functions with an `Identity` built from the authenticated session (never from env — the agent tier's `DIONYSUS_BUSINESS_ID` is not used here). One additive schema change in dionysus-mcp: a `MagicLink` model + `Business.ownerEmail`.

**Tech Stack:** Next.js ^15 (App Router, server components + server actions), React ^19, TypeScript strict, node:crypto (HMAC session cookie, sha256 token hashing), Prisma via `dionysus-mcp/db`, vitest. NO new auth libraries (H3's needs are 40 lines of crypto), NO CSS framework (minimal inline styles), NO Playwright at 4a (see Global Constraints — testing judgment call).

## Global Constraints

- **Stage-4 decomposition (on record):** stage 4 (§17 item 4) splits into sub-stages; 4a = cockpit foundation (this plan). Digest/edit-distance (D22), simulator pre-flight, verified send + outcome-poller, radar-lite, home-screen/CMO report, Stripe are LATER sub-stages — do not build any of them here (YAGNI).
- **H3 (spec, security addendum):** magic links are **single-use** (atomic redemption — reuse the stage-3c guarded-updateMany pattern), **short-TTL** (15 min), origin-bound at issue; the raw token is never stored (sha256 hash only). Step-up auth/MFA is deferred (no high-stakes acts exist at 4a — approving a draft is the normal act; OAuth-connect/launch come later).
- **D29:** the cockpit is THE approval path. Approve/reject go through `approveAction`/`rejectAction` from `dionysus-mcp/tools/lifecycle` — never raw Prisma status writes in cockpit code. `principal` = the session email.
- **D27.1 adapted for the cockpit tier:** identity = `{ businessId }` from the **verified session cookie** (session→business binding = H1 semantics as ordinary web-app auth, per D34's dissolution note). No businessId ever comes from a URL param, form field, or query string. The `Identity` TYPE is imported from `dionysus-mcp/identity`; `loadIdentity()` (env-based) is NOT used in cockpit.
- **Session cookie:** HMAC-SHA256-signed payload `{businessId, email, exp}`, httpOnly, sameSite=lax, 7-day TTL. Secret from `COCKPIT_SESSION_SECRET` env — **fail-closed**: missing secret throws, never falls back to a default. Signature compare via `timingSafeEqual`.
- **CSRF:** Next.js server actions enforce same-origin (Origin/Host check) natively; the auth route is a GET that only redeems a single-use token (idempotent-safe: second redemption fails). No extra CSRF machinery at 4a — recorded as a conscious judgment.
- **Testing judgment call (recorded):** all auth/review/approve logic is exercised by vitest through the service layer + route-handler functions invoked directly (Request→Response). `next build` is the wiring gate. Browser e2e (Playwright) is DEFERRED to the stage-4 checkpoint sub-stage when the full loop closes — this machine's constraint (heavy browser download, Windows flakiness) is not worth it for thin-wrapper coverage at 4a.
- **Pages that read the DB must set `export const dynamic = "force-dynamic"`** — `next build` must never prerender against the database.
- **Testing:** TDD; shared test DB (`$env:DATABASE_URL = "file:./.tmp/test.db"` resolves against the dionysus-mcp prisma/ schema dir); dionysus-mcp must be BUILT before cockpit tests/build. Baselines: mcp 120, dept 40 — both stay green. Tenant-scoped cleanup.
- **Commits:** conventional, no attribution footer. **Shell:** Windows/PowerShell (Git Bash broken); pnpm 9.15 workspace.

## File Structure

```
packages/dionysus-mcp/
  prisma/schema.prisma            # + MagicLink model; + Business.ownerEmail String?
  test/magic-link-schema.test.ts  # Task 1 schema test
packages/cockpit/
  package.json                    # next/react/react-dom + dionysus-mcp workspace:* + vitest
  tsconfig.json
  next.config.mjs                 # serverExternalPackages: dionysus-mcp + @prisma/client
  vitest.config.ts
  src/lib/session.ts              # createSessionToken / verifySessionToken (HMAC, fail-closed)
  src/lib/magic-link.ts           # issueMagicLink / verifyMagicLink (single-use atomic)
  src/lib/auth.ts                 # SESSION_COOKIE, sessionSecret(), requireSession()
  src/lib/review.ts               # listProposedDrafts / getRouteOverview (identity-scoped reads)
  src/app/layout.tsx
  src/app/login/page.tsx          # static "ask for a login link" page
  src/app/auth/[token]/route.ts   # GET: redeem link -> set cookie -> redirect /
  src/app/page.tsx                # route overview (objective -> waypoints -> actions)
  src/app/drafts/page.tsx         # draft-review: asset content + approve/reject
  src/app/actions.ts              # server actions approveDraft/rejectDraft (thin)
  scripts/issue-login-link.mjs    # hand-provisioning CLI (design partners, spec §0)
  test/session.test.ts
  test/magic-link.test.ts
  test/review.test.ts
  test/auth-route.test.ts
  test/cockpit-eval.e2e.test.ts   # Task 6 §15 gate (service-stack integration)
```

---

### Task 1: `MagicLink` model + `Business.ownerEmail` (dionysus-mcp, additive)

**Files:**
- Modify: `packages/dionysus-mcp/prisma/schema.prisma`
- Test: `packages/dionysus-mcp/test/magic-link-schema.test.ts`

**Interfaces:**
- Produces: Prisma model `MagicLink { id, businessId, email, tokenHash @unique, expiresAt, usedAt?, createdAt }` + `Business.ownerEmail String?` + back-relation `Business.magicLinks MagicLink[]`. Tasks 3/6 consume via `prisma.magicLink`.

- [ ] **Step 1: Write the failing test**

`packages/dionysus-mcp/test/magic-link-schema.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";

const BIZ = "biz_maglink";

describe("MagicLink schema", () => {
  beforeAll(async () => {
    await prisma.magicLink.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ },
      create: { id: BIZ, name: "ML Co", ownerEmail: "founder@example.com" },
      update: { ownerEmail: "founder@example.com" } });
  });

  it("persists a link with a unique token hash and null usedAt", async () => {
    const link = await prisma.magicLink.create({ data: {
      businessId: BIZ, email: "founder@example.com",
      tokenHash: "a".repeat(64), expiresAt: new Date(Date.now() + 60_000) } });
    expect(link.usedAt).toBeNull();
    await expect(prisma.magicLink.create({ data: {
      businessId: BIZ, email: "founder@example.com",
      tokenHash: "a".repeat(64), expiresAt: new Date() } })).rejects.toThrow(/unique/i);
  });

  it("Business carries ownerEmail", async () => {
    const b = await prisma.business.findUnique({ where: { id: BIZ } });
    expect(b?.ownerEmail).toBe("founder@example.com");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — from `packages/dionysus-mcp` with `$env:DATABASE_URL = "file:./.tmp/test.db"`: `pnpm vitest run test/magic-link-schema.test.ts` → FAIL.

- [ ] **Step 3: Edit `schema.prisma`** — add to `Business`: `ownerEmail String?` and `magicLinks MagicLink[]`. Append:

```prisma
model MagicLink {
  id         String    @id @default(cuid())
  businessId String
  business   Business  @relation(fields: [businessId], references: [id])
  email      String
  tokenHash  String    @unique
  expiresAt  DateTime
  usedAt     DateTime?
  createdAt  DateTime  @default(now())

  @@index([businessId])
}
```

- [ ] **Step 4: Generate + push + run**

```powershell
$env:DATABASE_URL = "file:./.tmp/test.db"
pnpm prisma generate
pnpm prisma db push
pnpm vitest run test/magic-link-schema.test.ts   # 2 passed
pnpm vitest run                                   # FULL mcp suite green (120 + 2)
pnpm build
```

- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: MagicLink model + Business.ownerEmail for cockpit auth"`

---

### Task 2: Cockpit package scaffold + session token lib

**Files:**
- Create: `packages/cockpit/package.json`, `tsconfig.json`, `next.config.mjs`, `vitest.config.ts`, `src/app/layout.tsx`, `src/app/login/page.tsx`, `src/lib/session.ts`
- Test: `packages/cockpit/test/session.test.ts`

**Interfaces:**
- Produces: `createSessionToken(payload: SessionPayload, secret: string): string`; `verifySessionToken(token: string, secret: string, now?: number): SessionPayload | null`; `type SessionPayload = { businessId: string; email: string; exp: number }`. Tasks 4/6 consume.

- [ ] **Step 1: Scaffold the package**

`packages/cockpit/package.json`:

```json
{
  "name": "cockpit",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  },
  "dependencies": {
    "dionysus-mcp": "workspace:*",
    "next": "^15.3.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "~5.8.0",
    "vitest": "^3.0.0"
  }
}
```

(Match the workspace's existing typescript/vitest majors if they differ — read a sibling package.json first; the repo pins TS below 7.)

`packages/cockpit/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false, "skipLibCheck": true, "strict": true,
    "noEmit": true, "esModuleInterop": true, "module": "esnext",
    "moduleResolution": "bundler", "resolveJsonModule": true,
    "isolatedModules": true, "jsx": "preserve", "incremental": true,
    "types": ["node"],
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx", "test/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`packages/cockpit/next.config.mjs`:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["dionysus-mcp", "@prisma/client"],
};
export default nextConfig;
```

`packages/cockpit/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", fileParallelism: false } });
```

`packages/cockpit/src/app/layout.tsx`:

```tsx
import type { ReactNode } from "react";

export const metadata = { title: "Dionysus Cockpit" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 860, margin: "0 auto", padding: 24 }}>
        <h1 style={{ fontSize: 20 }}>Dionysus Cockpit</h1>
        <nav style={{ display: "flex", gap: 16, marginBottom: 24 }}>
          <a href="/">Route</a>
          <a href="/drafts">Drafts</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
```

`packages/cockpit/src/app/login/page.tsx`:

```tsx
export default function LoginPage() {
  return (
    <main>
      <h2>Sign in</h2>
      <p>Access is by magic link. Ask your operator to issue one for your business.</p>
    </main>
  );
}
```

Run `pnpm install` at the workspace root (adds the new package), then from `packages/cockpit`: `pnpm exec next build` — expect a clean build of the two static pages.

- [ ] **Step 2: Write the failing session tests**

`packages/cockpit/test/session.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createSessionToken, verifySessionToken } from "../src/lib/session";

const SECRET = "test-secret-please-rotate";
const payload = { businessId: "biz_a", email: "f@example.com", exp: Date.now() + 60_000 };

describe("session tokens", () => {
  it("round-trips a valid payload", () => {
    const token = createSessionToken(payload, SECRET);
    expect(verifySessionToken(token, SECRET)).toEqual(payload);
  });
  it("rejects a tampered body (signature mismatch)", () => {
    const token = createSessionToken(payload, SECRET);
    const [body, sig] = token.split(".");
    const evil = Buffer.from(JSON.stringify({ ...payload, businessId: "biz_b" }), "utf8").toString("base64url");
    expect(verifySessionToken(`${evil}.${sig}`, SECRET)).toBeNull();
    expect(verifySessionToken(`${body}.AAAA`, SECRET)).toBeNull();
  });
  it("rejects a wrong secret and an expired session", () => {
    const token = createSessionToken(payload, SECRET);
    expect(verifySessionToken(token, "other-secret")).toBeNull();
    const stale = createSessionToken({ ...payload, exp: Date.now() - 1 }, SECRET);
    expect(verifySessionToken(stale, SECRET)).toBeNull();
  });
  it("fail-closed: empty secret throws on create AND verify", () => {
    expect(() => createSessionToken(payload, "")).toThrow(/secret/i);
    expect(() => verifySessionToken("a.b", "")).toThrow(/secret/i);
  });
});
```

- [ ] **Step 3: Run → FAIL. Step 4: Implement `src/lib/session.ts`**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export type SessionPayload = { businessId: string; email: string; exp: number };

function hmac(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data, "utf8").digest();
}

function requireSecret(secret: string): void {
  if (!secret) throw new Error("Session secret is required (COCKPIT_SESSION_SECRET).");
}

export function createSessionToken(payload: SessionPayload, secret: string): string {
  requireSecret(secret);
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${hmac(body, secret).toString("base64url")}`;
}

export function verifySessionToken(token: string, secret: string, now: number = Date.now()): SessionPayload | null {
  requireSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = hmac(body, secret);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof parsed.businessId !== "string" || typeof parsed.email !== "string" || typeof parsed.exp !== "number") return null;
    if (parsed.exp <= now) return null;
    return parsed;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run to green** — `pnpm vitest run` (cockpit) → 4 passed; `pnpm exec next build` clean.

- [ ] **Step 6: Commit** — `git add -A; git commit -m "feat: cockpit scaffold + HMAC session tokens (fail-closed secret, timing-safe verify)"`

---

### Task 3: Magic-link service (single-use, short-TTL) + provisioning CLI

**Files:**
- Create: `packages/cockpit/src/lib/magic-link.ts`, `packages/cockpit/scripts/issue-login-link.mjs`
- Test: `packages/cockpit/test/magic-link.test.ts`

**Interfaces:**
- Consumes: `prisma` from `dionysus-mcp/db` (Task 1's MagicLink model).
- Produces: `issueMagicLink(businessId: string, email: string): Promise<{ token: string; expiresAt: Date }>` (raw token returned once, only hash stored); `verifyMagicLink(token: string): Promise<{ businessId: string; email: string }>` (atomic single-use redemption); `MAGIC_LINK_TTL_MS = 900_000`. Task 4 consumes `verifyMagicLink`.

- [ ] **Step 1: Write the failing tests**

`packages/cockpit/test/magic-link.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { issueMagicLink, verifyMagicLink } from "../src/lib/magic-link";

const BIZ = "biz_cockpit_ml";

describe("magic links (H3)", () => {
  beforeAll(async () => {
    await prisma.magicLink.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "MLC" }, update: {} });
  });

  it("issues and redeems once; the raw token is never stored", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    const stored = await prisma.magicLink.findMany({ where: { businessId: BIZ } });
    expect(stored.some((l) => l.tokenHash === token)).toBe(false); // hash only
    const redeemed = await verifyMagicLink(token);
    expect(redeemed).toEqual({ businessId: BIZ, email: "f@example.com" });
  });

  it("a second redemption of the same token is refused (single-use)", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    await verifyMagicLink(token);
    await expect(verifyMagicLink(token)).rejects.toThrow(/invalid|expired|used/i);
  });

  it("concurrent double-redemption: exactly one wins (atomic)", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    const results = await Promise.allSettled([verifyMagicLink(token), verifyMagicLink(token)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("an expired link is refused; an unknown token is refused", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    await prisma.magicLink.updateMany({ where: { businessId: BIZ, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(verifyMagicLink(token)).rejects.toThrow(/invalid|expired|used/i);
    await expect(verifyMagicLink("not-a-real-token")).rejects.toThrow(/invalid|expired|used/i);
  });

  it("issuing for a nonexistent business fails closed", async () => {
    await expect(issueMagicLink("biz_ml_ghost", "g@example.com")).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement `src/lib/magic-link.ts`**

```ts
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "dionysus-mcp/db";

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // H3: short-TTL

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function issueMagicLink(businessId: string, email: string): Promise<{ token: string; expiresAt: Date }> {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new Error(`Business ${businessId} not found.`);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);
  await prisma.magicLink.create({ data: { businessId, email, tokenHash: hashToken(token), expiresAt } });
  return { token, expiresAt };
}

export async function verifyMagicLink(token: string): Promise<{ businessId: string; email: string }> {
  // H3 single-use: redemption is the atomic write — only an unused, unexpired row matches.
  const { count } = await prisma.magicLink.updateMany({
    where: { tokenHash: hashToken(token), usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (count === 0) throw new Error("Magic link is invalid, expired, or already used.");
  const link = await prisma.magicLink.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!link) throw new Error("Magic link row missing after redemption.");
  return { businessId: link.businessId, email: link.email };
}
```

`packages/cockpit/scripts/issue-login-link.mjs` (hand-provisioning for design partners, spec §0; duplicates the 6-line mint intentionally — .mjs cannot import the TS lib, and the redemption path stays single-sourced):

```js
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "dionysus-mcp/db";

const [businessId, email] = process.argv.slice(2);
if (!businessId || !email) {
  console.error("usage: node scripts/issue-login-link.mjs <businessId> <email>");
  process.exit(1);
}
const business = await prisma.business.findUnique({ where: { id: businessId } });
if (!business) {
  console.error(`Business ${businessId} not found.`);
  process.exit(1);
}
const token = randomBytes(32).toString("base64url");
await prisma.magicLink.create({ data: {
  businessId, email,
  tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
} });
console.log(`${process.env.COCKPIT_BASE_URL ?? "http://localhost:3000"}/auth/${token}`);
process.exit(0);
```

- [ ] **Step 4: Run to green** — cockpit `pnpm vitest run` (session + magic-link, 9 passed); `next build` clean.
- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: single-use short-TTL magic links (hash-only storage, atomic redemption) + provisioning CLI"`

---

### Task 4: Auth wiring — cookie session, redeem route, requireSession

**Files:**
- Create: `packages/cockpit/src/lib/auth.ts`, `packages/cockpit/src/app/auth/[token]/route.ts`
- Test: `packages/cockpit/test/auth-route.test.ts`

**Interfaces:**
- Consumes: `verifyMagicLink` (Task 3), `createSessionToken`/`verifySessionToken` (Task 2).
- Produces: `SESSION_COOKIE = "dionysus_session"`; `SESSION_TTL_MS = 604_800_000`; `sessionSecret(): string` (fail-closed env read); `requireSession(): Promise<SessionPayload>` (redirects to /login when absent/invalid); route `GET /auth/[token]` (redeem → Set-Cookie → redirect `/`; failure → redirect `/login?error=invalid`). Task 5 consumes `requireSession`.

- [ ] **Step 1: Write the failing tests** (route handler invoked directly as a function — no server needed):

`packages/cockpit/test/auth-route.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { issueMagicLink } from "../src/lib/magic-link";
import { verifySessionToken } from "../src/lib/session";
import { SESSION_COOKIE } from "../src/lib/auth";
import { GET } from "../src/app/auth/[token]/route";

const BIZ = "biz_cockpit_auth";
process.env.COCKPIT_SESSION_SECRET = "test-secret";

function req(token: string): [Request, { params: Promise<{ token: string }> }] {
  return [new Request(`http://localhost:3000/auth/${token}`), { params: Promise.resolve({ token }) }];
}

describe("GET /auth/[token]", () => {
  beforeAll(async () => {
    await prisma.magicLink.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "AC" }, update: {} });
  });

  it("redeems a valid link: sets an httpOnly session cookie bound to the link's business and redirects to /", async () => {
    const { token } = await issueMagicLink(BIZ, "f@example.com");
    const res = await GET(...req(token));
    expect(res.status).toBeGreaterThanOrEqual(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain("httponly");
    const value = decodeURIComponent(setCookie.split(`${SESSION_COOKIE}=`)[1]!.split(";")[0]!);
    const session = verifySessionToken(value, "test-secret");
    expect(session?.businessId).toBe(BIZ);
    expect(session?.email).toBe("f@example.com");
  });

  it("a bad token redirects to /login?error=invalid with NO cookie", async () => {
    const res = await GET(...req("bogus-token"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?error=invalid");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement**

`src/lib/auth.ts`:

```ts
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifySessionToken, type SessionPayload } from "./session";

export const SESSION_COOKIE = "dionysus_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionSecret(): string {
  const secret = process.env.COCKPIT_SESSION_SECRET;
  if (!secret) throw new Error("COCKPIT_SESSION_SECRET is not configured.");
  return secret;
}

export async function requireSession(): Promise<SessionPayload> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const session = token ? verifySessionToken(token, sessionSecret()) : null;
  if (!session) redirect("/login");
  return session;
}
```

`src/app/auth/[token]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { verifyMagicLink } from "../../../lib/magic-link";
import { createSessionToken } from "../../../lib/session";
import { SESSION_COOKIE, SESSION_TTL_MS, sessionSecret } from "../../../lib/auth";

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await ctx.params;
  try {
    const { businessId, email } = await verifyMagicLink(token);
    const session = createSessionToken({ businessId, email, exp: Date.now() + SESSION_TTL_MS }, sessionSecret());
    const res = NextResponse.redirect(new URL("/", req.url));
    res.cookies.set(SESSION_COOKIE, session, {
      httpOnly: true, sameSite: "lax", path: "/",
      secure: process.env.NODE_ENV === "production",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return res;
  } catch {
    return NextResponse.redirect(new URL("/login?error=invalid", req.url));
  }
}
```

- [ ] **Step 4: Run to green** — cockpit suite (11 passed); `next build` clean.
- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: magic-link redemption route + cookie session + requireSession guard"`

---

### Task 5: Review service + server actions + pages

**Files:**
- Create: `packages/cockpit/src/lib/review.ts`, `src/app/actions.ts`, `src/app/page.tsx`, `src/app/drafts/page.tsx`
- Test: `packages/cockpit/test/review.test.ts`

**Interfaces:**
- Consumes: `prisma` (`dionysus-mcp/db`), `Identity` type (`dionysus-mcp/identity`), `approveAction`/`rejectAction` (`dionysus-mcp/tools/lifecycle`), `requireSession` (Task 4).
- Produces:
  - `listProposedDrafts(identity): Promise<DraftCard[]>` where `DraftCard = { actionId, employeeRole, type, channel: string | null, title: string | null, body: string | null, waypointTitle: string, rationale: string | null }` — proposed actions WITH a bound asset, all reads identity-scoped.
  - `getRouteOverview(identity): Promise<RouteOverview>` where `RouteOverview = { objective: { kind, target, metric, status } | null, waypoints: Array<{ order, title, goal, status, actions: Array<{ id, employeeRole, type, status }> }> }` (latest route).
  - Server actions `approveDraft(routeActionId): Promise<ActionResult>` / `rejectDraft(routeActionId): Promise<ActionResult>` with `ActionResult = { ok: boolean; message: string }` — session identity, principal = session email, friendly error mapping (never a stack trace to the UI).

- [ ] **Step 1: Write the failing service tests**

`packages/cockpit/test/review.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import { listProposedDrafts, getRouteOverview } from "../src/lib/review";

const A = { businessId: "biz_cockpit_rev" };
const B = { businessId: "biz_cockpit_rev_other" };
let boundActionId = "";

beforeAll(async () => {
  for (const id of [A.businessId, B.businessId]) {
    await prisma.asset.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
  const obj = await prisma.objective.create({ data: { businessId: A.businessId, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: A.businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: A.businessId, routeId: route.id, order: 1, title: "Launch", goal: "20 signups", status: "active" } });
  const bound = await prisma.routeAction.create({ data: { businessId: A.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed", rationale: "launch" } });
  const { assetId } = await persistAsset(A, { channel: "hackernews", kind: "post", content: { title: "Show HN", body: "We built X" }, routeActionId: bound.id });
  await setActionAsset(A, bound.id, assetId);
  boundActionId = bound.id;
  // a proposed action with NO asset must not appear as a reviewable draft
  await prisma.routeAction.create({ data: { businessId: A.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
});

describe("review service", () => {
  it("lists only proposed actions WITH a bound asset, with parsed content", async () => {
    const drafts = await listProposedDrafts(A);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ actionId: boundActionId, channel: "hackernews", title: "Show HN", body: "We built X", waypointTitle: "Launch" });
  });

  it("route overview assembles objective -> waypoints -> actions", async () => {
    const view = await getRouteOverview(A);
    expect(view.objective?.kind).toBe("signups");
    expect(view.waypoints).toHaveLength(1);
    expect(view.waypoints[0]!.actions.length).toBe(2);
  });

  it("another tenant sees nothing (identity-scoped reads)", async () => {
    expect(await listProposedDrafts(B)).toHaveLength(0);
    expect((await getRouteOverview(B)).objective).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL. Step 3: Implement `src/lib/review.ts`**

```ts
import { prisma } from "dionysus-mcp/db";
import type { Identity } from "dionysus-mcp/identity";

export type DraftCard = {
  actionId: string; employeeRole: string; type: string;
  channel: string | null; title: string | null; body: string | null;
  waypointTitle: string; rationale: string | null;
};

export async function listProposedDrafts(identity: Identity): Promise<DraftCard[]> {
  const actions = await prisma.routeAction.findMany({
    where: { businessId: identity.businessId, status: "proposed", assetId: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  const cards: DraftCard[] = [];
  for (const action of actions) {
    const asset = await prisma.asset.findFirst({ where: { id: action.assetId!, businessId: identity.businessId } });
    if (!asset) continue; // dangling pointer: not reviewable
    const wp = await prisma.routeWaypoint.findFirst({ where: { id: action.waypointId, businessId: identity.businessId } });
    let title: string | null = null;
    let body: string | null = null;
    try {
      const content = JSON.parse(asset.contentJson) as { title?: unknown; body?: unknown };
      title = typeof content.title === "string" ? content.title : null;
      body = typeof content.body === "string" ? content.body : null;
    } catch {
      body = null;
    }
    cards.push({ actionId: action.id, employeeRole: action.employeeRole, type: action.type,
      channel: asset.channel, title, body, waypointTitle: wp?.title ?? "", rationale: action.rationale });
  }
  return cards;
}

export type RouteOverview = {
  objective: { kind: string; target: string; metric: string; status: string } | null;
  waypoints: Array<{ order: number; title: string; goal: string; status: string;
    actions: Array<{ id: string; employeeRole: string; type: string; status: string }> }>;
};

export async function getRouteOverview(identity: Identity): Promise<RouteOverview> {
  const route = await prisma.route.findFirst({
    where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
  if (!route) return { objective: null, waypoints: [] };
  const objective = await prisma.objective.findFirst({ where: { id: route.objectiveId, businessId: identity.businessId } });
  const waypoints = await prisma.routeWaypoint.findMany({
    where: { routeId: route.id, businessId: identity.businessId }, orderBy: { order: "asc" } });
  const out: RouteOverview["waypoints"] = [];
  for (const wp of waypoints) {
    const actions = await prisma.routeAction.findMany({
      where: { waypointId: wp.id, businessId: identity.businessId }, orderBy: { createdAt: "asc" } });
    out.push({ order: wp.order, title: wp.title, goal: wp.goal, status: wp.status,
      actions: actions.map((a) => ({ id: a.id, employeeRole: a.employeeRole, type: a.type, status: a.status })) });
  }
  return {
    objective: objective ? { kind: objective.kind, target: objective.target, metric: objective.metric, status: objective.status } : null,
    waypoints: out,
  };
}
```

`src/app/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { approveAction, rejectAction } from "dionysus-mcp/tools/lifecycle";
import { requireSession } from "../lib/auth";

export type ActionResult = { ok: boolean; message: string };

function friendly(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export async function approveDraft(routeActionId: string): Promise<ActionResult> {
  const session = await requireSession();
  try {
    await approveAction({ businessId: session.businessId }, { routeActionId, principal: session.email });
    revalidatePath("/drafts");
    revalidatePath("/");
    return { ok: true, message: "Approved." };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}

export async function rejectDraft(routeActionId: string): Promise<ActionResult> {
  const session = await requireSession();
  try {
    await rejectAction({ businessId: session.businessId }, { routeActionId });
    revalidatePath("/drafts");
    revalidatePath("/");
    return { ok: true, message: "Rejected." };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}
```

`src/app/page.tsx`:

```tsx
import { requireSession } from "../lib/auth";
import { getRouteOverview } from "../lib/review";

export const dynamic = "force-dynamic";

export default async function RoutePage() {
  const session = await requireSession();
  const view = await getRouteOverview({ businessId: session.businessId });
  if (!view.objective) return <main><p>No route yet. The department has not proposed one.</p></main>;
  return (
    <main>
      <h2>Objective: {view.objective.target} {view.objective.metric} ({view.objective.kind})</h2>
      <p>Status: {view.objective.status}</p>
      {view.waypoints.map((wp) => (
        <section key={wp.order} style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <h3>{wp.order}. {wp.title} — {wp.status}</h3>
          <p>{wp.goal}</p>
          <ul>
            {wp.actions.map((a) => (
              <li key={a.id}>{a.employeeRole} / {a.type} — <strong>{a.status}</strong></li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
```

`src/app/drafts/page.tsx`:

```tsx
import { requireSession } from "../../lib/auth";
import { listProposedDrafts } from "../../lib/review";
import { approveDraft, rejectDraft } from "../actions";

export const dynamic = "force-dynamic";

export default async function DraftsPage() {
  const session = await requireSession();
  const drafts = await listProposedDrafts({ businessId: session.businessId });
  if (drafts.length === 0) return <main><p>No drafts waiting for review.</p></main>;
  return (
    <main>
      <h2>Drafts for review</h2>
      {drafts.map((d) => (
        <article key={d.actionId} style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <p style={{ color: "#666", margin: 0 }}>{d.waypointTitle} · {d.employeeRole} · {d.type} · {d.channel}</p>
          {d.title ? <h3>{d.title}</h3> : null}
          <p style={{ whiteSpace: "pre-wrap" }}>{d.body}</p>
          {d.rationale ? <p style={{ color: "#666" }}>Why: {d.rationale}</p> : null}
          <form action={async () => { "use server"; await approveDraft(d.actionId); }} style={{ display: "inline" }}>
            <button type="submit">Approve</button>
          </form>{" "}
          <form action={async () => { "use server"; await rejectDraft(d.actionId); }} style={{ display: "inline" }}>
            <button type="submit">Reject</button>
          </form>
        </article>
      ))}
    </main>
  );
}
```

- [ ] **Step 4: Run to green** — cockpit suite (14 passed); `next build` clean (the DB pages are `force-dynamic` so the build never touches Prisma).
- [ ] **Step 5: Commit** — `git add -A; git commit -m "feat: draft-review + route overview pages wired to D29 approve/reject via session identity"`

---

### Task 6: §15 eval gate — the cockpit path under attack

**Files:**
- Test: `packages/cockpit/test/cockpit-eval.e2e.test.ts` (no production code expected; STOP and report if an invariant fails)

**Interfaces:** consumes the full service stack (magic-link → session → review → lifecycle).

- [ ] **Step 1: Write the gate**

```ts
// §15 stage-4a eval gate — the cockpit approval path under attack.
// Attacks: replayed magic link, forged session cookie, cross-tenant approval via a
// stolen-but-valid session, post-approval tamper surfacing through the cockpit path.
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import { approveAction } from "dionysus-mcp/tools/lifecycle";
import { issueMagicLink, verifyMagicLink } from "../src/lib/magic-link";
import { createSessionToken, verifySessionToken } from "../src/lib/session";
import { listProposedDrafts } from "../src/lib/review";

const SECRET = "eval-secret";
const A = { businessId: "biz_cockpit_eval_a" };
const B = { businessId: "biz_cockpit_eval_b" };
let actionA = "";

beforeAll(async () => {
  for (const id of [A.businessId, B.businessId]) {
    await prisma.magicLink.deleteMany({ where: { businessId: id } });
    await prisma.asset.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
  const obj = await prisma.objective.create({ data: { businessId: A.businessId, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: A.businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: A.businessId, routeId: route.id, order: 1, title: "Launch", goal: "20", status: "active" } });
  const action = await prisma.routeAction.create({ data: { businessId: A.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
  const { assetId } = await persistAsset(A, { channel: "x", kind: "post", content: { body: "reviewed words" }, routeActionId: action.id });
  await setActionAsset(A, action.id, assetId);
  actionA = action.id;
});

describe("§15 stage-4a eval gate — cockpit auth + approval under attack", () => {
  it("full path: link -> session -> drafts visible -> approve lands content-bound; replayed link refused", async () => {
    const { token } = await issueMagicLink(A.businessId, "founder-a@example.com");
    const identity = await verifyMagicLink(token);
    const cookie = createSessionToken({ businessId: identity.businessId, email: identity.email, exp: Date.now() + 60_000 }, SECRET);
    const session = verifySessionToken(cookie, SECRET)!;
    expect(session.businessId).toBe(A.businessId);

    const drafts = await listProposedDrafts({ businessId: session.businessId });
    expect(drafts.map((d) => d.actionId)).toContain(actionA);

    await approveAction({ businessId: session.businessId }, { routeActionId: actionA, principal: session.email });
    const approved = await prisma.routeAction.findUnique({ where: { id: actionA } });
    expect(approved!.status).toBe("approved");
    expect(approved!.approvedBy).toBe("founder-a@example.com");

    await expect(verifyMagicLink(token)).rejects.toThrow(/invalid|expired|used/i); // replay refused
  });

  it("a forged cookie (tampered businessId, valid-looking) yields no session", () => {
    const good = createSessionToken({ businessId: B.businessId, email: "evil@example.com", exp: Date.now() + 60_000 }, SECRET);
    const [_, sig] = good.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ businessId: A.businessId, email: "evil@example.com", exp: Date.now() + 60_000 }), "utf8").toString("base64url");
    expect(verifySessionToken(`${forgedBody}.${sig}`, SECRET)).toBeNull();
  });

  it("a VALID session for business B cannot see or approve business A's draft", async () => {
    const { token } = await issueMagicLink(B.businessId, "founder-b@example.com");
    const b = await verifyMagicLink(token);
    const drafts = await listProposedDrafts({ businessId: b.businessId });
    expect(drafts.map((d) => d.actionId)).not.toContain(actionA);
    await expect(approveAction({ businessId: b.businessId }, { routeActionId: actionA, principal: b.email }))
      .rejects.toThrow(/not found|scope|invalid transition/i);
    const still = await prisma.routeAction.findUnique({ where: { id: actionA } });
    expect(still!.approvedBy).toBe("founder-a@example.com"); // A's approval untouched
  });

  it("session identity flows into the D29 hash refusal (tamper after approve -> execution refused)", async () => {
    const action = await prisma.routeAction.findUnique({ where: { id: actionA } });
    await prisma.asset.update({ where: { id: action!.assetId! }, data: { contentJson: JSON.stringify({ body: "swapped" }) } });
    const { startExecution } = await import("dionysus-mcp/tools/lifecycle");
    await expect(startExecution({ businessId: A.businessId }, { routeActionId: actionA, runId: "r1" }))
      .rejects.toThrow(/hash mismatch/i);
  });
});
```

- [ ] **Step 2: Run the gate, then everything** — cockpit suite green; `next build` clean; FULL mcp suite (122 expected) + build; FULL department suite (40) + build. If an invariant fails, fix the offending module test-first; never weaken the gate.
- [ ] **Step 3: Commit** — `git add -A; git commit -m "test: stage-4a eval gate - magic-link replay, forged cookie, cross-tenant session, tamper refusal"`

---

## Out of Scope (deliberate — later sub-stages)

- D22 digest + edit-distance + `revisionOf` chat-iteration (4b); simulator pre-flight (4c); verified send + outcome-poller (4d); radar-lite (4e); progress-to-objective home screen + CMO Report + Stripe (4f, ends with the design-partner checkpoint + dogfood launch).
- Step-up auth / MFA (H3's high-stakes tier — no high-stakes acts exist at 4a).
- Email delivery of magic links (hand-provisioned CLI per spec §0 design partners; Outreach email integration is a later stage).
- Browser e2e (Playwright) — deferred to the stage-4 checkpoint sub-stage (recorded judgment, Global Constraints).
- The api_server/SSE live-activity panel and subagents store (stages 6-7).

## Self-Review Notes

- **Spec coverage:** §9 cockpit draft-review view (T5); H3 magic-link hardening — single-use atomic, short-TTL, hash-only storage (T3), httpOnly signed cookie (T2/T4); D29 cockpit-path approve/reject with principal (T5); D27.1 session→business binding, no businessId from request data (T4/T5); §15 gate (T6). §17 stage-4 items NOT in 4a are explicitly decomposed out.
- **Type consistency:** `SessionPayload` (T2) used in T4/T6; `verifyMagicLink` return shape (T3) consumed in T4 route + T6; `DraftCard`/`RouteOverview` (T5) self-contained; `ActionResult` used by both actions.
- **Judgment calls on record:** no auth library (40 lines of node:crypto, all failure modes tested); CLI mints links (email ships later) with a deliberate 6-line mint duplication in .mjs; server actions return `{ok, message}` instead of throwing (UI-friendly, no stack traces); review reads are sequential loops (N is tiny at 4a — no premature query optimization); `next build` + direct handler invocation replace browser e2e at 4a.
