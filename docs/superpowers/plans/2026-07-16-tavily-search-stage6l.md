# Tavily Search Provider (Stage 6l — mini) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap the discovery pipeline's search provider from Brave (no longer free) to Tavily (verified: 1,000 credits/month, no card), preserving the exported `webSearch` contract and the fail-closed invariant. Spec: `docs/superpowers/specs/2026-07-16-tavily-search-provider-design.md`.

**Architecture:** provider internals only — `web-search.ts` becomes a Tavily POST adapter; the transport seam gains a `body` parameter; env `BRAVE_API_KEY` → `TAVILY_API_KEY` everywhere.

**Tech Stack:** no new dependencies. department package + docs.

## Global Constraints

- **Exported contract unchanged:** `webSearch(query, opts) → SearchResult[] {title, url, snippet}`; `RESULT_COUNT = 8` preserved.
- **Fail-closed preserved verbatim:** no key (opts nor env) → throw "TAVILY_API_KEY is not set — web_search is unavailable (fail closed)."; non-200 → throw `Tavily search failed: HTTP <status>`.
- **The key flows ONLY into the Authorization header** — never logged, never in an error message.
- **Tavily contract (verified 2026-07-16):** `POST https://api.tavily.com/search`; `Authorization: Bearer <key>`; body `{"query": <q>, "max_results": 8}`; response `{results: [{title, url, content}]}` — `content` → `snippet`; results without a `url` dropped.
- **Ops:** PowerShell only (Git Bash broken). dept: `pnpm --filter department test`. Baselines: dept **222** (mcp 361 / cockpit 77 untouched).

---

## Task 1: The provider swap + env/docs sweep

**Files:**
- Modify: `packages/department/src/tools/web-search.ts`
- Modify: `packages/department/scripts/live-smoke.mjs` (the `need("BRAVE_API_KEY")` line → `TAVILY_API_KEY`)
- Modify: `packages/department/test/web-search.test.ts` (or wherever webSearch is tested — find it; re-pin all cases to Tavily)
- Modify: `packages/department/README.md` (env contract mentions of BRAVE_API_KEY, if present), `docs/DEPLOY.md` (§8's Brave mention if present — grep for `BRAVE` repo-wide and sweep every hit EXCEPT `.env.dogfood.ps1`, which the orchestrator edits separately since it is uncommitted and carries secrets)

**Complete `web-search.ts`:**

```typescript
// web_search tool: Tavily Search, fail-closed, injectable transport.
//
// Fail-closed (Orchestrator note 3 / Spec §14): with no TAVILY_API_KEY (neither
// opt nor env) this THROWS — never a silent empty result set that would let the
// Discovery pipeline present zero sources as "nothing found". The transport is
// injectable so unit tests stay network-free: tests pass a stub transport and
// assert the Tavily URL + auth header + POST body shape.
// (Provider history: Brave until 2026-07-16 — its key is no longer free. See
// docs/superpowers/specs/2026-07-16-tavily-search-provider-design.md.)
import { request } from "undici";

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchTransport = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; body: string }>;

// Number of results requested from Tavily per query (its max_results caps at 20).
const RESULT_COUNT = 8;

const defaultTransport: SearchTransport = async (url, headers, body) => {
  const res = await request(url, { method: "POST", headers, body });
  return { status: res.statusCode, body: await res.body.text() };
};

export async function webSearch(
  query: string,
  opts: { apiKey?: string; transport?: SearchTransport } = {},
): Promise<SearchResult[]> {
  const apiKey = opts.apiKey ?? process.env["TAVILY_API_KEY"];
  if (!apiKey) {
    throw new Error("TAVILY_API_KEY is not set — web_search is unavailable (fail closed).");
  }
  const transport = opts.transport ?? defaultTransport;
  const res = await transport(
    "https://api.tavily.com/search",
    { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    JSON.stringify({ query, max_results: RESULT_COUNT }),
  );
  if (res.status !== 200) throw new Error(`Tavily search failed: HTTP ${res.status}`);
  const parsed = JSON.parse(res.body) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (parsed.results ?? []).flatMap((r) =>
    r.url ? [{ title: r.title ?? "", url: r.url, snippet: r.content ?? "" }] : [],
  );
}
```

- [ ] **Step 1: failing tests.** Re-pin the existing webSearch test cases to Tavily (read the current test file first and preserve its case coverage one-for-one): (1) happy — stub transport records `(url, headers, body)`; assert url `https://api.tavily.com/search`, header `Authorization: Bearer <the test key>` (and the key appears ONLY there), parsed body `{query, max_results: 8}`, and the mapped results (`content`→`snippet`); (2) a result missing `url` is dropped; (3) missing key (no opt, env unset — save/restore `process.env`) → throws the exact fail-closed message; (4) non-200 → throws `Tavily search failed: HTTP 500`; (5) whatever additional cases the current file pins (e.g. empty results → `[]`) — keep them, Tavily-shaped. Run → RED (current code still calls Brave shapes).
- [ ] **Step 2: implement** (the code above) **→ GREEN:** the web-search file's tests, then the FULL dept suite (expect **222** — count unchanged; if `discover.ts` or its tests reference the transport shape or BRAVE anywhere, update them within this task and report it).
- [ ] **Step 3: env/docs sweep.** `live-smoke.mjs`: `need("TAVILY_API_KEY")` (and its header comment if it names Brave). Grep repo-wide for `BRAVE` (case-insensitive) and update every remaining committed hit (README env contract, DEPLOY.md). `pnpm --filter department build` clean.
- [ ] **Step 4: Commit** — `feat: tavily replaces brave as the search provider - free tier verified, fail-closed preserved`

---

## Self-Review

**Spec coverage:** every spec section maps to Step 1–3 (contract swap, fail-closed, seam shape, sweep). `.env.dogfood.ps1` is explicitly the orchestrator's edit (uncommitted, secret-bearing).
**Placeholders:** none — the full module is inline.
**Type consistency:** `SearchTransport` gains `body: string`; the only injectors are the module's tests (verified in the spec).

## Execution Handoff

Subagent-Driven — one Opus implementer, focused review, merge.
