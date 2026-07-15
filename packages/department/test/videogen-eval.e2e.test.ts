// §15 stage-6k eval gate — VIDEO GENERATION (the Videographer's generation phase, spec §employees:
// "concept→storyboard→Kling generation→assembly"), wired into the nightly, is:
//   (inv1) TWO-GATE END-TO-END: a full nightly on a business with a video Integration connected AND
//     the transport ready, but whose storyboard is only PROPOSED, generates NOTHING (zero transport
//     calls, zero video-post rows) — GATE 1 (the founder's approval) is the sole thing withheld, so
//     the null result proves the gate, not a missing source. APPROVE the same storyboard → the NEXT
//     nightly generates: the video-post lands `proposed` + `approvedAt` null + asset kind "video"
//     (GATE 2 is real — nothing auto-approved), and the persisted diary's `video` section is `ok`
//     carrying the generation count (the tenth section is honestly recorded).
//   (inv2) NO-INTEGRATION HONESTY: an APPROVED storyboard but NO connected video Integration → zero
//     transport calls, section skipped `"no video source connected"`, zero video-post rows —
//     Dionysus never generates through an unconfigured source.
//   (inv3) COST LEDGER (D28): a generation writes EXACTLY ONE `llmCall` row model `"video-gen"` whose
//     note carries the video-post actionId — the generation EVENT is ledgered even though per-unit
//     pricing is unknown (costUsd null is honest).
//   (inv4) IDEMPOTENT + CAP: a SECOND nightly after a generation makes NOTHING new (the
//     storyboardActionId link holds across nights, the transport never re-fires); and a fresh tenant
//     with TWO approved storyboards (createdAt scrambled vs insertion order) generates EXACTLY ONE —
//     the OLDEST — with the diary detail honestly reporting `1 awaiting (cap)`.
//   (inv5) SECRET DISCIPLINE: the FakeTransport RECORDS the apiKey it received (proving decryption
//     ran end-to-end through the nightly) AND that exact key string appears in NO persisted row
//     (assets, actions incl. rationale, nightlyRun sectionsJson, llmCall notes) and in NO returned
//     section reason/detail — the secret lives only between decrypt and the transport call.
//   (inv6) WHITELIST: TOOL_SCHEMAS stays exactly 11 — video generation is a department pipeline,
//     never an agent-assertable `run_video_gen` / `generate_video` tool.
//
// The transport is INJECTED via NightlyDeps.videoGenTransport (the Kling seam, exactly like 5d's
// metric transport) — a recording FakeTransport captures {endpoint, apiKey, prompt} so a test can
// COUNT real generation attempts and PROVE decryption. The video Integration is connected in-process
// with the DIONYSUS_CONFIG_KEY convention (the 5d/analytics + run-video-gen.test fixtures). The fake
// harness answers the deterministic non-video sections; a quiet HN transport keeps radar off the
// network; a throwing metric transport guarantees the metrics section dials nothing (no analytics
// source is connected, so ingestMetrics skips before ever calling it). Tenants live under
// biz_videogeneval_* so this gate never collides with other suites. CRITICAL teardown: nightlyRun
// AND llmCall AND integration rows FK-guard business deletion, so wipeChildren deletes them (and the
// standard children) FIRST — the sibling gates share this pattern.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { connectIntegration } from "dionysus-mcp/tools/integration";
import { CONFIG_KEY_ENV } from "dionysus-mcp/lib/secret-box";
import type { MetricTransport } from "dionysus-mcp/tools/analytics";
import { TOOL_SCHEMAS } from "dionysus-mcp/server";
import type { Harness, AgentDef } from "../src/llm/types.js";
import type { HnTransport } from "../src/tools/hn-source.js";
import { runNightly, type NightlyDeps } from "../src/run-nightly.js";
import type { VideoGenTransport } from "../src/run-video-gen.js";

// The fake harness for the deterministic (non-video) sections: a schema-valid draft for the
// copywriter's "Action: draft" call, else a quiet (valid, empty) observations set. The video
// section never touches the harness (it uses the injected transport), so this stays inert for it.
function goodHarness(): Harness {
  return {
    async runAgent(_def: AgentDef, input: string) {
      if (input.includes("Action: draft")) {
        return { finalOutput: JSON.stringify({ channel: "hackernews", kind: "post", content: { title: "T", body: "b" } }) };
      }
      return { finalOutput: JSON.stringify({ observations: [] }) };
    },
    async completeOnce() { return "unused"; },
  };
}

