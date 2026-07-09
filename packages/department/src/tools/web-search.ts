// web_search tool: Brave Search, fail-closed, injectable transport.
//
// Fail-closed (Orchestrator note 3 / Spec §14): with no BRAVE_API_KEY (neither
// opt nor env) this THROWS — never a silent empty result set that would let the
// Discovery pipeline present zero sources as "nothing found". The transport is
// injectable so unit tests stay network-free (no key, no 127.0.0.1-only rule
// broken): tests pass a stub transport and assert the Brave URL + header shape.
import { request } from "undici";

export type SearchResult = { title: string; url: string; snippet: string };
export type SearchTransport = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ status: number; body: string }>;

// Number of results requested from Brave per query.
const RESULT_COUNT = 8;

const defaultTransport: SearchTransport = async (url, headers) => {
  const res = await request(url, { method: "GET", headers });
  return { status: res.statusCode, body: await res.body.text() };
};

export async function webSearch(
  query: string,
  opts: { apiKey?: string; transport?: SearchTransport } = {},
): Promise<SearchResult[]> {
  const apiKey = opts.apiKey ?? process.env["BRAVE_API_KEY"];
  if (!apiKey) {
    throw new Error("BRAVE_API_KEY is not set — web_search is unavailable (fail closed).");
  }
  const transport = opts.transport ?? defaultTransport;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${RESULT_COUNT}`;
  const res = await transport(url, { Accept: "application/json", "X-Subscription-Token": apiKey });
  if (res.status !== 200) throw new Error(`Brave search failed: HTTP ${res.status}`);
  const parsed = JSON.parse(res.body) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (parsed.web?.results ?? []).flatMap((r) =>
    r.url ? [{ title: r.title ?? "", url: r.url, snippet: r.description ?? "" }] : [],
  );
}
