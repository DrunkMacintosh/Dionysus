// §15 stage-6e eval gate — the CONVERSION OPTIMIZER, wired into the nightly, is
// (inv1) GROUNDING-HONEST (a mixed grounded+fabricated audit persists ONLY the
// grounded finding — the fabrication reaches no routeAction/asset row, the radar
// §6.2 discipline applied to a fresh page), (inv2) NEVER-AUTO (a full measured-flat
// night lands proposed, asset-bound, approval-null cro-fixes the drafts step never
// re-drafts — exactly one asset per action), (inv3) SIGNAL-GATED (the CMO verdict
// is the sole discriminator: a healthy night skips CRO, the same business made
// measured-flat runs it), (inv4) DEGRADE-HONEST (measured-flat but an unreadable
// page → skip with ZERO cro model calls and nothing persisted — no audit of a page
// we could not read), (inv5) ONE-STANDING (a second night while findings pend adds
// no new cro-fixes), and (inv6) NON-MCP (the whitelist stays 11 — CRO is a
// department pipeline, never an agent-assertable tool).
//
// The nightly's own clock is `new Date()`, so every fixture row is backdated relative
// to the REAL now. The measured-flat fixture is the revision-eval inv8 recipe: a route
// 6 weeks old + a recent verified send (executedRecent > 0 → NOT stalled) + connected
// analytics with two EQUAL real snapshots (delta 0 → measured-flat, not measured-working).
// A local node:http server IS the founder's landing page; the Product.url points at it
// and croFetchOpts opens the loopback port (`__testAllowPrivate`) so scrapeLadder does a
// REAL fresh fetch — the grounding filter checks findings against the actually-fetched body.
// Tenants live under biz_croeval_* so this gate never collides with other suites.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import { prisma } from "dionysus-mcp/db";
import { connectIntegration } from "dionysus-mcp/tools/integration";
import { CONFIG_KEY_ENV } from "dionysus-mcp/lib/secret-box";
import type { MetricTransport } from "dionysus-mcp/tools/analytics";
import type { SafeFetchOptions } from "dionysus-mcp/lib/ssrf";
import { TOOL_SCHEMAS } from "dionysus-mcp/server";
import type { Harness, AgentDef } from "../src/llm/types.js";
import type { HnTransport } from "../src/tools/hn-source.js";
import { runNightly, type NightlyDeps } from "../src/run-nightly.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// The founder's landing page (identical to run-cro.test.ts, so the extracted-text
// grounding is the SAME proven surface): /page serves it 200, /boom 500s.
const PAGE = `<html><head><title>Acme CLI</title></head><body>
<h1>Acme CLI for developers</h1>
<p>Ship faster with our command line tool.</p>
<p>Start your free trial today and deploy in minutes.</p>
<button>Get started</button>
</body></html>`;

let server: http.Server;
let base = "";

// The EXACT fence opener runCro wraps the page in (fence("landing-page", text)).
// It is unique to the CRO model call — radar fences "hn-signals", the copywriter
// fences "waypoint-context"/"route-so-far", and fence() neutralizes any marker
// look-alike inside recalled content — so counting calls that contain it is a
// bulletproof, non-vacuous "did the CRO audit really run?" probe.
const CRO_FENCE = "<<<UNTRUSTED-CONTENT landing-page>>>";

// HAPPY: two findings whose evidence is verbatim on the page → two survivors.
const TWO_GROUNDED = JSON.stringify({ findings: [
  { issue: "Vague hero headline", evidence: "Acme CLI for developers",
    recommendation: "Lead with the outcome, not the tool name", snippet: "<h1>Ship code 2x faster</h1>" },
  { issue: "Weak value prop", evidence: "Ship faster with our command line tool",
    recommendation: "Quantify the speed gain" },
]});

