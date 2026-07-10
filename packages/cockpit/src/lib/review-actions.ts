import { approveAction, rejectAction } from "dionysus-mcp/tools/lifecycle";
import { editDraftContent } from "dionysus-mcp/tools/draft-edit";
import { markDigestReviewed } from "dionysus-mcp/tools/digest";
import { submitVerifiedSend } from "dionysus-mcp/tools/send";
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

// Verify a founder-posted send: fetch the public URL and prove the approved content
// is live (submitVerifiedSend closes the loop from outside). Empty-URL refusal happens
// BEFORE any call. NO fetch seam is passed — this is the production path; the fetch seam
// (and the verified-success assertion) belongs to the dionysus-mcp send suite + Task-6 gate.
export async function submitSendCore(session: CockpitSession, routeActionId: string, postedUrl: string): Promise<ActionResult> {
  const trimmed = postedUrl.trim();
  if (!trimmed) return { ok: false, message: "Paste the public URL where you posted this before verifying." };
  try {
    const res = await submitVerifiedSend({ businessId: session.businessId }, { routeActionId, postedUrl: trimmed });
    return { ok: true, message: `Verified live at ${res.verifiedAt.toISOString()}.` };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}
