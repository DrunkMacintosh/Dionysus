// Preflight doctor CLI — a thin operator wrapper over the pure check core.
//   node scripts/preflight.mjs [gateway|cockpit|nightly|all]   (default: all)
// Prints one line per check ([PASS]/[WARN]/[FAIL] service/name — detail), a summary,
// and exits 0 iff report.ok (warnings do NOT fail the exit). Operator output, so it
// prints (the live-smoke/nightly convention); the core never surfaces secret values.
import { runPreflight } from "../dist/lib/preflight.js";

const VALID = ["gateway", "cockpit", "nightly", "all"];
const service = process.argv[2] ?? "all";
if (!VALID.includes(service)) {
  console.error(`usage: node scripts/preflight.mjs [${VALID.join("|")}]`);
  process.exit(1);
}

const report = await runPreflight({ service });

for (const c of report.checks) {
  const isWarn = c.ok && c.detail.startsWith("WARN:");
  const tag = c.ok ? (isWarn ? "WARN" : "PASS") : "FAIL";
  const detail = isWarn ? c.detail.slice("WARN:".length).trim() : c.detail;
  console.log(`[${tag}] ${c.service}/${c.name} — ${detail}`);
}

const fails = report.checks.filter((c) => !c.ok).length;
const warns = report.checks.filter((c) => c.ok && c.detail.startsWith("WARN:")).length;
const passes = report.checks.length - fails - warns;
console.log(`\npreflight ${service}: ${report.ok ? "OK" : "FAILED"} — ${passes} passed, ${warns} warnings, ${fails} failed`);

process.exit(report.ok ? 0 : 1);
