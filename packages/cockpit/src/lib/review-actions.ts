import { approveAction, rejectAction } from "dionysus-mcp/tools/lifecycle";
import { editDraftContent } from "dionysus-mcp/tools/draft-edit";
import { markDigestReviewed } from "dionysus-mcp/tools/digest";
import type { SessionPayload } from "./session";

export type ActionResult = { ok: boolean; message: string };
export type CockpitSession = Pick<SessionPayload, "businessId" | "email">;

function friendly(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export async function approveDraftCore(session: CockpitSession, routeActionId: string): Promise<ActionResult> {
  try {
    await approveAction({ businessId: session.businessId }, { routeActionId, principal: session.email });
    return { ok: true, message: "Approved." };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}

export async function rejectDraftCore(session: CockpitSession, routeActionId: string): Promise<ActionResult> {
  try {
    await rejectAction({ businessId: session.businessId }, { routeActionId });
    return { ok: true, message: "Rejected." };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}

export async function editDraftCore(session: CockpitSession, routeActionId: string, newBody: string): Promise<ActionResult> {
  if (!newBody.trim()) return { ok: false, message: "The draft body cannot be empty." };
  try {
    const res = await editDraftContent({ businessId: session.businessId }, { routeActionId, newBody });
    return { ok: true, message: res.editDistance === 0 ? "No changes." : `Saved (edit distance ${res.editDistance}, total ${res.totalEditDistance}).` };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}

export async function markReviewedCore(session: CockpitSession, digestId: string): Promise<ActionResult> {
  try {
    await markDigestReviewed({ businessId: session.businessId }, digestId);
    return { ok: true, message: "Digest marked as reviewed." };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}
