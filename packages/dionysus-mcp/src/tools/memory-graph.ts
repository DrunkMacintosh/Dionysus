import { Prisma, type MemoryNode } from "@prisma/client";
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

/** True for a Prisma unique-constraint violation (P2002) — the concurrent-writer race we re-find on. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export const MEMORY_NODE_TYPES = ["waypoint", "action", "outcome", "learning", "market-observation", "case", "revision"] as const;
export const MEMORY_EDGE_KINDS = ["next", "caused", "informed-by", "supersedes", "references"] as const;
export type MemoryNodeType = (typeof MEMORY_NODE_TYPES)[number];
export type MemoryEdgeKind = (typeof MEMORY_EDGE_KINDS)[number];

export type MemoryNodeInput = { type: MemoryNodeType; title: string; body: string; confidence: number; role?: string; waypointId?: string; sourceId?: string; tainted?: boolean };
export type MemoryEdgeInput = { fromId: string; toId: string; kind: MemoryEdgeKind };

/** §13: a plan-mirror or memory node. Mirror nodes reflect our own server-set structured plan, so tainted defaults FALSE (recordObservation is the only writer that forces true). */
export async function persistMemoryNode(identity: Identity, input: MemoryNodeInput): Promise<{ nodeId: string }> {
  if (!MEMORY_NODE_TYPES.includes(input.type)) throw new Error(`Invalid memory node type "${input.type}".`);
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error(`Invalid confidence ${input.confidence} (must be a number in 0..1).`);
  }
  const row = await prisma.memoryNode.create({ data: {
    businessId: identity.businessId, type: input.type, title: input.title, body: input.body,
    confidence: input.confidence, role: input.role ?? null, waypointId: input.waypointId ?? null,
    sourceId: input.sourceId ?? null, tainted: input.tainted ?? false } });
  return { nodeId: row.id };
}

/** §10: an idempotent graph edge. Both endpoints must belong to the caller's business (findFirst scope guard); dedups on (businessId, fromId, toId, kind). */
export async function persistMemoryEdge(identity: Identity, input: MemoryEdgeInput): Promise<{ edgeId: string }> {
  if (!MEMORY_EDGE_KINDS.includes(input.kind)) throw new Error(`Invalid memory edge kind "${input.kind}".`);
  const from = await prisma.memoryNode.findFirst({ where: { id: input.fromId, businessId: identity.businessId } });
  if (!from) throw new Error(`Edge fromId ${input.fromId} not found in this business scope.`);
  const to = await prisma.memoryNode.findFirst({ where: { id: input.toId, businessId: identity.businessId } });
  if (!to) throw new Error(`Edge toId ${input.toId} not found in this business scope.`);
  const dedupWhere = { businessId: identity.businessId, fromId: input.fromId, toId: input.toId, kind: input.kind };
  const existing = await prisma.memoryEdge.findFirst({ where: dedupWhere });
  if (existing) return { edgeId: existing.id };
  try {
    const row = await prisma.memoryEdge.create({ data: dedupWhere });
    return { edgeId: row.id };
  } catch (error: unknown) {
    // Concurrency: a racing writer inserted the same (businessId, fromId, toId, kind) first — re-find it.
    if (isUniqueViolation(error)) {
      const row = await prisma.memoryEdge.findFirst({ where: dedupWhere });
      if (row) return { edgeId: row.id };
    }
    throw error;
  }
}

/** Find-or-create a mirror node keyed by (businessId, type, sourceId) — the idempotency primitive for the plan mirror. */
async function findOrCreateMirrorNode(identity: Identity, input: MemoryNodeInput & { sourceId: string }): Promise<string> {
  const dedupWhere = { businessId: identity.businessId, type: input.type, sourceId: input.sourceId };
  const existing = await prisma.memoryNode.findFirst({ where: dedupWhere });
  if (existing) return existing.id;
  try {
    const { nodeId } = await persistMemoryNode(identity, input);
    return nodeId;
  } catch (error: unknown) {
    // Concurrency: a racing mirror inserted the same (businessId, type, sourceId) first — re-find it.
    if (isUniqueViolation(error)) {
      const row = await prisma.memoryNode.findFirst({ where: dedupWhere });
      if (row) return row.id;
    }
    throw error;
  }
}

