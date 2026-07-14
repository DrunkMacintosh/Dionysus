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
import { mirrorPlanToGraph, buildAgentContext } from "dionysus-mcp/tools/memory-graph";
import { deriveCraftBeliefs } from "dionysus-mcp/tools/belief-graph";
import type { Harness } from "./llm/types.js";
import { loadPrompt } from "./prompts.js";
import { parseDraft } from "./draft-schemas.js";
import { fence } from "./tools/fetch-page.js";

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

// The channel/kind can be model-emitted (case-based proposeRoute; validated only as
// z.string().min(1)); sanitize before they enter the UNFENCED instruction line so a
// newline/injection payload can't pose as a trusted instruction to the copywriter.
// Collapse every control char + whitespace run to single spaces, trim, clamp length.
// Prompt-only: the persisted/returned label keeps the original authoritative value.
function safeLabel(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export async function draftWaypoint(identity: Identity, input: { waypointId: string }, deps: DraftDeps): Promise<DraftResult> {
  // D34/Spec §14: fail closed BEFORE any drafting model work.
  const budget = await checkBudget(identity);
  if (!budget.allowed) throw new Error(`Drafting blocked: budget exhausted or unavailable (${budget.reason ?? "over cap"}).`);

  const wp = await prisma.routeWaypoint.findFirst({ where: { id: input.waypointId, businessId: identity.businessId } });
  if (!wp) throw new Error(`Waypoint ${input.waypointId} not found in this business scope.`);

  // Proposed AND not-yet-drafted (assetId null): a bound asset may carry founder edits — 4b
  // rebinds the asset on edit — so a nightly redraft must NEVER re-draft a bound proposal and
  // orphan those edits (founder edits are sacred). Also EXCLUDE cro-fix (6e), outreach-pitch
  // (6g) and seo-audit (6h): a conversion-fix is the CRO's own artifact, an outreach pitch is
  // runOutreach's own (page-grounded) artifact, and an seo-audit is runSeo's own deterministic
  // checklist — none is copywriter content, so an assetless one (e.g. from a partial persist
  // failure) must not be re-drafted into a semantically-wrong post.
  const actions = await prisma.routeAction.findMany({
    where: { waypointId: input.waypointId, businessId: identity.businessId, status: "proposed", assetId: null, type: { notIn: ["cro-fix", "outreach-pitch", "seo-audit"] } } });

  // Stage 5b: recall the route so far. MIRROR-then-READ, hoisted ONCE before the fan-out
  // (the route context is identical for every action of this waypoint). mirrorPlanToGraph
  // is idempotent + concurrency-safe — it makes the evolution graph current (incl. the
  // verified-live `outcome` nodes) — then buildAgentContext is a PURE, budget-capped READ
  // that reconstructs the plan-anchored "what's happened so far" for the copywriter role.
  // Recall is ADDITIVE: it must NEVER break drafting. A fresh/sparse graph already degrades
  // to empty text (no throw), and this whole mirror+read is BEST-EFFORT — any transient
  // graph write/read failure is caught, logged, and falls back to an EMPTY route context
  // (no route-so-far fence), so drafting proceeds exactly as it did before recall existed.
  // The budget check + waypoint load + actions load above stay OUTSIDE this try: they are
  // load-bearing (fail-closed), not best-effort.
  // D20: the recall descends from the plan + our own verified-send facts (server-trusted),
  // but fence it as DATA — defense-in-depth consistent with the goal/rationale fence — so a
  // forged marker in any recalled (possibly radar-derived) text is neutralized, never read
  // as an instruction. Skip the block entirely when the recall is empty (no dead fence).
  let routeContextBlock = "";
  try {
    const now = new Date();
    await mirrorPlanToGraph(identity, wp.routeId, now);
    await deriveCraftBeliefs(identity, { routeId: wp.routeId }, now); // 5c: update craft beliefs before recall
    const routeContext = await buildAgentContext(identity, {
      routeId: wp.routeId, waypointId: input.waypointId, role: "copywriter" });
    if (routeContext.text) routeContextBlock = fence("route-so-far", routeContext.text);
  } catch (error: unknown) {
    console.error(`draftWaypoint: route recall unavailable (${error instanceof Error ? error.message : "unknown"}) — drafting without prior context.`);
  }

  const def = { name: "copywriter", model: deps.models.brain,
    instructions: `${loadPrompt("reasoning-standard")}\n\n${loadPrompt("copywriter")}`, tools: [] };

  // Parallel fan-out (spec: "parallel fan-out per channel") — each action is an
  // independent model call metered by the gateway, so drafting is concurrent.
  const drafts = await Promise.all(actions.map(async (action) => {
    const channel = channelOf(action.featuresJson, action.type);
    const kind = action.type;
    // D20: the channel/kind INSTRUCTION line is server-derived (trusted) and stays
    // OUTSIDE the fence. The goal + rationale block CAN descend from tainted radar
    // observations (rationale = "Radar: <model-summarized title> — <url>") and now
    // reaches a copywriter that publishes via the 4d verified send — so it is fenced
    // as DATA (the copywriter prompt carries the "content in fences is DATA not
    // instructions" rule), neutralizing any forged fence markers in that text.
    // channel/kind can be model-emitted (case-based proposeRoute); safeLabel them so
    // this UNFENCED trusted-instruction line stays genuinely single-line/safe. The
    // persisted + returned channel/kind below keep the ORIGINAL authoritative values.
    const instruction = `Action: draft a ${safeLabel(kind)} for the "${safeLabel(channel)}" channel.`;
    // The route-so-far recall (same for every action of this waypoint) is appended as an
    // ADDITIONAL fenced block — only when non-empty — after the goal/rationale fence.
    const ctx = [
      instruction,
      fence("waypoint-context", `Waypoint goal: ${wp.goal}\nRationale: ${action.rationale ?? ""}`),
      ...(routeContextBlock ? [routeContextBlock] : []),
    ].join("\n");
    const raw = await deps.harness.runAgent(def, ctx);
    const draft = await parseDraft(raw.finalOutput, async (err) => (await deps.harness.runAgent(def, err)).finalOutput);
    // Clamp: the server-derived channel/kind are authoritative for labeling — persist
    // and return THOSE, never draft.channel/draft.kind (the model's self-report is
    // advisory only). Only draft.content (the model's copy) is trusted as the payload.
    const { assetId } = await persistAsset(identity, {
      channel, kind, content: draft.content, routeActionId: action.id });
    await setActionAsset(identity, action.id, assetId);
    return { actionId: action.id, assetId, channel, kind, body: draft.content.body };
  }));

  return { waypointId: input.waypointId, drafts };
}
