import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { prisma } from "../src/db.js";
import type { LookupFn } from "../src/lib/ssrf.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";
import { approveAction } from "../src/tools/lifecycle.js";
import { submitVerifiedSend } from "../src/tools/send.js";

const BIZ = "biz_send";

async function freshWaypoint(businessId: string): Promise<string> {
  const obj = await prisma.objective.create({ data: { businessId, kind: "k", target: "1", metric: "m", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
  return wp.id;
}

describe("RouteAction send columns (schema)", () => {
  beforeAll(async () => {
    await prisma.routeAction.deleteMany({ where: { businessId: BIZ } });
    await prisma.routeWaypoint.deleteMany({ where: { businessId: BIZ } });
    await prisma.route.deleteMany({ where: { businessId: BIZ } });
    await prisma.objective.deleteMany({ where: { businessId: BIZ } });
    await prisma.business.upsert({ where: { id: BIZ }, create: { id: BIZ, name: "Send Co" }, update: {} });
  });

  it("a fresh RouteAction has postedUrl, verifiedAt and outcome all null (§10)", async () => {
    const wpId = await freshWaypoint(BIZ);
    const action = await prisma.routeAction.create({ data: { businessId: BIZ, waypointId: wpId, employeeRole: "copywriter", type: "post", status: "proposed" } });
    expect(action.postedUrl).toBeNull();
    expect(action.verifiedAt).toBeNull();
    expect(action.outcome).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// submitVerifiedSend — D29 at the publish moment (public-URL verification).
// A localhost node:http fixture stands in for the "real world" posted page.
// `livePage` is mutable so the content-mismatch test can FIX the page and retry
// the SAME call; `hits` proves the tamper path never touches the network.
// The verify/happy fetches use safeFetch's TEST seam (lookupFn -> 127.0.0.1 +
// __testAllowPrivate); the SSRF-refusal test passes NO seam so a real loopback
// URL is genuinely rejected by safeFetch's guards.
// ---------------------------------------------------------------------------
const VBIZ = "biz_send_verify";
const OTHER = "biz_send_other";

let server: http.Server;
let port: number;
let hits = 0;
let livePage = "";

const localLookup: LookupFn = async (hostname) => {
  if (hostname === "local.test") return [{ address: "127.0.0.1", family: 4 }];
  throw new Error(`unexpected lookup: ${hostname}`);
};
const seam = { lookupFn: localLookup, __testAllowPrivate: true } as const;

function postedUrl(): string {
  return `http://local.test:${port}/post`;
}

async function cleanTenant(businessId: string): Promise<void> {
  await prisma.asset.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
}

/** Seed a proposed, asset-bound RouteAction; returns its id + assetId. */
async function boundAction(
  businessId: string,
  content: { title?: string; body?: string },
): Promise<{ actionId: string; assetId: string }> {
  const obj = await prisma.objective.create({ data: { businessId, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "case", status: "proposed" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "t", goal: "g", status: "active" } });
  const action = await prisma.routeAction.create({ data: { businessId, waypointId: wp.id, employeeRole: "copywriter", type: "post", status: "proposed" } });
  const { assetId } = await persistAsset({ businessId }, { channel: "hackernews", kind: "post", content, routeActionId: action.id });
  await setActionAsset({ businessId }, action.id, assetId);
  return { actionId: action.id, assetId };
}

/** Seed an approved, bound action. */
async function approvedBound(
  businessId: string,
  content: { title?: string; body?: string },
): Promise<{ actionId: string; assetId: string }> {
  const seeded = await boundAction(businessId, content);
  await approveAction({ businessId }, { routeActionId: seeded.actionId, principal: "founder@example.com" });
  return seeded;
}

describe("submitVerifiedSend — D29 at the publish moment", () => {
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(livePage);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    await cleanTenant(VBIZ);
    await cleanTenant(OTHER);
    await prisma.business.upsert({ where: { id: VBIZ }, create: { id: VBIZ, name: "Verify Co" }, update: {} });
    await prisma.business.upsert({ where: { id: OTHER }, create: { id: OTHER, name: "Other Co" }, update: {} });
  });

  afterAll(() => server.close());

  it("happy path: approved+bound, live page carries the approved title -> executed & verified", async () => {
    const { actionId } = await approvedBound(VBIZ, { title: "Show HN Launch Alpha", body: "we shipped the thing" });
    livePage = "<html><head><title>site</title></head><body><h1>Show HN Launch Alpha</h1><p>we shipped the thing</p></body></html>";

    const out = await submitVerifiedSend({ businessId: VBIZ }, { routeActionId: actionId, postedUrl: postedUrl() }, seam);

    expect(out.runId).toMatch(/^manual:[0-9a-f]{16}$/);
    expect(out.outcome).toBe("verified");
    expect(out.verifiedAt).toBeInstanceOf(Date);

    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("executed");
    expect(a!.runId).toBe(out.runId);
    expect(a!.postedUrl).toBe(postedUrl());
    expect(a!.verifiedAt).toBeInstanceOf(Date);
    expect(a!.outcome).toBe("verified");
  });

  it("content mismatch stays executing & retryable; fixing the page + retrying the SAME call succeeds with the SAME runId", async () => {
    const { actionId } = await approvedBound(VBIZ, { title: "Retry Post Beta Gamma", body: "launch copy" });

    // Page does NOT carry the approved content -> verification fails.
    livePage = "<html><body><p>a totally unrelated placeholder page</p></body></html>";
    await expect(
      submitVerifiedSend({ businessId: VBIZ }, { routeActionId: actionId, postedUrl: postedUrl() }, seam),
    ).rejects.toThrow(/Verification failed: the posted page does not contain the approved content/);

    const mid = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(mid!.status).toBe("executing");          // startExecution ran; not completed
    expect(mid!.postedUrl).toBe(postedUrl());        // recorded even though verification failed
    expect(mid!.verifiedAt).toBeNull();
    expect(mid!.outcome).toBeNull();
    expect(mid!.runId).toMatch(/^manual:[0-9a-f]{16}$/);
    const runIdAfterFirst = mid!.runId;

    // Founder fixes the live page; retry the SAME call — no second startExecution.
    livePage = "<html><body><h1>Retry Post Beta Gamma</h1></body></html>";
    const out = await submitVerifiedSend({ businessId: VBIZ }, { routeActionId: actionId, postedUrl: postedUrl() }, seam);
    expect(out.runId).toBe(runIdAfterFirst);         // retry keeps the original runId

    const done = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(done!.status).toBe("executed");
    expect(done!.runId).toBe(runIdAfterFirst);
    expect(done!.verifiedAt).toBeInstanceOf(Date);
    expect(done!.outcome).toBe("verified");
  });

  it("tampered binding: submit throws /hash mismatch/, status stays approved, and the network is NEVER touched (zero hits)", async () => {
    const { actionId, assetId } = await approvedBound(VBIZ, { title: "Sealed Approved Copy", body: "sealed" });
    // Swap the underlying asset content AFTER approval — the bound hash no longer matches.
    await prisma.asset.update({ where: { id: assetId }, data: { contentJson: JSON.stringify({ title: "Sealed Approved Copy", body: "TAMPERED" }) } });

    const hitsBefore = hits;
    await expect(
      submitVerifiedSend({ businessId: VBIZ }, { routeActionId: actionId, postedUrl: postedUrl() }, seam),
    ).rejects.toThrow(/hash mismatch/i);

    expect(hits).toBe(hitsBefore);                   // assertContentBound throws BEFORE safeFetch
    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("approved");              // refusal never advanced the action
    expect(a!.runId).toBeNull();
    expect(a!.postedUrl).toBeNull();
    expect(a!.verifiedAt).toBeNull();
  });

  it("SSRF: a loopback URL with NO test seam is rejected by safeFetch's guards; the action is not verified", async () => {
    const { actionId } = await approvedBound(VBIZ, { title: "SSRF Probe Target Copy", body: "x" });

    await expect(
      // No fetchOpts -> no seam -> safeFetch genuinely refuses the private/loopback target.
      submitVerifiedSend({ businessId: VBIZ }, { routeActionId: actionId, postedUrl: "http://127.0.0.1:9/" }),
    ).rejects.toThrow(/blocked|private|ssrf/i);

    // Per the ratified write-ordering, startExecution runs BEFORE the fetch, so a
    // fetch-stage refusal leaves the action executing (retryable) — never verified.
    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("executing");
    expect(a!.verifiedAt).toBeNull();
    expect(a!.outcome).toBeNull();
  });

  it("a proposed (not-yet-approved) action -> /invalid transition/", async () => {
    const { actionId } = await boundAction(VBIZ, { title: "Not Yet Approved Copy", body: "x" });
    livePage = "<html><body><h1>Not Yet Approved Copy</h1></body></html>";
    await expect(
      submitVerifiedSend({ businessId: VBIZ }, { routeActionId: actionId, postedUrl: postedUrl() }, seam),
    ).rejects.toThrow(/invalid transition/i);
    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("proposed");
  });

  it("cross-tenant: another business cannot submit a send for this action -> /not found|scope/", async () => {
    const { actionId } = await approvedBound(VBIZ, { title: "Tenant Scoped Copy Alpha", body: "x" });
    const hitsBefore = hits;
    await expect(
      submitVerifiedSend({ businessId: OTHER }, { routeActionId: actionId, postedUrl: postedUrl() }, seam),
    ).rejects.toThrow(/not found|scope/i);
    expect(hits).toBe(hitsBefore);                   // rejected at the scoped load, before any fetch
    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("approved");              // victim tenant's action untouched
  });

  it("invalid URL is rejected before any DB or network effect", async () => {
    const { actionId } = await approvedBound(VBIZ, { title: "Invalid URL Guard Copy", body: "x" });
    const hitsBefore = hits;

    for (const bad of ["javascript:alert(1)", "not a url"]) {
      await expect(
        submitVerifiedSend({ businessId: VBIZ }, { routeActionId: actionId, postedUrl: bad }, seam),
      ).rejects.toThrow(/invalid|url|scheme/i);
    }

    expect(hits).toBe(hitsBefore);                   // never fetched
    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("approved");              // untouched: URL validation is step 1
    expect(a!.runId).toBeNull();
    expect(a!.postedUrl).toBeNull();
  });

  it("an approved action whose bound content yields no verification snippet -> throws before fetch", async () => {
    const { actionId } = await approvedBound(VBIZ, { title: "", body: "" });
    const hitsBefore = hits;
    await expect(
      submitVerifiedSend({ businessId: VBIZ }, { routeActionId: actionId, postedUrl: postedUrl() }, seam),
    ).rejects.toThrow(/snippet/i);
    expect(hits).toBe(hitsBefore);
  });
});