/**
 * §13 anchored-to-the-plan: mirror the STRUCTURED plan into the evolution graph — one `waypoint`
 * node per RouteWaypoint and one `action` node per RouteAction, wired by a `next` spine along the
 * ordered waypoints and `references` edges from each action node to its waypoint node. Each action
 * that has ACTUALLY GONE LIVE (status "executed" AND verifiedAt set — a real verified send) also
 * gets one `outcome` node + a `caused` edge (action node → outcome node). The outcome records the
 * VERIFIED-LIVE FACT only — title `went live on {channel}` (channel from the bound asset, else the
 * action type), body = the live postedUrl — it does NOT claim a metric moved (measured outcomes
 * need analytics — 5c). Proposed/approved/executing actions get NO outcome node.
 * Idempotent / lazy-on-view safe: each mirror node is found-or-created by (businessId, type,
 * sourceId=the RouteWaypoint/RouteAction id) — `type` disambiguates the outcome node from the
 * action node (same sourceId) — so re-calls return the SAME ids and add ZERO rows; edges dedup
 * inside persistMemoryEdge. Mirror nodes are TRUSTED (tainted:false — persistMemoryNode default)
 * since they reflect our own server-set plan and verified-send facts, not ingested content. `now`
 * is accepted for signature consistency (5a does not window on it; retained for the 5b learning loop).
 */
export async function mirrorPlanToGraph(
  identity: Identity, routeId: string, _now: Date,
): Promise<{ waypointNodeIds: string[]; actionNodeIds: string[]; outcomeNodeIds: string[]; edgeCount: number }> {
  const route = await prisma.route.findFirst({ where: { id: routeId, businessId: identity.businessId } });
  if (!route) throw new Error(`Route ${routeId} not found in this business scope.`);

  const waypoints = await prisma.routeWaypoint.findMany({
    where: { routeId, businessId: identity.businessId }, orderBy: { order: "asc" } });

  const waypointNodeIds: string[] = [];
  const actionNodeIds: string[] = [];
  const outcomeNodeIds: string[] = [];
  let edgeCount = 0;
  let prevWaypointNodeId: string | undefined; // for the `next` spine along consecutive waypoints

  for (const wp of waypoints) {
    // Waypoint mirror node (collected in `order`).
    const wpNodeId = await findOrCreateMirrorNode(identity, {
      type: "waypoint", title: wp.title, body: wp.goal, confidence: 1, waypointId: wp.id, sourceId: wp.id });
    waypointNodeIds.push(wpNodeId);

    // `next` edge from the previous waypoint node to this one (deduped in persistMemoryEdge).
    if (prevWaypointNodeId !== undefined) {
      await persistMemoryEdge(identity, { fromId: prevWaypointNodeId, toId: wpNodeId, kind: "next" });
      edgeCount++;
    }
    prevWaypointNodeId = wpNodeId;

    // Action mirror nodes for this waypoint + a `references` edge from each to its waypoint node.
    const actions = await prisma.routeAction.findMany({
      where: { waypointId: wp.id, businessId: identity.businessId }, orderBy: { createdAt: "asc" } });
    for (const action of actions) {
      const nodeId = await findOrCreateMirrorNode(identity, {
        type: "action", title: `${action.employeeRole}/${action.type}`, body: action.rationale ?? "",
        confidence: 1, waypointId: wp.id, sourceId: action.id });
      actionNodeIds.push(nodeId);
      await persistMemoryEdge(identity, { fromId: nodeId, toId: wpNodeId, kind: "references" });
      edgeCount++;

      // §13 honesty gate: an `outcome` node is created ONLY for a REAL verified send —
      // status "executed" AND verifiedAt set. It carries the VERIFIED-LIVE FACT (channel + live URL),
      // NOT a fabricated metric (measured outcomes need analytics — 5c). Idempotent by (businessId,
      // type:"outcome", sourceId=action.id); `type` disambiguates it from the action node above.
      if (action.status === "executed" && action.verifiedAt) {
        let channel = action.type; // fall back to the action type when there is no bound asset
        if (action.assetId) {
          const asset = await prisma.asset.findFirst({
            where: { id: action.assetId, businessId: identity.businessId } });
          if (asset) channel = asset.channel;
        }
        const outcomeNodeId = await findOrCreateMirrorNode(identity, {
          type: "outcome", title: `went live on ${channel}`, body: action.postedUrl ?? "",
          confidence: 1, waypointId: wp.id, sourceId: action.id });
        outcomeNodeIds.push(outcomeNodeId);
        await persistMemoryEdge(identity, { fromId: nodeId, toId: outcomeNodeId, kind: "caused" });
        edgeCount++;
      }
    }
  }

  return { waypointNodeIds, actionNodeIds, outcomeNodeIds, edgeCount };
}

