import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { isUniqueViolation } from "./memory-graph.js";
import type { CraftBelief } from "../lib/belief.js";

/** The stable idempotency key for a business's live belief about a (role, feature) pair. */
function beliefSourceId(role: string, featureKey: string): string {
  return `${role}::${featureKey}`;
}

/**
 * Persist a CRAFT belief as the single LIVE `learning` node for (businessId, role, featureKey),
 * found-or-created by sourceId. Corroboration (same stance) UPDATES the live node in place — zero
 * new rows. A stance FLIP (positive↔negative — a contradiction) snapshots the prior belief into a
 * superseded node and writes a `supersedes` edge (live → snapshot, spec §10 line 171), then updates
 * the live node to the new stance. neutral is not a contradiction (it only ever updates in place).
 * Belief nodes are TRUSTED (tainted:false) — our own summary of the founder's own actions.
 */
export async function persistCraftBelief(
  identity: Identity,
  input: { role: string; featureKey: string; belief: CraftBelief },
): Promise<{ beliefNodeId: string; superseded: boolean }> {
  const { role, featureKey, belief } = input;
  const sourceId = beliefSourceId(role, featureKey);
  const title = `${role} · ${featureKey}`;

  const existing = await prisma.memoryNode.findFirst({
    where: { businessId: identity.businessId, type: "learning", sourceId },
  });

  if (!existing) {
    try {
      const row = await prisma.memoryNode.create({
        data: {
          businessId: identity.businessId, type: "learning", role, waypointId: null,
          title, body: belief.summary, confidence: belief.confidence, stance: belief.stance,
          sourceId, tainted: false,
        },
      });
      return { beliefNodeId: row.id, superseded: false };
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        const row = await prisma.memoryNode.findFirst({ where: { businessId: identity.businessId, type: "learning", sourceId } });
        if (row) return { beliefNodeId: row.id, superseded: false };
      }
      throw error;
    }
  }

  const isFlip =
    (existing.stance === "positive" && belief.stance === "negative") ||
    (existing.stance === "negative" && belief.stance === "positive");

  let superseded = false;
  if (isFlip) {
    const snapshotCount = await prisma.memoryNode.count({
      where: { businessId: identity.businessId, type: "learning", sourceId: { startsWith: `${sourceId}::superseded::` } },
    });
    const snapshot = await prisma.memoryNode.create({
      data: {
        businessId: identity.businessId, type: "learning", role, waypointId: null,
        title: `${title} (superseded)`, body: existing.body, confidence: existing.confidence, stance: existing.stance,
        sourceId: `${sourceId}::superseded::${snapshotCount}`, tainted: false,
      },
    });
    await prisma.memoryEdge.create({
      data: { businessId: identity.businessId, fromId: existing.id, toId: snapshot.id, kind: "supersedes" },
    });
    superseded = true;
  }

  await prisma.memoryNode.update({
    where: { id: existing.id },
    data: { body: belief.summary, confidence: belief.confidence, stance: belief.stance, title },
  });
  return { beliefNodeId: existing.id, superseded };
}
