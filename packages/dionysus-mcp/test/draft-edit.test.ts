import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "../src/db.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";
import { approveAction } from "../src/tools/lifecycle.js";
import { editDraftContent } from "../src/tools/draft-edit.js";
import { hashContent } from "../src/lib/content-hash.js";
import { levenshtein } from "../src/lib/edit-distance.js";

const BIZ = "biz_edit";

async function freshBoundAction(businessId: string, body: string) {
  const obj = await prisma.objective.create({ data: { businessId, kind: "k", target: "1", metric: "m", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
  const action = await prisma.routeAction.create({ data: { businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
  const { assetId } = await persistAsset({ businessId }, { channel: "x", kind: "post", content: { title: "T", body }, routeActionId: action.id });
  await setActionAsset({ businessId }, action.id, assetId);
  return { actionId: action.id, assetId };
}

describe("editDraftContent (D22)", () => {
  beforeAll(async () => {
    await prisma.asset.deleteMany({ where: { businessId: BIZ } });
    await prisma.routeAction.deleteMany({ where: { businessId: BIZ } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: BIZ } });
    await prisma.route.deleteMany({ where: { businessId: BIZ } });
    await prisma.objective.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "ED" }, update: {} });
    await prisma.business.upsert({ where: { id: "biz_edit_other" }, create: { id: "biz_edit_other", name: "EO" }, update: {} });
  });

  it("edit rebinds a NEW asset revision, rebinds the hash, records the distance, preserves the title", async () => {
    const { actionId, assetId: original } = await freshBoundAction(BIZ, "hello world");
    const res = await editDraftContent({ businessId: BIZ }, { routeActionId: actionId, newBody: "hello brave world" });
    expect(res.assetId).not.toBe(original);
    expect(res.editDistance).toBe(levenshtein("hello world", "hello brave world"));
    const action = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(action!.assetId).toBe(res.assetId);
    expect(action!.editDistance).toBe(res.editDistance);
    const asset = await prisma.asset.findUnique({ where: { id: res.assetId } });
    const content = JSON.parse(asset!.contentJson) as { title?: string; body?: string };
    expect(content.body).toBe("hello brave world");
    expect(content.title).toBe("T"); // title preserved
    expect(action!.contentHash).toBe(hashContent(asset!.contentJson)); // hash follows the edit
    const history = await prisma.asset.findMany({ where: { routeActionId: actionId } });
    expect(history).toHaveLength(2); // provenance history preserved
  });

  it("edits accumulate; a zero-distance edit is a no-op (no new asset)", async () => {
    const { actionId } = await freshBoundAction(BIZ, "aaaa");
    const first = await editDraftContent({ businessId: BIZ }, { routeActionId: actionId, newBody: "aaab" });
    const second = await editDraftContent({ businessId: BIZ }, { routeActionId: actionId, newBody: "aabb" });
    expect(second.totalEditDistance).toBe(first.editDistance + second.editDistance);
    const before = await prisma.asset.count({ where: { routeActionId: actionId } });
    const noop = await editDraftContent({ businessId: BIZ }, { routeActionId: actionId, newBody: "aabb" });
    expect(noop.editDistance).toBe(0);
    expect(await prisma.asset.count({ where: { routeActionId: actionId } })).toBe(before);
  });

  it("concurrent edits on the same action never lose churn (atomic increment)", async () => {
    const { actionId } = await freshBoundAction(BIZ, "base");
    const results = await Promise.allSettled([
      editDraftContent({ businessId: BIZ }, { routeActionId: actionId, newBody: "base plus alpha" }),
      editDraftContent({ businessId: BIZ }, { routeActionId: actionId, newBody: "base plus beta" }),
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof editDraftContent>>> => r.status === "fulfilled");
    // Either both succeed or one loses the bind-guard race — both are acceptable. What MUST hold:
    // the persisted cumulative editDistance equals the SUM of the per-edit distances that were
    // actually applied (no increment clobbered by a stale read-modify-write). At least one edit
    // must land (a fresh proposed action is editable).
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const sumOfDeltas = fulfilled.reduce((acc, r) => acc + r.value.editDistance, 0);
    const action = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(action!.editDistance).toBe(sumOfDeltas);
  });

  it("editing a non-proposed action is refused; the approved binding never moves", async () => {
    const { actionId, assetId } = await freshBoundAction(BIZ, "final copy");
    await approveAction({ businessId: BIZ }, { routeActionId: actionId, principal: "p" });
    await expect(editDraftContent({ businessId: BIZ }, { routeActionId: actionId, newBody: "sneaky rewrite" }))
      .rejects.toThrow(/not in "proposed" status/i);
    const action = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(action!.assetId).toBe(assetId);
  });

  it("cross-tenant edit fails closed", async () => {
    const { actionId } = await freshBoundAction(BIZ, "mine");
    await expect(editDraftContent({ businessId: "biz_edit_other" }, { routeActionId: actionId, newBody: "theirs" }))
      .rejects.toThrow(/not found|scope/i);
  });
});
