import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import { prisma } from "dionysus-mcp/db";
import { runCro } from "../src/run-cro.js";
import type { Harness, AgentDef } from "../src/llm/types.js";

// A local http server IS the founder's landing page (the 6a metricTransport
// pattern): the Product.url points at it and deps.fetchOpts opens the private
// port. scrapeLadder does a REAL fresh fetch — no fetch stub — so the grounding
// filter checks findings against the actually-fetched body text.
let server: http.Server;
let base = "";
const PAGE = `<html><head><title>Acme CLI</title></head><body>
<h1>Acme CLI for developers</h1>
<p>Ship faster with our command line tool.</p>
<p>Start your free trial today and deploy in minutes.</p>
<button>Get started</button>
</body></html>`;

// __testAllowPrivate lets safeFetch reach the ephemeral loopback port; 127.0.0.1
// is an IP literal so the default DNS lookup resolves it with no lookupFn seam.
const seams = { __testAllowPrivate: true } as never;

let capturedInput = "";
type CountingHarness = Harness & { calls: number };
function fakeHarness(output: string): CountingHarness {
  const h = {
    calls: 0,
    async runAgent(_def: AgentDef, input: string) {
      h.calls++;
      capturedInput = input;
      return { finalOutput: output };
    },
    async completeOnce() { return "unused"; },
  };
  return h;
}

// HAPPY: two findings whose evidence is verbatim on the page.
const TWO_GROUNDED = JSON.stringify({ findings: [
  { issue: "Vague hero headline", evidence: "Acme CLI for developers",
    recommendation: "Lead with the outcome, not the tool name", snippet: "<h1>Ship code 2x faster</h1>" },
  { issue: "Weak value prop", evidence: "Ship faster with our command line tool",
    recommendation: "Quantify the speed gain" },
]});

// FABRICATION: one grounded + one whose evidence is NOT on the page (must drop).
const FAB_ISSUE = "Missing social proof";
const FAB_EVIDENCE = "Trusted by 5000 companies worldwide";
const ONE_GROUNDED_ONE_FAB = JSON.stringify({ findings: [
  { issue: "Buried trial CTA", evidence: "Start your free trial today",
    recommendation: "Move the trial CTA above the fold", snippet: "<a>Start free trial</a>" },
  { issue: FAB_ISSUE, evidence: FAB_EVIDENCE, recommendation: "Add customer logos" },
]});

// An evidence that is all whitespace (>= 8 chars, so it passes the schema) grounds NOTHING —
// `includes("")` would trivially match; it must be dropped like any fabrication.
const WHITESPACE_EVIDENCE = JSON.stringify({ findings: [
  { issue: "Blank quote", evidence: "          ", recommendation: "nope" },
]});

const actionCount = (biz: string) => prisma.routeAction.count({ where: { businessId: biz } });
const assetCount = (biz: string) => prisma.asset.count({ where: { businessId: biz } });

async function reset(biz: string): Promise<void> {
  await prisma.asset.deleteMany({ where: { businessId: biz } });
  await prisma.routeAction.deleteMany({ where: { businessId: biz } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId: biz } });
  await prisma.route.deleteMany({ where: { businessId: biz } });
  await prisma.objective.deleteMany({ where: { businessId: biz } });
  await prisma.product.deleteMany({ where: { businessId: biz } });
}

