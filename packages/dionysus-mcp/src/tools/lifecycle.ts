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

/** Cockpit-path only. Never registered as an MCP tool (D29: approval is never agent-asserted). */
export async function approveAction(identity: Identity, input: ApproveInput): Promise<void> {
  const action = await loadScopedAction(identity, input.routeActionId);
  assertTransition(action, ["proposed"], "approved");
  await assertBound(identity, action);
  await prisma.routeAction.update({ where: { id: action.id },
    data: { status: "approved", approvedAt: new Date(), approvedBy: input.principal } });
}

export async function rejectAction(identity: Identity, input: RejectInput): Promise<void> {
  const action = await loadScopedAction(identity, input.routeActionId);
  assertTransition(action, ["proposed", "executing"], "rejected");
  await prisma.routeAction.update({ where: { id: action.id },
    data: { status: "rejected", rejectionCount: { increment: 1 } } });
}

export async function startExecution(identity: Identity, input: StartExecutionInput): Promise<void> {
  const action = await loadScopedAction(identity, input.routeActionId);
  assertTransition(action, ["approved"], "executing");
  await assertBound(identity, action); // the send path refuses content whose hash differs from the approved one
  await prisma.routeAction.update({ where: { id: action.id },
    data: { status: "executing", runId: input.runId } });
}

export async function completeExecution(identity: Identity, input: CompleteExecutionInput): Promise<void> {
  const action = await loadScopedAction(identity, input.routeActionId);
  assertTransition(action, ["executing"], "executed");
  await prisma.routeAction.update({ where: { id: action.id }, data: { status: "executed" } });
}
