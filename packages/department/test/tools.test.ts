import { describe, it, expect } from "vitest";
import { webSearch } from "../src/tools/web-search.js";
import { fetchPageFenced } from "../src/tools/fetch-page.js";

describe("webSearch (Brave, injectable transport)", () => {
  it("maps Brave results and sends the subscription header", async () => {
    let seenUrl = ""; let seenHeaders: Record<string, string> = {};
    const transport = async (url: string, headers: Record<string, string>) => {
      seenUrl = url; seenHeaders = headers;
      return { status: 200, body: JSON.stringify({ web: { results: [
        { title: "T1", url: "https://a.example/1", description: "D1" },
      ]}})};
    };
    const results = await webSearch("notion launch history", { apiKey: "brave-key", transport });
    expect(seenUrl).toContain("api.search.brave.com");
    expect(seenUrl).toContain("notion%20launch%20history");
    expect(seenHeaders["X-Subscription-Token"]).toBe("brave-key");
    expect(results).toEqual([{ title: "T1", url: "https://a.example/1", snippet: "D1" }]);
  });

  it("fails closed without an api key", async () => {
    await expect(webSearch("q", { transport: async () => ({ status: 200, body: "{}" }) }))
      .rejects.toThrow(/BRAVE_API_KEY/);
  });
});

describe("fetchPageFenced", () => {
  it("fences scraped content as untrusted data (D20)", async () => {
    // uses the stage-1 test seams: local server + lookup injection
    const http = await import("node:http");
    const server = http.createServer((_q, r) => { r.writeHead(200, {"content-type":"text/html"}); r.end("<html><title>Zed launch</title><body>Zed launched on HN in 2023.</body></html>"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const out = await fetchPageFenced(`http://local.test:${port}/`, {
      lookupFn: async () => [{ address: "127.0.0.1", family: 4 }], __testAllowPrivate: true,
    } as never);
    server.close();
    expect(out).toContain("<<<UNTRUSTED-CONTENT");
    expect(out).toContain("Zed launched on HN");
    expect(out).toContain("END-UNTRUSTED-CONTENT>>>");
  });
});