async function seedTenant(
  biz: string, opts: { product?: string | null; tokens?: number } = {},
): Promise<void> {
  await reset(biz);
  await prisma.business.upsert({ where: { id: biz },
    create: { id: biz, name: biz, maxTokensPerDay: opts.tokens ?? 100000 },
    update: { maxTokensPerDay: opts.tokens ?? 100000 } });
  const obj = await prisma.objective.create({ data: { businessId: biz, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: biz, objectiveId: obj.id, source: "case", status: "active" } });
  await prisma.routeWaypoint.create({ data: { businessId: biz, routeId: route.id, order: 1, title: "Launch", goal: "20 signups", status: "active" } });
  if (opts.product !== null) {
    await prisma.product.create({ data: { businessId: biz, url: opts.product ?? `${base}/page`, readTier: 3, title: "Acme CLI" } });
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/boom") { res.writeHead(500); res.end("nope"); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
afterEach(() => vi.restoreAllMocks());

const deps = (harness: Harness) => ({ harness, models: { brain: "fake" }, fetchOpts: seams });

describe("runCro (fresh page -> verbatim-grounded findings -> never-auto fixes)", () => {
  it("HAPPY: grounded findings become proposed cro-fix actions with bound landing-page assets", async () => {
    const BIZ = "biz_cro_happy";
    await seedTenant(BIZ, {});
    const harness = fakeHarness(TWO_GROUNDED);
    const res = await runCro({ businessId: BIZ }, deps(harness));

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.actionIds).toHaveLength(2);
    expect(res.dropped).toBe(0);

    const actions = await prisma.routeAction.findMany({ where: { businessId: BIZ } });
    expect(actions).toHaveLength(2);
    // Never-auto: every action is a proposed cro-fix on the conversion-optimizer role.
    expect(actions.every((a) => a.status === "proposed")).toBe(true);
    expect(actions.every((a) => a.type === "cro-fix")).toBe(true);
    expect(actions.every((a) => a.employeeRole === "conversion-optimizer")).toBe(true);
    expect(actions.every((a) => a.approvedAt === null)).toBe(true);
    // features { channel: "landing-page", cro: true }
    expect(actions.every((a) => a.featuresJson.includes('"cro":true'))).toBe(true);
    expect(actions.every((a) => a.featuresJson.includes('"channel":"landing-page"'))).toBe(true);
    // rationale cites the verbatim evidence.
    expect(actions.some((a) => a.rationale?.includes("Acme CLI for developers"))).toBe(true);
    expect(actions.some((a) => a.rationale?.includes("Ship faster with our command line tool"))).toBe(true);

    // Each action has a bound asset: title = issue, body carries the recommendation.
    for (const a of actions) {
      expect(a.assetId).toBeTruthy();
      const asset = await prisma.asset.findFirst({ where: { id: a.assetId!, businessId: BIZ } });
      expect(asset).toBeTruthy();
      expect(asset!.channel).toBe("landing-page");
      expect(asset!.kind).toBe("cro-fix");
      expect(asset!.routeActionId).toBe(a.id);
      const content = JSON.parse(asset!.contentJson) as { title: string; body: string };
      expect(content.title.length).toBeGreaterThan(0);
      expect(content.body.length).toBeGreaterThan(0);
    }
    // The snippet-bearing finding folds its snippet into the asset body ("Ready to apply").
    const withSnippet = await prisma.asset.findFirst({ where: { businessId: BIZ, contentJson: { contains: "Ship code 2x faster" } } });
    expect(withSnippet).toBeTruthy();
    expect(withSnippet!.contentJson).toContain("Ready to apply");

    // D20: the page text entered the prompt FENCED as untrusted data.
    expect(capturedInput).toContain("<<<UNTRUSTED-CONTENT");
    expect(capturedInput).toContain("Acme CLI for developers");
    expect(harness.calls).toBe(1);
  });

  it("FABRICATION DROPPED: an ungrounded finding never persists (rationale nor asset)", async () => {
    const BIZ = "biz_cro_fab";
    await seedTenant(BIZ, {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = fakeHarness(ONE_GROUNDED_ONE_FAB);
    const res = await runCro({ businessId: BIZ }, deps(harness));

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.actionIds).toHaveLength(1);
    expect(res.dropped).toBe(1);
    expect(console.error).toHaveBeenCalled(); // dropped count logged, never silently invented

    // Only the grounded finding survives.
    expect(await actionCount(BIZ)).toBe(1);
    expect(await assetCount(BIZ)).toBe(1);

    // The fabricated issue + evidence appear NOWHERE — not in any rationale, not in any asset.
    const actions = await prisma.routeAction.findMany({ where: { businessId: BIZ } });
    expect(actions.some((a) => a.rationale?.includes(FAB_ISSUE))).toBe(false);
    expect(actions.some((a) => a.rationale?.includes(FAB_EVIDENCE))).toBe(false);
    const assets = await prisma.asset.findMany({ where: { businessId: BIZ } });
    expect(assets.some((a) => a.contentJson.includes(FAB_ISSUE))).toBe(false);
    expect(assets.some((a) => a.contentJson.includes(FAB_EVIDENCE))).toBe(false);
    // The survivor is the grounded one.
    expect(actions[0]!.rationale).toContain("Start your free trial today");
  });

  it("FABRICATION DROPPED: a whitespace-only evidence grounds nothing and never persists", async () => {
    const BIZ = "biz_cro_blank";
    await seedTenant(BIZ, {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await runCro({ businessId: BIZ }, deps(fakeHarness(WHITESPACE_EVIDENCE)));
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.actionIds).toHaveLength(0);
    expect(res.dropped).toBe(1);
    expect(await actionCount(BIZ)).toBe(0);
    expect(await assetCount(BIZ)).toBe(0);
  });

  it("DEGRADE no product: skipped with NO model call, nothing persisted", async () => {
    const BIZ = "biz_cro_noprod";
    await seedTenant(BIZ, { product: null });
    const harness = fakeHarness(TWO_GROUNDED);
    const res = await runCro({ businessId: BIZ }, deps(harness));
    expect(res).toEqual({ status: "skipped", reason: "no product page on record" });
    expect(harness.calls).toBe(0);
    expect(await actionCount(BIZ)).toBe(0);
    expect(await assetCount(BIZ)).toBe(0);
  });

  it("DEGRADE unreadable page (HTTP 500): skipped with NO model call, nothing persisted", async () => {
    const BIZ = "biz_cro_500";
    await seedTenant(BIZ, { product: `${base}/boom` });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = fakeHarness(TWO_GROUNDED);
    const res = await runCro({ businessId: BIZ }, deps(harness));
    expect(res).toEqual({ status: "skipped", reason: "page unreadable" });
    expect(harness.calls).toBe(0);
    expect(await actionCount(BIZ)).toBe(0);
    expect(await assetCount(BIZ)).toBe(0);
  });

  it("DEGRADE no active waypoint: skipped, nothing persisted", async () => {
    const BIZ = "biz_cro_nowp";
    await seedTenant(BIZ, {});
    // Retire the active waypoint so none remains active.
    await prisma.routeWaypoint.updateMany({ where: { businessId: BIZ }, data: { status: "done" } });
    const harness = fakeHarness(TWO_GROUNDED);
    const res = await runCro({ businessId: BIZ }, deps(harness));
    expect(res).toEqual({ status: "skipped", reason: "no active waypoint" });
    expect(harness.calls).toBe(0);
    expect(await actionCount(BIZ)).toBe(0);
  });

  it("ONE-STANDING: a second run while findings pend is skipped, counts unchanged", async () => {
    const BIZ = "biz_cro_standing";
    await seedTenant(BIZ, {});
    const first = await runCro({ businessId: BIZ }, deps(fakeHarness(TWO_GROUNDED)));
    expect(first.status).toBe("ok");
    const actionsAfterFirst = await actionCount(BIZ);
    const assetsAfterFirst = await assetCount(BIZ);

    const second = await runCro({ businessId: BIZ }, deps(fakeHarness(TWO_GROUNDED)));
    expect(second).toEqual({ status: "skipped", reason: "CRO findings already pending review" });
    expect(await actionCount(BIZ)).toBe(actionsAfterFirst);
    expect(await assetCount(BIZ)).toBe(assetsAfterFirst);
  });

  it("ASSETLESS ORPHAN never wedges: a proposed cro-fix with assetId null does NOT suppress a re-run", async () => {
    const BIZ = "biz_cro_orphan";
    await seedTenant(BIZ, {});
    // A crash between upsertRouteAction and setActionAsset leaves a proposed cro-fix
    // action with assetId null: it matches the old standing predicate (proposed +
    // "cro":true) yet is invisible on /drafts (listProposedDrafts requires assetId).
    // Such an orphan must NEVER wedge the employee — runCro must still proceed.
    const wp = await prisma.routeWaypoint.findFirst({ where: { businessId: BIZ, status: "active" } });
    await prisma.routeAction.create({ data: {
      businessId: BIZ, waypointId: wp!.id, employeeRole: "conversion-optimizer", type: "cro-fix",
      status: "proposed", featuresJson: '{"channel":"landing-page","cro":true}', assetId: null } });

    const res = await runCro({ businessId: BIZ }, deps(fakeHarness(TWO_GROUNDED)));

    // Must PROCEED — not skip "CRO findings already pending review".
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.actionIds).toHaveLength(2);
    // The two fresh grounded findings landed WITH bound assets (visible on /drafts).
    const bound = await prisma.routeAction.findMany({ where: { businessId: BIZ, type: "cro-fix", assetId: { not: null } } });
    expect(bound).toHaveLength(2);
    expect(await assetCount(BIZ)).toBe(2);
  });

  it("BUDGET fail-closed FIRST: over cap throws, NO model call, nothing persisted", async () => {
    const BIZ = "biz_cro_budget";
    await seedTenant(BIZ, { tokens: 0 });
    const harness = fakeHarness(TWO_GROUNDED);
    await expect(runCro({ businessId: BIZ }, deps(harness))).rejects.toThrow(/budget/i);
    expect(harness.calls).toBe(0);
    expect(await actionCount(BIZ)).toBe(0);
    expect(await assetCount(BIZ)).toBe(0);
  });
});
