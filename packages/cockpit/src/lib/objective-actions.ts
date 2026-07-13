"use server";
import { revalidatePath } from "next/cache";
import { requireSession } from "./auth";
import { getActiveObjective } from "./review";
import { createObjective } from "dionysus-mcp/tools/plan";

export type ActionResult = { ok: boolean; message: string };

// Stage 6f, Task 2 — the /setup objective form's server action. requireSession is
// OUTSIDE try (D27.1: the auth boundary), businessId comes from the session ONLY.
// Pure string validation refuses before any DB touch; the already-active guard then
// refuses BEFORE any write (the dogfood simplification: one active objective at a
// time). On success the founder-stated objective is created (the nightly bootstraps
// the first route from it) and /setup + / are revalidated. NOT an MCP tool.
export async function createObjectiveAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const kind = String(formData.get("kind") ?? "").trim();
  const target = String(formData.get("target") ?? "").trim();
  const metric = String(formData.get("metric") ?? "").trim();
  if (!kind || !target || !metric) return { ok: false, message: "Objective kind, target, and metric are all required." };
  try {
    if (await getActiveObjective(identity)) {
      return { ok: false, message: "An objective is already active — Dionysus works one objective at a time." };
    }
    await createObjective(identity, { kind, target, metric });
    revalidatePath("/setup");
    revalidatePath("/");
    return { ok: true, message: "Objective saved. Dionysus will propose a route overnight — check /route in the morning." };
  } catch {
    return { ok: false, message: "Could not save the objective — try again." };
  }
}
