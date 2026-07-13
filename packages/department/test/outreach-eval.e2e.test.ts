// §15 stage-6g eval gate — the OUTREACH/PR employee, wired into the nightly, is
// (inv1) FOUNDER-TARGETED ONLY (the anti-fabrication rule for contacts: a full nightly on
// a business with an objective/route/waypoint but ZERO pitch requests makes ZERO outreach
// model calls and creates ZERO outreach actions — Dionysus never invents a target, while
// OTHER sections DO call the model, proving the probe distinguishes an outreach call),
// (inv2) GROUNDED OR UNDRAFTED (a pitch quoting evidence NOT on the target page is dropped
// before persistence — the fabricated text reaches NO asset row anywhere in the tenant —
// while a grounded sibling drafts in the same run, so the drop is a real drop, not a dead
// pipeline), (inv3) NEVER-AUTO END-TO-END (a full grounded night lands the pitch proposed +
// asset-bound + approval-null, kind outreach-pitch — the copywriter, which runs AFTER
// outreach, never double-drafts it: exactly one asset per action), (inv4) HONEST DEGRADE +
// REAL RETRY (night 1 target 500 → zero outreach model calls, undrafted; night 2 healthy →
// the SAME request drafts), (inv5) CAP HONESTY (4 requests with scrambled insertion vs
// createdAt order → exactly the 3 OLDEST draft, the newest defers, the section detail says
// so), and (inv6) NON-MCP (the whitelist stays 11 — outreach is a department pipeline,
// never an agent-assertable tool).
//
// A local node:http server IS each founder-named target's page: /page serves it 200, /boom
// 500s, and /toggle flips 200/500 for the retry night. Each pitch request's featuresJson
// targetUrl points at it and outreachFetchOpts opens the loopback port (`__testAllowPrivate`)
// so scrapeLadder does a REAL fresh fetch — the grounding filter checks the pitch's evidence
// against the actually-fetched body. The dual-purpose harness (the nightly-eval/cro-eval
// dispatch pattern) answers the outreach call from the target-page fence, the copywriter from
// the "Action: draft" line, else the (quiet) radar payload — and records every input so a
// test can COUNT the outreach calls. The probe is the fence label runOutreach wraps the page
// in (`fence("target-page", text)`): radar fences "hn-signals", the copywriter
// "waypoint-context"/"route-so-far", the CRO "landing-page", and fence() defangs any marker
// look-alike inside recalled content — so counting inputs that carry `<<<UNTRUSTED-CONTENT
// target-page>>>` is a bulletproof, non-vacuous "did an outreach model call really happen?"
// probe. Tenants live under biz_outreacheval_* so this gate never collides with other suites.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import { prisma } from "dionysus-mcp/db";
import { CONFIG_KEY_ENV } from "dionysus-mcp/lib/secret-box";
import type { SafeFetchOptions } from "dionysus-mcp/lib/ssrf";
import type { MetricTransport } from "dionysus-mcp/tools/analytics";
import { TOOL_SCHEMAS } from "dionysus-mcp/server";
import type { Harness, AgentDef } from "../src/llm/types.js";
import type { HnTransport } from "../src/tools/hn-source.js";
import { runNightly, type NightlyDeps } from "../src/run-nightly.js";
import { runOutreach, MAX_PITCHES_PER_NIGHT } from "../src/run-outreach.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// The founder-named target's page (identical surface to run-outreach.test.ts, so the
// extracted-text grounding is the SAME proven behaviour).
const PAGE = `<html><head><title>The Dev Digest</title></head><body>
<h1>The Dev Digest — a weekly newsletter for backend engineers</h1>
<p>This week we covered database indexing strategies and query planners.</p>
<p>Subscribe for a deep dive every Thursday.</p>
</body></html>`;

// The EXACT fence opener runOutreach wraps the target page in (`fence("target-page", text)`).
// Unique to the outreach model call — see the file header — so counting inputs that contain
// it is a non-vacuous "did an outreach call really run?" probe.
const OUTREACH_FENCE = "<<<UNTRUSTED-CONTENT target-page>>>";

// GROUNDED: personalizationEvidence is verbatim on PAGE → the pitch survives grounding.
const GROUNDED_EVIDENCE = "database indexing strategies";
const GROUNDED_PITCH = JSON.stringify({
  subject: "A CLI your backend readers would actually use",
  body: "Hi — I loved your piece on database indexing strategies and had to reach out about a tool built for exactly that audience.",
  personalizationEvidence: GROUNDED_EVIDENCE,
});

