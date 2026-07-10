// Stage 4c Task 4 — the simulateAction pre-flight pipeline: run a proposed draft
// past a synthetic focus group and attach a labeled PREDICTION to the action.
//
//   checkBudget (fail-closed FIRST, D28/D34/Spec §14)
//     → load the RouteAction scoped to identity (throw if not found / cross-tenant)
//     → require status "proposed" (D29 pre-flight ONLY — a simulation never
//       mutates the action: no status, no binding, no content hash)
//     → require + load its bound Asset (scoped)
//     → load the waypoint for goal context (scoped)
//     → build ctx with the draft body FENCED as untrusted DATA (D20) — draft
//       bodies descend from model output over possibly-tainted context plus
//       founder edits, so the shared fence() neutralizes any forged marker before
//       it can reach the simulator prompt
//     → simulator runAgent (reasoning-standard + simulator, no tools)   [T1 harness]
//     → parsePrediction (one retry via the harness; the def is reused)  [T4 schema]
//     → recordSimulation(engine "focus_group", confidence from prediction) [MCP tool]
//
// §10: the result is a "pre-flight prediction attached to an action; rendered as a
// labeled prediction, never fact." §3/D21 labeled-prediction honesty lives in the
// simulator prompt. Identity is ambient (D27.1) — every read/write is tenant-scoped
// and the model can never set a businessId. All model traffic is the injected
// Harness (D34). Fail-closed persistence: a malformed model output (after the one
// parseWithRetry retry) throws and persists NOTHING.
import type { Identity } from "dionysus-mcp/identity";
import { prisma } from "dionysus-mcp/db";
import { checkBudget } from "dionysus-mcp/tools/cost-budget";
import { recordSimulation } from "dionysus-mcp/tools/simulation";
import type { Harness } from "./llm/types.js";
import { loadPrompt } from "./prompts.js";
import { fence } from "./tools/fetch-page.js";
import { parsePrediction, type Prediction } from "./sim-schemas.js";

export type SimDeps = { harness: Harness; models: { brain: string } };
export type SimResult = { simulationId: string; prediction: Prediction };

/** §10 pre-flight: a focus-group PREDICTION for a proposed draft. Never mutates the action. */
export async function simulateAction(identity: Identity, input: { routeActionId: string }, deps: SimDeps): Promise<SimResult> {
  // D28/D34/Spec §14: fail closed BEFORE any simulation model work.
  const budget = await checkBudget(identity);
  if (!budget.allowed) throw new Error(`Simulation blocked: budget exhausted or unavailable (${budget.reason ?? "over cap"}).`);

  const action = await prisma.routeAction.findFirst({ where: { id: input.routeActionId, businessId: identity.businessId } });
  if (!action) throw new Error(`RouteAction ${input.routeActionId} not found in this business scope.`);
  if (action.status !== "proposed") {
    throw new Error(`Cannot simulate: RouteAction ${input.routeActionId} is not in "proposed" status (pre-flight only).`);
  }
  if (!action.assetId) throw new Error(`RouteAction ${input.routeActionId} has no bound asset to simulate.`);
  const asset = await prisma.asset.findFirst({ where: { id: action.assetId, businessId: identity.businessId } });
  if (!asset) throw new Error(`Asset ${action.assetId} not found in this business scope.`);
  const wp = await prisma.routeWaypoint.findFirst({ where: { id: action.waypointId, businessId: identity.businessId } });

  let title = "";
  let body = "";
  try {
    const content = JSON.parse(asset.contentJson) as { title?: unknown; body?: unknown };
    title = typeof content.title === "string" ? content.title : "";
    body = typeof content.body === "string" ? content.body : "";
  } catch {
    body = "";
  }

  const def = { name: "simulator", model: deps.models.brain,
    instructions: `${loadPrompt("reasoning-standard")}\n\n${loadPrompt("simulator")}`, tools: [] };
  const ctx = [
    `Channel: ${asset.channel}`,
    `Waypoint goal: ${wp?.goal ?? ""}`,
    `Draft to evaluate:`,
    fence("draft", title ? `${title}\n\n${body}` : body),
  ].join("\n");

  const raw = await deps.harness.runAgent(def, ctx);
  const prediction = await parsePrediction(raw.finalOutput, async (err) => (await deps.harness.runAgent(def, err)).finalOutput);
  const { simulationId } = await recordSimulation(identity, {
    routeActionId: action.id, engine: "focus_group", prediction, confidence: prediction.confidence });
  return { simulationId, prediction };
}
