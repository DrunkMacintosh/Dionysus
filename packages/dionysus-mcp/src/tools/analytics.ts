import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { getConnectedAnalytics, getDecryptedConfig, type IntegrationConfig } from "./integration.js";

// The transport is injectable (tests) and, in production (6a trigger, NOT this stage),
// defaults to the stage-1 SSRF-guarded fetch (src/lib/ssrf.ts) — the analytics endpoint
// is founder-provided (semi-trusted). No production caller exists in 5d.
export type MetricTransport = (url: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Read a numeric value out of an unknown JSON body at a dotted path (default "value"). */
function readNumberAtPath(body: unknown, path: string): number | null {
  let cur: unknown = body;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : null;
}

/**
 * Read the current metric value from a provider endpoint. Provider-agnostic reference reader:
 * GET config.endpoint (optional `Authorization: Bearer config.apiKey`), parse the number at
 * config.valuePath (default "value"). DEGRADES to null on any failure (missing endpoint,
 * transport throw, non-200, non-numeric body) — honest: no reading, no snapshot.
 */
export async function fetchCurrentMetric(config: IntegrationConfig, transport: MetricTransport): Promise<number | null> {
  const endpoint = typeof config.endpoint === "string" ? config.endpoint : "";
  if (!endpoint) return null;
  const headers: Record<string, string> = {};
  if (typeof config.apiKey === "string" && config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
  const valuePath = typeof config.valuePath === "string" && config.valuePath ? config.valuePath : "value";
  try {
    const res = await transport(endpoint, headers);
    if (!res.ok || res.status !== 200) return null;
    const body = await res.json();
    return readNumberAtPath(body, valuePath);
  } catch {
    return null;
  }
}

/**
 * Ingest ONE real metric snapshot for the business's connected analytics source. Reads the
 * decrypted config, fetches the current value (injectable transport), and persists a
 * MetricSnapshot ONLY if a real number came back. No connected source or a degraded fetch →
 * persists nothing, returns { snapshotId: null }. Scoped; never throws to the caller.
 */
export async function ingestMetrics(identity: Identity, deps: { transport: MetricTransport }): Promise<{ snapshotId: string | null }> {
  const connected = await getConnectedAnalytics(identity);
  if (!connected) return { snapshotId: null };
  const config = await getDecryptedConfig(identity, connected.id);
  if (!config) return { snapshotId: null };
  const value = await fetchCurrentMetric(config, deps.transport);
  if (value === null) return { snapshotId: null };
  const snap = await prisma.metricSnapshot.create({ data: {
    businessId: identity.businessId, integrationId: connected.id, metric: connected.metric, value } });
  return { snapshotId: snap.id };
}
