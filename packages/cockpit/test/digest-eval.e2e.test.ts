// §15 stage-4b eval gate — D22 digest + edit-distance under attack.
// Attacks: double-build (no re-batch), edit-after-approve (binding must not move),
// edited-content approval (hash must follow the LAST edit), cross-tenant digest/edit,
// stale-digest reviewedAt double-stamp.
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import { startExecution } from "dionysus-mcp/tools/lifecycle";
import { buildDailyDigest, markDigestReviewed } from "dionysus-mcp/tools/digest";
import { hashContent } from "dionysus-mcp/lib/content-hash";
import { approveDraftCore, editDraftCore, markReviewedCore } from "../src/lib/review-actions";

const S = { businessId: "biz_dg_eval", email: "founder@example.com" };
const GHOST = { businessId: "biz_dg_eval_ghost", email: "ghost@example.com" };
let wpId = "";

async function freshDraft(body: string) {
  const action = await prisma.routeAction.create({ data: { businessId: S.businessId, waypointId: wpId, employeeRole: "copywriter", type: "post", status: "proposed" } });
  const { assetId } = await persistAsset({ businessId: S.businessId }, { channel: "x", kind: "post", content: { body }, routeActionId: action.id });
  await setActionAsset({ businessId: S.businessId }, action.id, assetId);
  return action.id;
}

