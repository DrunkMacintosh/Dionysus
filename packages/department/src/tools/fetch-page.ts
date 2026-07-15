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

// D20 break-out defense. Attacker-controlled content (page title / description
// / text), a fetched url, a Tavily search snippet, or a scraped product blurb can
// itself contain the literal fence markers. If a forged `<<<END-UNTRUSTED-CONTENT>>>`
// survived INSIDE the fenced region, a downstream model would see the fence close
// early and read everything after it as trusted instructions. We defang any
// marker-lookalike sequence by inserting a zero-width space (U+200B) between the
// leading `<`s: it is no longer the literal marker the checker/prompts key on,
// yet stays human-readable. The OUTER real markers are written from string
// literals in `fence` below and are NEVER passed through `neutralizeFenceMarkers`,
// so they stay byte-exact — Task 4's prompts and Task 6's fixed-marker checker
// depend on those exact strings, so this is deliberately a fixed defang, not a
// random nonce.
//
// Exported so every untrusted-content-into-prompt path (fetch_page, web_search,
// scraped product description) shares ONE fencing implementation (D20) instead
// of re-deriving the marker logic per call site.
export function neutralizeFenceMarkers(s: string): string {
  return s.replace(/<<<(\/?(?:END-)?UNTRUSTED-CONTENT)/gi, "<​<​<$1");
}

// Wrap arbitrary untrusted text as fenced DATA. `label` is echoed into the
// opening marker for provenance (e.g. `url=...`, `web-search-results`); both the
// label and the content are neutralized so neither can forge a marker.
export function fence(label: string, content: string): string {
  return `<<<UNTRUSTED-CONTENT ${neutralizeFenceMarkers(label)}>>>\n${neutralizeFenceMarkers(content)}\n<<<END-UNTRUSTED-CONTENT>>>`;
}

export async function fetchPageFenced(url: string, fetchOpts?: SafeFetchOptions): Promise<string> {
  const r = await scrapeLadder(url, fetchOpts);
  const payload = r.tier === 4
    ? `COULD NOT READ (${r.error ?? "unknown"})`
    : [r.title, r.description, r.text].filter(Boolean).join("\n");
  return fence(`url=${url}`, payload);
}
