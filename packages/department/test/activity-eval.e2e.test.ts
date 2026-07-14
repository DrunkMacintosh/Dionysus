// §15 stage-6j eval gate — the NIGHTLY ACTIVITY DIARY (D31 liveness / §16 accountability made
// visible) is:
//   (inv1) HONEST RECORD (the core): a FULL nightly on a business with budget cap 0 REALLY fails
//     a section (radar throws fail-closed) while others skip → the persisted record's section map
//     deep-equals the RETURNED result VERBATIM (businessId dropped). The failed section's STORED
//     reason is the REAL failure string — it equals the returned reason AND is non-empty — and the
//     map is genuinely mixed (≥1 failed + ≥1 skipped), so the equality is not over a uniform map.
//     Nothing is ok-washed, summarized, or softened between runNightly and the diary row.
//   (inv2) THE DIARY NEVER FAILS THE NIGHT: runNightly on a vanished businessId RESOLVES (no throw)
//     — the diary write FK-fails into its own best-effort catch — and writes ZERO nightlyRun rows.
//   (inv3) CROSS-TENANT: two businesses each run a night → each has exactly ONE record carrying its
//     OWN businessId; a query scoped to tenant A returns nothing of B's (D27.1 on the write path).
//   (inv4) APPEND-ONLY: the same business runs twice → TWO records with DISTINCT ids; the first
//     run's record still exists unchanged alongside the second (nothing upserted/overwritten), and
//     the pair is orderable newest-first by ranAt (the diary accumulates history).
//   (inv5) WHITELIST: TOOL_SCHEMAS stays exactly 11 — `record_nightly_run` is a non-MCP diary
//     write (create-only, identity-scoped), never an agent-assertable tool.
//
// This gate touches no page fetch, no analytics source, and no real model call: radar throws on the
// budget gate before any model call (inv1), the fake harness answers the deterministic sections, and
// the quiet HN transport keeps radar off the network. Tenants live under biz_activityeval_* so this
// gate never collides with other suites. CRITICAL teardown: nightlyRun rows FK-guard business
// deletion, so wipeChildren deletes them FIRST (the sibling gates share this pattern).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { prisma } from "dionysus-mcp/db";
import { CONFIG_KEY_ENV } from "dionysus-mcp/lib/secret-box";
import type { MetricTransport } from "dionysus-mcp/tools/analytics";
import { TOOL_SCHEMAS } from "dionysus-mcp/server";
import type { Harness, AgentDef } from "../src/llm/types.js";
import type { HnTransport } from "../src/tools/hn-source.js";
import { runNightly, type NightlyDeps } from "../src/run-nightly.js";

// The fake harness for the deterministic sections: a schema-valid draft for the copywriter's
// "Action: draft" call, else a quiet (valid, empty) observations set. No real model is touched —
// inv1's failing section throws on the budget gate before ever reaching this.
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

// A quiet HN transport keeps radar OFF the network (zero signals → radar ok, no proposals); a
// throwing metric transport guarantees nothing dials out for metrics (no source is connected, so
// ingestMetrics skips before ever calling it).
const quietHn: HnTransport = async () => ({ status: 200, body: JSON.stringify({ hits: [] }) });
const failMetrics: MetricTransport = async () => { throw new Error("no metric endpoint in activity eval"); };

function nightlyDeps(): NightlyDeps {
  return { harness: goodHarness(), models: { brain: "fake" }, hnTransport: quietHn, metricTransport: failMetrics };
}

const HONEST = "biz_activityeval_honest";
const GHOST = "biz_activityeval_ghost";
const CROSS_A = "biz_activityeval_cross_a";
const CROSS_B = "biz_activityeval_cross_b";
const APPEND = "biz_activityeval_append";
const TENANTS = [HONEST, GHOST, CROSS_A, CROSS_B, APPEND];

// FK-safe teardown (the diary FIRST — nightlyRun rows FK-guard business deletion, T2's note); then
// the standard children → nodes; leaves the Business row alone. Children before parents.
async function wipeChildren(businessId: string): Promise<void> {
  await prisma.nightlyRun.deleteMany({ where: { businessId } }); // 6j: the diary FK-guards business deletion
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

// The standard minimal nightly fixture: an active objective/route/waypoint (no product, no
// analytics source). `maxTokensPerDay` is a parameter so inv1 can seed budget cap 0 → radar throws
// fail-closed (a REAL section failure) while the deterministic sections skip.
async function seedBusiness(businessId: string, maxTokensPerDay: number): Promise<void> {
  await wipeChildren(businessId);
  await prisma.business.upsert({ where: { id: businessId },
    create: { id: businessId, name: businessId, maxTokensPerDay },
    update: { maxTokensPerDay, name: businessId } });
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active" } });
  await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "Launch", goal: "go live", status: "active" } });
}

type StoredSection = { status: string; detail?: string; reason?: string };