// MIXED: one grounded + one whose evidence is NOT on the page → the fabrication must drop.
const GROUNDED_ISSUE = "Buried trial CTA";
const GROUNDED_EVIDENCE = "Start your free trial today";
const FAB_ISSUE = "Missing social proof";
const FAB_EVIDENCE = "Trusted by 5000 companies worldwide";
const ONE_GROUNDED_ONE_FAB = JSON.stringify({ findings: [
  { issue: GROUNDED_ISSUE, evidence: GROUNDED_EVIDENCE,
    recommendation: "Move the trial CTA above the fold", snippet: "<a>Start free trial</a>" },
  { issue: FAB_ISSUE, evidence: FAB_EVIDENCE, recommendation: "Add customer logos" },
]});

// The non-cro nightly sections still call the harness: the copywriter drafts the
// recommender's hackernews post (radar stays quiet, so its branch is a safe default).
const DRAFT_JSON = JSON.stringify({ channel: "hackernews", kind: "post", content: { title: "Note", body: "A crisp launch note for HN." } });
const OBSERVATIONS_JSON = JSON.stringify({ observations: [] });

// Dual-purpose fake harness (mirrors nightly-eval's dispatch): cro findings when the
// input carries the landing-page fence, the draft payload for the copywriter, else the
// (quiet) radar payload. Records every input so a test can count the cro-def calls.
function nightlyHarness(croOutput: string, calls?: string[]): Harness {
  return {
    async runAgent(_def: AgentDef, input: string) {
      calls?.push(input);
      if (input.includes(CRO_FENCE)) return { finalOutput: croOutput };
      if (input.includes("Action: draft")) return { finalOutput: DRAFT_JSON };
      return { finalOutput: OBSERVATIONS_JSON };
    },
    async completeOnce() { return "unused"; },
  };
}

// croFetchOpts opens the ephemeral loopback port; a throwing metric transport keeps the
// metrics section from adding a third snapshot (the seeded pair stays the only readings);
// a zero-signal HN transport keeps radar quiet (no model call, no proposals).
const seams: SafeFetchOptions = { __testAllowPrivate: true };
const failMetrics: MetricTransport = async () => { throw new Error("no metric endpoint in eval"); };
const quietHn: HnTransport = async () => ({ status: 200, body: JSON.stringify({ hits: [] }) });

function nightlyDeps(croOutput: string, calls?: string[]): NightlyDeps {
  return { harness: nightlyHarness(croOutput, calls), models: { brain: "fake" },
    hnTransport: quietHn, metricTransport: failMetrics, croFetchOpts: seams };
}

const TENANTS = ["biz_croeval_ground", "biz_croeval_auto", "biz_croeval_trigger", "biz_croeval_degrade", "biz_croeval_standing"];
const croActions = (biz: string) => prisma.routeAction.count({ where: { businessId: biz, type: "cro-fix" } });

// FK-safe teardown (edges → nodes → revisions → snapshots → integrations → assets →
// actions → waypoints → routes → objectives → products); leaves the Business row alone.
async function wipeChildren(businessId: string): Promise<void> {
  await prisma.nightlyRun.deleteMany({ where: { businessId } }); // 6j: the diary FK-guards business deletion
  await prisma.memoryEdge.deleteMany({ where: { businessId } });
  await prisma.memoryNode.deleteMany({ where: { businessId } });
  await prisma.routeRevision.deleteMany({ where: { businessId } });
  await prisma.metricSnapshot.deleteMany({ where: { businessId } });
  await prisma.integration.deleteMany({ where: { businessId } });
  await prisma.asset.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
  await prisma.product.deleteMany({ where: { businessId } });
}

async function upsertBusiness(businessId: string): Promise<void> {
  await prisma.business.upsert({ where: { id: businessId },
    create: { id: businessId, name: businessId, maxTokensPerDay: 100000 },
    update: { maxTokensPerDay: 100000 } });
}

/**
 * The measured-flat fixture (revision-eval inv8 recipe): route 6w old + one verified
 * send 1w ago (executedRecent > 0 → NOT stalled) + connected analytics with two EQUAL
 * real snapshots (delta 0 → measured-flat). An ACTIVE waypoint is the cro findings' home,
 * and the Product.url points at the local page. One `clock` drives every offset so the
 * baseline snapshot's capturedAt is exactly the route start (baseline is found).
 */
