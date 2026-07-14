# SEO/AEO Strategist (Stage 6h — deterministic on-page audit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The SEO/AEO Strategist employee (spec §employees, D25) — its honest first slice: a nightly, fully **deterministic** audit of the founder's own landing page (title/meta/h1/canonical/og/JSON-LD/viewport + robots.txt/sitemap.xml/llms.txt), landed as a proposed `seo-audit` RouteAction with a bound checklist Asset on `/drafts`. Zero model calls — every finding is a machine-checked fact of the fetched page, so fabrication is impossible **by construction** (`runSeo` takes no harness).

**Architecture:** A pure audit function in dionysus-mcp's scrape lib (`auditPageSeo` — safeFetch raw HTML + cheerio checks + same-origin well-known fetches) consumed by a dept pipeline (`runSeo`) that follows the cro shape minus the model steps: product url → active waypoint → one-standing → fresh audit → **page-change dedup** (sha256 of the findings vs the latest audit asset's stored hash — an unchanged page is never re-proposed; the radar rerun-dedup discipline) → persist proposed action + asset. Ninth nightly section between cro and outreach. Excluded from the send queue (apply-checklist semantics, like cro-fix) and from the copywriter.

**Tech Stack:** No new dependencies (cheerio + node:crypto already in-tree), no schema change. dionysus-mcp + department + cockpit (one-line exclusion).

## Global Constraints