// FABRICATION: a UNIQUE invented-familiarity phrase that is NOT on PAGE — if it ever reached
// an asset row, the tenant-wide search below would catch it. Grounding must drop it first.
const FAB_EVIDENCE = "your fabled quarter-million cephalopod subscriber cabal";
const FAB_PITCH = JSON.stringify({
  subject: "Partnership?",
  body: `Hi — congratulations on ${FAB_EVIDENCE}, I would love to collaborate with you and your readers.`,
  personalizationEvidence: FAB_EVIDENCE,
});

// The copywriter (drafts section) payload — a channel-native draft that parseDraft accepts.
const DRAFT_JSON = JSON.stringify({ channel: "hackernews", kind: "post", content: { title: "Note", body: "A crisp launch note for HN." } });
// The radar / default payload — an empty (but valid) observations set: a quiet radar night.
const OBSERVATIONS_JSON = JSON.stringify({ observations: [] });

// Dual-purpose fake harness (the nightly-eval/cro-eval dispatch): the outreach pitch when the
// input carries the target-page fence (chosen per-input so inv2 can key on the target name),
// the draft payload for the copywriter, else the quiet radar payload. Records every input so a
// test can count the outreach-fence calls.
function nightlyHarness(outreach: string | ((input: string) => string), calls?: string[]): Harness {
  const pickPitch = typeof outreach === "function" ? outreach : () => outreach;
  return {
    async runAgent(_def: AgentDef, input: string) {
      calls?.push(input);
      if (input.includes(OUTREACH_FENCE)) return { finalOutput: pickPitch(input) };
      if (input.includes("Action: draft")) return { finalOutput: DRAFT_JSON };
      return { finalOutput: OBSERVATIONS_JSON };
    },
    async completeOnce() { return "unused"; },
  };
}

// outreachFetchOpts opens the ephemeral loopback port for the REAL target fetch; a throwing
// metric transport keeps the metrics section from connecting anything; a zero-signal HN
// transport keeps radar quiet (no model call) except where a test opts into one signal.
const seams: SafeFetchOptions = { __testAllowPrivate: true };
const failMetrics: MetricTransport = async () => { throw new Error("no metric endpoint in outreach eval"); };
const quietHn: HnTransport = async () => ({ status: 200, body: JSON.stringify({ hits: [] }) });
// One grounded HN signal so RADAR makes a real (NON-outreach) model call — inv1's contrast.
const oneSignalHn: HnTransport = async () => ({ status: 200, body: JSON.stringify({ hits: [{ title: "S0", objectID: "0", points: 100 }] }) });

function nightlyDeps(outreach: string | ((input: string) => string), calls?: string[], opts: { hn?: HnTransport } = {}): NightlyDeps {
  return { harness: nightlyHarness(outreach, calls), models: { brain: "fake" },
    hnTransport: opts.hn ?? quietHn, metricTransport: failMetrics, outreachFetchOpts: seams };
}

const TENANTS = ["biz_outreacheval_founder", "biz_outreacheval_ground", "biz_outreacheval_auto", "biz_outreacheval_degrade", "biz_outreacheval_cap"];

// FK-safe teardown (edges → nodes → revisions → snapshots → integrations → assets → actions →
// waypoints → routes → objectives → products); leaves the Business row alone. Children first.
async function wipeChildren(businessId: string): Promise<void> {
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

// A business with an active objective/route/waypoint + a latest Product (no analytics → the
// CRO verdict is never measured-flat, so the CRO section stays skipped). Returns the active
// waypoint id so a test can hang founder pitch requests off it. Newest Product is the own-
// product block source in runOutreach.
async function seedBusiness(businessId: string, productUrl: string): Promise<string> {
  await wipeChildren(businessId);
  await prisma.business.upsert({ where: { id: businessId },
    create: { id: businessId, name: businessId, maxTokensPerDay: 100000 },
    update: { maxTokensPerDay: 100000 } });
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "Launch", goal: "go live", status: "active" } });
  await prisma.product.create({ data: { businessId, url: productUrl, readTier: 3, title: "Acme CLI", description: "Ship faster from the command line." } });
  return wp.id;
}

