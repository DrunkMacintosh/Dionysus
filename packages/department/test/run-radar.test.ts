import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { runRadar } from "../src/run-radar.js";
import type { Harness, AgentDef } from "../src/llm/types.js";
import type { HnTransport } from "../src/tools/hn-source.js";

// Caller tenant and a FOREIGN tenant (for the cross-tenant / scoping cases).
const CALLER = { businessId: "biz_radar" };
const OTHER = { businessId: "biz_radar_x" };
let callerRoute = "";
let otherRoute = "";
let capturedInput = "";

// The three signals HN "returns" this run. Their radar URLs are the item?id
// permalinks derived from objectID — this is the fetched set the honesty core
// checks observation sourceUrls against.
const HITS = [
  { objectID: "s1", title: "Sig 1", points: 100, author: "a" },
  { objectID: "s2", title: "Sig 2", points: 50, author: "b" },
  { objectID: "s3", title: "Sig 3", points: 10, author: "c" },
];
const URL_S1 = "https://news.ycombinator.com/item?id=s1";
const URL_S2 = "https://news.ycombinator.com/item?id=s2";

const okTransport = (hits: unknown[]): HnTransport => async () => ({ status: 200, body: JSON.stringify({ hits }) });
const emptyTransport: HnTransport = async () => ({ status: 200, body: JSON.stringify({ hits: [] }) });

// Two real observations (one high-relevance, one low) + one FABRICATED (its
// sourceUrl is NOT in the fetched set — the anti-fabrication filter must drop it).
const HAPPY = JSON.stringify({
  observations: [
    { title: "Real high", body: "high body", sourceUrl: URL_S1, relevance: 9, confidence: 0.8 },
    { title: "Real low", body: "low body", sourceUrl: URL_S2, relevance: 3, confidence: 0.5 },
    { title: "Fabricated", body: "fake body", sourceUrl: "https://fabricated.example/x", relevance: 10, confidence: 0.9 },
  ],
});

type CountingHarness = Harness & { calls: number };
function fakeHarness(output: string): CountingHarness {
  const h = {
    calls: 0,
    async runAgent(_def: AgentDef, input: string) {
      h.calls++;
      capturedInput = input;
      return { finalOutput: output };
    },
    async completeOnce() { return "unused"; },
  };
  return h;
}

const memCount = (biz: string) => prisma.memoryNode.count({ where: { businessId: biz, type: "market-observation" } });
const actionCount = (biz: string) => prisma.routeAction.count({ where: { businessId: biz } });

async function seedTenant(biz: string, tokens = 100000): Promise<string> {
  await prisma.memoryNode.deleteMany({ where: { businessId: biz } });
  await prisma.routeAction.deleteMany({ where: { businessId: biz } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId: biz } });
  await prisma.route.deleteMany({ where: { businessId: biz } });
  await prisma.objective.deleteMany({ where: { businessId: biz } });
  await prisma.business.upsert({ where: { id: biz },
    create: { id: biz, name: biz, maxTokensPerDay: tokens }, update: { maxTokensPerDay: tokens } });
  const obj = await prisma.objective.create({ data: { businessId: biz, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: biz, objectiveId: obj.id, source: "case", status: "active" } });
  await prisma.routeWaypoint.create({ data: { businessId: biz, routeId: route.id, order: 1, title: "Launch", goal: "20 signups", status: "active" } });
  return route.id;
}

beforeAll(async () => {
  callerRoute = await seedTenant(CALLER.businessId);
  otherRoute = await seedTenant(OTHER.businessId);
});

afterEach(() => vi.restoreAllMocks());

const input = (routeId?: string) => ({ objective: "Grow devtool signups", query: "ai agents", ...(routeId ? { routeId } : {}) });

