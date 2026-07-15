import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { connectIntegration } from "dionysus-mcp/tools/integration";
import { CONFIG_KEY_ENV } from "dionysus-mcp/lib/secret-box";
import { runVideoGen, MAX_VIDEOS_PER_NIGHT, type VideoGenTransport } from "../src/run-video-gen.js";

// A generated video is GATE 2 material: a NEW proposed video-post + video asset from an
// APPROVED storyboard (gate 1). The transport is INJECTED (the Kling seam, exactly like 5d's
// metric transport) — a FakeTransport records the inputs it received (proving decryption ran +
// the storyboard title reached the prompt) and returns a configurable url / error.
type Recorded = { endpoint: string; apiKey: string; prompt: string };
function fakeTransport(result: { url: string } | { error: string }, calls: Recorded[]): VideoGenTransport {
  return async (input) => { calls.push(input); return result; };
}

// The in-process config key convention (the 5d/analytics tests): a 32-byte key, base64.
beforeAll(() => { process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); });
afterEach(() => vi.restoreAllMocks());

async function reset(biz: string): Promise<void> {
  await prisma.llmCall.deleteMany({ where: { businessId: biz } });
  await prisma.asset.deleteMany({ where: { businessId: biz } });
  await prisma.routeAction.deleteMany({ where: { businessId: biz } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId: biz } });
  await prisma.route.deleteMany({ where: { businessId: biz } });
  await prisma.objective.deleteMany({ where: { businessId: biz } });
  await prisma.integration.deleteMany({ where: { businessId: biz } });
}

// Seed a tenant with an objective/route/active-waypoint; return the waypoint id.
async function seedTenant(biz: string): Promise<string> {
  await reset(biz);
  await prisma.business.upsert({ where: { id: biz },
    create: { id: biz, name: biz, maxTokensPerDay: 100000 }, update: { maxTokensPerDay: 100000 } });
  const obj = await prisma.objective.create({ data: { businessId: biz, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: biz, objectiveId: obj.id, source: "case", status: "active" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: biz, routeId: route.id, order: 1, title: "Launch", goal: "20 signups", status: "active" } });
  return wp.id;
}

// The storyboard body ends with "Caption: ..." (draft-waypoint's formatStoryboard shape).
const storyboardBody = (caption: string) => `1. [open on phone] the hook\n2. [cut to product] the reveal\n\nCaption: ${caption}`;

// A storyboard action in a given status, with a bound "storyboard" asset. Assets bind only while
// proposed (setActionAsset's guard), so bind first, then move to the target status.
async function addStoryboard(
  biz: string, wpId: string,
  opts: { status?: "proposed" | "approved"; title?: string; caption?: string; channel?: string; createdAt?: Date } = {},
): Promise<string> {
  const status = opts.status ?? "approved";
  const action = await prisma.routeAction.create({ data: {
    businessId: biz, waypointId: wpId, employeeRole: "videographer", type: "post", status: "proposed",
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    featuresJson: JSON.stringify({ channel: opts.channel ?? "tiktok", video: true }) } });
  const asset = await prisma.asset.create({ data: {
    businessId: biz, channel: opts.channel ?? "tiktok", kind: "storyboard", routeActionId: action.id,
    contentJson: JSON.stringify({ title: opts.title ?? "The hook", body: storyboardBody(opts.caption ?? "Follow for more") }) } });
  await prisma.routeAction.update({ where: { id: action.id }, data: { assetId: asset.id, ...(status === "approved" ? { status: "approved", approvedAt: new Date() } : {}) } });
  return action.id;
}

async function connectVideo(biz: string, endpoint: string, apiKey: string): Promise<void> {
  await connectIntegration({ businessId: biz }, { kind: "video", provider: "http-json", metric: "video-generation", config: { endpoint, apiKey } });
}

const videoPostCount = (biz: string) => prisma.routeAction.count({ where: { businessId: biz, type: "video-post" } });
const costRowCount = (biz: string) => prisma.llmCall.count({ where: { businessId: biz, model: "video-gen" } });

