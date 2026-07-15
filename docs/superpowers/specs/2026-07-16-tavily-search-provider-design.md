# Tavily Search Provider (replacing Brave) — Design

**Date:** 2026-07-16. **Status:** approved (founder, this session). **Scope:** one module swap + env/docs sweep.

## Problem

The discovery pipeline's `web_search` tool is Brave-specific, and Brave's API key is no longer
free to obtain — the founder cannot run discovery. Verified this session: **Tavily's Researcher
tier is 1,000 API credits/month, no credit card** ([tavily.com/pricing](https://www.tavily.com/pricing)).
Discovery runs a handful of queries once per business, so 1,000/month is effectively unlimited here.

## Decision

Replace Brave with **Tavily** inside `packages/department/src/tools/web-search.ts`. The exported
contract is unchanged — `webSearch(query, opts) → SearchResult[] {title, url, snippet}` — so
`discover.ts` and everything downstream keep their behavior. Brave support is removed outright
(a dead provider path is speculative code; the transport seam makes any future provider a
three-line adapter).

## The Tavily contract (verified against docs.tavily.com, 2026-07-16)

- `POST https://api.tavily.com/search`
- Auth: `Authorization: Bearer <tvly-key>` header
- Body: `{ "query": string, "max_results": number }` (max_results 0–20; we keep the existing 8)
- Response: `{ results: [{ title, url, content, ... }] }` — `content` maps to our `snippet`

## Invariants preserved

- **Fail-closed (Spec §14 / Orchestrator note 3):** no `TAVILY_API_KEY` (neither `opts.apiKey`
  nor env) → THROW. Never a silent empty result set that would let discovery present zero
  sources as "nothing found". Non-200 → throw with the status.
- **Injectable transport** for network-free unit tests. The seam's shape changes from GET-style
  `(url, headers)` to `(url, headers, body)` since Tavily is a POST — only the module's own
  tests inject transports, so the blast radius is that one test file.
- **The key never logs**; it flows only into the Authorization header.

## Env + docs sweep

`BRAVE_API_KEY` → `TAVILY_API_KEY` everywhere it appears: `web-search.ts` (env fallback +
error message), `scripts/live-smoke.mjs` (the fail-closed `need()`), README's env contract,
`docs/DEPLOY.md`, and the founder's local `.env.dogfood.ps1` comment line (uncommitted file,
edited in place).

## Testing

The existing `web-search` unit tests re-pin against Tavily: exact URL, Bearer header (with the
key value asserted present in the header and nowhere else), POST body `{query, max_results: 8}`,
response mapping (`content`→`snippet`, results without a `url` dropped), fail-closed on missing
key, and non-200 throw. Discovery's tests stub at the transport/harness level and are unchanged.

## Out of scope

Multi-provider selection (`SEARCH_PROVIDER` env), SearXNG self-hosting, result-quality tuning
(`search_depth` stays default `basic`). Each is a later decision if Tavily disappoints.
