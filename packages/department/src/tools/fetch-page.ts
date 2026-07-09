// fetch_page tool: reads a URL via dionysus-mcp's SSRF-guarded scrapeLadder and
// fences the result as UNTRUSTED DATA (D20) before it can enter any prompt.
//
// D20 is load-bearing: the exact `<<<UNTRUSTED-CONTENT url=...>>>` ...
// `<<<END-UNTRUSTED-CONTENT>>>` markers are what Task 4's prompts and Task 6's
// citation-entailment checker rely on to tell trusted instructions apart from
// scraped web content. A tier-4 "couldn't read" result is STILL fenced (with a
// COULD NOT READ note) — fetchPageFenced never throws on a failed read, so a
// broken source degrades gracefully instead of crashing the pipeline.
//
// Import style (Task 1 precedent / Orchestrator note 1): resolve dionysus-mcp
// via its `exports` map subpaths (no `.js` extension) — `"./*": "./dist/*.js"`
// maps `dionysus-mcp/lib/scrape/ladder` → `dist/lib/scrape/ladder.js`.
import { scrapeLadder } from "dionysus-mcp/lib/scrape/ladder";
import type { SafeFetchOptions } from "dionysus-mcp/lib/ssrf";

export async function fetchPageFenced(url: string, fetchOpts?: SafeFetchOptions): Promise<string> {
  const r = await scrapeLadder(url, fetchOpts);
  const payload = r.tier === 4
    ? `COULD NOT READ (${r.error ?? "unknown"})`
    : [r.title, r.description, r.text].filter(Boolean).join("\n");
  return `<<<UNTRUSTED-CONTENT url=${url}>>>\n${payload}\n<<<END-UNTRUSTED-CONTENT>>>`;
}