describe("runVideoGen (two-gate: approved storyboards -> proposed video-post + video asset, capped, ledgered)", () => {
  it("HAPPY: an approved storyboard + connected video source -> ONE proposed video-post + video asset; transport got the title + real apiKey; ONE cost row", async () => {
    const BIZ = "biz_videogen_happy";
    const wpId = await seedTenant(BIZ);
    const sbId = await addStoryboard(BIZ, wpId, { title: "The hook", caption: "Follow for more", channel: "tiktok" });
    await connectVideo(BIZ, "https://kling.example/api", "sk-real-key");
    const calls: Recorded[] = [];
    const res = await runVideoGen({ businessId: BIZ }, { transport: fakeTransport({ url: "https://cdn.example/v.mp4" }, calls) });

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.generated).toHaveLength(1);
    expect(res.skippedItems).toBe(0);
    expect(res.awaiting).toBe(0);
    const newId = res.generated[0]!;

    // GATE 2 material: a NEW proposed video-post, approvedAt null, videographer, storyboardActionId linked.
    const action = await prisma.routeAction.findUnique({ where: { id: newId } });
    expect(action!.type).toBe("video-post");
    expect(action!.status).toBe("proposed");
    expect(action!.approvedAt).toBeNull();
    expect(action!.employeeRole).toBe("videographer");
    expect(action!.featuresJson).toContain(`"storyboardActionId":"${sbId}"`);
    expect(action!.assetId).toBeTruthy();

    // The video asset: kind "video", body carries the transport URL AND the storyboard's caption.
    const asset = await prisma.asset.findFirst({ where: { id: action!.assetId!, businessId: BIZ } });
    expect(asset!.kind).toBe("video");
    expect(asset!.channel).toBe("tiktok");
    const content = JSON.parse(asset!.contentJson) as { title: string; body: string };
    expect(content.title).toBe("The hook");
    expect(content.body).toContain("https://cdn.example/v.mp4");
    expect(content.body).toContain("Follow for more"); // the storyboard's caption preserved

    // The transport received OUR storyboard title in the prompt AND the decrypted apiKey.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("The hook");
    expect(calls[0]!.endpoint).toBe("https://kling.example/api");
    expect(calls[0]!.apiKey).toBe("sk-real-key"); // decryption worked

    // D28: exactly ONE video-gen cost row whose note carries the video-post actionId.
    const costRows = await prisma.llmCall.findMany({ where: { businessId: BIZ, model: "video-gen" } });
    expect(costRows).toHaveLength(1);
    expect(costRows[0]!.note).toContain(newId);
    expect(costRows[0]!.costUsd).toBeNull(); // per-unit pricing unknown → honest null

    // The apiKey never entered any persisted string.
    expect(action!.featuresJson).not.toContain("sk-real-key");
    expect(asset!.contentJson).not.toContain("sk-real-key");
    expect(action!.rationale ?? "").not.toContain("sk-real-key");
    expect(costRows[0]!.note ?? "").not.toContain("sk-real-key");
  });

  it("GATE no integration: an approved storyboard but NO connected video source -> skipped, transport NEVER called", async () => {
    const BIZ = "biz_videogen_noint";
    const wpId = await seedTenant(BIZ);
    await addStoryboard(BIZ, wpId);
    const calls: Recorded[] = [];
    const res = await runVideoGen({ businessId: BIZ }, { transport: fakeTransport({ url: "https://cdn.example/v.mp4" }, calls) });
    expect(res).toEqual({ status: "skipped", reason: "no video source connected" });
    expect(calls).toHaveLength(0);
    expect(await videoPostCount(BIZ)).toBe(0);
  });

  it("GATE no transport: connected source but no transport configured -> skipped", async () => {
    const BIZ = "biz_videogen_notransport";
    const wpId = await seedTenant(BIZ);
    await addStoryboard(BIZ, wpId);
    await connectVideo(BIZ, "https://kling.example/api", "sk-real-key");
    const res = await runVideoGen({ businessId: BIZ }, {});
    expect(res).toEqual({ status: "skipped", reason: "no video transport configured" });
    expect(await videoPostCount(BIZ)).toBe(0);
  });

  it("ELIGIBILITY FIRST: zero approved storyboards (integration connected) -> skipped, transport never called", async () => {
    const BIZ = "biz_videogen_none";
    await seedTenant(BIZ);
    await connectVideo(BIZ, "https://kling.example/api", "sk-real-key");
    const calls: Recorded[] = [];
    const res = await runVideoGen({ businessId: BIZ }, { transport: fakeTransport({ url: "https://cdn.example/v.mp4" }, calls) });
    expect(res).toEqual({ status: "skipped", reason: "no approved storyboards awaiting generation" });
    expect(calls).toHaveLength(0);
  });

  it("GATE 1 IS REAL: a PROPOSED (unapproved) storyboard is NOT eligible -> skipped, nothing generated", async () => {
    const BIZ = "biz_videogen_unapproved";
    const wpId = await seedTenant(BIZ);
    await addStoryboard(BIZ, wpId, { status: "proposed" });
    await connectVideo(BIZ, "https://kling.example/api", "sk-real-key");
    const calls: Recorded[] = [];
    const res = await runVideoGen({ businessId: BIZ }, { transport: fakeTransport({ url: "https://cdn.example/v.mp4" }, calls) });
    expect(res).toEqual({ status: "skipped", reason: "no approved storyboards awaiting generation" });
    expect(calls).toHaveLength(0);
    expect(await videoPostCount(BIZ)).toBe(0);
  });

  it("IDEMPOTENT: run twice -> still exactly ONE video-post (the second night finds nothing awaiting)", async () => {
    const BIZ = "biz_videogen_idem";
    const wpId = await seedTenant(BIZ);
    await addStoryboard(BIZ, wpId);
    await connectVideo(BIZ, "https://kling.example/api", "sk-real-key");
    const calls: Recorded[] = [];
    const transport = fakeTransport({ url: "https://cdn.example/v.mp4" }, calls);

    const first = await runVideoGen({ businessId: BIZ }, { transport });
    expect(first.status).toBe("ok");
    expect(await videoPostCount(BIZ)).toBe(1);

    const second = await runVideoGen({ businessId: BIZ }, { transport });
    expect(second).toEqual({ status: "skipped", reason: "no approved storyboards awaiting generation" });
    expect(await videoPostCount(BIZ)).toBe(1); // no second generation
    expect(calls).toHaveLength(1); // the transport fired ONCE, across both nights
  });

  it("CAP: two approved storyboards (inserted newest-first) -> exactly ONE generated (the OLDEST), awaiting 1", async () => {
    const BIZ = "biz_videogen_cap";
    const wpId = await seedTenant(BIZ);
    // Insert the NEWER first, the OLDER second, so an orderBy-less query would pick the wrong one.
    const t0 = new Date("2026-07-10T00:00:00Z").getTime();
    const newerSb = await addStoryboard(BIZ, wpId, { title: "Newer", createdAt: new Date(t0 + 60000) });
    const olderSb = await addStoryboard(BIZ, wpId, { title: "Older", createdAt: new Date(t0) });
    await connectVideo(BIZ, "https://kling.example/api", "sk-real-key");
    const calls: Recorded[] = [];
    const res = await runVideoGen({ businessId: BIZ }, { transport: fakeTransport({ url: "https://cdn.example/v.mp4" }, calls) });

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.generated).toHaveLength(MAX_VIDEOS_PER_NIGHT); // exactly 1
    expect(res.awaiting).toBe(1);
    expect(await videoPostCount(BIZ)).toBe(1);
    // The generated video-post links the OLDEST storyboard, not the newer one.
    const vp = await prisma.routeAction.findFirst({ where: { businessId: BIZ, type: "video-post" } });
    expect(vp!.featuresJson).toContain(`"storyboardActionId":"${olderSb}"`);
    expect(vp!.featuresJson).not.toContain(`"storyboardActionId":"${newerSb}"`);
  });

  it("TRANSPORT ERROR + RETRY: an {error} return -> zero video-post rows, skippedItems 1, no cost row; a healthy retry then generates", async () => {
    const BIZ = "biz_videogen_retry";
    const wpId = await seedTenant(BIZ);
    await addStoryboard(BIZ, wpId);
    await connectVideo(BIZ, "https://kling.example/api", "sk-real-key");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const errCalls: Recorded[] = [];
    const errRes = await runVideoGen({ businessId: BIZ }, { transport: fakeTransport({ error: "kling 503" }, errCalls) });
    expect(errRes.status).toBe("ok");
    if (errRes.status !== "ok") return;
    expect(errRes.generated).toHaveLength(0);
    expect(errRes.skippedItems).toBe(1);
    expect(await videoPostCount(BIZ)).toBe(0); // ungenerated — stays approved, retries
    expect(await costRowCount(BIZ)).toBe(0);   // a failed item leaves NO cost row

    // The retry is REAL: the storyboard is still approved + unlinked, so a healthy night generates.
    const okCalls: Recorded[] = [];
    const okRes = await runVideoGen({ businessId: BIZ }, { transport: fakeTransport({ url: "https://cdn.example/v.mp4" }, okCalls) });
    expect(okRes.status).toBe("ok");
    if (okRes.status !== "ok") return;
    expect(okRes.generated).toHaveLength(1);
    expect(await videoPostCount(BIZ)).toBe(1);
    expect(await costRowCount(BIZ)).toBe(1);
  });

  it("URL SHAPE: a non-http(s) url (javascript:) is rejected -> skippedItems 1, zero rows, no cost row", async () => {
    const BIZ = "biz_videogen_url";
    const wpId = await seedTenant(BIZ);
    await addStoryboard(BIZ, wpId);
    await connectVideo(BIZ, "https://kling.example/api", "sk-real-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await runVideoGen({ businessId: BIZ }, { transport: fakeTransport({ url: "javascript:alert(1)" }, []) });

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.generated).toHaveLength(0);
    expect(res.skippedItems).toBe(1);
    expect(await videoPostCount(BIZ)).toBe(0);
    expect(await costRowCount(BIZ)).toBe(0);
  });
});