// The recording FakeTransport (the Kling seam): captures every {endpoint, apiKey, prompt} it is
// handed so a test can count real generation attempts AND prove the apiKey was decrypted, then
// returns a configurable url / error.
type Recorded = { endpoint: string; apiKey: string; prompt: string };
function recordingTransport(result: { url: string } | { error: string }, calls: Recorded[]): VideoGenTransport {
  return async (input) => { calls.push(input); return result; };
}

// A quiet HN transport keeps radar OFF the network (zero signals → radar ok, no proposals); a
// throwing metric transport guarantees nothing dials out for metrics (no analytics source is
// connected, so ingestMetrics skips before ever calling it).
const quietHn: HnTransport = async () => ({ status: 200, body: JSON.stringify({ hits: [] }) });
const failMetrics: MetricTransport = async () => { throw new Error("no metric endpoint in videogen eval"); };

function nightlyDeps(transport?: VideoGenTransport): NightlyDeps {
  return {
    harness: goodHarness(), models: { brain: "fake" },
    hnTransport: quietHn, metricTransport: failMetrics,
    ...(transport ? { videoGenTransport: transport } : {}),
  };
}

const TWOGATE = "biz_videogeneval_twogate";
const NOINT = "biz_videogeneval_noint";
const LEDGER = "biz_videogeneval_ledger";
const IDEM = "biz_videogeneval_idem";
const CAP = "biz_videogeneval_cap";
const SECRET = "biz_videogeneval_secret";
const TENANTS = [TWOGATE, NOINT, LEDGER, IDEM, CAP, SECRET];

// FK-safe teardown: llmCall (D28 cost rows) + nightlyRun (the diary) + integration + metricSnapshot
// all FK-guard business deletion, so they (and the standard children) go FIRST. Children before
// parents; leaves the Business row alone.
async function wipeChildren(businessId: string): Promise<void> {
  await prisma.llmCall.deleteMany({ where: { businessId } });      // 6k: the D28 cost ledger FK-guards business deletion
  await prisma.nightlyRun.deleteMany({ where: { businessId } });   // 6j: the diary FK-guards business deletion
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

// A business with an active objective/route/waypoint (ample budget so the video section never
// fail-closes on the budget gate). No product, no analytics source → cro/seo/outreach all skip.
// Returns the active waypoint id.
async function seedBusiness(businessId: string): Promise<string> {
  await wipeChildren(businessId);
  await prisma.business.upsert({ where: { id: businessId },
    create: { id: businessId, name: businessId, maxTokensPerDay: 100000 },
    update: { maxTokensPerDay: 100000, name: businessId } });
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "Launch", goal: "go live", status: "active" } });
  return wp.id;
}

// The storyboard body ends with "Caption: ..." (draft-waypoint's formatStoryboard shape).
const storyboardBody = (caption: string) => `1. [open on phone] the hook\n2. [cut to product] the reveal\n\nCaption: ${caption}`;

// A storyboard action in a given status, with a bound "storyboard" asset. Assets bind only while
// proposed (setActionAsset's guard), so bind first, then move to the target status. Returns the id.
async function addStoryboard(
  businessId: string, waypointId: string,
  opts: { status?: "proposed" | "approved"; title?: string; caption?: string; channel?: string; createdAt?: Date } = {},
): Promise<string> {
  const status = opts.status ?? "approved";
  const channel = opts.channel ?? "tiktok";
  const action = await prisma.routeAction.create({ data: {
    businessId, waypointId, employeeRole: "videographer", type: "post", status: "proposed",
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    featuresJson: JSON.stringify({ channel, video: true }) } });
  const asset = await prisma.asset.create({ data: {
    businessId, channel, kind: "storyboard", routeActionId: action.id,
    contentJson: JSON.stringify({ title: opts.title ?? "The hook", body: storyboardBody(opts.caption ?? "Follow for more") }) } });
  await prisma.routeAction.update({ where: { id: action.id },
    data: { assetId: asset.id, ...(status === "approved" ? { status: "approved", approvedAt: new Date() } : {}) } });
  return action.id;
}

