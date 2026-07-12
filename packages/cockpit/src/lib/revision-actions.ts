"use server";
// Stage 6c, Task 5 — the founder-gated decide of a proposed route revision from the
// cockpit "/route" card. NEVER-AUTO: the waypoint goal changes ONLY through one of
// these session-authed decisions. requireSession() runs OUTSIDE the try (an auth
// failure redirects, it is not a decide error); the businessId comes from the session,
// never the form; the decide + revalidate live in the try; on success both the route
// card (the pending revision clears) and the timeline (the was/now/why line appears)
// are revalidated. NOT an MCP tool — a cockpit-tier server action.
import { revalidatePath } from "next/cache";
import { requireSession } from "./auth";
import { decideRouteRevision } from "dionysus-mcp/tools/decide-revision";

export type ActionResult = { ok: boolean; message: string };

export async function approveRevisionAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const revisionId = String(formData.get("revisionId") ?? "");
  if (!revisionId) return { ok: false, message: "Missing revision." };
  try {
    await decideRouteRevision(identity, { revisionId, decision: "approved" }, new Date());
    revalidatePath("/route");
    revalidatePath("/timeline");
    return { ok: true, message: "Plan change approved — the waypoint goal is updated." };
  } catch {
    return { ok: false, message: "Could not apply the change — the waypoint may no longer be revisable." };
  }
}

export async function rejectRevisionAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const revisionId = String(formData.get("revisionId") ?? "");
  if (!revisionId) return { ok: false, message: "Missing revision." };
  try {
    await decideRouteRevision(identity, { revisionId, decision: "rejected" }, new Date());
    revalidatePath("/route");
    revalidatePath("/timeline");
    return { ok: true, message: "Plan change rejected — the plan is unchanged." };
  } catch {
    return { ok: false, message: "Could not reject — it may have already been decided." };
  }
}
