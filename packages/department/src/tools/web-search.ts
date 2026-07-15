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
import { z } from "zod";

// A genuine Tavily search response carries a `results` array (empty is a valid
// zero-result search). `results` is REQUIRED: a 200 body without it is NOT a
// search response, so we throw rather than fake "nothing found" with a silent [].
const TavilyResponseSchema = z.object({
  results: z.array(z.object({
    title: z.string().optional(),
    url: z.string().optional(),
    content: z.string().optional(),
  })),
});

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
  // JSON.parse failure propagates as before. A 200 that parses but does not match the
  // response shape (no `results` array, or not an object) throws — a silent [] would fake
  // "nothing found". `{"results":[]}` is a valid, honest zero-result search.
  const parsed = TavilyResponseSchema.safeParse(JSON.parse(res.body));
  if (!parsed.success) throw new Error("Tavily search failed: unrecognized response shape");
  return parsed.data.results.flatMap((r) =>
    r.url ? [{ title: r.title ?? "", url: r.url, snippet: r.content ?? "" }] : [],
  );
}
