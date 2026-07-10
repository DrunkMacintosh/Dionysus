"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "../lib/auth";
import {
  approveDraftCore, rejectDraftCore, editDraftCore, markReviewedCore,
  type ActionResult,
} from "../lib/review-actions";

export type { ActionResult } from "../lib/review-actions";

function refresh(result: ActionResult): ActionResult {
  if (result.ok) {
    revalidatePath("/drafts");
    revalidatePath("/");
  }
  return result;
}

export async function approveDraft(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  return refresh(await approveDraftCore(session, String(formData.get("routeActionId") ?? "")));
}

export async function rejectDraft(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  return refresh(await rejectDraftCore(session, String(formData.get("routeActionId") ?? "")));
}

export async function editDraft(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  return refresh(await editDraftCore(session, String(formData.get("routeActionId") ?? ""), String(formData.get("newBody") ?? "")));
}

export async function markReviewed(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  return refresh(await markReviewedCore(session, String(formData.get("digestId") ?? "")));
}
