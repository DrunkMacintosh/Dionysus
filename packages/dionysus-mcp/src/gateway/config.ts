import type { GatewayConfig } from "./proxy.js";

const DEFAULT_PORT = 8787;

/**
 * Load the gateway config from the environment. Fail-closed (D28): missing
 * `GATEWAY_UPSTREAM_URL` or a non-positive-integer `GATEWAY_PORT` throws at
 * startup rather than booting a misconfigured, unmetered proxy.
 */
export function loadGatewayConfig(
  env: Record<string, string | undefined> = process.env,
): GatewayConfig {
  const upstreamUrl = env["GATEWAY_UPSTREAM_URL"];
  if (!upstreamUrl) {
    throw new Error(
      "GATEWAY_UPSTREAM_URL is not set — refusing to start (fail-closed, D28).",
    );
  }

  const rawPort = env["GATEWAY_PORT"];
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `GATEWAY_PORT must be a positive integer (got "${rawPort}") — refusing to start (fail-closed, D28).`,
    );
  }

  return {
    port,
    upstreamUrl: upstreamUrl.replace(/\/+$/, ""),
    upstreamKey: env["GATEWAY_UPSTREAM_KEY"] || undefined,
    inboundToken: env["GATEWAY_TOKEN"] || undefined,
  };
}
