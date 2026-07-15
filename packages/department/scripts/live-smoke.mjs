// GATED live-smoke for the Discovery pipeline (Task 8).
//
// This script IS the live test — there is no unit test for it. It drives
// discover() end-to-end through the LOCAL D28 gateway (which forwards to
// NVIDIA's hosted API), using real Tavily + NVIDIA keys the founder supplies.
//
// Acceptance for the gated task: it exists, builds against dist/, and
// FAIL-CLOSES (exit 1) when any required env var — or the product-url arg — is
// missing. The actual live model call is run by/with the founder once keys
// exist (NVIDIA free tier, ~40 RPM; expect a slow run). See README.md for the
// full env contract and the one-time Business-row setup.
import { createSdkHarness } from "../dist/llm/harness.js";
import { discover } from "../dist/discover.js";

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing ${k} — refusing to run.`); process.exit(1); } return v; };
const businessId = need("DIONYSUS_BUSINESS_ID");
need("TAVILY_API_KEY");
const gatewayUrl = process.env.GATEWAY_LOCAL_URL ?? "http://127.0.0.1:8787/v1";
const brain = process.env.DEPARTMENT_BRAIN_MODEL ?? "nvidia/nemotron-3-super-120b-a12b";
const productUrl = process.argv[2];
if (!productUrl) { console.error("Usage: pnpm smoke <product-url>"); process.exit(1); }

const harness = createSdkHarness({ baseUrl: gatewayUrl, apiKey: process.env.GATEWAY_TOKEN ?? "local" });
const brief = await discover({ businessId }, productUrl, {
  harness, models: { brain, judge: brain }, searchApiKey: process.env.TAVILY_API_KEY,
});
console.log(JSON.stringify(brief, null, 2));
console.log(`\nCases: ${brief.cases.length}. Check the LlmCall ledger for gateway-metered rows (note="gateway").`);
