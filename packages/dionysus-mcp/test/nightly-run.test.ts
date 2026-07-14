import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { recordNightlyRun, type RecordedSection } from "../src/tools/nightly-run.js";

const BIZ = "biz_nightly_a";
const OTHER = "biz_nightly_b";
const GHOST = "biz_nightly_ghost_missing"; // never created — no Business row

beforeEach(async () => {
  for (const id of [BIZ, OTHER]) {
    await prisma.nightlyRun.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
  await prisma.nightlyRun.deleteMany({ where: { businessId: GHOST } });
});

describe("recordNightlyRun", () => {
  it("records a valid section map and round-trips it VERBATIM (incl. a failed reason)", async () => {
    const sections: Record<string, RecordedSection> = {
      plan: { status: "ok", detail: "3 waypoints advanced" },
      radar: { status: "skipped", reason: "no active objectives" },
      drafts: { status: "failed", reason: "budget cap reached: 0 tokens remaining" },
    };
    const { runId } = await recordNightlyRun({ businessId: BIZ }, { sections });

    const row = await prisma.nightlyRun.findUnique({ where: { id: runId } });
    expect(row).not.toBeNull();
    // VERBATIM: the stored JSON deep-equals the input — nothing renamed/summarized/softened.
    expect(JSON.parse(row!.sectionsJson)).toEqual(sections);
  });

  it("rejects an empty section map (an empty map is not a night)", async () => {
    await expect(recordNightlyRun({ businessId: BIZ }, { sections: {} }))
      .rejects.toThrow(/empty section map/i);
    expect(await prisma.nightlyRun.count({ where: { businessId: BIZ } })).toBe(0);
  });

  it("rejects a section with an invalid status and writes ZERO rows (never store a malformed diary)", async () => {
    const sections = {
      plan: { status: "ok", detail: "ok" },
      radar: { status: "exploded", reason: "not a real status" },
    } as unknown as Record<string, RecordedSection>;
    await expect(recordNightlyRun({ businessId: BIZ }, { sections }))
      .rejects.toThrow(/valid status/i);
    expect(await prisma.nightlyRun.count({ where: { businessId: BIZ } })).toBe(0);
  });

  it("is scoped — tenant A's record carries A's businessId (D27.1)", async () => {
    const { runId } = await recordNightlyRun({ businessId: BIZ }, {
      sections: { plan: { status: "ok", detail: "advanced" } } });
    const row = await prisma.nightlyRun.findUnique({ where: { id: runId } });
    expect(row?.businessId).toBe(BIZ);
    // OTHER's diary is untouched — this write belongs only to A.
    expect(await prisma.nightlyRun.count({ where: { businessId: OTHER } })).toBe(0);
  });

  it("rejects a nonexistent businessId (FK) — the caller's catch is what keeps the night alive", async () => {
    await expect(recordNightlyRun({ businessId: GHOST }, {
      sections: { plan: { status: "ok", detail: "advanced" } } })).rejects.toThrow();
    expect(await prisma.nightlyRun.count({ where: { businessId: GHOST } })).toBe(0);
  });
});
