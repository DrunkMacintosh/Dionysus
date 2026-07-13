// The preflight doctor (D31 dogfood). A PURE, injectable check core: per-service
// required/warn checks over an injected env + an injected DB probe, so unit tests
// never touch the real environment or database. Fail-closed vs warn, honestly —
// a check is ok:false ONLY when the service genuinely refuses to work; degradable
// configs are WARN (ok:true, detail prefixed "WARN:"). Secret VALUES never surface:
// details report presence/validity ONLY (e.g. "set (32 bytes)"), never a value.

export type PreflightService = "gateway" | "cockpit" | "nightly" | "all";
export type CheckResult = { service: string; name: string; ok: boolean; detail: string };
export type PreflightReport = { ok: boolean; checks: CheckResult[] };

const CONFIG_KEY_BYTES = 32;
const MIN_SESSION_SECRET_CHARS = 16;

/** A passing/failing check with an honest severity. */
function check(service: string, name: string, ok: boolean, detail: string): CheckResult {
  return { service, name, ok, detail };
}

/** A degradable-config warning: ok:true, detail prefixed "WARN:" (the CLI strips it into a tag). */
function warn(service: string, name: string, detail: string): CheckResult {
  return { service, name, ok: true, detail: `WARN: ${detail}` };
}

/** Presence report — byte length ONLY, never the value. e.g. "set (32 bytes)". */
function presence(value: string): string {
  return `set (${Buffer.byteLength(value, "utf8")} bytes)`;
}

/** First line only — strips any stack trace (and never echoes multi-line detail). */
function firstLine(message: string): string {
  return message.split("\n")[0]!.trim();
}

/**
 * Scrub URL userinfo (user[:password]@host) from an error message before surfacing it.
 * Preflight output gets pasted into reports/issues (the runbook says so) — a driver error's
 * first line can embed a connection URL whose userinfo must never travel with it.
 */
function scrubUserinfo(message: string): string {
  return message.replace(/\/\/[^@/\s]+@/g, "//***@");
}

/** The default probe lazily imports prisma so unit tests (which inject a stub) never load the DB. */
async function defaultDbProbe(): Promise<void> {
  const { prisma } = await import("../db.js");
  await prisma.$queryRaw`SELECT 1`;
}

/** Common checks run for EVERY selected service: a database URL, and a reachable database. */
async function commonChecks(
  env: Record<string, string | undefined>,
  dbProbe: () => Promise<void>,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  const url = env["DATABASE_URL"];
  checks.push(
    check("common", "DATABASE_URL", Boolean(url), url ? "set" : "not set — every service needs a database."),
  );

  try {
    await dbProbe();
    checks.push(check("common", "database reachable", true, "reachable"));
  } catch (err) {
    const message = scrubUserinfo(firstLine(err instanceof Error ? err.message : String(err)));
    checks.push(check("common", "database reachable", false, `unreachable: ${message}`));
  }

  return checks;
}

/** Gateway: refuses to boot without an upstream URL; port must be a positive int if set. */
function gatewayChecks(env: Record<string, string | undefined>): CheckResult[] {
  const checks: CheckResult[] = [];

  // The gateway process loads its ambient identity BEFORE its config (gateway-index.ts) —
  // it refuses to boot without DIONYSUS_BUSINESS_ID, so the doctor must fail it too
  // (a gap the executed runbook acceptance discovered).
  const businessId = env["DIONYSUS_BUSINESS_ID"];
  checks.push(
    check(
      "gateway",
      "DIONYSUS_BUSINESS_ID",
      Boolean(businessId),
      businessId ? "set" : "not set — the gateway refuses to boot without its ambient identity.",
    ),
  );

  const upstreamUrl = env["GATEWAY_UPSTREAM_URL"];
  checks.push(
    check(
      "gateway",
      "GATEWAY_UPSTREAM_URL",
      Boolean(upstreamUrl),
      upstreamUrl ? "set" : "not set — the gateway refuses to boot without an upstream.",
    ),
  );

  const rawPort = env["GATEWAY_PORT"];
  if (rawPort === undefined || rawPort === "") {
    checks.push(check("gateway", "GATEWAY_PORT", true, "unset — defaults to 8787."));
  } else {
    const port = Number(rawPort);
    const valid = Number.isInteger(port) && port > 0;
    checks.push(
      check("gateway", "GATEWAY_PORT", valid, valid ? `set (${port})` : "set but not a positive integer."),
    );
  }

  const upstreamKey = env["GATEWAY_UPSTREAM_KEY"];
  checks.push(
    upstreamKey
      ? check("gateway", "GATEWAY_UPSTREAM_KEY", true, presence(upstreamKey))
      : warn("gateway", "GATEWAY_UPSTREAM_KEY", "not set — upstream may reject unauthenticated calls."),
  );

  const token = env["GATEWAY_TOKEN"];
  checks.push(
    token
      ? check("gateway", "GATEWAY_TOKEN", true, presence(token))
      : warn("gateway", "GATEWAY_TOKEN", "not set — gateway accepts unauthenticated local callers."),
  );

  return checks;
}

