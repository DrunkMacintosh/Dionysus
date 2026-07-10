// §15 stage-4d eval gate — the loop closes ONLY when the public page carries
// the approved content. This is the stage's headline honesty invariant under
// attack: a verified send may claim `verified` ONLY after the real public URL
// is fetched and proven to carry the approved copy.
//
// The chains are built with the REAL functions end-to-end (createObjective ->
// persistRoute -> persistWaypoint -> upsertRouteAction -> persistAsset ->
// setActionAsset -> approveAction -> submitVerifiedSend), not raw prisma, so
// the gate exercises the genuine loop rather than a hand-forged row.
//
// A localhost node:http fixture stands in for the "real world" posted page. It
// carries a HIT COUNTER so we can prove which paths reach the network and which
// refuse before it: `livePage` is mutable so the mismatch test can FIX the page
// and retry the SAME call; the tamper test asserts ZERO hits (the publish-moment
// hash gate fires BEFORE safeFetch). The verify fetches use safeFetch's TEST
// seam (lookupFn -> 127.0.0.1 + __testAllowPrivate); the SSRF-refusal test passes
// NO seam so a real loopback URL is genuinely rejected by safeFetch's guards.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { prisma } from "../src/db.js";
import type { LookupFn } from "../src/lib/ssrf.js";
import { TOOL_SCHEMAS } from "../src/server.js";
import { createObjective, persistRoute, persistWaypoint, upsertRouteAction } from "../src/tools/plan.js";
import { persistAsset, setActionAsset } from "../src/tools/asset.js";
import { approveAction } from "../src/tools/lifecycle.js";
import { submitVerifiedSend } from "../src/tools/send.js";

const A = { businessId: "biz_sendeval" };
const GHOST = { businessId: "biz_sendeval_ghost" };

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

/**
 * Build a fresh approved+bound RouteAction through the REAL tool functions,
 * end-to-end. Each call mints its own objective/route/waypoint so `order: 1`
 * never collides. Returns the actionId + assetId for the attack tests to poke.
 */
async function approvedBoundViaRealFns(
  identity: { businessId: string },
  content: { title?: string; body?: string },
): Promise<{ actionId: string; assetId: string }> {
  const { objectiveId } = await createObjective(identity, { kind: "signups", target: "100", metric: "users" });
  const { routeId } = await persistRoute(identity, { objectiveId, source: "case" });
  const { waypointId } = await persistWaypoint(identity, { routeId, order: 1, title: "Launch", goal: "20 signups" });
  const { actionId } = await upsertRouteAction(identity, { waypointId, employeeRole: "copywriter", type: "post", rationale: "launch post" });
  const { assetId } = await persistAsset(identity, { channel: "hackernews", kind: "post", content, routeActionId: actionId });
  await setActionAsset(identity, actionId, assetId);
  await approveAction(identity, { routeActionId: actionId, principal: "founder@example.com" });
  return { actionId, assetId };
}

