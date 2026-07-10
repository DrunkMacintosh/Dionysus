import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchHnSignals, type HnTransport } from "../src/tools/hn-source.js";

// A hit shape mirroring HN Algolia's /search response.
const hit = (over: Record<string, unknown> = {}) => ({
  objectID: "111",
  title: "Show HN: a thing",
  points: 42,
  author: "pg",
  url: "https://external.example/story",
  ...over,
});

const ok = (hits: unknown[]): HnTransport => async () => ({
  status: 200,
  body: JSON.stringify({ hits }),
});

describe("fetchHnSignals (HN Algolia, injectable transport, degrade-to-empty)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps hits to signals whose url is the HN comments permalink (not the external url)", async () => {
    const transport = ok([
      hit({ objectID: "39001", title: "A", points: 10, author: "alice" }),
      hit({ objectID: "39002", title: "B", points: 20, author: "bob" }),
    ]);
    const signals = await fetchHnSignals("ai agents", { transport });
    expect(signals).toEqual([
      { title: "A", url: "https://news.ycombinator.com/item?id=39001", points: 10, author: "alice" },
      { title: "B", url: "https://news.ycombinator.com/item?id=39002", points: 20, author: "bob" },
    ]);
    // The verifiability anchor: never the external story url field.
    expect(signals.every((s) => s.url.startsWith("https://news.ycombinator.com/item?id="))).toBe(true);
  });

  it("skips a hit missing its title (no untitled signals)", async () => {
    const transport = ok([
      hit({ objectID: "1", title: "kept" }),
      hit({ objectID: "2", title: undefined }),
    ]);
    const signals = await fetchHnSignals("q", { transport });
    expect(signals).toEqual([
      { title: "kept", url: "https://news.ycombinator.com/item?id=1", points: 42, author: "pg" },
    ]);
  });

  it("degrades to [] on a non-200 response (no throw)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const transport: HnTransport = async () => ({ status: 503, body: "upstream down" });
    await expect(fetchHnSignals("q", { transport })).resolves.toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it("degrades to [] when the transport throws (no throw)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const transport: HnTransport = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(fetchHnSignals("q", { transport })).resolves.toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it("URL-encodes the query into the request URL", async () => {
    let seenUrl = "";
    const transport: HnTransport = async (url) => {
      seenUrl = url;
      return { status: 200, body: JSON.stringify({ hits: [] }) };
    };
    await fetchHnSignals("notion launch history", { transport });
    expect(seenUrl).toContain("hn.algolia.com/api/v1/search");
    expect(seenUrl).toContain("query=notion%20launch%20history");
    expect(seenUrl).toContain("tags=story");
    expect(seenUrl).toContain("hitsPerPage=20");
  });
});
