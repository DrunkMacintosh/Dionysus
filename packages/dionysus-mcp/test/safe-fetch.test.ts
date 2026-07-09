import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { safeFetch, SsrfError, type LookupFn } from "../src/lib/ssrf.js";

// Local test server on 127.0.0.1. Production code blocks loopback, so tests
// inject a lookupFn that maps "local.test" -> 127.0.0.1 and treats it as public.
let server: http.Server;
let port: number;
const localLookup: LookupFn = async (hostname) => {
  if (hostname === "local.test") return [{ address: "127.0.0.1", family: 4 }];
  if (hostname === "private.test") return [{ address: "10.0.0.1", family: 4 }];
  throw new Error(`unexpected lookup: ${hostname}`);
};
// The guard treats 127.0.0.1 as private; for fetch-mechanics tests we allow it
// by passing an allowlist-style lookup that the production default never uses.
const testOpts = { lookupFn: localLookup, __testAllowPrivate: true } as const;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><title>ok</title></html>");
    } else if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("x".repeat(100_000));
    } else if (req.url === "/redirect-private") {
      res.writeHead(302, { location: "http://private.test/steal" });
      res.end();
    } else if (req.url === "/redirect-loop") {
      res.writeHead(302, { location: "/redirect-loop" });
      res.end();
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterAll(() => server.close());

describe("safeFetch", () => {
  it("fetches a page and returns body + finalUrl", async () => {
    const res = await safeFetch(`http://local.test:${port}/ok`, testOpts);
    expect(res.status).toBe(200);
    expect(res.body).toContain("<title>ok</title>");
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
    await expect(safeFetch("ftp://example.com/x")).rejects.toBeInstanceOf(SsrfError);
  });

  it("blocks redirect to a private host (per-hop re-validation)", async () => {
    await expect(
      safeFetch(`http://local.test:${port}/redirect-private`, { lookupFn: localLookup, __testAllowPrivate: false, __testAllowHosts: ["local.test"] } as never),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("caps redirect count", async () => {
    await expect(
      safeFetch(`http://local.test:${port}/redirect-loop`, { ...testOpts, maxRedirects: 2 }),
    ).rejects.toThrow(/redirect/i);
  });

  it("caps response size", async () => {
    await expect(
      safeFetch(`http://local.test:${port}/big`, { ...testOpts, maxBytes: 10_000 }),
    ).rejects.toThrow(/size/i);
  });
});