describe("§15 stage-4d eval gate — the loop closes only when the public page carries the approved content", () => {
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(livePage);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    await cleanTenant(A.businessId);
    await cleanTenant(GHOST.businessId);
    await prisma.business.upsert({ where: { id: A.businessId }, create: { id: A.businessId, name: "SendEval A" }, update: {} });
    // The ghost tenant EXISTS: the cross-tenant refusal must be scope-based, not
    // an artifact of an unknown business id.
    await prisma.business.upsert({ where: { id: GHOST.businessId }, create: { id: GHOST.businessId, name: "SendEval Ghost" }, update: {} });
  });

  afterAll(() => server.close());

  // Inv 1 — Full loop via real functions: the page genuinely carries the approved
  // title, so verification fetches the live page (hits increment) and the loop
  // closes: executed + verifiedAt + outcome "verified" + postedUrl, manual: runId.
  it("inv1 full loop: chain->bind->approve->submit against a page carrying the approved title -> executed & verified & postedUrl; runId is manual:", async () => {
    const { actionId } = await approvedBoundViaRealFns(A, { title: "Show HN Dionysus Live CMO", body: "the AI CMO that actually lives" });
    livePage = "<html><head><title>Hacker News</title></head><body><h1>Show HN Dionysus Live CMO</h1><p>the AI CMO that actually lives</p></body></html>";

    const hitsBefore = hits;
    const out = await submitVerifiedSend(A, { routeActionId: actionId, postedUrl: postedUrl() }, seam);

    expect(hits).toBeGreaterThan(hitsBefore); // the live page was genuinely fetched
    expect(out.runId).toMatch(/^manual:[0-9a-f]{16}$/);
    expect(out.outcome).toBe("verified");
    expect(out.verifiedAt).toBeInstanceOf(Date);

    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("executed");
    expect(a!.runId).toBe(out.runId);
    expect(a!.runId!.startsWith("manual:")).toBe(true);
    expect(a!.postedUrl).toBe(postedUrl());
    expect(a!.verifiedAt).toBeInstanceOf(Date);
    expect(a!.outcome).toBe("verified");
  });

  // Inv 2 — Honesty (§3): a LIVE-but-wrong page must not verify, and the action
  // stays retryable. The mismatch page carries plausible OTHER copy so the failure
  // is content-based (not empty-page-based). The retry re-verifies the SAME action
  // against a FIXED page and the runId is UNCHANGED (no second startExecution).
  it("inv2 honesty: a live page WITHOUT the approved content throws & stays executing (verifiedAt null); the SAME action retried against a fixed page verifies with the runId UNCHANGED", async () => {
    const { actionId } = await approvedBoundViaRealFns(A, { title: "Retry Post Delta Epsilon", body: "the real launch copy" });

    // A real-looking but DIFFERENT page — content mismatch, not an empty page.
    livePage = "<html><head><title>Our Blog</title></head><body><h1>Ten Tips for Better Sleep</h1><p>Sleep hygiene matters for founders too.</p></body></html>";
    await expect(
      submitVerifiedSend(A, { routeActionId: actionId, postedUrl: postedUrl() }, seam),
    ).rejects.toThrow(/does not contain the approved content/);

    const mid = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(mid!.status).toBe("executing"); // startExecution ran; completeExecution did not
    expect(mid!.postedUrl).toBe(postedUrl()); // recorded (auditable) even though verify failed
    expect(mid!.verifiedAt).toBeNull(); // §3: never claim verified for a page we could not confirm
    expect(mid!.outcome).toBeNull();
    const runIdAfterFirst = mid!.runId;
    expect(runIdAfterFirst).toMatch(/^manual:[0-9a-f]{16}$/);

    // Founder fixes the live page; retry the SAME call — must NOT open a second run.
    livePage = "<html><head><title>Our Blog</title></head><body><h1>Retry Post Delta Epsilon</h1><p>the real launch copy</p></body></html>";
    const out = await submitVerifiedSend(A, { routeActionId: actionId, postedUrl: postedUrl() }, seam);
    expect(out.runId).toBe(runIdAfterFirst); // runId UNCHANGED across the retry

    const done = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(done!.status).toBe("executed");
    expect(done!.runId).toBe(runIdAfterFirst);
    expect(done!.verifiedAt).toBeInstanceOf(Date);
    expect(done!.outcome).toBe("verified");
  });

  // Inv 3 — Publish-moment D29: the bound hash is checked BEFORE the network is
  // touched. Tamper the bound asset AFTER approval; the submit must throw
  // /hash mismatch/ and the fixture server must record ZERO hits, proving
  // assertContentBound fired before safeFetch. Status stays approved (not advanced).
  it("inv3 publish-moment D29: tampering the bound asset after approval -> submit throws /hash mismatch/, fixture server gets ZERO hits, status still approved", async () => {
    const { actionId, assetId } = await approvedBoundViaRealFns(A, { title: "Sealed Launch Announcement Copy", body: "sealed and approved" });
    // Swap the underlying asset content AFTER approval — the bound hash no longer matches.
    await prisma.asset.update({
      where: { id: assetId },
      data: { contentJson: JSON.stringify({ title: "Sealed Launch Announcement Copy", body: "TAMPERED after approval" }) },
    });
    // Point the (never-fetched) page at content that WOULD verify, to prove the
    // refusal is the hash gate and not a content miss.
    livePage = "<html><body><h1>Sealed Launch Announcement Copy</h1><p>sealed and approved</p></body></html>";

    const hitsBefore = hits;
    await expect(
      submitVerifiedSend(A, { routeActionId: actionId, postedUrl: postedUrl() }, seam),
    ).rejects.toThrow(/hash mismatch/i);

    expect(hits).toBe(hitsBefore); // ZERO network hits: the hash gate ran before safeFetch
    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("approved"); // refusal never advanced the action
    expect(a!.runId).toBeNull();
    expect(a!.postedUrl).toBeNull();
    expect(a!.verifiedAt).toBeNull();
    expect(a!.outcome).toBeNull();
  });

  // Inv 4 — SSRF: a private/loopback postedUrl with NO seam is refused by
  // safeFetch's guards. Per the ratified write-ordering startExecution runs before
  // the fetch, so a fetch-stage refusal leaves the action `executing` (retryable) —
  // but the honesty-bearing columns (verifiedAt/outcome) are NEVER set. No row is
  // corrupted into a false `verified`.
  it("inv4 SSRF: a private-address postedUrl with NO seam is refused by safeFetch; the action is never verified and its verify columns are uncorrupted", async () => {
    const { actionId } = await approvedBoundViaRealFns(A, { title: "SSRF Guard Target Announcement", body: "x" });

    await expect(
      // No fetchOpts -> no seam. Default port 80 IS in safeFetch's port allow-list, so
      // the refusal routes through the private-IP guard (assertPublicHost/isPrivateIp:
      // "Blocked private/reserved IP literal"), NOT the port allow-list. This genuinely
      // exercises the IP check — deleting the private-IP guard makes this assertion RED.
      submitVerifiedSend(A, { routeActionId: actionId, postedUrl: "http://127.0.0.1/" }),
    ).rejects.toThrow(/blocked|private|ssrf/i);

    const a = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(a!.status).toBe("executing"); // startExecution ran before the refused fetch
    expect(a!.verifiedAt).toBeNull(); // never verified
    expect(a!.outcome).toBeNull(); // no outcome recorded — no false claim
  });

  // Inv 5 — Agent-tier separation (D27.2 spirit): submitVerifiedSend is NOT
  // MCP-registered. The agent surface stays the exact 11 tools and can never carry
  // a send/outcome tool. The exact SORTED 11-tool whitelist is pinned by the
  // stage-3c lifecycle gate (test/lifecycle-eval.e2e.test.ts); here we pin the
  // count and the specific forbidden name so a send tool cannot slip onto either.
  it("inv5 agent-tier separation: TOOL_SCHEMAS stays the exact 11 and never contains submit_verified_send", () => {
    const toolNames = Object.keys(TOOL_SCHEMAS);
    expect(toolNames.length).toBe(11);
    expect(toolNames).not.toContain("submit_verified_send");
  });

  // Inv 6 — Cross-tenant: the target action EXISTS and is approved in tenant A,
  // and the live page WOULD verify — so if the scope guard were broken the ghost's
  // submit would succeed. It must instead be refused at the scoped load (ZERO
  // fetch hits) and leave every one of A's columns untouched.
  it("inv6 cross-tenant: a ghost tenant cannot submit a send for tenant A's approved action -> refused at the scoped load with zero fetch hits and zero effect on A's rows", async () => {
    const { actionId } = await approvedBoundViaRealFns(A, { title: "Tenant A Scoped Announcement Copy", body: "belongs to A" });
    // Precondition made explicit (not just transitively implied): the target action
    // EXISTS and is approved in tenant A — so a successful ghost submit could only be a
    // scope-guard failure, never a missing/unknown row.
    const target = await prisma.routeAction.findFirst({ where: { id: actionId, businessId: A.businessId } });
    expect(target?.status).toBe("approved");
    // A page that WOULD verify for A — proves the refusal is scope, not content.
    livePage = "<html><body><h1>Tenant A Scoped Announcement Copy</h1><p>belongs to A</p></body></html>";
    const before = await prisma.routeAction.findUnique({ where: { id: actionId } });
    const hitsBefore = hits;

    await expect(
      submitVerifiedSend(GHOST, { routeActionId: actionId, postedUrl: postedUrl() }, seam),
    ).rejects.toThrow(/not found|scope/i);

    expect(hits).toBe(hitsBefore); // refused at the scoped load, before any fetch
    const after = await prisma.routeAction.findUnique({ where: { id: actionId } });
    expect(after!.status).toBe("approved"); // A's action untouched
    expect(after!.status).toBe(before!.status);
    expect(after!.runId).toBeNull();
    expect(after!.postedUrl).toBeNull();
    expect(after!.verifiedAt).toBeNull();
    expect(after!.outcome).toBeNull();
  });
});
