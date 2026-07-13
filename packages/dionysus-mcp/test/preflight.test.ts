import { describe, it, expect } from "vitest";
import { runPreflight } from "../src/lib/preflight.js";

// A stub probe that resolves — the DB is "reachable". Unit tests NEVER touch a real DB.
const okProbe = () => Promise.resolve();
// A 32-byte key, base64-encoded — a valid DIONYSUS_CONFIG_KEY.
const validConfigKey = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

/** A fully-valid environment: every required var set, every warn-able var set. */
function greenEnv(): Record<string, string | undefined> {
  return {
    DATABASE_URL: "file:./.tmp/preflight-green.db",
    DIONYSUS_BUSINESS_ID: "biz-preflight-green",
    GATEWAY_UPSTREAM_URL: "https://upstream.example.com/v1",
    GATEWAY_PORT: "8787",
    GATEWAY_UPSTREAM_KEY: "upstream-key-value",
    GATEWAY_TOKEN: "inbound-token-value",
    COCKPIT_SESSION_SECRET: "a-strong-session-secret-well-over-16",
    COCKPIT_BASE_URL: "https://cockpit.example.com",
    DIONYSUS_CONFIG_KEY: validConfigKey,
    GATEWAY_LOCAL_URL: "http://127.0.0.1:8787/v1",
  };
}

const isWarn = (detail: string) => detail.startsWith("WARN:");

