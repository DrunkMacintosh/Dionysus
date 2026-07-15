"use server";
import { revalidatePath } from "next/cache";
import { requireSession } from "./auth";
import { connectIntegration, disconnectIntegration } from "dionysus-mcp/tools/integration";

export type ActionResult = { ok: boolean; message: string };

// http(s)-only endpoint gate — a javascript:/data:/garbage endpoint is refused
// BEFORE any write (no half-connected row), mirroring the review-layer URL guard.
const isHttpUrl = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

export async function connectAnalyticsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const endpoint = String(formData.get("endpoint") ?? "").trim();
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  const metric = String(formData.get("metric") ?? "").trim();
  if (!endpoint || !metric) return { ok: false, message: "Endpoint and metric are required." };
  try {
    await connectIntegration(identity, { kind: "analytics", provider: "http-json", metric, config: { endpoint, apiKey } });
    revalidatePath("/connect");
    return { ok: true, message: "Analytics connected. Real measurement will appear in your report as data arrives." };
  } catch {
    return { ok: false, message: "Could not connect — check the endpoint and try again." };
  }
}

// Stage 6k — connect a video-generation source (the Videographer's generation
// transport). TWO honest gates BEFORE any write: the endpoint must be http(s) AND
// the apiKey must be non-empty (a keyless generator cannot generate). The config is
// encrypted at rest by connectIntegration; the apiKey is write-only — it is never
// echoed back into any read view. requireSession stays OUTSIDE the try (an auth
// failure is a redirect, not a friendly "could not connect").
export async function connectVideoSourceAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const endpoint = String(formData.get("endpoint") ?? "").trim();
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  if (!isHttpUrl(endpoint)) return { ok: false, message: "Enter a valid http(s) generation endpoint." };
  if (!apiKey) return { ok: false, message: "An API key is required to connect a video source." };
  try {
    await connectIntegration(identity, { kind: "video", provider: "http-json", metric: "video-generation", config: { endpoint, apiKey } });
    revalidatePath("/connect");
    return { ok: true, message: "Video source connected. Approved storyboards will generate video drafts you review before posting." };
  } catch {
    return { ok: false, message: "Could not connect — check the endpoint and try again." };
  }
}

export async function disconnectAnalyticsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const integrationId = String(formData.get("integrationId") ?? "");
  if (!integrationId) return { ok: false, message: "Missing integration." };
  await disconnectIntegration(identity, { integrationId });
  revalidatePath("/connect");
  return { ok: true, message: "Analytics disconnected." };
}
