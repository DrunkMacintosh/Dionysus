// Task 5 — the proposeRoute pipeline: the integration seam that turns a founder
// objective + a chosen Case into a persisted, ordered Route of waypoints with
// proposed actions.
//
//   checkBudget (fail-closed FIRST, D34/Spec §14)
//     → load Case by caseId, tenant-scoped (throw if not found / cross-tenant)
//     → route-strategist runAgent (objective + fenced case material)   [T1 harness]
//     → parseRouteProposal (retry via the harness)                     [T4 schema]
//     → createObjective (objective-first, D31/D8/D12 — AFTER budget+case guards
//                        AND after the model output parses, so a bad case or an
//                        unparseable model reply never orphans an objective)
//     → persistRoute(source:"case", caseRef:caseId)                    [grounded]
//     → per waypoint (order = index+1) persistWaypoint → per action upsertRouteAction
//     → assembled RoutePlan
//
// Identity is ambient (D27.1) — the caller passes it in; it is never a value the
// model can set, and no tool takes a businessId param. All model traffic is the
// injected Harness (D34). The Case's claim text originated from the web, so the
// case material is fenced as untrusted DATA (D20) before it reaches the prompt.
import type { Identity } from "dionysus-mcp/identity";
import { prisma } from "dionysus-mcp/db";
import { checkBudget } from "dionysus-mcp/tools/cost-budget";
import {
  createObjective, persistRoute, persistWaypoint, upsertRouteAction,
  type ObjectiveInput,
} from "dionysus-mcp/tools/plan";
import type { Harness } from "./llm/types.js";
import { loadPrompt } from "./prompts.js";
import { fence } from "./tools/fetch-page.js";
import { parseRouteProposal } from "./plan-schemas.js";
import { isVideoChannel } from "./video-channels.js";

export type ProposeRouteInput = { objective: ObjectiveInput; caseId: string; existingObjectiveId?: string };
export type ProposeRouteDeps = { harness: Harness; models: { brain: string } };
export type RoutePlan = {
  objectiveId: string;
  routeId: string;
  waypoints: Array<{
    waypointId: string; order: number; title: string; goal: string;
    actions: Array<{ actionId: string; employeeRole: string; type: string; rationale: string }>;
  }>;
};

export async function proposeRoute(identity: Identity, input: ProposeRouteInput, deps: ProposeRouteDeps): Promise<RoutePlan> {
  const budget = await checkBudget(identity);
  if (!budget.allowed) throw new Error(`Route proposal blocked: budget exhausted or unavailable (${budget.reason ?? "over cap"}).`);

  const kase = await prisma.case.findFirst({ where: { id: input.caseId, businessId: identity.businessId } });
  if (!kase) throw new Error(`Case ${input.caseId} not found in this business scope.`);

  const caseMaterial = fence("case", JSON.stringify({
    name: kase.name, platform: kase.platform, mode: kase.mode,
    historicalArc: JSON.parse(kase.historicalArcJson),
    modernizedPlan: JSON.parse(kase.modernizedPlanJson),
    insight: kase.insight,
  }));
  const objText = `Objective: reach ${input.objective.target} ${input.objective.metric} (kind: ${input.objective.kind}).`;
  const def = { name: "route-strategist", model: deps.models.brain,
    instructions: `${loadPrompt("reasoning-standard")}\n\n${loadPrompt("route-strategist")}`, tools: [] };
  const raw = await deps.harness.runAgent(def, `${objText}\n\nChosen case:\n${caseMaterial}`);
  const proposal = await parseRouteProposal(raw.finalOutput,
    async (err) => (await deps.harness.runAgent(def, err)).finalOutput);

  // Objective: reuse the founder's cockpit-created row when given (validated in scope —
  // no duplicate objective); otherwise create it now, post-parse as before (a model/parse
  // failure still never persists a routeless orphan objective).
  let objectiveId: string;
  if (input.existingObjectiveId) {
    const existing = await prisma.objective.findFirst({
      where: { id: input.existingObjectiveId, businessId: identity.businessId } });
    if (!existing) throw new Error(`Objective ${input.existingObjectiveId} not found in this business scope.`);
    objectiveId = existing.id;
  } else {
    ({ objectiveId } = await createObjective(identity, input.objective));
  }
  const { routeId } = await persistRoute(identity, { objectiveId, source: "case", caseRef: input.caseId });

  const waypoints: RoutePlan["waypoints"] = [];
  for (let i = 0; i < proposal.waypoints.length; i++) {
    const w = proposal.waypoints[i]!;
    const order = i + 1;
    const { waypointId } = await persistWaypoint(identity, { routeId, order, title: w.title, goal: w.goal });
    const actions: RoutePlan["waypoints"][number]["actions"] = [];
    for (const a of w.actions) {
      // 6m: video-channel actions belong to the Videographer — clamp the role
      // server-side so its craft beliefs accrue under the right employee (the
      // model's self-assigned role is advisory, like channel/kind labels).
      const actionChannel = typeof a.features?.["channel"] === "string" ? (a.features["channel"] as string) : a.type;
      const employeeRole = isVideoChannel(actionChannel) ? "videographer" : a.employeeRole;
      const { actionId } = await upsertRouteAction(identity, {
        waypointId, employeeRole, type: a.type, rationale: a.rationale, features: a.features ?? {} });
      actions.push({ actionId, employeeRole, type: a.type, rationale: a.rationale });
    }
    waypoints.push({ waypointId, order, title: w.title, goal: w.goal, actions });
  }
  return { objectiveId, routeId, waypoints };
}
