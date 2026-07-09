"use server";

import { revalidatePath } from "next/cache";
import { approveAction, rejectAction } from "dionysus-mcp/tools/lifecycle";
import { requireSession } from "../lib/auth";

export type ActionResult = { ok: boolean; message: string };

function friendly(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export async function approveDraft(routeActionId: string): Promise<ActionResult> {
  const session = await requireSession();
  try {
    await approveAction({ businessId: session.businessId }, { routeActionId, principal: session.email });
    revalidatePath("/drafts");
    revalidatePath("/");
    return { ok: true, message: "Approved." };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}

export async function rejectDraft(routeActionId: string): Promise<ActionResult> {
  const session = await requireSession();
  try {
    await rejectAction({ businessId: session.businessId }, { routeActionId });
    revalidatePath("/drafts");
    revalidatePath("/");
    return { ok: true, message: "Rejected." };
  } catch (error: unknown) {
    return { ok: false, message: friendly(error) };
  }
}
