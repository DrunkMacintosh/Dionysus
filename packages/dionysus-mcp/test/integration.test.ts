import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { prisma } from "../src/db.js";
import { CONFIG_KEY_ENV } from "../src/lib/secret-box.js";
import { connectIntegration, disconnectIntegration, getConnectedAnalytics, getConnectedVideoSource, getDecryptedConfig, listIntegrations } from "../src/tools/integration.js";

const BIZ = "biz_integ_a";
const OTHER = "biz_integ_b";

beforeAll(() => {
  process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
});

beforeEach(async () => {
  for (const id of [BIZ, OTHER]) {
    await prisma.metricSnapshot.deleteMany({ where: { businessId: id } });
    await prisma.integration.deleteMany({ where: { businessId: id } });
    await prisma.business.upsert({ where: { id }, create: { id, name: id }, update: {} });
  }
});

describe("integration", () => {
  it("connects an analytics source, storing config ONLY as ciphertext (never plaintext)", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, {
      kind: "analytics", provider: "http-json", metric: "signups",
      config: { endpoint: "https://plausible.io/api/x", apiKey: "sekret-key-xyz" } });

    const row = await prisma.integration.findUnique({ where: { id: integrationId } });
    expect(row?.status).toBe("connected");
    expect(row?.configEnc).not.toContain("sekret-key-xyz");
    expect(row?.configEnc.startsWith("v1.")).toBe(true);
    const cfg = await getDecryptedConfig({ businessId: BIZ }, integrationId);
    expect(cfg).toMatchObject({ endpoint: "https://plausible.io/api/x", apiKey: "sekret-key-xyz" });
  });

  it("getConnectedAnalytics returns the connected source WITHOUT config; null when disconnected", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, {
      kind: "analytics", provider: "http-json", metric: "signups", config: { apiKey: "k" } });
    const connected = await getConnectedAnalytics({ businessId: BIZ });
    expect(connected?.metric).toBe("signups");
    expect(connected).not.toHaveProperty("configEnc");
    expect(connected).not.toHaveProperty("config");

    await disconnectIntegration({ businessId: BIZ }, { integrationId });
    expect(await getConnectedAnalytics({ businessId: BIZ })).toBeNull();
  });

  it("re-connecting the same (kind, provider) updates in place (upsert), re-encrypting", async () => {
    const first = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { apiKey: "old" } });
    const second = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { apiKey: "new" } });
    expect(second.integrationId).toBe(first.integrationId);
    const rows = await prisma.integration.findMany({ where: { businessId: BIZ } });
    expect(rows).toHaveLength(1);
    expect((await getDecryptedConfig({ businessId: BIZ }, first.integrationId))).toMatchObject({ apiKey: "new" });
  });

  it("is scoped — another tenant cannot read or decrypt this integration", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, { kind: "analytics", provider: "http-json", metric: "signups", config: { apiKey: "k" } });
    expect(await getConnectedAnalytics({ businessId: OTHER })).toBeNull();
    expect(await getDecryptedConfig({ businessId: OTHER }, integrationId)).toBeNull();
    await disconnectIntegration({ businessId: OTHER }, { integrationId }); // no-op cross-tenant
    expect((await getConnectedAnalytics({ businessId: BIZ }))?.status).toBe("connected");
  });
});

describe("getConnectedVideoSource", () => {
  it("returns the connected video source WITHOUT config; null when disconnected", async () => {
    const { integrationId } = await connectIntegration({ businessId: BIZ }, {
      kind: "video", provider: "http-json", metric: "video-generation",
      config: { endpoint: "https://kling.example/api", apiKey: "sekret-video-key" } });
    const connected = await getConnectedVideoSource({ businessId: BIZ });
    expect(connected?.kind).toBe("video");
    expect(connected?.metric).toBe("video-generation");
    expect(connected?.status).toBe("connected");
    expect(connected).not.toHaveProperty("configEnc");
    expect(connected).not.toHaveProperty("config");

    await disconnectIntegration({ businessId: BIZ }, { integrationId });
    expect(await getConnectedVideoSource({ businessId: BIZ })).toBeNull();
  });

  it("returns null when no video source has ever been connected", async () => {
    expect(await getConnectedVideoSource({ businessId: BIZ })).toBeNull();
  });

  it("is kind-isolated — a connected ANALYTICS row does not satisfy a VIDEO lookup", async () => {
    await connectIntegration({ businessId: BIZ }, {
      kind: "analytics", provider: "http-json", metric: "signups", config: { apiKey: "k" } });
    expect(await getConnectedVideoSource({ businessId: BIZ })).toBeNull();
    // and a video source is not returned by the analytics lookup either
    await connectIntegration({ businessId: BIZ }, {
      kind: "video", provider: "http-json", metric: "video-generation", config: { apiKey: "k" } });
    expect((await getConnectedAnalytics({ businessId: BIZ }))?.kind).toBe("analytics");
    expect((await getConnectedVideoSource({ businessId: BIZ }))?.kind).toBe("video");
  });

  it("is scoped — another tenant cannot read this video source", async () => {
    await connectIntegration({ businessId: BIZ }, {
      kind: "video", provider: "http-json", metric: "video-generation", config: { apiKey: "k" } });
    expect(await getConnectedVideoSource({ businessId: OTHER })).toBeNull();
    expect((await getConnectedVideoSource({ businessId: BIZ }))?.status).toBe("connected");
  });
});