async function seedMeasuredFlat(businessId: string, productUrl: string): Promise<void> {
  await wipeChildren(businessId);
  await upsertBusiness(businessId);
  const clock = Date.now();
  const wa = (n: number) => new Date(clock - n * WEEK_MS);
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active", createdAt: wa(6) } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "Launch", goal: "go live", status: "active", createdAt: wa(6) } });
  await prisma.product.create({ data: { businessId, url: productUrl, readTier: 3, title: "Acme CLI" } });
  await prisma.routeAction.create({ data: { businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "executed", verifiedAt: wa(1), createdAt: wa(1) } });
  const { integrationId } = await connectIntegration({ businessId }, { kind: "analytics", provider: "http-json", metric: "signups", config: { endpoint: "https://x" } });
  await prisma.metricSnapshot.create({ data: { businessId, integrationId, metric: "signups", value: 100, capturedAt: wa(6) } });
  await prisma.metricSnapshot.create({ data: { businessId, integrationId, metric: "signups", value: 100, capturedAt: wa(0) } });
}

/** A HEALTHY fixture: a young route, no analytics, nothing shipped → getting-started (not measured-flat). */
async function seedHealthy(businessId: string, productUrl: string): Promise<void> {
  await wipeChildren(businessId);
  await upsertBusiness(businessId);
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active" } });
  await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "Launch", goal: "go live", status: "active" } });
  await prisma.product.create({ data: { businessId, url: productUrl, readTier: 3, title: "Acme CLI" } });
}