/** Cockpit: a session secret ≥ 16 chars (else sessions are unusable/weak); base URL is degradable. */
function cockpitChecks(env: Record<string, string | undefined>): CheckResult[] {
  const checks: CheckResult[] = [];

  const secret = env["COCKPIT_SESSION_SECRET"];
  if (!secret) {
    checks.push(check("cockpit", "COCKPIT_SESSION_SECRET", false, "not set — sessions cannot be signed."));
  } else if (secret.length < MIN_SESSION_SECRET_CHARS) {
    checks.push(
      check("cockpit", "COCKPIT_SESSION_SECRET", false, "set but shorter than 16 chars — sessions would be weak."),
    );
  } else {
    checks.push(check("cockpit", "COCKPIT_SESSION_SECRET", true, "set (ok length)"));
  }

  const baseUrl = env["COCKPIT_BASE_URL"];
  checks.push(
    baseUrl
      ? check("cockpit", "COCKPIT_BASE_URL", true, "set")
      : warn("cockpit", "COCKPIT_BASE_URL", "not set — magic links will print localhost."),
  );

  return checks;
}

/** Nightly: config key is degradable when ABSENT (WARN) but FAIL when set-but-malformed. */
function nightlyChecks(env: Record<string, string | undefined>): CheckResult[] {
  const checks: CheckResult[] = [];

  const rawKey = env["DIONYSUS_CONFIG_KEY"];
  if (!rawKey) {
    checks.push(warn("nightly", "DIONYSUS_CONFIG_KEY", "not set — metric ingestion will be skipped."));
  } else {
    const decodedBytes = Buffer.from(rawKey, "base64").length;
    checks.push(
      decodedBytes === CONFIG_KEY_BYTES
        ? check("nightly", "DIONYSUS_CONFIG_KEY", true, `set (decodes to ${CONFIG_KEY_BYTES} bytes)`)
        : check(
            "nightly",
            "DIONYSUS_CONFIG_KEY",
            false,
            `set but decodes to ${decodedBytes} bytes, not ${CONFIG_KEY_BYTES} — a wrong key silently corrupts every decrypt.`,
          ),
    );
  }

  const localUrl = env["GATEWAY_LOCAL_URL"];
  checks.push(
    localUrl
      ? check("nightly", "GATEWAY_LOCAL_URL", true, "set")
      : warn("nightly", "GATEWAY_LOCAL_URL", "not set — defaults to http://127.0.0.1:8787/v1."),
  );

  return checks;
}

/**
 * Run the preflight doctor over an injected env + DB probe. `report.ok` is true iff
 * no check FAILs (ok:false) across the selected service set; WARNs (ok:true) never fail it.
 */
export async function runPreflight(opts: {
  service?: PreflightService;
  env?: Record<string, string | undefined>;
  dbProbe?: () => Promise<void>;
}): Promise<PreflightReport> {
  const service = opts.service ?? "all";
  const env = opts.env ?? process.env;
  const dbProbe = opts.dbProbe ?? defaultDbProbe;

  const services: Array<Exclude<PreflightService, "all">> =
    service === "all" ? ["gateway", "cockpit", "nightly"] : [service];

  const checks: CheckResult[] = [...(await commonChecks(env, dbProbe))];
  for (const svc of services) {
    if (svc === "gateway") checks.push(...gatewayChecks(env));
    else if (svc === "cockpit") checks.push(...cockpitChecks(env));
    else if (svc === "nightly") checks.push(...nightlyChecks(env));
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}