/** The plan-anchored causal-recall read: the waypoint ancestor path + the anchor's action/outcome neighborhood + role-scoped learnings + a compact prompt rendering. */
export type AgentContext = {
  ancestorPath: Array<{ title: string; goal: string }>;                                 // waypoints head→anchor (incl.), in `next`-spine order
  neighborhood: Array<{ kind: "action" | "outcome"; title: string; detail: string }>;   // the anchor waypoint's actions + their `caused` outcomes, capped
  learnings: Array<{ title: string; body: string; confidence: number }>;                // role-scoped `learning` nodes (none at 5b — forward-compatible)
  text: string;                                                                          // bounded prompt rendering (capped by maxItems)
};

/** Budget cap on the recalled neighborhood + learnings (and, via the neighborhood, the `text`). */
const DEFAULT_MAX_ITEMS = 12;

/**
 * §Memory read = traversal. The plan-anchored CAUSAL-RECALL read behind an agent's "what's happened
 * so far" context. It is PURE and businessId-SCOPED: it writes nothing and mirrors nothing
 * (mirrorPlanToGraph is the sole writer — this only READS whatever graph already exists), and it is
 * BUDGET-CAPPED so the recalled context stays bounded no matter how large the graph grows.
 *
 * Flow: scoped route load (a cross-tenant/unknown routeId is the ONLY throw). Reconstruct the
 * waypoint ancestor path by ordering the route's waypoint mirror nodes on the SOURCE
 * RouteWaypoint.order (join via sourceId → RouteWaypoint.id → .order — deterministic integer order,
 * no createdAt ties; the same ordering getTimeline relies on). Anchor = the given waypointId's mirror
 * node, else the LAST waypoint on the spine; ancestorPath = head→anchor inclusive. Neighborhood = the
 * anchor waypoint's `action` nodes plus the `outcome` nodes they `caused` (edge traversal), capped at
 * `maxItems`. `text` renders the path (anchor marked "(current)") + the capped "Done" facts, so
 * maxItems bounds BOTH the item list and the prompt string. A sparse/empty graph (route exists but was
 * never mirrored) degrades to an all-empty context — NO throw. `learnings` are role-scoped `learning`
 * nodes; NONE exist at 5b (the belief layer lands in 5c), so this stays forward-compatible and empty.
 */
