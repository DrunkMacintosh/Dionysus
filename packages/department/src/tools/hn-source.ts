// HN Algolia sensing source: keyless, injectable transport, degrade-to-empty.
//
// Mirrors web-search.ts's injectable-transport pattern so unit tests stay
// network-free, BUT unlike web_search this DEGRADES to [] on any failure
// (non-200 or transport throw, logged to stderr) instead of fail-closing:
// a single source outage must not kill the nightly radar. A zero-signal run
// is honestly just "nothing noticed", not a lie about coverage.
import { request } from "undici";

export type HnSignal = { title: string; url: string; points: number; author: string };
export type HnTransport = (url: string) => Promise<{ status: number; body: string }>;

// Number of stories requested from HN Algolia per query.
const HITS = 20;

const defaultTransport: HnTransport = async (url) => {
  const res = await request(url, { method: "GET" });
  return { status: res.statusCode, body: await res.body.text() };
};

/** Free, keyless devtool sensing surface. Degrades to [] on any failure -- a
 *  source outage must not kill the nightly radar (contrast web_search's
 *  fail-closed). The signal `url` is ALWAYS the HN comments permalink
 *  (item?id=<objectID>), a real/stable/fetchable URL, never the possibly-
 *  missing external story url -- so every signal stays source-verifiable. */
export async function fetchHnSignals(
  query: string,
  opts: { transport?: HnTransport } = {},
): Promise<HnSignal[]> {
  const transport = opts.transport ?? defaultTransport;
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${HITS}`;
  try {
    const res = await transport(url);
    if (res.status !== 200) {
      console.error(`radar: HN source returned HTTP ${res.status} -- 0 signals this run.`);
      return [];
    }
    const parsed = JSON.parse(res.body) as {
      hits?: Array<{ objectID?: string; title?: string; points?: number; author?: string }>;
    };
    return (parsed.hits ?? []).flatMap((h) =>
      h.objectID && h.title
        ? [
            {
              title: h.title,
              url: `https://news.ycombinator.com/item?id=${h.objectID}`,
              points: typeof h.points === "number" ? h.points : 0,
              author: h.author ?? "",
            },
          ]
        : [],
    );
  } catch (error: unknown) {
    console.error(
      `radar: HN source unreachable (${error instanceof Error ? error.message : "unknown"}) -- 0 signals this run.`,
    );
    return [];
  }
}
