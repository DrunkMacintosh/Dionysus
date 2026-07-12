// GATED nightly wake (stage 6a). One sweep: every business gets its night —
// radar sensing + metric ingestion — under its own identity, failures isolated.
// Invoke from any external scheduler (Task Scheduler / cron / a platform job):
//   pnpm --filter department nightly
// Env: GATEWAY_LOCAL_URL (default http://127.0.0.1:8787/v1), GATEWAY_TOKEN (default "local"),
// DEPARTMENT_BRAIN_MODEL (default below), DATABASE_URL (the business DB),
// DIONYSUS_CONFIG_KEY (needed only to decrypt connected analytics configs — without it,
// metric ingestion degrades to "skipped", honestly; radar still runs).
import { createSdkHarness } from "../dist/llm/harness.js";
import { runNightlySweep } from "../dist/run-nightly.js";

const gatewayUrl = process.env.GATEWAY_LOCAL_URL ?? "http://127.0.0.1:8787/v1";
const brain = process.env.DEPARTMENT_BRAIN_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
if (!process.env.DIONYSUS_CONFIG_KEY) {
  console.error("nightly: DIONYSUS_CONFIG_KEY not set — metric ingestion will be skipped (radar unaffected).");
}

const harness = createSdkHarness({ baseUrl: gatewayUrl, apiKey: process.env.GATEWAY_TOKEN ?? "local" });
const started = Date.now();
const results = await runNightlySweep({ harness, models: { brain } });

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => r.radar.status === "failed" || r.metrics.status === "failed").length;
console.log(`\nnightly: ${results.length} business(es) in ${Math.round((Date.now() - started) / 1000)}s — ${failed} with failures (see report above).`);
process.exit(0); // per-business failures are REPORTED, not fatal — the sweep itself succeeded
