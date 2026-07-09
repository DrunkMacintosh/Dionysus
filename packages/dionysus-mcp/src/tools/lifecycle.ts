import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { hashContent } from "../lib/content-hash.js";

export type ApproveInput = { routeActionId: string; principal: string };
export type RejectInput = { routeActionId: string };
export type StartExecutionInput = { routeActionId: string; runId: string };
export type CompleteExecutionInput = { routeActionId: string };

type ActionRow = NonNullable<Awaited<ReturnType<typeof prisma.routeAction.findFirst>>>;

async function loadScopedAction(identity: Identity, routeActionId: string): Promise<ActionRow> {
  const action = await prisma.routeAction.findFirst({ where: { id: routeActionId, businessId: identity.businessId } });
  if (!action) throw new Error(`RouteAction ${routeActionId} not found in this business scope.`);
  return action;
}

function assertTransition(action: ActionRow, allowedFrom: readonly string[], to: string): void {
  if (!allowedFrom.includes(action.status)) {
    throw new Error(`Invalid transition: RouteAction ${action.id} is "${action.status}", cannot move to "${to}" (allowed from: ${allowedFrom.join(", ")}).`);
  }
}

async function assertBound(identity: Identity, action: ActionRow): Promise<void> {
  if (!action.assetId) throw new Error(`RouteAction ${action.id} has no bound asset.`);
  const asset = await prisma.asset.findFirst({ where: { id: action.assetId, businessId: identity.businessId } });
  if (!asset) throw new Error(`Asset ${action.assetId} not found in this business scope.`);
  if (hashContent(asset.contentJson) !== action.contentHash) {
    throw new Error(`Content hash mismatch for RouteAction ${action.id}: current asset content differs from the bound content.`);
  }
}

/** Send-path guard (D29): the current linked asset must hash to the bound contentHash. */
export async function assertContentBound(identity: Identity, routeActionId: string): Promise<void> {
  const action = await loadScopedAction(identity, routeActionId);
  await assertBound(identity, action);
}

/**
 * Concurrency backstop (D29 TOCTOU): the write itself re-asserts the source status.
 * `assertTransition` above still runs first for the FRIENDLY allowed-from error message,
 * but between that check and this write another call could have advanced the row. Scoping
 * the updateMany by the source status (and businessId) means a concurrent transition writes
 * first and this one matches zero rows — the loser throws instead of double-writing.
 */
async function transitionOrThrow(
  actionId: string,
  businessId: string,
  fromStatus: Prisma.RouteActionWhereInput["status"],
  data: Prisma.RouteActionUpdateManyMutationInput,
): Promise<void> {
  const { count } = await prisma.routeAction.updateMany({
    where: { id: actionId, businessId, status: fromStatus },
    data,
  });
  if (count === 0) {
    throw new Error(`Invalid transition: RouteAction ${actionId} changed state concurrently.`);
  }
}

/** Cockpit-path only. Never registered as an MCP tool (D29: approval is never agent-asserted). */
export async function approveAction(identity: Identity, input: ApproveInput): Promise<void> {
  const action = await loadScopedAction(identity, input.routeActionId);
  assertTransition(action, ["proposed"], "approved");
  await assertBound(identity, action);
  await transitionOrThrow(action.id, identity.businessId, "proposed",
    { status: "approved", approvedAt: new Date(), approvedBy: input.principal });
}

export async function rejectAction(identity: Identity, input: RejectInput): Promise<void> {
  const action = await loadScopedAction(identity, input.routeActionId);
  assertTransition(action, ["proposed", "executing"], "rejected");
  await transitionOrThrow(action.id, identity.businessId, { in: ["proposed", "executing"] },
    { status: "rejected", rejectionCount: { increment: 1 } });
}

export async function startExecution(identity: Identity, input: StartExecutionInput): Promise<void> {
  const action = await loadScopedAction(identity, input.routeActionId);
  assertTransition(action, ["approved"], "executing");
  await assertBound(identity, action); // the send path refuses content whose hash differs from the approved one
  await transitionOrThrow(action.id, identity.businessId, "approved",
    { status: "executing", runId: input.runId });
}

export async function completeExecution(identity: Identity, input: CompleteExecutionInput): Promise<void> {
  const action = await loadScopedAction(identity, input.routeActionId);
  assertTransition(action, ["executing"], "executed");
  await transitionOrThrow(action.id, identity.businessId, "executing",
    { status: "executed" });
}