describe("§15 stage-6e eval gate — CRO findings are page-grounded, never-auto, signal-gated, non-MCP", () => {
  beforeAll(async () => {
    process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    server = http.createServer((req, res) => {
      if (req.url === "/boom") { res.writeHead(500); res.end("nope"); return; }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server.close();
    for (const b of TENANTS) await wipeChildren(b);
    await prisma.business.deleteMany({ where: { id: { in: TENANTS } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("inv1 GROUNDING: a mixed grounded+fabricated audit persists ONLY the grounded finding — the fabrication reaches no row", async () => {
    const BIZ = "biz_croeval_ground";
    await seedMeasuredFlat(BIZ, `${base}/page`);
    vi.spyOn(console, "error").mockImplementation(() => {}); // the dropped-count log is expected

    const res = await runNightly({ businessId: BIZ }, nightlyDeps(ONE_GROUNDED_ONE_FAB));
    expect(res.cro.status).toBe("ok"); // the measured-flat signal fired the CRO section

    // Exactly the grounded survivor — non-vacuous: the model returned TWO findings, one dropped.
    const cro = await prisma.routeAction.findMany({ where: { businessId: BIZ, type: "cro-fix" } });
    expect(cro).toHaveLength(1);
    expect(cro[0]!.rationale).toContain(GROUNDED_EVIDENCE);

    // The fabrication is NOWHERE — not in any routeAction rationale, not in any asset content.
    const actions = await prisma.routeAction.findMany({ where: { businessId: BIZ } });
    expect(actions.some((a) => a.rationale?.includes(FAB_ISSUE))).toBe(false);
    expect(actions.some((a) => a.rationale?.includes(FAB_EVIDENCE))).toBe(false);
    const assets = await prisma.asset.findMany({ where: { businessId: BIZ } });
    expect(assets.some((a) => a.contentJson.includes(FAB_ISSUE))).toBe(false);
    expect(assets.some((a) => a.contentJson.includes(FAB_EVIDENCE))).toBe(false);
  });

  it("inv2 NEVER-AUTO: a full measured-flat night lands proposed, asset-bound, approval-null fixes the drafts step never re-drafts", async () => {
    const BIZ = "biz_croeval_auto";
    await seedMeasuredFlat(BIZ, `${base}/page`);
    const calls: string[] = [];
    const res = await runNightly({ businessId: BIZ }, nightlyDeps(TWO_GROUNDED, calls));
    expect(res.cro.status).toBe("ok");
    // Non-vacuity: the CRO landing-page audit really ran — exactly one cro-def model call.
    expect(calls.filter((c) => c.includes(CRO_FENCE))).toHaveLength(1);

    const cro = await prisma.routeAction.findMany({ where: { businessId: BIZ, type: "cro-fix" } });
    expect(cro).toHaveLength(2); // both grounded findings queued
    for (const a of cro) {
      expect(a.status).toBe("proposed");                  // never-auto: awaiting review
      expect(a.approvedAt).toBeNull();                    // nothing approved
      expect(a.employeeRole).toBe("conversion-optimizer");
      expect(a.assetId).toBeTruthy();                     // asset bound
      // The drafts section (assetless-only + cro-fix-excluded) never re-drafted: ONE asset per action.
      expect(await prisma.asset.count({ where: { businessId: BIZ, routeActionId: a.id } })).toBe(1);
      const asset = await prisma.asset.findFirst({ where: { id: a.assetId!, businessId: BIZ } });
      expect(asset!.kind).toBe("cro-fix");
      expect(asset!.channel).toBe("landing-page");
    }
  });

  it("inv3 TRIGGER CONTRAST: the verdict is the sole discriminator — a healthy night skips CRO, measured-flat runs it", async () => {
    const BIZ = "biz_croeval_trigger";
    // (a) Healthy: young route, no analytics, nothing shipped → getting-started → CRO skipped.
    await seedHealthy(BIZ, `${base}/page`);
    const healthy = await runNightly({ businessId: BIZ }, nightlyDeps(TWO_GROUNDED));
    expect(healthy.cro).toEqual({ status: "skipped", reason: "no traffic-without-conversion signal" });
    expect(await croActions(BIZ)).toBe(0);

    // (b) The SAME business, now measured-flat → CRO runs and lands fixes. Only the verdict changed.
    await seedMeasuredFlat(BIZ, `${base}/page`);
    const flat = await runNightly({ businessId: BIZ }, nightlyDeps(TWO_GROUNDED));
    expect(flat.cro.status).toBe("ok");
    expect(await croActions(BIZ)).toBeGreaterThan(0);
  });

  it("inv4 DEGRADE: measured-flat but the page 500s → CRO skipped, ZERO cro model calls, nothing persisted", async () => {
    const BIZ = "biz_croeval_degrade";
    await seedMeasuredFlat(BIZ, `${base}/boom`); // the Product URL 500s — an unreadable page
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    const res = await runNightly({ businessId: BIZ }, nightlyDeps(TWO_GROUNDED, calls));
    // The verdict gate PASSED (reason is the page, not the signal) but the read failed → honest skip.
    expect(res.cro).toEqual({ status: "skipped", reason: "page unreadable" });
    // ZERO cro-def model calls — the unreadable page is never audited (no fabricated audit).
    expect(calls.filter((c) => c.includes(CRO_FENCE))).toHaveLength(0);
    // Nothing persisted by CRO.
    expect(await croActions(BIZ)).toBe(0);
    expect(await prisma.asset.count({ where: { businessId: BIZ, kind: "cro-fix" } })).toBe(0);
  });

  it("inv5 ONE-STANDING: a second measured-flat night while findings pend proposes no new CRO fixes", async () => {
    const BIZ = "biz_croeval_standing";
    await seedMeasuredFlat(BIZ, `${base}/page`);
    const first = await runNightly({ businessId: BIZ }, nightlyDeps(TWO_GROUNDED));
    expect(first.cro.status).toBe("ok");
    const after = await croActions(BIZ);
    expect(after).toBeGreaterThan(0); // the first night really proposed (non-vacuous baseline)

    const second = await runNightly({ businessId: BIZ }, nightlyDeps(TWO_GROUNDED));
    expect(second.cro).toEqual({ status: "skipped", reason: "CRO findings already pending review" });
    expect(await croActions(BIZ)).toBe(after); // count pinned — no duplicate audits stack up
  });

  it("inv6 WHITELIST: TOOL_SCHEMAS stays exactly 11 and never exposes a CRO tool (CRO is a department pipeline, non-MCP)", () => {
    const names = Object.keys(TOOL_SCHEMAS);
    expect(names).toHaveLength(11);
    for (const forbidden of ["run_cro", "persist_cro_finding", "audit_landing_page"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