// A pending founder pitch request: a proposed outreach-pitch action, assetId null, the
// founder-supplied target in featuresJson. createdAt is set EXPLICITLY so oldest-first is
// deterministic (and, in inv5, so insertion order can be scrambled relative to createdAt).
async function addPitchRequest(
  businessId: string, waypointId: string,
  opts: { targetName: string; targetUrl: string; createdAt?: Date },
): Promise<string> {
  const row = await prisma.routeAction.create({ data: {
    businessId, waypointId, employeeRole: "outreach", type: "outreach-pitch", status: "proposed",
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    featuresJson: JSON.stringify({ channel: "outreach-email", outreach: true, targetUrl: opts.targetUrl, targetName: opts.targetName }) } });
  return row.id;
}

// A plain undrafted copywriter proposal so the DRAFTS section actually runs — proving the
// copywriter is active this night yet still never touches the outreach pitch.
async function addPlainPost(businessId: string, waypointId: string): Promise<string> {
  const row = await prisma.routeAction.create({ data: {
    businessId, waypointId, employeeRole: "copywriter", type: "post", status: "proposed",
    featuresJson: JSON.stringify({ channel: "hackernews" }) } });
  return row.id;
}

let server: http.Server;
let base = "";
// /toggle flips between 200 (healthy) and 500 (down) so inv4 can degrade then recover the
// SAME target URL across two nights. Only the /toggle path reads this; /page and /boom are
// fixed, so no other test is affected by the flag's value.
let toggleHealthy = true;

