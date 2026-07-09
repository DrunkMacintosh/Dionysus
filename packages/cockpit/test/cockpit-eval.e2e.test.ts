// §15 stage-4a eval gate — the cockpit approval path under attack.
// Attacks: replayed magic link, forged session cookie, cross-tenant approval via a
// stolen-but-valid session, post-approval tamper surfacing through the cockpit path.
import { describe, it, expect, beforeAll } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import { approveAction } from "dionysus-mcp/tools/lifecycle";
import { issueMagicLink, verifyMagicLink } from "../src/lib/magic-link";
import { createSessionToken, verifySessionToken } from "../src/lib/session";
import { listProposedDrafts } from "../src/lib/review";

const SECRET = "eval-secret";
const A = { businessId: "biz_cockpit_eval_a" };
const B = { businessId: "biz_cockpit_eval_b" };
let actionA = "";

beforeAll(async () => {
  for (const id of [A.businessId, B.businessId]) {
    await prisma.magicLink.deleteMany({ where: { businessId: id } });
    await prisma.asset.deleteMany({ where: { businessId: id } });
    await prisma.routeAction.deleteMany({ where: { businessId: id } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: id } });
    await prisma.route.deleteMany({ where: { businessId: id } });
    await prisma.objective.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
  const obj = await prisma.objective.create({ data: { businessId: A.businessId, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: A.businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: A.businessId, routeId: route.id, order: 1, title: "Launch", goal: "20", status: "active" } });
  const action = await prisma.routeAction.create({ data: { businessId: A.businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
  const { assetId } = await persistAsset(A, { channel: "x", kind: "post", content: { body: "reviewed words" }, routeActionId: action.id });
  await setActionAsset(A, action.id, assetId);
  actionA = action.id;
});

describe("§15 stage-4a eval gate — cockpit auth + approval under attack", () => {
  it("full path: link -> session -> drafts visible -> approve lands content-bound; replayed link refused", async () => {
    const { token } = await issueMagicLink(A.businessId, "founder-a@example.com");
    const identity = await verifyMagicLink(token);
    const cookie = createSessionToken({ businessId: identity.businessId, email: identity.email, exp: Date.now() + 60_000 }, SECRET);
    const session = verifySessionToken(cookie, SECRET)!;
    expect(session.businessId).toBe(A.businessId);

    const drafts = await listProposedDrafts({ businessId: session.businessId });
    expect(drafts.map((d) => d.actionId)).toContain(actionA);

    await approveAction({ businessId: session.businessId }, { routeActionId: actionA, principal: session.email });
    const approved = await prisma.routeAction.findUnique({ where: { id: actionA } });
    expect(approved!.status).toBe("approved");
    expect(approved!.approvedBy).toBe("founder-a@example.com");

    await expect(verifyMagicLink(token)).rejects.toThrow(/invalid|expired|used/i); // replay refused
  });

  it("a forged cookie (tampered businessId, valid-looking) yields no session", () => {
    const good = createSessionToken({ businessId: B.businessId, email: "evil@example.com", exp: Date.now() + 60_000 }, SECRET);
    const [_, sig] = good.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ businessId: A.businessId, email: "evil@example.com", exp: Date.now() + 60_000 }), "utf8").toString("base64url");
    expect(verifySessionToken(`${forgedBody}.${sig}`, SECRET)).toBeNull();
  });

  it("a VALID session for business B cannot see or approve business A's draft", async () => {
    const { token } = await issueMagicLink(B.businessId, "founder-b@example.com");
    const b = await verifyMagicLink(token);
    const drafts = await listProposedDrafts({ businessId: b.businessId });
    expect(drafts.map((d) => d.actionId)).not.toContain(actionA);
    await expect(approveAction({ businessId: b.businessId }, { routeActionId: actionA, principal: b.email }))
      .rejects.toThrow(/not found|scope|invalid transition/i);
    const still = await prisma.routeAction.findUnique({ where: { id: actionA } });
    expect(still!.approvedBy).toBe("founder-a@example.com"); // A's approval untouched
  });

  it("session identity flows into the D29 hash refusal (tamper after approve -> execution refused)", async () => {
    const action = await prisma.routeAction.findUnique({ where: { id: actionA } });
    await prisma.asset.update({ where: { id: action!.assetId! }, data: { contentJson: JSON.stringify({ body: "swapped" }) } });
    const { startExecution } = await import("dionysus-mcp/tools/lifecycle");
    await expect(startExecution({ businessId: A.businessId }, { routeActionId: actionA, runId: "r1" }))
      .rejects.toThrow(/hash mismatch/i);
  });
});