beforeAll(async () => {
  for (const id of [S.businessId, GHOST.businessId]) {
    await prisma.digest.deleteMany({ where: { businessId: id } });
    await prisma.asset.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
  const obj = await prisma.objective.create({ data: { businessId: S.businessId, kind: "k", target: "1", metric: "m", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: S.businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: S.businessId, routeId: route.id, order: 1, title: "Launch", goal: "g", status: "active" } });
  wpId = wp.id;
});

describe("§15 stage-4b eval gate — D22 under attack", () => {
  it("the founder's edit is what gets approved and executed: hash follows the LAST edit; the pre-edit asset cannot sneak through", async () => {
    const id = await freshDraft("the robot's first draft");
    const edit = await editDraftCore(S, id, "the founder's rewrite");
    expect(edit.ok).toBe(true);
    const approve = await approveDraftCore(S, id);
    expect(approve.ok).toBe(true);
    const action = await prisma.routeAction.findUnique({ where: { id } });
    const bound = await prisma.asset.findUnique({ where: { id: action!.assetId! } });
    expect((JSON.parse(bound!.contentJson) as { body: string }).body).toBe("the founder's rewrite");
    expect(action!.contentHash).toBe(hashContent(bound!.contentJson));
    // the ORIGINAL asset still exists (provenance) but is NOT what executes
    const history = await prisma.asset.findMany({ where: { routeActionId: id } });
    expect(history).toHaveLength(2);
    await startExecution({ businessId: S.businessId }, { routeActionId: id, runId: "run_edited" });
    const executing = await prisma.routeAction.findUnique({ where: { id } });
    expect(executing!.status).toBe("executing");
  });

  it("edit-after-approve is refused through the cockpit core; the approved binding and editDistance are untouched", async () => {
    const id = await freshDraft("approved words");
    await approveDraftCore(S, id);
    const before = await prisma.routeAction.findUnique({ where: { id } });
    const res = await editDraftCore(S, id, "sneaky post-approval rewrite");
    expect(res.ok).toBe(false);
    const after = await prisma.routeAction.findUnique({ where: { id } });
    expect(after!.assetId).toBe(before!.assetId);
    expect(after!.editDistance).toBe(before!.editDistance);
  });

  it("digest cannot double-batch: two builds same day = one digest, one membership; ghost tenant sees nothing", async () => {
    const id = await freshDraft("batch me");
    const first = await buildDailyDigest(S, "2026-07-20");
    const second = await buildDailyDigest(S, "2026-07-20");
    expect(second.digestId).toBe(first.digestId);
    const row = await prisma.routeAction.findUnique({ where: { id } });
    expect(row!.digestId).toBe(first.digestId);
    // Non-vacuous leak check (per the fixture note): "batch me" is already batched into A's
    // 2026-07-20 digest, so at ghost-build time there would be NO unbatched A draft and
    // itemCount===0 would hold even if buildDailyDigest ignored businessId. So mint ONE MORE
    // unbatched proposed A draft immediately before the ghost build — now a missing businessId
    // filter has somewhere to leak into (an unscoped updateMany would sweep this row into GHOST's
    // digest). Assert both that GHOST's build stays empty AND that this fresh A draft is untouched.
    const unbatchedA = await freshDraft("still mine, ghost");
    const ghostBuild = await buildDailyDigest(GHOST, "2026-07-20");
    // NOTE: itemCount counts only GHOST's own swept rows, so it stays 0 even under an unscoped
    // batch write — the REAL leak detector is the `unbatchedRow.digestId` still-null check below.
    expect(ghostBuild.itemCount).toBe(0); // A's drafts never leak into GHOST's digest
    expect(ghostBuild.digestId).not.toBe(first.digestId);
    const unbatchedRow = await prisma.routeAction.findUnique({ where: { id: unbatchedA } });
    expect(unbatchedRow!.digestId).toBeNull(); // GHOST's build did not claim A's unbatched draft
    await expect(markDigestReviewed(GHOST, first.digestId)).rejects.toThrow(/not found|already/i);
  });

  it("cumulative edit distance survives the full review flow (the D22 churn metric is real)", async () => {
    const id = await freshDraft("v1");
    await editDraftCore(S, id, "v22");  // levenshtein "v1"->"v22"   = 2
    await editDraftCore(S, id, "v333"); // levenshtein "v22"->"v333" = 3
    const row = await prisma.routeAction.findUnique({ where: { id } });
    // exact value pins CUMULATIVE accumulation — a last-write-wins bug would store 3 and fail.
    expect(row!.editDistance).toBe(5); // 2 + 3, hand-verified (levenshtein is pure)
    const digest = await buildDailyDigest(S, "2026-07-21");
    expect((await markReviewedCore(S, digest.digestId)).ok).toBe(true);
    expect((await markReviewedCore(S, digest.digestId)).ok).toBe(false); // single stamp
    // Re-read AFTER the digest build + review stamp: the churn counter must SURVIVE the full flow.
    // A digest build (or review stamp) that wiped editDistance would be caught HERE, not before.
    const afterFlow = await prisma.routeAction.findUnique({ where: { id } });
    expect(afterFlow!.editDistance).toBe(5); // still 5 — cumulative churn is durable across the review flow
  });

  it("cross-tenant review is refused on a FRESH, unreviewed digest — and the ghost's refused probe does not consume S's single stamp", async () => {
    // Task-5 review fix (confounded assertion): the unit test probed markReviewed cross-tenant only
    // AFTER reviewedAt was set, so count===0 held regardless of the businessId filter (vacuous on
    // scoping). Here S's digest is brand-new on a date S never touched: reviewedAt is null, so the
    // ONLY thing that can refuse the ghost is the businessId filter.
    await freshDraft("cross-tenant probe subject");
    const sDigest = await buildDailyDigest(S, "2026-07-25");
    expect(sDigest.itemCount).toBeGreaterThanOrEqual(1); // a real, non-empty S digest to attack

    // GHOST attacks S's unreviewed digest through the cockpit core — only businessId scoping refuses it.
    expect((await markReviewedCore(GHOST, sDigest.digestId)).ok).toBe(false);
    // The refused probe wrote nothing: reviewedAt is still null, S's single stamp is intact.
    const afterGhost = await prisma.digest.findUnique({ where: { id: sDigest.digestId } });
    expect(afterGhost!.reviewedAt).toBeNull();

    // S can still stamp it exactly once — proof the ghost's probe did not consume the single stamp.
    expect((await markReviewedCore(S, sDigest.digestId)).ok).toBe(true);
    expect((await markReviewedCore(S, sDigest.digestId)).ok).toBe(false); // single stamp intact
  });
});
