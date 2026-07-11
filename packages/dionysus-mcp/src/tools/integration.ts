import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { encryptSecret, decryptSecret } from "../lib/secret-box.js";

export type IntegrationConfig = Record<string, unknown>;
export type ConnectedIntegration = { id: string; kind: string; provider: string; metric: string; status: string; createdAt: Date };

/** Project a row to the config-FREE view (config never leaves this module in plaintext). */
function toView(row: { id: string; kind: string; provider: string; metric: string; status: string; createdAt: Date }): ConnectedIntegration {
  return { id: row.id, kind: row.kind, provider: row.provider, metric: row.metric, status: row.status, createdAt: row.createdAt };
}

/**
 * Connect (or re-connect) an integration. The config is JSON-serialized then AES-256-GCM
 * encrypted (secret-box) BEFORE it touches the DB — the plaintext is never persisted.
 * Upsert on (businessId, kind, provider): re-connecting re-encrypts + flips status connected.
 */
export async function connectIntegration(
  identity: Identity,
  input: { kind: string; provider: string; metric: string; config: IntegrationConfig },
): Promise<{ integrationId: string }> {
  const configEnc = encryptSecret(JSON.stringify(input.config)); // throws fail-closed if the key is absent
  const existing = await prisma.integration.findFirst({
    where: { businessId: identity.businessId, kind: input.kind, provider: input.provider } });
  if (existing) {
    await prisma.integration.update({ where: { id: existing.id },
      data: { metric: input.metric, configEnc, status: "connected" } });
    return { integrationId: existing.id };
  }
  const row = await prisma.integration.create({ data: {
    businessId: identity.businessId, kind: input.kind, provider: input.provider,
    metric: input.metric, configEnc, status: "connected" } });
  return { integrationId: row.id };
}

/** Disconnect (scoped): flip status. A cross-tenant id matches nothing (no-op). */
export async function disconnectIntegration(identity: Identity, input: { integrationId: string }): Promise<void> {
  await prisma.integration.updateMany({
    where: { id: input.integrationId, businessId: identity.businessId },
    data: { status: "disconnected" } });
}

/** The connected analytics integration (config-free), or null. */
export async function getConnectedAnalytics(identity: Identity): Promise<ConnectedIntegration | null> {
  const row = await prisma.integration.findFirst({
    where: { businessId: identity.businessId, kind: "analytics", status: "connected" },
    orderBy: { createdAt: "desc" } });
  return row ? toView(row) : null;
}

/** Decrypt the config for ingestion (scoped). Null if not found in scope or on a decrypt failure. */
export async function getDecryptedConfig(identity: Identity, integrationId: string): Promise<IntegrationConfig | null> {
  const row = await prisma.integration.findFirst({ where: { id: integrationId, businessId: identity.businessId } });
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(decryptSecret(row.configEnc));
    return typeof parsed === "object" && parsed !== null ? (parsed as IntegrationConfig) : null;
  } catch {
    return null; // malformed/tampered/undecryptable — degrade, never throw config internals to the caller
  }
}

export async function listIntegrations(identity: Identity): Promise<ConnectedIntegration[]> {
  const rows = await prisma.integration.findMany({
    where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
  return rows.map(toView);
}
