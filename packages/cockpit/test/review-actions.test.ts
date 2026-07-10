import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import { approveDraftCore, rejectDraftCore, editDraftCore, markReviewedCore, submitSendCore } from "../src/lib/review-actions";
import { buildDailyDigest } from "dionysus-mcp/tools/digest";

const S = { businessId: "biz_ck_actions", email: "f@example.com" };

async function freshDraft(body: string) {
  const obj = await prisma.objective.create({ data: { businessId: S.businessId, kind: "k", target: "1", metric: "m", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: S.businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: S.businessId, routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
  const action = await prisma.routeAction.create({ data: { businessId: S.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
  const { assetId } = await persistAsset({ businessId: S.businessId }, { channel: "x", kind: "post", content: { body }, routeActionId: action.id });
  await setActionAsset({ businessId: S.businessId }, action.id, assetId);
  return action.id;
}

beforeAll(async () => {
  await prisma.digest.deleteMany({ where: { businessId: S.businessId } });
  await prisma.asset.deleteMany({ where: { businessId: S.businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId: S.businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId: S.businessId } });
  await prisma.route.deleteMany({ where: { businessId: S.businessId } });
  await prisma.objective.deleteMany({ where: { businessId: S.businessId } });
  await prisma.business.upsert({ where: { id: S.businessId }, create: { id: S.businessId, name: "CKA" }, update: {} });
});

describe("cockpit action cores (direct tests — 4a debt)", () => {
  it("approve: ok=true, approvedBy = session email; approving again returns ok=false with a message (no throw)", async () => {
    const id = await freshDraft("approve me");
    const res = await approveDraftCore(S, id);
    expect(res.ok).toBe(true);
    const row = await prisma.routeAction.findUnique({ where: { id } });
    expect(row!.approvedBy).toBe(S.email);
    const again = await approveDraftCore(S, id);
    expect(again.ok).toBe(false);
    expect(again.message.length).toBeGreaterThan(0);
  });

  it("reject: ok=true and status lands rejected", async () => {
    const id = await freshDraft("reject me");
    const res = await rejectDraftCore(S, id);
    expect(res.ok).toBe(true);
    const row = await prisma.routeAction.findUnique({ where: { id } });
    expect(row!.status).toBe("rejected");
  });

  it("edit: ok=true with the distance in the message; empty body refused without DB writes", async () => {
    const id = await freshDraft("original body");
    const res = await editDraftCore(S, id, "original bodyy");
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/1/);
    const before = await prisma.asset.count({ where: { businessId: S.businessId } });
    const bad = await editDraftCore(S, id, "   ");
    expect(bad.ok).toBe(false);
    expect(await prisma.asset.count({ where: { businessId: S.businessId } })).toBe(before);
  });

  it("markReviewed: ok=true once, ok=false the second time; wrong tenant ok=false", async () => {
    const { digestId } = await buildDailyDigest({ businessId: S.businessId }, "2026-07-13");
    expect((await markReviewedCore(S, digestId)).ok).toBe(true);
    expect((await markReviewedCore(S, digestId)).ok).toBe(false);
    expect((await markReviewedCore({ businessId: "biz_ck_ghost", email: "g@x.com" }, digestId)).ok).toBe(false);
  });
});

// submitSendCore is exercised ONLY on its refusal paths (empty URL / cross-tenant /
// wrong-status) — each throws BEFORE submitVerifiedSend touches the network, so no
// fetch seam is needed at this tier. The verified-success path (which needs the SSRF
// fetch seam against a localhost fixture) is deliberately owned by the dionysus-mcp
// send suite + the Task-6 gate, not the cockpit suite.
describe("submitSendCore refusal paths (no fetch — all throw before the network)", () => {
  async function approvedBoundDraft(body: string): Promise<string> {
    const id = await freshDraft(body);
    await prisma.routeAction.update({ where: { id }, data: { status: "approved" } });
    return id;
  }

  it("empty URL: friendly ok=false refusal BEFORE any call, no DB effect", async () => {
    const id = await approvedBoundDraft("ready to send");
    const res = await submitSendCore(S, id, "   ");
    expect(res.ok).toBe(false);
    expect(res.message.length).toBeGreaterThan(0);
    const row = await prisma.routeAction.findUnique({ where: { id } });
    expect(row!.status).toBe("approved"); // untouched — refused before submitVerifiedSend
    expect(row!.postedUrl).toBeNull();
  });

  it("cross-tenant id: ok=false with a not-found/scope message; victim untouched", async () => {
    const id = await approvedBoundDraft("victim action");
    const res = await submitSendCore({ businessId: "biz_ck_ghost", email: "g@x.com" }, id, "https://example.com/post");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not found|scope/i);
    const row = await prisma.routeAction.findUnique({ where: { id } });
    expect(row!.status).toBe("approved");
    expect(row!.postedUrl).toBeNull();
  });

  it("proposed (not-yet-approved) action: ok=false with an invalid-transition message", async () => {
    const id = await freshDraft("still proposed");
    const res = await submitSendCore(S, id, "https://example.com/post");
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/invalid transition/i);
    const row = await prisma.routeAction.findUnique({ where: { id } });
    expect(row!.status).toBe("proposed");
  });
});