describe("§15 stage-6g eval gate — outreach is founder-targeted, page-grounded, draft-only, capped, non-MCP", () => {
  beforeAll(async () => {
    process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    server = http.createServer((req, res) => {
      if (req.url === "/boom") { res.writeHead(500); res.end("nope"); return; }
      if (req.url === "/toggle" && !toggleHealthy) { res.writeHead(500); res.end("down"); return; }
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

  it("inv1 FOUNDER-TARGETED ONLY: a full nightly with ZERO pitch requests makes ZERO outreach model calls and invents no target", async () => {
    const BIZ = "biz_outreacheval_founder";
    await seedBusiness(BIZ, `${base}/page`); // objective/route/active waypoint/product — but NO pitch requests
    vi.spyOn(console, "error").mockImplementation(() => {}); // radar dedup / draft best-effort logs are expected

    // One HN signal makes RADAR make a real model call — a NON-outreach section call. If the
    // probe were counting the wrong thing, this call would pollute the outreach count.
    const calls: string[] = [];
    const res = await runNightly({ businessId: BIZ }, nightlyDeps(GROUNDED_PITCH, calls, { hn: oneSignalHn }));

    // Outreach never entered its pipeline: no founder target exists, so runOutreach short-circuits
    // on the pending-check BEFORE any budget/fetch/model work.
    expect(res.outreach).toEqual({ status: "skipped", reason: "no pitch requests pending" });
    // The probe: ZERO model calls carried the target-page fence...
    expect(calls.filter((c) => c.includes(OUTREACH_FENCE))).toHaveLength(0);
    // ...while OTHER sections DID call the model (non-vacuous: the night really ran — radar made a call).
    expect(res.radar.status).toBe("ok");
    expect(calls.filter((c) => !c.includes(OUTREACH_FENCE)).length).toBeGreaterThan(0);
    // Dionysus never ORIGINATED a target: zero outreach actions + zero outreach assets exist.
    expect(await prisma.routeAction.count({ where: { businessId: BIZ, type: "outreach-pitch" } })).toBe(0);
    expect(await prisma.asset.count({ where: { businessId: BIZ, kind: "outreach-pitch" } })).toBe(0);
  });

  it("inv2 GROUNDED OR UNDRAFTED: a fabricated-evidence pitch is dropped tenant-wide while a grounded sibling drafts in the same run", async () => {
    const BIZ = "biz_outreacheval_ground";
    const wpId = await seedBusiness(BIZ, `${base}/page`);
    vi.spyOn(console, "error").mockImplementation(() => {}); // the drop is logged, never silent

    // Two founder requests against the SAME readable page: the harness keys on the target name in
    // the outreach ctx — one gets fabricated evidence, one gets grounded evidence.
    const fabId = await addPitchRequest(BIZ, wpId, { targetName: "Fab Target", targetUrl: `${base}/page`, createdAt: new Date("2026-07-10T00:00:00Z") });
    const groundedId = await addPitchRequest(BIZ, wpId, { targetName: "Grounded Target", targetUrl: `${base}/page`, createdAt: new Date("2026-07-11T00:00:00Z") });

    const pickPitch = (input: string) => (input.includes("Grounded Target") ? GROUNDED_PITCH : FAB_PITCH);
    const res = await runOutreach({ businessId: BIZ }, { harness: nightlyHarness(pickPitch), models: { brain: "fake" }, fetchOpts: seams });

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    // The grounded sibling DID draft — the pipeline is alive, so the drop below is a real drop, not a dead run.
    expect(res.drafted).toEqual([groundedId]);
    expect(res.dropped).toBe(1);

    // Fabricated familiarity → the fab request stays assetless (retries next night)...
    expect((await prisma.routeAction.findUnique({ where: { id: fabId } }))!.assetId).toBeNull();
    // ...and the grounded request is asset-bound.
    expect((await prisma.routeAction.findUnique({ where: { id: groundedId } }))!.assetId).toBeTruthy();
    // The unique fabricated string appears in NO asset row anywhere in the tenant (searched across ALL rows).
    const assets = await prisma.asset.findMany({ where: { businessId: BIZ } });
    expect(assets).toHaveLength(1); // only the grounded pitch persisted
    expect(assets.some((a) => a.contentJson.includes(FAB_EVIDENCE))).toBe(false);
  });

  it("inv3 NEVER-AUTO END-TO-END: a grounded night lands the pitch proposed + asset-bound + approval-null; the copywriter never double-drafts it", async () => {
    const BIZ = "biz_outreacheval_auto";
    const wpId = await seedBusiness(BIZ, `${base}/page`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pitchId = await addPitchRequest(BIZ, wpId, { targetName: "The Dev Digest", targetUrl: `${base}/page`, createdAt: new Date("2026-07-10T00:00:00Z") });
    // A plain undrafted post so the DRAFTS (copywriter) section actually runs this night.
    await addPlainPost(BIZ, wpId);

    const calls: string[] = [];
    const res = await runNightly({ businessId: BIZ }, nightlyDeps(GROUNDED_PITCH, calls));

    expect(res.outreach.status).toBe("ok");
    // Non-vacuous: the outreach audit really ran — exactly one model call carried the target-page fence.
    expect(calls.filter((c) => c.includes(OUTREACH_FENCE))).toHaveLength(1);
    // Non-vacuous: the copywriter really drafted this night (the plain post) yet left the pitch alone.
    expect(calls.some((c) => c.includes("Action: draft"))).toBe(true);
    expect(res.drafts.status).toBe("ok");

    // Never-auto: the pitch is a PROPOSED, asset-bound, approval-null outreach-pitch action.
    const pitch = await prisma.routeAction.findUnique({ where: { id: pitchId } });
    expect(pitch!.status).toBe("proposed");
    expect(pitch!.type).toBe("outreach-pitch");
    expect(pitch!.employeeRole).toBe("outreach");
    expect(pitch!.approvedAt).toBeNull();
    expect(pitch!.assetId).toBeTruthy();
    // Exactly ONE asset bound to the pitch action, kind outreach-pitch — the copywriter (which runs
    // AFTER outreach) never re-drafted it (assetless-only + type-excluded in draftWaypoint).
    const pitchAssets = await prisma.asset.findMany({ where: { businessId: BIZ, routeActionId: pitchId } });
    expect(pitchAssets).toHaveLength(1);
    expect(pitchAssets[0]!.kind).toBe("outreach-pitch"); // the kind listSendQueue EXCLUDES (a private email has no public URL to verify)
    expect(pitchAssets[0]!.channel).toBe("outreach-email");
    // Tenant-wide: exactly one outreach-pitch asset exists — no duplicate drafting anywhere.
    expect(await prisma.asset.count({ where: { businessId: BIZ, kind: "outreach-pitch" } })).toBe(1);
  });

  it("inv4 HONEST DEGRADE + REAL RETRY: night 1 target 500 → zero outreach model calls, undrafted; night 2 healthy → the SAME request drafts", async () => {
    const BIZ = "biz_outreacheval_degrade";
    const wpId = await seedBusiness(BIZ, `${base}/toggle`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pitchId = await addPitchRequest(BIZ, wpId, { targetName: "The Dev Digest", targetUrl: `${base}/toggle`, createdAt: new Date("2026-07-10T00:00:00Z") });

    // NIGHT 1 — the target page 500s. Honest skip: NO model call, the request stays undrafted.
    toggleHealthy = false;
    const calls1: string[] = [];
    const night1 = await runNightly({ businessId: BIZ }, nightlyDeps(GROUNDED_PITCH, calls1));
    expect(night1.outreach.status).toBe("ok"); // the section ran and honestly skipped the unreadable target
    expect(calls1.filter((c) => c.includes(OUTREACH_FENCE))).toHaveLength(0); // never a fabricated pitch about a page we could not read
    expect((await prisma.routeAction.findUnique({ where: { id: pitchId } }))!.assetId).toBeNull(); // undrafted → retries
    expect(await prisma.asset.count({ where: { businessId: BIZ, kind: "outreach-pitch" } })).toBe(0);

    // NIGHT 2 — the SAME request row, the server now healthy. The retry is real: it drafts.
    toggleHealthy = true;
    const calls2: string[] = [];
    const night2 = await runNightly({ businessId: BIZ }, nightlyDeps(GROUNDED_PITCH, calls2));
    expect(night2.outreach.status).toBe("ok");
    expect(calls2.filter((c) => c.includes(OUTREACH_FENCE))).toHaveLength(1); // NOW the model drafted the pitch
    const pitch = await prisma.routeAction.findUnique({ where: { id: pitchId } });
    expect(pitch!.assetId).toBeTruthy(); // the SAME row is now drafted
    const asset = await prisma.asset.findFirst({ where: { id: pitch!.assetId!, businessId: BIZ } });
    expect(asset!.kind).toBe("outreach-pitch");
    toggleHealthy = true; // leave the shared server healthy for any later test
  });

  it("inv5 CAP HONESTY: 4 requests (insertion order != createdAt order) → exactly the 3 OLDEST draft, the newest defers, reported in the detail", async () => {
    const BIZ = "biz_outreacheval_cap";
    const wpId = await seedBusiness(BIZ, `${base}/page`);
    vi.spyOn(console, "error").mockImplementation(() => {});

    // FOUR requests with DISTINCT createdAt, inserted in an order that is DELIBERATELY not the
    // createdAt order: the NEWEST is inserted FIRST. A pending query WITHOUT `orderBy createdAt asc`
    // would take the first-inserted rows and draft the NEWEST (wrong), deferring an older one —
    // failing this test. Only the 3 OLDEST-by-createdAt may draft.
    const t0 = new Date("2026-07-10T00:00:00Z").getTime();
    const newestId = await addPitchRequest(BIZ, wpId, { targetName: "Newest", targetUrl: `${base}/page`, createdAt: new Date(t0 + 3 * DAY_MS) });
    const old1 = await addPitchRequest(BIZ, wpId, { targetName: "Old1", targetUrl: `${base}/page`, createdAt: new Date(t0 + 0 * DAY_MS) });
    const old2 = await addPitchRequest(BIZ, wpId, { targetName: "Old2", targetUrl: `${base}/page`, createdAt: new Date(t0 + 1 * DAY_MS) });
    const old3 = await addPitchRequest(BIZ, wpId, { targetName: "Old3", targetUrl: `${base}/page`, createdAt: new Date(t0 + 2 * DAY_MS) });

    const calls: string[] = [];
    const res = await runNightly({ businessId: BIZ }, nightlyDeps(GROUNDED_PITCH, calls));

    expect(res.outreach.status).toBe("ok");
    if (res.outreach.status !== "ok") return;
    // The cap is REPORTED, never silent: the detail names 3 drafted + 1 deferred beyond tonight's cap.
    expect(res.outreach.detail).toContain(`${MAX_PITCHES_PER_NIGHT} pitch(es) drafted`);
    expect(res.outreach.detail).toContain("1 pending (cap)");
    // Exactly MAX outreach model calls — the cap bounds the spend; the 4th is never fetched or modeled.
    expect(calls.filter((c) => c.includes(OUTREACH_FENCE))).toHaveLength(MAX_PITCHES_PER_NIGHT);

    // The 3 OLDEST-by-createdAt drafted...
    for (const id of [old1, old2, old3]) {
      expect((await prisma.routeAction.findUnique({ where: { id } }))!.assetId).toBeTruthy();
    }
    // ...and the NEWEST is the 1 deferred, still undrafted (draftWaypoint excludes the type, so the
    // copywriter never drafts it either) → it retries next night.
    expect((await prisma.routeAction.findUnique({ where: { id: newestId } }))!.assetId).toBeNull();
    expect(await prisma.asset.count({ where: { businessId: BIZ, kind: "outreach-pitch" } })).toBe(MAX_PITCHES_PER_NIGHT);
  });

  it("inv6 WHITELIST: TOOL_SCHEMAS stays exactly 11 and never exposes an outreach tool (outreach is a department pipeline, non-MCP)", () => {
    const names = Object.keys(TOOL_SCHEMAS);
    expect(names).toHaveLength(11);
    for (const forbidden of ["run_outreach", "create_pitch_request", "send_outreach"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