export async function buildAgentContext(
  identity: Identity,
  input: { routeId: string; waypointId?: string; role?: string },
  opts?: { maxItems?: number },
): Promise<AgentContext> {
  const maxItems = opts?.maxItems ?? DEFAULT_MAX_ITEMS;
  const empty: AgentContext = { ancestorPath: [], neighborhood: [], learnings: [], text: "" };

  // Scoped route load — a cross-tenant/unknown routeId is a not-found (the ONLY throw path).
  const route = await prisma.route.findFirst({ where: { id: input.routeId, businessId: identity.businessId } });
  if (!route) throw new Error(`Route ${input.routeId} not found in this business scope.`);

  // Waypoint spine, ordered by the SOURCE RouteWaypoint.order (deterministic; no createdAt ties).
  // Join: each route waypoint (ordered) → its waypoint mirror node by (type "waypoint", sourceId=wp.id).
  const waypoints = await prisma.routeWaypoint.findMany({
    where: { routeId: input.routeId, businessId: identity.businessId }, orderBy: { order: "asc" } });
  const wpNodes: MemoryNode[] = [];
  for (const wp of waypoints) {
    const node = await prisma.memoryNode.findFirst({
      where: { businessId: identity.businessId, type: "waypoint", sourceId: wp.id } });
    if (node) wpNodes.push(node);
  }
  // Degrade-to-empty: no mirror nodes yet (route never mirrored) → empty context, NO throw.
  if (wpNodes.length === 0) return empty;

  // Anchor = the given waypointId's mirror node, else the LAST waypoint on the spine.
  let anchorIndex = wpNodes.length - 1;
  if (input.waypointId) {
    const found = wpNodes.findIndex((n) => n.waypointId === input.waypointId || n.sourceId === input.waypointId);
    if (found !== -1) anchorIndex = found;
    // else: an unresolvable/foreign waypointId falls back to the last (current) waypoint (anchorIndex
    // unchanged) — the caller (draftWaypoint) always passes a valid in-route id, so this is a defensive
    // default, not an error path (deliberately no throw).
  }
  const anchor = wpNodes[anchorIndex];
  if (!anchor) return empty; // unreachable (wpNodes is non-empty, anchorIndex is in range) — satisfies the type guard

  // Ancestor path = head → anchor (inclusive), in spine order.
  const ancestorPath = wpNodes.slice(0, anchorIndex + 1).map((n) => ({ title: n.title, goal: n.body }));

  // Neighborhood = the anchor waypoint's `action` nodes + the `outcome` nodes they `caused`, capped
  // at maxItems. Each action is immediately followed by its caused outcome(s) (recall of "what this
  // action produced"). The cap can cut mid-action-group — that is intended: it hard-bounds the list.
  const neighborhood: AgentContext["neighborhood"] = [];
  if (anchor.waypointId) {
    const actionNodes = await prisma.memoryNode.findMany({
      where: { businessId: identity.businessId, type: "action", waypointId: anchor.waypointId },
      orderBy: { createdAt: "asc" } });
    for (const actionNode of actionNodes) {
      if (neighborhood.length >= maxItems) break;
      neighborhood.push({ kind: "action", title: actionNode.title, detail: actionNode.body });
      // Traverse the `caused` edge (action → outcome) to recall the verified-live facts it produced.
      const causedEdges = await prisma.memoryEdge.findMany({
        where: { businessId: identity.businessId, fromId: actionNode.id, kind: "caused" } });
      for (const edge of causedEdges) {
        if (neighborhood.length >= maxItems) break;
        const outcomeNode = await prisma.memoryNode.findFirst({
          where: { id: edge.toId, businessId: identity.businessId } });
        if (outcomeNode) neighborhood.push({ kind: "outcome", title: outcomeNode.title, detail: outcomeNode.body });
      }
    }
  }

  // Learnings = role-scoped `learning` nodes — NONE at 5b (the belief layer is 5c); bounded by maxItems.
  const learningNodes = await prisma.memoryNode.findMany({
    where: { businessId: identity.businessId, type: "learning", ...(input.role ? { role: input.role } : {}) },
    orderBy: { confidence: "desc" }, take: maxItems });
  const learnings = learningNodes.map((n) => ({ title: n.title, body: n.body, confidence: n.confidence }));

  // Compact, bounded prompt rendering: the waypoint path (anchor marked "(current)") + the capped
  // "Done" facts drawn from the neighborhood's outcome items (so maxItems bounds the text too).
  const lines = ["Route so far:"];
  ancestorPath.forEach((wp, i) => {
    const marker = i === ancestorPath.length - 1 ? " (current)" : "";
    lines.push(`- ${wp.title}${marker}: ${wp.goal}`);
  });
  for (const item of neighborhood) {
    if (item.kind !== "outcome") continue;
    lines.push(`Done: ${item.title}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  const text = lines.join("\n");

  return { ancestorPath, neighborhood, learnings, text };
}