describe("runRadar (sense -> observe -> propose; the honesty core)", () => {
  it("drops fabricated-URL observations, persists tainted survivors, proposes only relevance>=7", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = fakeHarness(HAPPY);
    const res = await runRadar(CALLER, input(callerRoute), { harness, models: { brain: "fake" }, hnTransport: okTransport(HITS) });

    // §6.2 anti-fabrication: only the 2 fetched-set observations survive.
    expect(res.observations).toHaveLength(2);
    expect(res.observations.map((o) => o.sourceUrl).sort()).toEqual([URL_S1, URL_S2]);
    expect(res.observations.some((o) => o.sourceUrl === "https://fabricated.example/x")).toBe(false);
    expect(console.error).toHaveBeenCalled(); // logged the dropped count

    // Persisted, tainted (D27.2), scoped to the caller.
    expect(await memCount(CALLER.businessId)).toBe(2);
    const nodes = await prisma.memoryNode.findMany({ where: { businessId: CALLER.businessId, type: "market-observation" } });
    expect(nodes.every((n) => n.tainted)).toBe(true);
    expect(nodes.every((n) => !!n.sourceUrl)).toBe(true);

    // Propose (D27.2 never-auto): only the relevance>=7 survivor became a proposal.
    expect(res.proposedActionIds).toHaveLength(1);
    const actions = await prisma.routeAction.findMany({ where: { businessId: CALLER.businessId } });
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe("proposed");
    expect(actions[0].rationale).toContain("Radar:");
    expect(actions[0].rationale).toContain(URL_S1); // rationale cites the source

    // D20: signals entered the prompt FENCED; the objective is plain.
    expect(capturedInput).toContain("<<<UNTRUSTED-CONTENT");
    expect(capturedInput).toContain("Grow devtool signups");
    expect(capturedInput).toContain(URL_S1);
  });

  it("budget fail-closed FIRST: over cap throws, nothing persisted, no model call", async () => {
    await prisma.business.update({ where: { id: CALLER.businessId }, data: { maxTokensPerDay: 0 } });
    const beforeMem = await memCount(CALLER.businessId);
    const beforeAct = await actionCount(CALLER.businessId);
    const harness = fakeHarness(HAPPY);
    await expect(runRadar(CALLER, input(callerRoute), { harness, models: { brain: "fake" }, hnTransport: okTransport(HITS) }))
      .rejects.toThrow(/budget/i);
    expect(harness.calls).toBe(0);
    expect(await memCount(CALLER.businessId)).toBe(beforeMem);
    expect(await actionCount(CALLER.businessId)).toBe(beforeAct);
    await prisma.business.update({ where: { id: CALLER.businessId }, data: { maxTokensPerDay: 100000 } });
  });

  it("zero signals: returns empty, NO model call, nothing persisted", async () => {
    const beforeMem = await memCount(CALLER.businessId);
    const beforeAct = await actionCount(CALLER.businessId);
    const harness = fakeHarness(HAPPY);
    const res = await runRadar(CALLER, input(callerRoute), { harness, models: { brain: "fake" }, hnTransport: emptyTransport });
    expect(res).toEqual({ observations: [], proposedActionIds: [] });
    expect(harness.calls).toBe(0); // guarded behind signals-nonempty
    expect(await memCount(CALLER.businessId)).toBe(beforeMem);
    expect(await actionCount(CALLER.businessId)).toBe(beforeAct);
  });

  it("malformed model output (after retry) throws, persists nothing", async () => {
    const beforeMem = await memCount(CALLER.businessId);
    const beforeAct = await actionCount(CALLER.businessId);
    const harness = fakeHarness("{ not valid json");
    await expect(runRadar(CALLER, input(callerRoute), { harness, models: { brain: "fake" }, hnTransport: okTransport(HITS) }))
      .rejects.toThrow();
    expect(await memCount(CALLER.businessId)).toBe(beforeMem);
    expect(await actionCount(CALLER.businessId)).toBe(beforeAct);
  });

  it("cross-tenant routeId: records observations under the CALLER, zero cross-tenant proposals", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const beforeCallerMem = await memCount(CALLER.businessId);
    const beforeOtherAct = await actionCount(OTHER.businessId);
    const harness = fakeHarness(HAPPY);
    // Caller passes ANOTHER tenant's routeId — the active-waypoint lookup is scoped
    // to the caller, so it misses and no proposal is written anywhere.
    const res = await runRadar(CALLER, input(otherRoute), { harness, models: { brain: "fake" }, hnTransport: okTransport(HITS) });
    expect(res.observations).toHaveLength(2);
    expect(res.proposedActionIds).toEqual([]);
    // Observations landed under the caller; no cross-tenant action write.
    expect(await memCount(CALLER.businessId)).toBe(beforeCallerMem + 2);
    expect(await actionCount(OTHER.businessId)).toBe(beforeOtherAct);
  });

  it("scoped: a foreign identity records observations and proposals under that identity only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const beforeCallerMem = await memCount(CALLER.businessId);
    const beforeOtherMem = await memCount(OTHER.businessId);
    const harness = fakeHarness(HAPPY);
    const res = await runRadar(OTHER, input(otherRoute), { harness, models: { brain: "fake" }, hnTransport: okTransport(HITS) });
    expect(res.observations).toHaveLength(2);
    expect(res.proposedActionIds).toHaveLength(1);
    // Writes landed under OTHER only — the caller tenant is untouched.
    expect(await memCount(OTHER.businessId)).toBe(beforeOtherMem + 2);
    expect(await memCount(CALLER.businessId)).toBe(beforeCallerMem);
    const otherActions = await prisma.routeAction.findMany({ where: { businessId: OTHER.businessId } });
    expect(otherActions.every((a) => a.businessId === OTHER.businessId)).toBe(true);
  });
});