describe("§15 stage-6j eval gate — the nightly diary is verbatim, best-effort, tenant-scoped, non-MCP", () => {
  beforeAll(() => {
    process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
  });
  afterAll(async () => {
    for (const b of TENANTS) await wipeChildren(b);
    await prisma.business.deleteMany({ where: { id: { in: TENANTS } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("inv1 HONEST RECORD: a budget-capped night REALLY fails a section while others skip; the record deep-equals the returned map, the failed reason verbatim", async () => {
    // Budget cap 0 → runRadar throws fail-closed (a REAL failure) while plan/metrics/... skip. The
    // business row EXISTS, so the diary write succeeds and we can compare it to the return VERBATIM.
    await seedBusiness(HONEST, 0);
    vi.spyOn(console, "error").mockImplementation(() => {}); // best-effort section logs are expected

    const res = await runNightly({ businessId: HONEST }, nightlyDeps());
    const { businessId: _businessId, ...sections } = res;

    // Exactly ONE record was written for this night...
    const rows = await prisma.nightlyRun.findMany({ where: { businessId: HONEST } });
    expect(rows).toHaveLength(1);
    // ...and it is the RETURNED section map VERBATIM — no ok-washing, no summarizing anywhere.
    const stored = JSON.parse(rows[0]!.sectionsJson) as Record<string, StoredSection>;
    expect(stored).toEqual(sections);

    // Non-vacuous: the map is genuinely MIXED — at least one section REALLY failed and at least one
    // skipped, so the deep-equality above is not over a trivially uniform map.
    const statuses = Object.values(sections).map((s) => s.status);
    expect(statuses).toContain("failed");
    expect(statuses).toContain("skipped");

    // The failed section (radar, budget fail-closed) carries its REAL reason: the STORED reason
    // equals the RETURNED reason and is non-empty — the diary never softens a failure into silence.
    const radar = res.radar;
    if (radar.status !== "failed") throw new Error(`expected radar to fail under budget cap 0, got ${radar.status}`);
    expect(radar.reason.length).toBeGreaterThan(0);
    expect(stored.radar!.status).toBe("failed");
    expect(stored.radar!.reason).toBe(radar.reason);
  });

  it("inv2 THE DIARY NEVER FAILS THE NIGHT: a vanished businessId RESOLVES (no throw) and writes ZERO records", async () => {
    // No business row for GHOST: every section degrades and the diary write FK-fails into its own
    // best-effort catch — the night must still RESOLVE, with no record left behind.
    await prisma.nightlyRun.deleteMany({ where: { businessId: GHOST } });
    await prisma.business.deleteMany({ where: { id: GHOST } });
    vi.spyOn(console, "error").mockImplementation(() => {}); // the swallowed FK failure is logged

    const res = await runNightly({ businessId: GHOST }, nightlyDeps());

    expect(res.businessId).toBe(GHOST); // it RESOLVED — did NOT throw
    expect(await prisma.nightlyRun.count({ where: { businessId: GHOST } })).toBe(0);
  });

  it("inv3 CROSS-TENANT: two businesses each run a night → each has exactly ONE record with its own businessId; A's query never sees B's", async () => {
    await seedBusiness(CROSS_A, 100000);
    await seedBusiness(CROSS_B, 100000);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runNightly({ businessId: CROSS_A }, nightlyDeps());
    await runNightly({ businessId: CROSS_B }, nightlyDeps());

    // Each tenant has exactly ONE record, carrying only its own businessId (D27.1 on the write path).
    const aRows = await prisma.nightlyRun.findMany({ where: { businessId: CROSS_A } });
    const bRows = await prisma.nightlyRun.findMany({ where: { businessId: CROSS_B } });
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows.every((r) => r.businessId === CROSS_A)).toBe(true);
    expect(bRows.every((r) => r.businessId === CROSS_B)).toBe(true);
    // Non-vacuous cross-check: A's row id never appears in B's tenant and vice versa.
    expect(bRows.some((r) => r.id === aRows[0]!.id)).toBe(false);
  });

  it("inv4 APPEND-ONLY: the same business run twice → TWO distinct records; the first survives alongside the second, orderable newest-first", async () => {
    await seedBusiness(APPEND, 100000);
    vi.spyOn(console, "error").mockImplementation(() => {});

    // NIGHT 1 — one record. Capture its id + sectionsJson so we can prove night 2 did not overwrite it.
    await runNightly({ businessId: APPEND }, nightlyDeps());
    const afterFirst = await prisma.nightlyRun.findMany({ where: { businessId: APPEND } });
    expect(afterFirst).toHaveLength(1);
    const firstId = afterFirst[0]!.id;
    const firstJson = afterFirst[0]!.sectionsJson;

    // NIGHT 2 — the diary ACCUMULATES: a SECOND record, never an upsert of the first.
    await runNightly({ businessId: APPEND }, nightlyDeps());
    const afterSecond = await prisma.nightlyRun.findMany({ where: { businessId: APPEND }, orderBy: { ranAt: "desc" } });
    expect(afterSecond).toHaveLength(2);

    // The two records are DISTINGUISHABLE (distinct ids)...
    const ids = afterSecond.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
    // ...the first run's record STILL EXISTS unchanged (nothing upserted/overwritten)...
    const survivor = afterSecond.find((r) => r.id === firstId);
    expect(survivor).toBeDefined();
    expect(survivor!.sectionsJson).toBe(firstJson);
    // ...and the pair is orderable newest-first by ranAt (the read surface's ordering holds).
    expect(afterSecond[0]!.ranAt.getTime()).toBeGreaterThanOrEqual(afterSecond[1]!.ranAt.getTime());
  });

  it("inv5 WHITELIST: TOOL_SCHEMAS stays exactly 11 and never exposes record_nightly_run (the diary is a non-MCP write)", () => {
    const names = Object.keys(TOOL_SCHEMAS);
    expect(names).toHaveLength(11);
    for (const forbidden of ["record_nightly_run", "list_nightly_activity", "record_activity"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
