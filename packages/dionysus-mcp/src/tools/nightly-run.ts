// Stage 6j — the nightly's activity record: the account of what ran, what was
// skipped, and what failed, VERBATIM (§16 accountability; D31 liveness). This is
// a diary write, not a lifecycle tool: it can create rows only, is scoped to the
// ambient identity (D27.1), and is NOT MCP-registered (whitelist stays 11).
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

export type RecordedSection =
  | { status: "ok"; detail: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

const VALID_STATUS = new Set(["ok", "skipped", "failed"]);

export async function recordNightlyRun(
  identity: Identity,
  input: { sections: Record<string, RecordedSection> },
): Promise<{ runId: string }> {
  const keys = Object.keys(input.sections);
  if (keys.length === 0) throw new Error("recordNightlyRun: an empty section map is not a night.");
  for (const key of keys) {
    const s = input.sections[key] as { status?: unknown };
    if (typeof s?.status !== "string" || !VALID_STATUS.has(s.status)) {
      throw new Error(`recordNightlyRun: section "${key}" has no valid status — a malformed diary is worse than none.`);
    }
  }
  const row = await prisma.nightlyRun.create({
    data: { businessId: identity.businessId, sectionsJson: JSON.stringify(input.sections) } });
  return { runId: row.id };
}
