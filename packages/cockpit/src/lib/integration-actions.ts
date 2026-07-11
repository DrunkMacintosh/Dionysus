"use server";
import { revalidatePath } from "next/cache";
import { requireSession } from "./auth";
import { connectIntegration, disconnectIntegration } from "dionysus-mcp/tools/integration";

export type ActionResult = { ok: boolean; message: string };

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

export async function disconnectAnalyticsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();
  const identity = { businessId: session.businessId };
  const integrationId = String(formData.get("integrationId") ?? "");
  if (!integrationId) return { ok: false, message: "Missing integration." };
  await disconnectIntegration(identity, { integrationId });
  revalidatePath("/connect");
  return { ok: true, message: "Analytics disconnected." };
}
