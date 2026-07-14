// §15 stage-6i eval gate — the VIDEOGRAPHER, a SECOND agent def inside draftWaypoint's existing
// parallel fan-out (no new pipeline), is:
//   (inv1) ROUTING HONESTY (discriminating): ONE draftWaypoint night over a MIXED waypoint (one
//     tiktok action, one x action) → the tiktok action's bound asset is kind "storyboard" (title =
//     concept, body = numbered `N. [shot] text` lines + a Caption) AND its harness call carries the
//     videographer marker "storyboard a short-form video"; the x action's asset keeps the copywriter
//     shape (kind "post") AND its call carries the copywriter marker "Action: draft"; NEITHER marker
//     crosses into the other's call. Routing is SERVER-derived (features.channel), never a model pick.
//   (inv2) ROLE-PURITY RECALL: a copywriter-role craft belief seeded via persistCraftBelief (role
//     "copywriter", a UNIQUE body marker) renders into the COPYWRITER call's route-so-far block — the
//     POSITIVE side, proving learnings really render for their role — yet NEVER into the VIDEOGRAPHER
//     call (the 5c role-purity discipline: copywriter beliefs must not steer a storyboard).
//     buildAgentContext filters learnings by role, so the videographer's OWN role-scoped recall
//     (role "videographer") excludes the copywriter belief. Without the proven positive, the negative
//     would be vacuous — so this test pins BOTH sides.
//   (inv3) NEVER-AUTO: the storyboard action lands proposed + approvedAt null + asset-bound (the
//     founder reviews it on /drafts, assetId set); after the founder APPROVES it, the bound asset's
//     kind stays "storyboard" — the exact kind the cockpit send-queue excludes (a filmed video has no
//     public-URL verified-send contract; the read-path filter itself is pinned in the cockpit suite).
//   (inv4) HONEST DEGRADE (discriminating): a TEXT-ONLY waypoint (x + hackernews) makes ZERO harness
//     calls carrying the videographer marker while the copywriter-marker calls are > 0 — the probe
//     genuinely distinguishes a videographer call from a copywriter call (non-vacuous).
//   (inv5) TRUNCATE HONESTY: a 7-scene model output → the persisted body has scenes 1..6 in order
//     (scene-1 text appears BEFORE scene-6 text) and NO scene 7 — truncate keeps the FIRST six, never
//     reorders (the 6a truncate-not-reject posture).
//   (inv6) NON-MCP: TOOL_SCHEMAS stays exactly 11 — the videographer is a department fan-out branch,
//     never an agent-assertable tool (no draft_storyboard / run_videographer).
//
// The videographer lives INSIDE draftWaypoint (not a nightly section), so the gate drives
// draftWaypoint DIRECTLY with a DUAL-PURPOSE recording harness keyed on input CONTENT (the fan-out
// dispatch pattern): the videographer call (the "storyboard a short-form video" marker) gets
// storyboard JSON, the copywriter call (the "Action: draft" marker) gets draft JSON. Every input is
// recorded so a test can prove WHICH marker reached WHICH call. Tenants live under biz_videoeval_* so
// this gate never collides with other suites; tests in a file run sequentially.
import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { TOOL_SCHEMAS } from "dionysus-mcp/server";
import { persistCraftBelief } from "dionysus-mcp/tools/belief-graph";
import type { CraftBelief } from "dionysus-mcp/lib/belief";
import { draftWaypoint } from "../src/draft-waypoint.js";
import type { Harness, AgentDef } from "../src/llm/types.js";

// The two probe markers — the server-derived instruction lines draftWaypoint emits per branch.
const VIDEOGRAPHER_MARKER = "storyboard a short-form video";
const COPYWRITER_MARKER = "Action: draft";

// The storyboard concept becomes the asset title; the caption is the tail line. Scene texts are
// UNIQUE tokens so the truncate/order probe (inv5) is unambiguous (no accidental substring matches).
const CONCEPT = "The one-take founder hook";
const CAPTION = "Follow for more build-in-public";
const sceneText = (i: number): string => `SCENE_TEXT_${i}`;

// The copywriter's draft payload (parseDraft accepts it) — the non-video branch.
const DRAFT_JSON = JSON.stringify({ channel: "x", kind: "post", content: { title: "Note", body: "A crisp launch note." } });

// A live copywriter craft belief with a UNIQUE body marker — SEEDED (not derived) via
// persistCraftBelief (the 5c seeding path). featureKey is unique so deriveCraftBeliefs (which runs
// inside draftWaypoint over the route's OWN actions) never overwrites it; high confidence so it ranks
// into the rendered learnings. The marker lives in `summary` — the field buildAgentContext renders.
const BELIEF_MARKER = "VIDEOEVAL_COPYWRITER_BELIEF_MARKER_Q7X";
const copywriterBelief: CraftBelief = {
  confidence: 0.9, stance: "positive", lowConfidence: false,
  summary: `${BELIEF_MARKER}: the founder tends to accept crisp one-line hooks.`,
};