- **ZERO MODEL CALLS (the honesty core).** `runSeo` has no `harness`/`models` in its deps type — a model call is structurally impossible. Every finding's `evidence` is either a verbatim value read from the fetched page (200-char deterministic cap), the literal string `"absent"`, or the literal string `"unreachable"`. Advice strings come from a hardcoded constant map — never generated.
- **NO BUDGET GATE.** checkBudget gates model spend; a zero-model section skips it (the metrics-section precedent in run-nightly.ts). Fetches are SSRF-guarded and bounded (1 page + 3 well-known paths).
- **PAGE-CHANGE DEDUP.** `auditHash = sha256(JSON.stringify(findings))` stored inside the asset's content JSON; a new audit whose hash equals the latest `seo-audit` asset's hash → honest skip `"page unchanged since last audit"`. A founder's REJECT therefore means "don't show me this again until the page changes"; an APPROVE + applied fixes changes the page → a fresh audit fires. Malformed/missing stored hash → proceed (fail-open toward re-auditing — a fresh audit of the current page is never a fabrication).
- **NEVER-AUTO.** The audit lands as a `proposed` action + bound asset; excluded from `listSendQueue` (kind `seo-audit`) and from `draftWaypoint` (`type notIn ["cro-fix","outreach-pitch","seo-audit"]`).
- **ONE-STANDING = pending review and VISIBLE:** the standing predicate requires `assetId != null` (unlike cro's any-proposed predicate) — an assetless partial-failure orphan is invisible on /drafts and must never block the employee forever. Documented divergence.
- **HONEST degrade.** No product url / no active waypoint / unreadable page / unchanged page → skip with the exact reasons below; an unreadable page retries next night.
- **D27.1 scoped everything; NOT MCP (whitelist stays 11); no schema change; no `console.log` in src; ESM `.js` specifiers in dept.**
- **Ops:** PowerShell only (Git Bash broken). T1 changes dionysus-mcp → `pnpm --filter dionysus-mcp build` BEFORE running the dept suite (dept imports the built dist). mcp tests: `$env:DATABASE_URL="file:./.tmp/test.db"`. cockpit tests: that plus `$env:COCKPIT_SESSION_SECRET="test-secret"`.
- **Baselines at stage start:** mcp **342**, dept **163**, cockpit **66**.

**Deferred (documented judgment):** GSC keyword grounding (D21 — the Integration substrate from 5d is ready; needs a real GSC connection); long-form content briefs for the Copywriter (without GSC keyword data a brief is model-invented topics — fabrication-adjacent, deferred until GSC); monthly re-scan timer (decision-gated + page-change-gated re-scan approximates the cadence); multi-page crawl; AEO authority placement.

---

## Task 1: `auditPageSeo` — the deterministic audit (dionysus-mcp)

**Files:**
- Create: `packages/dionysus-mcp/src/lib/scrape/seo-audit.ts`
- Test: `packages/dionysus-mcp/test/seo-audit.test.ts`

**Interfaces (produces):**

```typescript
export type SeoFinding = {
  check: string;                       // fixed id, e.g. "title", "meta-description"
  status: "pass" | "warn" | "fail";
  evidence: string;                    // verbatim page value (≤200 chars) | "absent" | "unreachable" | count text
  advice: string;                      // hardcoded constant ("" on pass)
};
export type SeoAuditResult =
  | { ok: true; findings: SeoFinding[] }
  | { ok: false; error: string };
export async function auditPageSeo(url: string, fetchOpts?: SafeFetchOptions): Promise<SeoAuditResult>;
```

**Complete implementation:**

```typescript
// Stage 6h Task 1 — deterministic on-page SEO/AEO audit (D25, spec §employees).
// Every finding is a machine-checked FACT of the fetched page: evidence is a
// verbatim value read from the HTML (200-char cap), the literal "absent", or the
// literal "unreachable"; advice comes from the constant map below. No model is
// involved anywhere in this file — fabrication is impossible by construction.
import * as cheerio from "cheerio";
import { safeFetch, type SafeFetchOptions } from "../ssrf.js";

export type SeoFinding = {
  check: string;
  status: "pass" | "warn" | "fail";
  evidence: string;
  advice: string;
};
export type SeoAuditResult =
  | { ok: true; findings: SeoFinding[] }
  | { ok: false; error: string };

const EVIDENCE_CAP = 200;
const cap = (s: string): string => (s.length > EVIDENCE_CAP ? s.slice(0, EVIDENCE_CAP) : s);

// Hardcoded advice — deterministic constants, never generated.
const ADVICE: Record<string, string> = {
  "title": "Add a <title> of 10-60 characters — it is the search result headline.",
  "title-length": "Keep the <title> between 10 and 60 characters so it displays untruncated.",
  "meta-description": "Add a meta description of 50-160 characters — it is the search result snippet.",
  "meta-description-length": "Keep the meta description between 50 and 160 characters.",
  "h1": "Add exactly one <h1> stating what the page is about.",
  "h1-multiple": "Use exactly one <h1>; demote the others to <h2>.",
  "canonical": "Add a <link rel=\"canonical\"> to prevent duplicate-content dilution.",
  "og-title": "Add og:title so shares render a proper card.",
  "og-description": "Add og:description so shares render a proper card.",
  "json-ld": "Add schema.org JSON-LD — AI assistants and rich results rely on structured data.",
  "json-ld-invalid": "Fix the JSON-LD block — it is present but not valid JSON.",
  "viewport": "Add a viewport meta tag — mobile rendering affects ranking.",
  "robots-txt": "Add a robots.txt so crawlers know what to index.",
  "sitemap-xml": "Add a sitemap.xml so crawlers discover every page.",
  "llms-txt": "Add an llms.txt — AEO: AI assistants look for it when citing sources.",
};

function finding(check: string, status: "pass" | "warn" | "fail", evidence: string, adviceKey?: string): SeoFinding {
  return { check, status, evidence: cap(evidence), advice: status === "pass" ? "" : ADVICE[adviceKey ?? check] ?? "" };
}

export async function auditPageSeo(url: string, fetchOpts?: SafeFetchOptions): Promise<SeoAuditResult> {
  // The page itself: unreadable → the audit honestly does not exist (ok:false).
  let body: string;
  try {
    const res = await safeFetch(url, fetchOpts);
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `HTTP ${res.status}` };
    if (!res.contentType.toLowerCase().includes("html")) return { ok: false, error: `Not HTML (${res.contentType || "unknown content-type"})` };
    body = res.body;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const findings: SeoFinding[] = [];
  try {
    const $ = cheerio.load(body);

    // 1. title — present + 10-60 chars.
    const title = $("title").first().text().trim();
    if (!title) findings.push(finding("title", "fail", "absent"));
    else if (title.length < 10 || title.length > 60) findings.push(finding("title", "warn", `"${title}" (${title.length} chars)`, "title-length"));
    else findings.push(finding("title", "pass", `"${title}"`));

    // 2. meta description — present + 50-160 chars.
    const desc = $('meta[name="description"]').attr("content")?.trim() ?? "";
    if (!desc) findings.push(finding("meta-description", "fail", "absent"));
    else if (desc.length < 50 || desc.length > 160) findings.push(finding("meta-description", "warn", `"${desc}" (${desc.length} chars)`, "meta-description-length"));
    else findings.push(finding("meta-description", "pass", `"${desc}"`));

    // 3. h1 — exactly one.
    const h1s = $("h1");
    if (h1s.length === 0) findings.push(finding("h1", "fail", "absent"));
    else if (h1s.length > 1) findings.push(finding("h1", "warn", `${h1s.length} h1 elements`, "h1-multiple"));
    else findings.push(finding("h1", "pass", `"${h1s.first().text().trim()}"`));

    // 4. canonical.
    const canonical = $('link[rel="canonical"]').attr("href")?.trim() ?? "";
    findings.push(canonical ? finding("canonical", "pass", canonical) : finding("canonical", "warn", "absent"));

    // 5-6. og:title / og:description.
    const ogTitle = $('meta[property="og:title"]').attr("content")?.trim() ?? "";
    findings.push(ogTitle ? finding("og-title", "pass", `"${ogTitle}"`) : finding("og-title", "warn", "absent"));
    const ogDesc = $('meta[property="og:description"]').attr("content")?.trim() ?? "";
    findings.push(ogDesc ? finding("og-description", "pass", `"${ogDesc}"`) : finding("og-description", "warn", "absent"));

    // 7. JSON-LD — present AND parseable (AEO/schema.org).
    const ldBlocks = $('script[type="application/ld+json"]');
    if (ldBlocks.length === 0) findings.push(finding("json-ld", "warn", "absent"));
    else {
      let parsedTypes: string[] = []; let invalid = false;
      ldBlocks.each((_, el) => {
        try {
          const parsed: unknown = JSON.parse($(el).text());
          const t = (parsed as { "@type"?: unknown })?.["@type"];
          if (typeof t === "string") parsedTypes.push(t);
        } catch { invalid = true; }
      });
      if (invalid) findings.push(finding("json-ld", "fail", "unparseable JSON-LD", "json-ld-invalid"));
      else findings.push(finding("json-ld", "pass", parsedTypes.length > 0 ? `@type: ${parsedTypes.join(", ")}` : "valid JSON-LD"));
    }

    // 8. viewport.
    const viewport = $('meta[name="viewport"]').attr("content")?.trim() ?? "";
    findings.push(viewport ? finding("viewport", "pass", viewport) : finding("viewport", "warn", "absent"));
  } catch (e) {
    // Parser blowup on adversarial HTML → the audit honestly does not exist.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // 9-11. Well-known same-origin files. The page proved reachable above, so a
  // failure here is the file's own absence/unreachability — a warn, never a throw.
  for (const [check, path] of [["robots-txt", "/robots.txt"], ["sitemap-xml", "/sitemap.xml"], ["llms-txt", "/llms.txt"]] as const) {
    let evidence = "absent"; let status: "pass" | "warn" = "warn";
    try {
      const res = await safeFetch(new URL(path, url).toString(), fetchOpts);
      if (res.status >= 200 && res.status < 300) { status = "pass"; evidence = `HTTP ${res.status}`; }
    } catch { evidence = "unreachable"; }
    findings.push(finding(check, status, evidence));
  }

  return { ok: true, findings };
}
```

- [ ] **Step 1: failing tests** — `packages/dionysus-mcp/test/seo-audit.test.ts`, local `node:http` server (the ssrf-test pattern; serve configurable HTML per path). Cases:
  1. **healthy page** (title 30 chars, description 100 chars, one h1, canonical, og pair, valid JSON-LD `{"@type":"SoftwareApplication"}`, viewport; robots/sitemap/llms.txt all 200) → `ok:true`, ALL findings `pass`, title evidence contains the verbatim title text, json-ld evidence contains `SoftwareApplication`.
  2. **bare page** (`<html><body>hi</body></html>`; well-known 404) → title/meta-description/h1 `fail` with evidence exactly `"absent"`; canonical/og/json-ld/viewport `warn` `"absent"`; robots/sitemap/llms `warn` `"absent"`; every non-pass finding has non-empty `advice`.
  3. **boundary lengths** — 61-char title → `title` warn with `(61 chars)`; 9-char title → warn; 49-char description → warn; 161 → warn.
  4. **two h1s** → warn `"2 h1 elements"`.
  5. **unparseable JSON-LD** (`<script type="application/ld+json">{nope</script>`) → `json-ld` **fail** `"unparseable JSON-LD"`.
  6. **page 500** → `ok:false` error `HTTP 500`. **non-HTML** content-type → `ok:false`.
  7. **determinism** — audit the healthy page twice → `JSON.stringify(findings)` byte-identical (the dedup-hash precondition).
  8. **evidence cap** — a 500-char title → evidence length ≤ 200 + 10 (quote/suffix allowance): assert `f.evidence.length <= 210`.
  9. **SSRF** — `http://127.0.0.1:9/` (unroutable loopback is BLOCKED by the guard) → `ok:false` (safeFetch throws → caught).
- [ ] **Step 2: RED → implement → GREEN**: `$env:DATABASE_URL="file:./.tmp/test.db"; pnpm --filter dionysus-mcp test` (expect ~351-352) + `pnpm --filter dionysus-mcp build` clean.
- [ ] **Step 3: Commit** — `feat: auditPageSeo - deterministic on-page SEO/AEO audit, facts not model output`

---

## Task 2: `runSeo` pipeline + ninth nightly section + exclusions

**Files:**
- Create: `packages/department/src/run-seo.ts`
- Modify: `packages/department/src/run-nightly.ts` (seo section between cro and outreach → NINE sections; `NightlyBusinessResult.seo`; `NightlyDeps.seoFetchOpts?`; header + JSDoc updated)
- Modify: `packages/department/src/draft-waypoint.ts` (`type: { notIn: ["cro-fix", "outreach-pitch", "seo-audit"] }`)
- Modify: `packages/cockpit/src/lib/review.ts` (`listSendQueue` kind exclusion gains `"seo-audit"`)
- Test: `packages/department/test/run-seo.test.ts` (new), appends to `packages/department/test/run-nightly.test.ts`, `packages/department/test/draft-waypoint.test.ts`, `packages/cockpit/test/review.test.ts`

**Interfaces (produces):**

```typescript
export type SeoDeps = { fetchOpts?: SafeFetchOptions };   // NO harness, NO models — zero-model by construction
export type SeoResult =
  | { status: "ok"; actionId: string; fail: number; warn: number }
  | { status: "skipped"; reason: string };
export async function runSeo(identity: Identity, deps: SeoDeps): Promise<SeoResult>;
```

**Complete `run-seo.ts`:**

```typescript
// Stage 6h — the SEO/AEO Strategist's deterministic slice (D25). Zero model
// calls BY CONSTRUCTION: SeoDeps has no harness, so nothing here can spend a
// token or invent a fact. The audit is machine-checked page facts (T1); this
// pipeline decides WHEN it lands as founder-reviewable work:
//   latest Product (no url → skip) → active waypoint (none → skip)
//   → ONE-STANDING (a proposed seo-audit WITH a bound asset → skip; unlike cro,
//     an assetless partial-failure orphan does NOT block — it is invisible on
//     /drafts and must never wedge the employee forever)
//   → auditPageSeo FRESH (unreadable → skip, retries next night)
//   → PAGE-CHANGE DEDUP: sha256(findings) vs the latest seo-audit asset's
//     stored auditHash — unchanged page → skip (reject = "not until it changes")
//   → persist ONE proposed seo-audit action + bound checklist asset (never-auto).
// No checkBudget: it gates model spend (the metrics-section precedent).
import { createHash } from "node:crypto";
import type { Identity } from "dionysus-mcp/identity";
import { prisma } from "dionysus-mcp/db";
import { upsertRouteAction } from "dionysus-mcp/tools/plan";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import { auditPageSeo, type SeoFinding } from "dionysus-mcp/lib/scrape/seo-audit";
import type { SafeFetchOptions } from "dionysus-mcp/lib/ssrf";

export type SeoDeps = { fetchOpts?: SafeFetchOptions };
export type SeoResult =
  | { status: "ok"; actionId: string; fail: number; warn: number }
  | { status: "skipped"; reason: string };

const hashFindings = (findings: SeoFinding[]): string =>
  createHash("sha256").update(JSON.stringify(findings)).digest("hex");

// The checklist the founder reads on /drafts — fixed formatting over T1's facts.
function formatAuditBody(url: string, findings: SeoFinding[]): string {
  const lines = findings.map((f) =>
    `[${f.status.toUpperCase()}] ${f.check} — ${f.evidence}${f.advice ? `. ${f.advice}` : ""}`);
  return [
    `Deterministic SEO/AEO audit of ${url}.`,
    ...lines,
    `Every line above is a machine-checked fact of the fetched page — no model involved.`,
  ].join("\n");
}

export async function runSeo(identity: Identity, deps: SeoDeps): Promise<SeoResult> {
  // 1. Latest Product (scoped, newest). No row / empty url → honest skip.
  const product = await prisma.product.findFirst({
    where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
  if (!product || !product.url) return { status: "skipped", reason: "no product page on record" };

  // 2. Active waypoint on the latest route — the audit's home.
  const route = await prisma.route.findFirst({
    where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
  const activeWaypoint = route ? await prisma.routeWaypoint.findFirst({
    where: { businessId: identity.businessId, routeId: route.id, status: "active" }, orderBy: { order: "asc" } }) : null;
  if (!activeWaypoint) return { status: "skipped", reason: "no active waypoint" };

  // 3. ONE-STANDING: an audit pending review (proposed + asset BOUND = visible on
  // /drafts) suppresses a re-run. assetId!=null on purpose — see the header note.
  const standing = await prisma.routeAction.findFirst({
    where: { businessId: identity.businessId, status: "proposed", type: "seo-audit", assetId: { not: null } } });
  if (standing) return { status: "skipped", reason: "audit already pending review" };

  // 4. FRESH deterministic audit (SSRF-guarded inside). Unreadable → skip, retry.
  const audit = await auditPageSeo(product.url, deps.fetchOpts);
  if (!audit.ok) return { status: "skipped", reason: "page unreadable" };

  // 5. PAGE-CHANGE DEDUP vs the latest audit asset's stored hash (any status —
  // a REJECTED audit's hash also blocks: "don't show me this until it changes").
  const auditHash = hashFindings(audit.findings);
  const latest = await prisma.asset.findFirst({
    where: { businessId: identity.businessId, kind: "seo-audit" }, orderBy: { createdAt: "desc" } });
  if (latest) {
    try {
      const content = JSON.parse(latest.contentJson) as { auditHash?: unknown };
      if (typeof content.auditHash === "string" && content.auditHash === auditHash) {
        return { status: "skipped", reason: "page unchanged since last audit" };
      }
    } catch {
      // Malformed stored content → fail-open toward re-auditing (a fresh audit
      // of the current page is never a fabrication).
    }
  }

  // 6. Persist (never-auto): ONE proposed action + bound checklist asset.
  const fail = audit.findings.filter((f) => f.status === "fail").length;
  const warn = audit.findings.filter((f) => f.status === "warn").length;
  const { actionId } = await upsertRouteAction(identity, {
    waypointId: activeWaypoint.id, employeeRole: "seo", type: "seo-audit",
    rationale: `SEO/AEO audit of ${product.url}: ${fail} fail, ${warn} warn — machine-checked page facts, no model involved.`,
    features: { channel: "seo", seo: true } });
  const { assetId } = await persistAsset(identity, {
    channel: "seo", kind: "seo-audit",
    content: { title: `SEO/AEO audit — ${product.url}`, body: formatAuditBody(product.url, audit.findings), auditHash },
    routeActionId: actionId });
  await setActionAsset(identity, actionId, assetId);

  return { status: "ok", actionId, fail, warn };
}
```

**Nightly section** (between cro and outreach — NINE sections: plan→radar→metrics→learn→strategy→cro→**seo**→outreach→drafts; update the file header and the one-line JSDoc):

```typescript
  // SEO — deterministic on-page audit of the founder's own page (D25). Zero
  // model calls by construction (runSeo takes no harness); no budget gate.
  let seo: SectionResult;
  try {
    const res = await runSeo(identity, deps.seoFetchOpts ? { fetchOpts: deps.seoFetchOpts } : {});
    seo = res.status === "ok"
      ? { status: "ok", detail: `audit drafted: ${res.fail} fail, ${res.warn} warn` }
      : { status: "skipped", reason: res.reason };
  } catch (error: unknown) {
    seo = { status: "failed", reason: failureReason(error) };
  }
```

`NightlyDeps` gains `seoFetchOpts?: SafeFetchOptions`; `NightlyBusinessResult` gains `seo: SectionResult`; the sweep's per-business catch is untouched (section-local catch above already isolates).

**Exclusions:**
- `draft-waypoint.ts`: `type: { notIn: ["cro-fix", "outreach-pitch"] }` → `type: { notIn: ["cro-fix", "outreach-pitch", "seo-audit"] }`.
- `cockpit review.ts` `listSendQueue`: the kind exclusion list gains `"seo-audit"` (matches however cro-fix/outreach-pitch are excluded there today — extend the same construct, do not invent a second one).

- [ ] **Step 1: failing tests.** `run-seo.test.ts` (local `node:http` server serving a configurable page + well-known paths; fixture = business + product with url + route + active waypoint, the run-cro.test.ts pattern):
  1. **HAPPY** — audit drafted: action `proposed` + `approvedAt` null + employeeRole `"seo"` + type `"seo-audit"`; asset kind `"seo-audit"` bound; body contains the page's verbatim title text AND the closing machine-checked line; content JSON carries a 64-hex `auditHash`; result `{status:"ok", fail, warn}` counts match the served page.
  2. **NO-URL skip** (product without url) → `"no product page on record"`, zero actions.
  3. **NO-WAYPOINT skip** → `"no active waypoint"`, zero actions.
  4. **ONE-STANDING skip** — seed a proposed seo-audit WITH a bound asset → `"audit already pending review"`, still exactly 1 action.
  5. **ORPHAN does NOT block** — seed an assetless proposed seo-audit → run proceeds and creates a NEW action (2 total, 1 with asset).
  6. **UNREADABLE + retry** — server 500 → skip `"page unreadable"`, zero actions; flip healthy → next run drafts.
  7. **DEDUP** — run twice against the identical page → second run skips `"page unchanged since last audit"`, still 1 action; CHANGE the served title → third run drafts a SECOND audit (dedup is not an always-skip).
  `run-nightly.test.ts` append: the standard no-product fixture → `res.seo.status === "skipped"`. `draft-waypoint.test.ts` append: an assetless proposed `seo-audit` action is NOT copywriter-drafted. `review.test.ts` append: an approved `seo-audit` asset is excluded from `listSendQueue`.
- [ ] **Step 2: RED → build mcp dist first (`pnpm --filter dionysus-mcp build`) → implement → GREEN:** FULL dept suite + FULL cockpit suite + `pnpm --filter cockpit exec next build` + dept tsc clean.
- [ ] **Step 3: Commit** — `feat: runSeo - the SEO employee audits the founder's page nightly, zero model calls`

---

## Task 3: §15 eval gate

**Files:**
- Create: `packages/department/test/seo-eval.e2e.test.ts`

Invariants (tenants `biz_seoeval_*`; a local `node:http` target with a unique marker string in its HTML, e.g. title `"SEOEVAL_UNIQUE_MARKER_TITLE"`; the standard nightly fixture with objective/route/active waypoint + product url):
- **inv1 ZERO-MODEL (the honesty core, discriminating):** a FULL nightly where the seo section drafts an audit AND at least one other section makes real model calls (e.g. seed a plain proposed action so drafts fires, or a radar signal) → assert the audit asset EXISTS, `harness.calls.length > 0` (the probe can discriminate), and NO harness call input contains the marker string — the page content never reached a model.
- **inv2 FACTS-ONLY:** the served page has the marker title and NO meta description → the audit body contains the verbatim marker title AND the line `[FAIL] meta-description — absent` (substring); the rationale carries `"fail"`/`"warn"` counts consistent with the body.
- **inv3 NEVER-AUTO + EXCLUSIONS:** the audit action is `proposed`, `approvedAt` null, asset bound; after approving it, it does NOT appear in the send-queue read path (assert the kind directly here — the cockpit exclusion is pinned in cockpit tests); the copywriter never double-drafts it (exactly ONE `seo-audit` asset after a full nightly that also drafted a plain action).
- **inv4 HONEST DEGRADE + REAL RETRY:** night 1 the target 500s → seo skipped, zero seo actions; night 2 healthy → audit drafted. Same business.
- **inv5 DEDUP HONESTY (two-sided):** night 2 drafted; approve the audit; night 3 with the UNCHANGED page → skipped `"page unchanged since last audit"`, still ONE audit; change the page title; night 4 → a SECOND audit drafts (the dedup is alive, not an always-skip).
- **inv6 WHITELIST:** `TOOL_SCHEMAS` length **11**; no `run_seo` / `audit_page_seo` names.
- [ ] Gate green standalone (`pnpm --filter department test -- seo-eval`) → FULL dept suite → Commit — `test: stage-6h eval gate - the seo employee is zero-model, facts-only, deduped, draft-only, non-MCP`

---

## Self-Review

**Spec coverage:** D25's honest first slice — on-page recommendations (patch artifacts, drafts-only) + AEO/GEO signals (schema JSON-LD, llms.txt) — delivered without a single model call, so §16's no-fabrication guarantee is structural. GSC-grounded keyword work and Copywriter briefs are explicitly deferred to the GSC connection (D21) — the 5d Integration substrate is ready for it.

**Placeholders:** none — T1/T2 carry complete code; T3 is a complete invariant recipe against established fixture patterns.

**Type consistency:** `SeoFinding`/`SeoAuditResult` (T1) → `runSeo` (T2) → gate (T3); `SeoDeps` has no harness anywhere; `NightlyBusinessResult.seo` + `seoFetchOpts` additive; the `notIn` list is consumed nowhere else.

## Execution Handoff

Subagent-Driven — fresh Opus subagent per task, review between tasks, whole-branch review at the end.
