// Stage 3b Task 5 — the Copywriter draftWaypoint pipeline: the parallel fan-out
// that turns a waypoint's proposed actions into one channel-native draft asset
// each, concurrently.
//
//   checkBudget (fail-closed FIRST, D34/Spec §14)
//     → load the waypoint scoped to identity (throw if not found / cross-tenant)
//     → load its RouteActions with status "proposed" (scoped)
//     → Promise.all over the actions — one independent, gateway-metered model call
//       per action (the spec's "parallel fan-out per channel"):
//         copywriter runAgent (no tools)   [T1 harness]
//         → parseDraft (retry via the harness)                 [T4 schema]
//         → persistAsset({channel, kind, content, routeActionId})  [T2 tool]
//         → setActionAsset (links RouteAction.assetId)             [T2 tool]
//     → assembled DraftResult
//
// Identity is ambient (D27.1) — the caller passes it in; it is never a value the
// model can set, and no tool takes a businessId param. All model traffic is the
// injected Harness (D34). §3 reasoning standard: drafts only, no fabricated
// numbers, obey channel self-promo norms — enforced by the copywriter prompt.
import type { Identity } from "dionysus-mcp/identity";
import { prisma } from "dionysus-mcp/db";
import { checkBudget } from "dionysus-mcp/tools/cost-budget";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import type { Harness } from "./llm/types.js";
import { loadPrompt } from "./prompts.js";
import { parseDraft } from "./draft-schemas.js";

export type DraftDeps = { harness: Harness; models: { brain: string } };
export type DraftResult = {
  waypointId: string;
  drafts: Array<{ actionId: string; assetId: string; channel: string; kind: string; body: string }>;
};

// The channel is the action's featuresJson.channel; fall back to the action type
// when absent or unparseable so drafting never crashes on malformed features.
function channelOf(featuresJson: string, fallback: string): string {
  try {
    const f = JSON.parse(featuresJson) as { channel?: unknown };
    return typeof f.channel === "string" ? f.channel : fallback;
  } catch {
    return fallback;
  }
}

export async function draftWaypoint(identity: Identity, input: { waypointId: string }, deps: DraftDeps): Promise<DraftResult> {
  // D34/Spec §14: fail closed BEFORE any drafting model work.
  const budget = await checkBudget(identity);
  if (!budget.allowed) throw new Error(`Drafting blocked: budget exhausted or unavailable (${budget.reason ?? "over cap"}).`);

  const wp = await prisma.routeWaypoint.findFirst({ where: { id: input.waypointId, businessId: identity.businessId } });
  if (!wp) throw new Error(`Waypoint ${input.waypointId} not found in this business scope.`);

  const actions = await prisma.routeAction.findMany({
    where: { waypointId: input.waypointId, businessId: identity.businessId, status: "proposed" } });

  const def = { name: "copywriter", model: deps.models.brain,
    instructions: `${loadPrompt("reasoning-standard")}\n\n${loadPrompt("copywriter")}`, tools: [] };

  // Parallel fan-out (spec: "parallel fan-out per channel") — each action is an
  // independent model call metered by the gateway, so drafting is concurrent.
  const drafts = await Promise.all(actions.map(async (action) => {
    const channel = channelOf(action.featuresJson, action.type);
    const kind = action.type;
    const ctx = `Action: draft a ${kind} for the "${channel}" channel.\nWaypoint goal: ${wp.goal}\nRationale: ${action.rationale ?? ""}`;
    const raw = await deps.harness.runAgent(def, ctx);
    const draft = await parseDraft(raw.finalOutput, async (err) => (await deps.harness.runAgent(def, err)).finalOutput);
    const { assetId } = await persistAsset(identity, {
      channel: draft.channel, kind: draft.kind, content: draft.content, routeActionId: action.id });
    await setActionAsset(identity, action.id, assetId);
    return { actionId: action.id, assetId, channel: draft.channel, kind: draft.kind, body: draft.content.body };
  }));

  return { waypointId: input.waypointId, drafts };
}
