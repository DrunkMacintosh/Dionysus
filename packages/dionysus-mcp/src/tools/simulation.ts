import { prisma } from "../db.js";
import type { Identity } from "../identity.js";

export const SIMULATION_ENGINES = ["focus_group", "mirofish"] as const;
export type SimulationEngine = (typeof SIMULATION_ENGINES)[number];
export type SimulationInput = { routeActionId: string; engine: SimulationEngine; prediction: unknown; confidence: number };

/** §10: a labeled prediction attached to an action. Writes ONLY a SimulationResult row — never the action. */
export async function recordSimulation(identity: Identity, input: SimulationInput): Promise<{ simulationId: string }> {
  if (!SIMULATION_ENGINES.includes(input.engine)) {
    throw new Error(`Invalid simulation engine "${input.engine}" (allowed: ${SIMULATION_ENGINES.join(", ")}).`);
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error(`Invalid confidence ${input.confidence} (must be a number in 0..1).`);
  }
  const action = await prisma.routeAction.findFirst({ where: { id: input.routeActionId, businessId: identity.businessId } });
  if (!action) throw new Error(`RouteAction ${input.routeActionId} not found in this business scope.`);
  const row = await prisma.simulationResult.create({ data: {
    businessId: identity.businessId, routeActionId: input.routeActionId,
    engine: input.engine, predictionJson: JSON.stringify(input.prediction ?? {}), confidence: input.confidence } });
  return { simulationId: row.id };
}
