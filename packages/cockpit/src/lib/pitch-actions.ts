"use server";
import { revalidatePath } from "next/cache";
import { prisma } from "dionysus-mcp/db";
import { upsertRouteAction } from "dionysus-mcp/tools/plan";
import { requireSession } from "./auth";
import { isRenderableHttpUrl } from "./review";

export type ActionResult = { ok: boolean; message: string };

// Stage 6g, Task 2 — the /pitch request form's server action. The founder NAMES an
// outreach target (newsletter/podcast/blog) here; this creates a proposed
// `outreach-pitch` RouteAction that the nightly drafts overnight, grounded in the
// target's real page. The anti-fabrication rule made STRUCTURAL: Dionysus NEVER
// originates a target — one exists ONLY because the founder created it here. Never
// invented by a model. requireSession is OUTSIDE try (D27.1: the auth boundary),
// businessId comes from the session ONLY. targetUrl is SHAPE-validated (parses as a
// full http(s) URL) — reachability is the nightly's honest, retrying job. An ACTIVE
// waypoint on the latest route is the request's home; none yet → an honest refusal
// BEFORE any write. NOT an MCP tool (the whitelist stays 11).
export async function createPitchRequestAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const targetName = String(formData.get("targetName") ?? "").trim();
  const targetUrl = String(formData.get("targetUrl") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  if (!targetName) return { ok: false, message: "Give the target a name — who are you pitching?" };
  if (!isRenderableHttpUrl(targetUrl)) return { ok: false, message: "Enter the target's page as a full http(s) URL." };
  try {
    // An ACTIVE waypoint on the latest route is where the request lives. None yet → refuse honestly
    // BEFORE any write (the founder has no objective/route to hang the pitch on).
    const route = await prisma.route.findFirst({
      where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
    const activeWaypoint = route ? await prisma.routeWaypoint.findFirst({
      where: { businessId: identity.businessId, routeId: route.id, status: "active" }, orderBy: { order: "asc" } }) : null;
    if (!activeWaypoint) return { ok: false, message: "No active waypoint yet — set your objective on /setup first." };
    await upsertRouteAction(identity, {
      waypointId: activeWaypoint.id,
      employeeRole: "outreach",
      type: "outreach-pitch",
      rationale: `Pitch ${targetName} (founder-requested)${note ? ` — ${note}` : ""}`,
      features: { channel: "outreach-email", outreach: true, targetUrl, targetName },
    });
    revalidatePath("/pitch");
    revalidatePath("/drafts");
    return { ok: true, message: "Pitch queued — Dionysus will draft it overnight, grounded in the target's page." };
  } catch {
    return { ok: false, message: "Could not queue the pitch — try again." };
  }
}