// Dual-purpose recording harness keyed on input CONTENT: the videographer call → storyboard JSON
// (`scenes` scenes), else the copywriter draft JSON (also the safe default). Records every input so a
// test can prove which marker reached which call. `scenes` drives the truncate probe (inv5).
function recordingHarness(captured: string[], opts: { scenes?: number } = {}): Harness {
  const sceneCount = opts.scenes ?? 3;
  return {
    async runAgent(_def: AgentDef, input: string) {
      captured.push(input);
      if (input.includes(VIDEOGRAPHER_MARKER)) {
        const scenes = Array.from({ length: sceneCount }, (_, i) => ({ shot: `shot ${i + 1}`, text: sceneText(i + 1) }));
        return { finalOutput: JSON.stringify({ concept: CONCEPT, scenes, caption: CAPTION }) };
      }
      return { finalOutput: DRAFT_JSON }; // the copywriter branch (Action: draft) — and the safe default
    },
    async completeOnce() { return "unused"; },
  };
}

const TENANTS = ["biz_videoeval_route", "biz_videoeval_pure", "biz_videoeval_auto", "biz_videoeval_degrade", "biz_videoeval_truncate"];

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

// The standard route fixture: an active objective/route/waypoint + one proposed, assetless action per
// channel (employeeRole "copywriter" — the DB role; the DRAFT-time router is server-derived from the
// channel, NOT this field). Returns the waypoint id + an action-id-by-channel map so a test can read
// the bound asset back per channel.
async function seedWaypoint(businessId: string, channels: string[]): Promise<{ wpId: string; actionByChannel: Record<string, string> }> {
  await wipeChildren(businessId);
  await prisma.business.upsert({ where: { id: businessId },
    create: { id: businessId, name: businessId, maxTokensPerDay: 100000 },
    update: { maxTokensPerDay: 100000 } });
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "Launch", goal: "go live", status: "active" } });
  const actionByChannel: Record<string, string> = {};
  for (const channel of channels) {
    const a = await prisma.routeAction.create({ data: { businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed", featuresJson: JSON.stringify({ channel }) } });
    actionByChannel[channel] = a.id;
  }
  return { wpId: wp.id, actionByChannel };
}

describe("§15 stage-6i eval gate — video work routes to the videographer, role-pure, truncated, draft-only, non-MCP", () => {
  afterAll(async () => {
    for (const b of TENANTS) await wipeChildren(b);
    await prisma.business.deleteMany({ where: { id: { in: TENANTS } } });
  });

  it("inv1 ROUTING HONESTY: a mixed waypoint routes the tiktok action to a storyboard and the x action to the copywriter; neither marker crosses calls", async () => {
    const BIZ = "biz_videoeval_route";
    const { wpId, actionByChannel } = await seedWaypoint(BIZ, ["tiktok", "x"]);

    const captured: string[] = [];
    const res = await draftWaypoint({ businessId: BIZ }, { waypointId: wpId }, { harness: recordingHarness(captured), models: { brain: "fake" } });

    expect(res.drafts).toHaveLength(2);
    const vidDraft = res.drafts.find((d) => d.channel === "tiktok")!;
    const copyDraft = res.drafts.find((d) => d.channel === "x")!;

    // (a) the tiktok action → a STORYBOARD asset: kind "storyboard", title = concept, body = numbered shots + Caption.
    expect(vidDraft.kind).toBe("storyboard");
    const vidAsset = await prisma.asset.findFirst({ where: { routeActionId: actionByChannel["tiktok"] } });
    expect(vidAsset!.kind).toBe("storyboard");
    const vidContent = JSON.parse(vidAsset!.contentJson) as { title: string; body: string };
    expect(vidContent.title).toBe(CONCEPT);
    expect(vidContent.body).toContain("1. [");
    expect(vidContent.body).toContain("Caption:");

    // (b) the x action → the copywriter shape (kind "post", the model's own body).
    expect(copyDraft.kind).toBe("post");
    const copyAsset = await prisma.asset.findFirst({ where: { routeActionId: actionByChannel["x"] } });
    expect(copyAsset!.kind).toBe("post");
    expect(JSON.parse(copyAsset!.contentJson).body).toBe("A crisp launch note.");

    // (c) DISCRIMINATING: the videographer marker is in the tiktok call ONLY; "Action: draft" in the x call ONLY.
    const vidCall = captured.find((i) => i.includes(`${VIDEOGRAPHER_MARKER} for the "tiktok" channel`));
    const copyCall = captured.find((i) => i.includes(`Action: draft a post for the "x" channel`));
    expect(vidCall).toBeDefined();
    expect(copyCall).toBeDefined();
    expect(vidCall).not.toContain(COPYWRITER_MARKER);     // no "Action: draft" leaked into the storyboard call
    expect(copyCall).not.toContain(VIDEOGRAPHER_MARKER);  // no "storyboard a short-form video" leaked into the draft call
  });

  it("inv2 ROLE-PURITY RECALL: a seeded copywriter belief renders into the copywriter call but NEVER the videographer call", async () => {
    const BIZ = "biz_videoeval_pure";
    const { wpId } = await seedWaypoint(BIZ, ["tiktok", "x"]);
    // Seed a live copywriter craft belief AFTER the seed wipe (persistCraftBelief, the 5c path).
    // Business-scoped, role "copywriter"; the unique featureKey never collides with a derived belief.
    await persistCraftBelief({ businessId: BIZ }, { role: "copywriter", featureKey: "channel=videoeval_belief", belief: copywriterBelief });

    const captured: string[] = [];
    await draftWaypoint({ businessId: BIZ }, { waypointId: wpId }, { harness: recordingHarness(captured), models: { brain: "fake" } });

    const vidCall = captured.find((i) => i.includes(VIDEOGRAPHER_MARKER));
    const copyCall = captured.find((i) => i.includes(COPYWRITER_MARKER));
    expect(vidCall).toBeDefined();
    expect(copyCall).toBeDefined();
    // POSITIVE (non-vacuity): the belief marker DOES render into the copywriter's role-scoped route-so-far block...
    expect(copyCall).toContain(BELIEF_MARKER);
    // ...and NEVER into the videographer's — its recall is built with role "videographer" (the 5c role-purity gate).
    expect(vidCall).not.toContain(BELIEF_MARKER);
  });

  it("inv3 NEVER-AUTO: the storyboard lands proposed + approval-null + asset-bound; approving keeps the asset kind storyboard", async () => {
    const BIZ = "biz_videoeval_auto";
    const { wpId, actionByChannel } = await seedWaypoint(BIZ, ["tiktok"]);

    await draftWaypoint({ businessId: BIZ }, { waypointId: wpId }, { harness: recordingHarness([]), models: { brain: "fake" } });

    // Never-auto: the storyboard action is PROPOSED, approval-null, asset-bound (the founder reviews it on /drafts).
    const action = await prisma.routeAction.findUnique({ where: { id: actionByChannel["tiktok"] } });
    expect(action!.status).toBe("proposed");
    expect(action!.approvedAt).toBeNull();
    expect(action!.assetId).toBeTruthy();
    const asset = await prisma.asset.findFirst({ where: { id: action!.assetId!, businessId: BIZ } });
    expect(asset!.kind).toBe("storyboard");
    expect(asset!.channel).toBe("tiktok");

    // After the founder APPROVES it, the bound asset's kind stays "storyboard" — the exact kind the cockpit
    // send-queue excludes (a filmed video has no public URL to verify; the read-path filter is pinned in cockpit).
    await prisma.routeAction.update({ where: { id: action!.id }, data: { status: "approved", approvedAt: new Date() } });
    const afterApprove = await prisma.asset.findFirst({ where: { id: action!.assetId!, businessId: BIZ } });
    expect(afterApprove!.kind).toBe("storyboard");
  });

  it("inv4 HONEST DEGRADE: a text-only waypoint makes ZERO videographer-marker calls while copywriter calls exist", async () => {
    const BIZ = "biz_videoeval_degrade";
    const { wpId } = await seedWaypoint(BIZ, ["x", "hackernews"]);

    const captured: string[] = [];
    const res = await draftWaypoint({ businessId: BIZ }, { waypointId: wpId }, { harness: recordingHarness(captured), models: { brain: "fake" } });

    expect(res.drafts).toHaveLength(2);
    expect(res.drafts.every((d) => d.kind === "post")).toBe(true);
    // The probe discriminates: NO call carried the videographer marker...
    expect(captured.filter((i) => i.includes(VIDEOGRAPHER_MARKER))).toHaveLength(0);
    // ...while the copywriter-marker calls DID happen (non-vacuous: the fan-out really ran).
    expect(captured.filter((i) => i.includes(COPYWRITER_MARKER)).length).toBeGreaterThan(0);
  });

  it("inv5 TRUNCATE HONESTY: a 7-scene output persists scenes 1..6 in order, no scene 7 (first-six, never reordered)", async () => {
    const BIZ = "biz_videoeval_truncate";
    const { wpId, actionByChannel } = await seedWaypoint(BIZ, ["reels"]);

    await draftWaypoint({ businessId: BIZ }, { waypointId: wpId }, { harness: recordingHarness([], { scenes: 7 }), models: { brain: "fake" } });

    const asset = await prisma.asset.findFirst({ where: { routeActionId: actionByChannel["reels"] } });
    const body = JSON.parse(asset!.contentJson).body as string;
    // Exactly the first six numbered lines — the 7th scene was truncated, never persisted.
    expect(body).toContain("1. [");
    expect(body).toContain("6. [");
    expect(body).not.toContain("7. [");
    // ORDER preserved: scene-1 text appears BEFORE scene-6 text, and scene 7's text is absent.
    const idx1 = body.indexOf(sceneText(1));
    const idx6 = body.indexOf(sceneText(6));
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx6).toBeGreaterThan(idx1);
    expect(body).not.toContain(sceneText(7));
  });

  it("inv6 WHITELIST: TOOL_SCHEMAS stays exactly 11 and never exposes a videographer tool (a department fan-out branch, non-MCP)", () => {
    const names = Object.keys(TOOL_SCHEMAS);
    expect(names).toHaveLength(11);
    for (const forbidden of ["draft_storyboard", "run_videographer"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