async function connectVideo(businessId: string, endpoint: string, apiKey: string): Promise<void> {
  await connectIntegration({ businessId }, { kind: "video", provider: "http-json", metric: "video-generation", config: { endpoint, apiKey } });
}

const videoPostCount = (businessId: string) => prisma.routeAction.count({ where: { businessId, type: "video-post" } });
const ledgerCount = (businessId: string) => prisma.llmCall.count({ where: { businessId, model: "video-gen" } });

describe("§15 stage-6k eval gate — video generation is two-gate, capped, ledgered, secret-tight, non-MCP", () => {
  beforeAll(() => {
    process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
  });
  afterAll(async () => {
    for (const b of TENANTS) await wipeChildren(b);
    await prisma.business.deleteMany({ where: { id: { in: TENANTS } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("inv1 TWO-GATE END-TO-END: a PROPOSED storyboard (source + transport ready) generates nothing; approving it makes the NEXT nightly generate a proposed video-post + video asset, diary video ok", async () => {
    const wpId = await seedBusiness(TWOGATE);
    // The Integration is connected and the transport is ready BEFORE night 1 — so the ONLY thing
    // withheld is the founder's approval (gate 1). A non-vacuous gate-1 proof: everything else is go.
    const sbId = await addStoryboard(TWOGATE, wpId, { status: "proposed", title: "The hook", caption: "Follow for more", channel: "tiktok" });
    await connectVideo(TWOGATE, "https://kling.example/api", "sk-twogate-key");
    vi.spyOn(console, "error").mockImplementation(() => {}); // best-effort section logs are expected

    // NIGHT 1 — storyboard PROPOSED. Gate 1 withholds it: eligibility filters it out, so the video
    // section skips BEFORE the source/budget/transport work. Zero transport calls, zero video-post
    // rows. (Removing the `status: "approved"` eligibility filter in run-video-gen would fail this.)
    const calls1: Recorded[] = [];
    const night1 = await runNightly({ businessId: TWOGATE }, nightlyDeps(recordingTransport({ url: "https://cdn.example/v1.mp4" }, calls1)));
    expect(night1.video).toEqual({ status: "skipped", reason: "no approved storyboards awaiting generation" });
    expect(calls1).toHaveLength(0);                    // the transport NEVER fired for an unapproved storyboard
    expect(await videoPostCount(TWOGATE)).toBe(0);     // nothing generated

    // GATE 1 — the founder approves the SAME storyboard.
    await prisma.routeAction.update({ where: { id: sbId }, data: { status: "approved", approvedAt: new Date() } });

    // NIGHT 2 — now eligible. The transport fires once; a NEW proposed video-post + video asset lands.
    const calls2: Recorded[] = [];
    const night2 = await runNightly({ businessId: TWOGATE }, nightlyDeps(recordingTransport({ url: "https://cdn.example/v2.mp4" }, calls2)));
    expect(night2.video.status).toBe("ok");
    if (night2.video.status !== "ok") return;
    expect(night2.video.detail).toContain("1 video(s) generated");
    expect(calls2).toHaveLength(1);                    // exactly one real generation attempt this night

    // GATE 2 is real: the generated video-post is PROPOSED + approvedAt null (nothing auto-approved),
    // videographer, linked to the storyboard, bound to a kind "video" asset.
    const vps = await prisma.routeAction.findMany({ where: { businessId: TWOGATE, type: "video-post" } });
    expect(vps).toHaveLength(1);
    const vp = vps[0]!;
    expect(vp.status).toBe("proposed");
    expect(vp.approvedAt).toBeNull();                  // GATE 2: the founder still reviews the video
    expect(vp.employeeRole).toBe("videographer");
    expect(vp.featuresJson).toContain(`"storyboardActionId":"${sbId}"`);
    const asset = await prisma.asset.findFirst({ where: { id: vp.assetId!, businessId: TWOGATE } });
    expect(asset!.kind).toBe("video");
    expect(asset!.contentJson).toContain("https://cdn.example/v2.mp4");

    // The tenth section is honestly RECORDED: the persisted diary carries a skipped video (night 1)
    // AND an ok video with the generation count (night 2) — verbatim, never ok-washed.
    const diaries = (await prisma.nightlyRun.findMany({ where: { businessId: TWOGATE }, orderBy: { ranAt: "desc" } }))
      .map((r) => JSON.parse(r.sectionsJson) as Record<string, { status: string; detail?: string; reason?: string }>);
    const videoStatuses = diaries.map((d) => d.video!.status);
    expect(videoStatuses).toContain("skipped");        // night 1 — gate 1 withheld
    expect(videoStatuses).toContain("ok");             // night 2 — generated
    const okDiary = diaries.find((d) => d.video!.status === "ok");
    expect(okDiary!.video!.detail).toContain("1 video(s) generated");
  });

  it("inv2 NO-INTEGRATION HONESTY: an approved storyboard with NO connected video source → zero transport calls, section skipped, zero video-post rows", async () => {
    const wpId = await seedBusiness(NOINT);
    await addStoryboard(NOINT, wpId, { status: "approved" }); // eligible — so the gate below is the source, not eligibility
    vi.spyOn(console, "error").mockImplementation(() => {});

    // The transport is provided but must never be reached: no connected "video" Integration → the
    // video section skips at the source gate. (Removing the getConnectedVideoSource gate would let it
    // call the transport and fail this.)
    const calls: Recorded[] = [];
    const res = await runNightly({ businessId: NOINT }, nightlyDeps(recordingTransport({ url: "https://cdn.example/v.mp4" }, calls)));
    expect(res.video).toEqual({ status: "skipped", reason: "no video source connected" });
    expect(calls).toHaveLength(0);                     // never generated through an unconfigured source
    expect(await videoPostCount(NOINT)).toBe(0);
  });

  it("inv3 COST LEDGER (D28): a generation writes EXACTLY ONE video-gen llmCall whose note carries the video-post actionId", async () => {
    const wpId = await seedBusiness(LEDGER);
    await addStoryboard(LEDGER, wpId, { status: "approved" });
    await connectVideo(LEDGER, "https://kling.example/api", "sk-ledger-key");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const calls: Recorded[] = [];
    const res = await runNightly({ businessId: LEDGER }, nightlyDeps(recordingTransport({ url: "https://cdn.example/v.mp4" }, calls)));
    expect(res.video.status).toBe("ok");
    expect(calls).toHaveLength(1);                      // non-vacuous: a generation really happened

    const vp = await prisma.routeAction.findFirst({ where: { businessId: LEDGER, type: "video-post" } });
    expect(vp).not.toBeNull();
    // EXACTLY ONE video-gen ledger row, its note naming the video-post it paid for; costUsd honestly
    // null (per-unit pricing unknown). (Dropping the recordCost call would make this 0.)
    const rows = await prisma.llmCall.findMany({ where: { businessId: LEDGER, model: "video-gen" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note).toContain(vp!.id);
    expect(rows[0]!.costUsd).toBeNull();
  });

  it("inv4 IDEMPOTENT + CAP: a second nightly generates nothing new; a fresh tenant with TWO approved storyboards generates exactly the OLDEST, diary detail says '1 awaiting (cap)'", async () => {
    // PART A — IDEMPOTENT ACROSS NIGHTS. First nightly generates one; the second finds the
    // storyboardActionId link and generates NOTHING new (the transport never re-fires).
    const wpId = await seedBusiness(IDEM);
    await addStoryboard(IDEM, wpId, { status: "approved" });
    await connectVideo(IDEM, "https://kling.example/api", "sk-idem-key");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const calls1: Recorded[] = [];
    const first = await runNightly({ businessId: IDEM }, nightlyDeps(recordingTransport({ url: "https://cdn.example/v.mp4" }, calls1)));
    expect(first.video.status).toBe("ok");
    expect(await videoPostCount(IDEM)).toBe(1);
    expect(calls1).toHaveLength(1);

    const calls2: Recorded[] = [];
    const second = await runNightly({ businessId: IDEM }, nightlyDeps(recordingTransport({ url: "https://cdn.example/v.mp4" }, calls2)));
    expect(second.video).toEqual({ status: "skipped", reason: "no approved storyboards awaiting generation" });
    expect(await videoPostCount(IDEM)).toBe(1);         // no second generation — the link holds
    expect(calls2).toHaveLength(0);                     // the transport never re-fired
    expect(await ledgerCount(IDEM)).toBe(1);            // and no second cost row

    // PART B — CAP (MAX_VIDEOS_PER_NIGHT = 1), oldest-first. TWO approved storyboards with DISTINCT
    // createdAt, inserted NEWEST-first so an orderBy-less query would take the wrong one.
    const capWp = await seedBusiness(CAP);
    const t0 = new Date("2026-07-10T00:00:00Z").getTime();
    const newerSb = await addStoryboard(CAP, capWp, { status: "approved", title: "Newer", createdAt: new Date(t0 + 60000) });
    const olderSb = await addStoryboard(CAP, capWp, { status: "approved", title: "Older", createdAt: new Date(t0) });
    await connectVideo(CAP, "https://kling.example/api", "sk-cap-key");

    const capCalls: Recorded[] = [];
    const capRes = await runNightly({ businessId: CAP }, nightlyDeps(recordingTransport({ url: "https://cdn.example/v.mp4" }, capCalls)));
    expect(capRes.video.status).toBe("ok");
    if (capRes.video.status !== "ok") return;
    // Exactly ONE generated this night; the remainder is honestly REPORTED, never silent.
    expect(capRes.video.detail).toContain("1 video(s) generated");
    expect(capRes.video.detail).toContain("1 awaiting (cap)");
    expect(capCalls).toHaveLength(1);                   // the cap bounds the spend to one attempt
    expect(await videoPostCount(CAP)).toBe(1);

    // The generated video-post links the OLDEST storyboard, not the newer one (createdAt asc, oldest
    // first — a missing orderBy would fail this).
    const vp = await prisma.routeAction.findFirst({ where: { businessId: CAP, type: "video-post" } });
    expect(vp!.featuresJson).toContain(`"storyboardActionId":"${olderSb}"`);
    expect(vp!.featuresJson).not.toContain(`"storyboardActionId":"${newerSb}"`);

    // The cap is also honestly recorded in the diary.
    const diary = JSON.parse((await prisma.nightlyRun.findFirst({ where: { businessId: CAP }, orderBy: { ranAt: "desc" } }))!.sectionsJson) as Record<string, { status: string; detail?: string }>;
    expect(diary.video!.detail).toContain("1 awaiting (cap)");
  });

  it("inv5 SECRET DISCIPLINE: the transport RECEIVES the decrypted apiKey, yet that key appears in NO persisted row and NO section reason/detail", async () => {
    const SECRET_KEY = "sk-videogeneval-SECRET-must-never-persist-9f3a";
    const wpId = await seedBusiness(SECRET);
    await addStoryboard(SECRET, wpId, { status: "approved" });
    await connectVideo(SECRET, "https://kling.example/api", SECRET_KEY);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const calls: Recorded[] = [];
    const res = await runNightly({ businessId: SECRET }, nightlyDeps(recordingTransport({ url: "https://cdn.example/v.mp4" }, calls)));
    expect(res.video.status).toBe("ok");

    // DECRYPTION PROVEN: the transport was handed the REAL apiKey (the secret really flowed end-to-end
    // through the nightly, decrypted from the encrypted Integration config).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.apiKey).toBe(SECRET_KEY);

    // ...yet the secret is nowhere at rest. Sweep every persisted surface the plan names.
    const assets = await prisma.asset.findMany({ where: { businessId: SECRET } });
    for (const a of assets) expect(a.contentJson).not.toContain(SECRET_KEY);
    const actions = await prisma.routeAction.findMany({ where: { businessId: SECRET } });
    for (const act of actions) {
      expect(act.featuresJson ?? "").not.toContain(SECRET_KEY);
      expect(act.rationale ?? "").not.toContain(SECRET_KEY);
    }
    const runs = await prisma.nightlyRun.findMany({ where: { businessId: SECRET } });
    for (const r of runs) expect(r.sectionsJson).not.toContain(SECRET_KEY);
    const ledger = await prisma.llmCall.findMany({ where: { businessId: SECRET } });
    for (const l of ledger) expect(l.note ?? "").not.toContain(SECRET_KEY);

    // And never in a returned section reason/detail (covers the whole result envelope).
    expect(JSON.stringify(res)).not.toContain(SECRET_KEY);
  });

  it("inv6 WHITELIST: TOOL_SCHEMAS stays exactly 11 and never exposes a video-generation tool (it is a department pipeline, non-MCP)", () => {
    const names = Object.keys(TOOL_SCHEMAS);
    expect(names).toHaveLength(11);
    for (const forbidden of ["run_video_gen", "generate_video"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