describe("runPreflight (fail-closed doctor)", () => {
  it("1. all-green env → ok:true, zero FAILs, WARN-free", async () => {
    const report = await runPreflight({ env: greenEnv(), dbProbe: okProbe });
    expect(report.ok).toBe(true);
    expect(report.checks.some((c) => c.ok === false)).toBe(false); // zero FAILs
    expect(report.checks.some((c) => isWarn(c.detail))).toBe(false); // WARN-free
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it("2. gateway without GATEWAY_UPSTREAM_URL → ok:false naming it; cockpit run with same env stays ok (service scoping)", async () => {
    const env = { ...greenEnv() };
    delete env.GATEWAY_UPSTREAM_URL;

    const gateway = await runPreflight({ service: "gateway", env, dbProbe: okProbe });
    expect(gateway.ok).toBe(false);
    const failing = gateway.checks.filter((c) => !c.ok);
    expect(failing.some((c) => c.name.includes("GATEWAY_UPSTREAM_URL"))).toBe(true);

    // Same env, cockpit scope — the gateway problem is out of scope, so it stays ok.
    const cockpit = await runPreflight({ service: "cockpit", env, dbProbe: okProbe });
    expect(cockpit.ok).toBe(true);
    expect(cockpit.checks.some((c) => c.name.includes("GATEWAY"))).toBe(false);
  });

  it("3. cockpit with an 8-char COCKPIT_SESSION_SECRET → ok:false; detail never contains the secret value", async () => {
    const secret = "shortkey"; // exactly 8 chars
    const env = { ...greenEnv(), COCKPIT_SESSION_SECRET: secret };
    const report = await runPreflight({ service: "cockpit", env, dbProbe: okProbe });
    expect(report.ok).toBe(false);
    const secretCheck = report.checks.find((c) => c.name.includes("COCKPIT_SESSION_SECRET"));
    expect(secretCheck?.ok).toBe(false);
    for (const c of report.checks) expect(c.detail).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("4. nightly DIONYSUS_CONFIG_KEY absent → ok:true with a WARN mentioning 'skipped'; malformed (5 bytes) → ok:false", async () => {
    const absentEnv = { ...greenEnv() };
    delete absentEnv.DIONYSUS_CONFIG_KEY;
    const absent = await runPreflight({ service: "nightly", env: absentEnv, dbProbe: okProbe });
    expect(absent.ok).toBe(true);
    const warnCheck = absent.checks.find((c) => c.name.includes("DIONYSUS_CONFIG_KEY"));
    expect(warnCheck?.ok).toBe(true);
    expect(isWarn(warnCheck!.detail)).toBe(true);
    expect(warnCheck!.detail.toLowerCase()).toContain("skipped");

    // base64 of 5 bytes — decodes to the wrong length → FAIL (a wrong key silently corrupts decrypts).
    const malformed = Buffer.alloc(5).toString("base64");
    const badEnv = { ...greenEnv(), DIONYSUS_CONFIG_KEY: malformed };
    const bad = await runPreflight({ service: "nightly", env: badEnv, dbProbe: okProbe });
    expect(bad.ok).toBe(false);
    const badCheck = bad.checks.find((c) => c.name.includes("DIONYSUS_CONFIG_KEY"));
    expect(badCheck?.ok).toBe(false);
  });

  it("5. DB probe rejecting → ok:false with the db check failing; detail carries no stack", async () => {
    const failingProbe = () => {
      const err = new Error("connection refused to sqlite");
      err.stack = "Error: connection refused to sqlite\n    at probe (secret-stack.ts:99:1)\n    at more";
      return Promise.reject(err);
    };
    const report = await runPreflight({ env: greenEnv(), dbProbe: failingProbe });
    expect(report.ok).toBe(false);
    const dbCheck = report.checks.find((c) => c.name.toLowerCase().includes("reachable"));
    expect(dbCheck?.ok).toBe(false);
    // The message class is surfaced, but never a stack trace.
    expect(dbCheck!.detail).not.toContain("at probe");
    expect(dbCheck!.detail).not.toContain("secret-stack.ts");
    for (const c of report.checks) expect(c.detail).not.toContain("    at ");
  });

  it("2b. gateway without DIONYSUS_BUSINESS_ID → ok:false (the boot-order identity gap the runbook execution discovered)", async () => {
    const env = { ...greenEnv() };
    delete env.DIONYSUS_BUSINESS_ID;
    const gateway = await runPreflight({ service: "gateway", env, dbProbe: okProbe });
    expect(gateway.ok).toBe(false);
    expect(gateway.checks.find((c) => c.name === "DIONYSUS_BUSINESS_ID")?.ok).toBe(false);
    // Non-gateway services do not require the ambient identity.
    const cockpit = await runPreflight({ service: "cockpit", env, dbProbe: okProbe });
    expect(cockpit.ok).toBe(true);
  });

  it("5b. a probe error embedding a connection URL has its userinfo SCRUBBED (output gets pasted into reports)", async () => {
    const failingProbe = () =>
      Promise.reject(new Error("P1000: auth failed against postgres://admin:redacted@db.example.com:5432/prod"));
    const report = await runPreflight({ env: greenEnv(), dbProbe: failingProbe });
    const dbCheck = report.checks.find((c) => c.name.toLowerCase().includes("reachable"));
    expect(dbCheck?.ok).toBe(false);
    expect(dbCheck!.detail).not.toContain("admin"); // the userinfo never travels
    expect(dbCheck!.detail).toContain("//***@"); // visibly scrubbed, host kept for diagnostics
    expect(dbCheck!.detail).toContain("db.example.com"); // the useful part survives
  });

  it("6. SECRETS NEVER SURFACE: distinctive secret values across every service never appear in the report JSON", async () => {
    const secrets = {
      DATABASE_URL: "file:./sk-DBSECRET-000000.db",
      GATEWAY_UPSTREAM_KEY: "sk-UPSTREAMSECRET-111111111111",
      GATEWAY_TOKEN: "sk-INBOUNDSECRET-222222222222",
      COCKPIT_SESSION_SECRET: "sk-SESSIONSECRET-3333333333333333",
      DIONYSUS_CONFIG_KEY: Buffer.from("sk-CONFIGSECRET-4444-32bytes!!!!").toString("base64"),
    };
    const env = { ...greenEnv(), ...secrets };
    const report = await runPreflight({ service: "all", env, dbProbe: okProbe });
    const json = JSON.stringify(report);
    for (const value of Object.values(secrets)) {
      expect(json).not.toContain(value);
    }
  });
});
