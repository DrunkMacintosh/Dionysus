import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import { prisma } from "dionysus-mcp/db";
import { runOutreach, MAX_PITCHES_PER_NIGHT } from "../src/run-outreach.js";
import type { Harness, AgentDef } from "../src/llm/types.js";

// A local http server IS the founder-named target's page (the 6e run-cro pattern):
// the request's featuresJson.targetUrl points at it and deps.fetchOpts opens the
// private port. scrapeLadder does a REAL fresh fetch — no fetch stub — so the
// grounding filter checks the pitch's evidence against the actually-fetched text.
let server: http.Server;
let base = "";
const PAGE = `<html><head><title>The Dev Digest</title></head><body>
<h1>The Dev Digest — a weekly newsletter for backend engineers</h1>
<p>This week we covered database indexing strategies and query planners.</p>
<p>Subscribe for a deep dive every Thursday.</p>
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

// HAPPY: a pitch whose personalizationEvidence is verbatim on the target page.
const GROUNDED_EVIDENCE = "database indexing strategies";
const GROUNDED_PITCH = JSON.stringify({
  subject: "A CLI your backend readers would actually use",
  body: "Hi — I loved your piece on database indexing strategies and had to reach out about a tool I built for exactly that audience.",
  personalizationEvidence: GROUNDED_EVIDENCE,
});

// FABRICATION: evidence NOT on the page (invented familiarity → must be dropped).
const FAB_EVIDENCE = "your legendary fifty-thousand subscriber list";
const FAB_PITCH = JSON.stringify({
  subject: "Partnership?",
  body: "Hi — congratulations on your legendary fifty-thousand subscriber list, I would love to collaborate with you.",
  personalizationEvidence: FAB_EVIDENCE,
});

// MALFORMED: no JSON object at all → parsePitch fails BOTH the initial attempt and its one
// retry (the harness echoes the same unparseable text), so parsePitch throws.
const MALFORMED_OUTPUT = "The model rambled on and never produced a JSON object at all.";

// A harness that returns VALID output ONLY when the input mentions `validForName`, else
// MALFORMED. The loop is oldest-first, so the older request's ctx (a different name) AND
// its parse-retry (the error-summary string, which also omits the name) both get MALFORMED
// and parsePitch throws for it — deterministically — before the newer request is reached.
function keyedHarness(validForName: string, valid: string, malformed: string): CountingHarness {
  const h = {
    calls: 0,
    async runAgent(_def: AgentDef, input: string) {
      h.calls++;
      capturedInput = input;
      return { finalOutput: input.includes(validForName) ? valid : malformed };
    },
    async completeOnce() { return "unused"; },
  };
  return h;
}

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

// Seed a tenant with an objective/route/active-waypoint + a latest Product (the own-
// product block source) and return the waypoint id so tests can hang pitch requests.
async function seedTenant(biz: string, opts: { tokens?: number } = {}): Promise<string> {
  await reset(biz);
  await prisma.business.upsert({ where: { id: biz },
    create: { id: biz, name: biz, maxTokensPerDay: opts.tokens ?? 100000 },
    update: { maxTokensPerDay: opts.tokens ?? 100000 } });
  const obj = await prisma.objective.create({ data: { businessId: biz, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: biz, objectiveId: obj.id, source: "case", status: "active" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: biz, routeId: route.id, order: 1, title: "Launch", goal: "20 signups", status: "active" } });
  await prisma.product.create({ data: { businessId: biz, url: `${base}/product`, readTier: 3, title: "Acme CLI", description: "Ship faster from the command line." } });
  return wp.id;
}

// A pending founder pitch request: proposed outreach-pitch, assetId null, target in features.
// createdAt is set EXPLICITLY so the cap's oldest-first ordering is deterministic.
async function addRequest(
  biz: string, wpId: string,
  opts: { targetName?: string; targetUrl?: string; createdAt?: Date; malformed?: boolean } = {},
): Promise<string> {
  const row = await prisma.routeAction.create({ data: {
    businessId: biz, waypointId: wpId, employeeRole: "outreach", type: "outreach-pitch", status: "proposed",
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    featuresJson: opts.malformed
      ? "{ not valid json"
      : JSON.stringify({ channel: "outreach-email", outreach: true,
          targetUrl: opts.targetUrl ?? `${base}/page`, targetName: opts.targetName ?? "The Dev Digest" }) } });
  return row.id;
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

describe("runOutreach (founder-targeted -> page-grounded -> draft-only pitches)", () => {
  it("HAPPY: a grounded pitch binds a proposed outreach-email asset {title: subject}; features intact; page fenced", async () => {
    const BIZ = "biz_outreach_happy";
    const wpId = await seedTenant(BIZ);
    const requestId = await addRequest(BIZ, wpId);
    const harness = fakeHarness(GROUNDED_PITCH);
    const res = await runOutreach({ businessId: BIZ }, deps(harness));

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.drafted).toEqual([requestId]);
    expect(res.skipped).toBe(0);
    expect(res.dropped).toBe(0);
    expect(harness.calls).toBe(1);

    // Never-auto: the request is STILL a proposed outreach-pitch, approvedAt null, now asset-bound.
    const action = await prisma.routeAction.findUnique({ where: { id: requestId } });
    expect(action!.status).toBe("proposed");
    expect(action!.type).toBe("outreach-pitch");
    expect(action!.employeeRole).toBe("outreach");
    expect(action!.approvedAt).toBeNull();
    expect(action!.assetId).toBeTruthy();
    // The founder's target survives byte-for-byte in features (drafting never rewrites it).
    expect(action!.featuresJson).toContain('"targetName":"The Dev Digest"');
    expect(action!.featuresJson).toContain('"targetUrl"');

    // The bound asset: outreach-email / outreach-pitch, title = subject, body = the pitch.
    const asset = await prisma.asset.findFirst({ where: { id: action!.assetId!, businessId: BIZ } });
    expect(asset!.channel).toBe("outreach-email");
    expect(asset!.kind).toBe("outreach-pitch");
    expect(asset!.routeActionId).toBe(requestId);
    const content = JSON.parse(asset!.contentJson) as { title: string; body: string };
    expect(content.title).toBe("A CLI your backend readers would actually use");
    expect(content.body).toContain("database indexing strategies");

    // D20: ONLY the target page is fenced (attacker-influenceable); the own-product block is
    // PLAIN (trusted own data) — it appears BEFORE the fence marker, outside the fenced region.
    expect(capturedInput).toContain('Draft a pitch to "The Dev Digest"');
    expect(capturedInput).toContain("Your product: Acme CLI");
    expect(capturedInput).toContain("<<<UNTRUSTED-CONTENT target-page");
    expect(capturedInput).toContain(GROUNDED_EVIDENCE); // the page text is inside the fence
    expect(capturedInput.indexOf("Your product: Acme CLI")).toBeLessThan(capturedInput.indexOf("<<<UNTRUSTED-CONTENT"));
  });

  it("GROUNDING: a fabricated-evidence pitch is DROPPED before persistence; the request stays undrafted", async () => {
    const BIZ = "biz_outreach_fab";
    const wpId = await seedTenant(BIZ);
    const requestId = await addRequest(BIZ, wpId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = fakeHarness(FAB_PITCH);
    const res = await runOutreach({ businessId: BIZ }, deps(harness));

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.drafted).toHaveLength(0);
    expect(res.dropped).toBe(1);
    expect(res.skipped).toBe(0);
    expect(console.error).toHaveBeenCalled(); // the drop is logged, never silently invented

    // The request stays undrafted (assetId null) → it retries next night; NO asset was written.
    const action = await prisma.routeAction.findUnique({ where: { id: requestId } });
    expect(action!.assetId).toBeNull();
    expect(await assetCount(BIZ)).toBe(0);
    // The fabricated familiarity appears in NO asset row.
    const assets = await prisma.asset.findMany({ where: { businessId: BIZ } });
    expect(assets.some((a) => a.contentJson.includes(FAB_EVIDENCE))).toBe(false);
  });

  it("UNREADABLE: a target page 500 → skipped with NO model call; the request stays undrafted", async () => {
    const BIZ = "biz_outreach_500";
    const wpId = await seedTenant(BIZ);
    const requestId = await addRequest(BIZ, wpId, { targetUrl: `${base}/boom` });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = fakeHarness(GROUNDED_PITCH);
    const res = await runOutreach({ businessId: BIZ }, deps(harness));

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.skipped).toBe(1);
    expect(res.drafted).toHaveLength(0);
    expect(harness.calls).toBe(0); // never a fabricated pitch about a page we couldn't read
    const action = await prisma.routeAction.findUnique({ where: { id: requestId } });
    expect(action!.assetId).toBeNull(); // undrafted → retries next night
    expect(await assetCount(BIZ)).toBe(0);
  });

  it("NO-REQUESTS: zero pending → skipped with ZERO model calls AND no budget throw even at 0 budget", async () => {
    const BIZ = "biz_outreach_norq";
    await seedTenant(BIZ, { tokens: 0 }); // budget exhausted, but the pending-check precedes checkBudget
    const harness = fakeHarness(GROUNDED_PITCH);
    const res = await runOutreach({ businessId: BIZ }, deps(harness));
    expect(res).toEqual({ status: "skipped", reason: "no pitch requests pending" });
    expect(harness.calls).toBe(0);
    expect(await actionCount(BIZ)).toBe(0);
  });

  it("CAP: 4 pending → exactly MAX_PITCHES_PER_NIGHT drafted OLDEST-FIRST; the newest stays undrafted", async () => {
    const BIZ = "biz_outreach_cap";
    const wpId = await seedTenant(BIZ);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Four requests with strictly increasing createdAt so oldest-first is deterministic.
    const t0 = new Date("2026-07-10T00:00:00Z").getTime();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await addRequest(BIZ, wpId, { targetName: `Target ${i}`, createdAt: new Date(t0 + i * 60000) }));
    }
    const harness = fakeHarness(GROUNDED_PITCH);
    const res = await runOutreach({ businessId: BIZ }, deps(harness));

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.drafted).toHaveLength(MAX_PITCHES_PER_NIGHT); // exactly 3
    // The OLDEST 3 (ids[0..2]) were drafted; the NEWEST (ids[3]) is the 1 remaining, undrafted.
    expect(res.drafted.sort()).toEqual(ids.slice(0, 3).sort());
    for (const id of ids.slice(0, 3)) {
      expect((await prisma.routeAction.findUnique({ where: { id } }))!.assetId).toBeTruthy();
    }
    expect((await prisma.routeAction.findUnique({ where: { id: ids[3]! } }))!.assetId).toBeNull();
    expect(await assetCount(BIZ)).toBe(3);
    // The cap is reported, never silent (the 1 deferred request is logged).
    expect(console.error).toHaveBeenCalled();
  });

  it("MALFORMED features: skipped with no crash; the request stays undrafted", async () => {
    const BIZ = "biz_outreach_malformed";
    const wpId = await seedTenant(BIZ);
    const requestId = await addRequest(BIZ, wpId, { malformed: true });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = fakeHarness(GROUNDED_PITCH);
    const res = await runOutreach({ businessId: BIZ }, deps(harness));

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.skipped).toBe(1);
    expect(res.drafted).toHaveLength(0);
    expect(harness.calls).toBe(0); // malformed features never reach a fetch or a model call
    const action = await prisma.routeAction.findUnique({ where: { id: requestId } });
    expect(action!.assetId).toBeNull();
    expect(await assetCount(BIZ)).toBe(0);
  });

  it("MODEL-PARSE ISOLATION: an unparseable OLDER pitch is skipped, never aborting the batch; the NEWER request still drafts", async () => {
    const BIZ = "biz_outreach_parse_iso";
    const wpId = await seedTenant(BIZ);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Two pending requests, both with readable pages (same server). createdAt is explicit so
    // the OLDER (poison) is processed first, oldest-first — head-of-line if the throw escapes.
    const t0 = new Date("2026-07-11T00:00:00Z").getTime();
    const olderId = await addRequest(BIZ, wpId, { targetName: "Older Newsletter", createdAt: new Date(t0) });
    const newerId = await addRequest(BIZ, wpId, { targetName: "Newer Newsletter", createdAt: new Date(t0 + 60000) });
    // MALFORMED for the OLDER (its ctx + retry omit "Newer Newsletter"); a grounded pitch for the NEWER.
    const harness = keyedHarness("Newer Newsletter", GROUNDED_PITCH, MALFORMED_OUTPUT);
    const res = await runOutreach({ businessId: BIZ }, deps(harness));

    // The night did NOT throw: one poison request cannot sink the batch (no head-of-line blocking).
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    // The NEWER request drafted despite the OLDER one's unparseable output.
    expect(res.drafted).toEqual([newerId]);
    // The OLDER parse failure is counted in the skip accounting (a non-drafted, non-grounding degrade).
    expect(res.skipped).toBe(1);
    expect(res.dropped).toBe(0);
    expect(console.error).toHaveBeenCalled(); // the skip is logged, never silent

    // NEWER: drafted → assetId set, still a proposed outreach-pitch; the asset was persisted.
    const newer = await prisma.routeAction.findUnique({ where: { id: newerId } });
    expect(newer!.assetId).toBeTruthy();
    expect(newer!.status).toBe("proposed");
    // OLDER: undrafted → assetId null, still proposed → it retries next night.
    const older = await prisma.routeAction.findUnique({ where: { id: olderId } });
    expect(older!.assetId).toBeNull();
    expect(older!.status).toBe("proposed");
    // Exactly one asset was written (the newer's); the poison request wrote nothing partial.
    expect(await assetCount(BIZ)).toBe(1);
  });
});
