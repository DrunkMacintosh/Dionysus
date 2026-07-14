import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { auditPageSeo, type SeoFinding } from "../src/lib/scrape/seo-audit.js";
import type { LookupFn, SafeFetchOptions } from "../src/lib/ssrf.js";

// Local test server on 127.0.0.1. Production code blocks loopback, so we inject
// a lookupFn that maps "local.test" -> 127.0.0.1 and allow it via a test seam —
// exactly the safe-fetch.test.ts / scrape-ladder.test.ts convention.
let server: http.Server;
let port: number;
const localLookup: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
const testOpts: SafeFetchOptions = { lookupFn: localLookup, __testAllowPrivate: true };

// The audit fetches the main page + three same-origin well-known paths. A single
// server serves all of them from mutable state each test sets before it runs;
// vitest runs tests in a file serially, so this is race-free.
type ServerState = {
  status: number;
  contentType: string;
  html: string;
  wellKnown: number; // status returned for /robots.txt, /sitemap.xml, /llms.txt
};
let state: ServerState;

const WELL_KNOWN = new Set(["/robots.txt", "/sitemap.xml", "/llms.txt"]);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (WELL_KNOWN.has(path)) {
      res.writeHead(state.wellKnown, { "content-type": "text/plain" });
      res.end(state.wellKnown >= 200 && state.wellKnown < 300 ? "ok" : "not found");
      return;
    }
    res.writeHead(state.status, { "content-type": state.contentType });
    res.end(state.html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterAll(() => server.close());

// A verbatim, in-range healthy page: title in [10,60], description in [50,160],
// exactly one h1, canonical, og pair, a valid SoftwareApplication JSON-LD block,
// and a viewport meta. Well-known paths default to 200 (set per test).
const HEALTHY_TITLE = "Acme Analytics Platform Home Page"; // 33 chars — in [10,60]
const HEALTHY_DESC =
  "Acme Analytics gives developer teams a real-time view of product usage and growth signals every day."; // 100 chars
const healthyHtml = (title = HEALTHY_TITLE): string => `<!doctype html><html><head>
  <title>${title}</title>
  <meta name="description" content="${HEALTHY_DESC}">
  <link rel="canonical" href="https://acme.example/">
  <meta property="og:title" content="Acme Analytics">
  <meta property="og:description" content="Real-time product analytics">
  <script type="application/ld+json">{"@type":"SoftwareApplication","name":"Acme"}</script>
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head><body><h1>Acme Analytics</h1><p>Best analytics.</p></body></html>`;

const MAIN_URL = (): string => `http://local.test:${port}/`;
const audit = (opts: SafeFetchOptions = testOpts) => auditPageSeo(MAIN_URL(), opts);
const byCheck = (findings: SeoFinding[], check: string): SeoFinding => {
  const f = findings.find((x) => x.check === check);
  if (!f) throw new Error(`no finding for ${check}`);
  return f;
};

beforeEach(() => {
  // Baseline: healthy page, all well-known present. Each test overrides as needed.
  state = { status: 200, contentType: "text/html", html: healthyHtml(), wellKnown: 200 };
});

describe("auditPageSeo", () => {
  it("passes every check on a healthy page and echoes verbatim evidence", async () => {
    const r = await audit();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.findings) expect(f.status).toBe("pass");
    expect(byCheck(r.findings, "title").evidence).toContain(HEALTHY_TITLE);
    expect(byCheck(r.findings, "json-ld").evidence).toContain("SoftwareApplication");
    // Every pass finding carries an empty advice string.
    for (const f of r.findings) expect(f.advice).toBe("");
  });

  it("fails/warns 'absent' with non-empty advice on a bare page", async () => {
    state.html = "<html><body>hi</body></html>";
    state.wellKnown = 404;
    const r = await audit();
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    for (const check of ["title", "meta-description", "h1"]) {
      const f = byCheck(r.findings, check);
      expect(f.status).toBe("fail");
      expect(f.evidence).toBe("absent");
    }
    for (const check of ["canonical", "og-title", "og-description", "json-ld", "viewport"]) {
      const f = byCheck(r.findings, check);
      expect(f.status).toBe("warn");
      expect(f.evidence).toBe("absent");
    }
    for (const check of ["robots-txt", "sitemap-xml", "llms-txt"]) {
      const f = byCheck(r.findings, check);
      expect(f.status).toBe("warn");
      expect(f.evidence).toBe("absent");
    }
    // Every non-pass finding must carry hardcoded advice.
    for (const f of r.findings) {
      if (f.status !== "pass") expect(f.advice.length).toBeGreaterThan(0);
    }
  });

  it("warns on boundary lengths for title and meta description", async () => {
    // 61-char title → warn (61 chars)
    state.html = `<html><head><title>${"T".repeat(61)}</title></head><body></body></html>`;
    let r = await audit();
    if (!r.ok) throw new Error("expected ok");
    let f = byCheck(r.findings, "title");
    expect(f.status).toBe("warn");
    expect(f.evidence).toContain("(61 chars)");

    // 9-char title → warn (9 chars)
    state.html = `<html><head><title>${"T".repeat(9)}</title></head><body></body></html>`;
    r = await audit();
    if (!r.ok) throw new Error("expected ok");
    f = byCheck(r.findings, "title");
    expect(f.status).toBe("warn");
    expect(f.evidence).toContain("(9 chars)");

    // 49-char description → warn (49 chars)
    state.html = `<html><head><meta name="description" content="${"d".repeat(49)}"></head><body></body></html>`;
    r = await audit();
    if (!r.ok) throw new Error("expected ok");
    f = byCheck(r.findings, "meta-description");
    expect(f.status).toBe("warn");
    expect(f.evidence).toContain("(49 chars)");

    // 161-char description → warn (161 chars)
    state.html = `<html><head><meta name="description" content="${"d".repeat(161)}"></head><body></body></html>`;
    r = await audit();
    if (!r.ok) throw new Error("expected ok");
    f = byCheck(r.findings, "meta-description");
    expect(f.status).toBe("warn");
    expect(f.evidence).toContain("(161 chars)");
  });

  it("warns on multiple h1 elements", async () => {
    state.html = "<html><body><h1>one</h1><h1>two</h1></body></html>";
    const r = await audit();
    if (!r.ok) throw new Error("expected ok");
    const f = byCheck(r.findings, "h1");
    expect(f.status).toBe("warn");
    expect(f.evidence).toBe("2 h1 elements");
  });

  it("fails on unparseable JSON-LD", async () => {
    state.html = `<html><head><script type="application/ld+json">{nope</script></head><body></body></html>`;
    const r = await audit();
    if (!r.ok) throw new Error("expected ok");
    const f = byCheck(r.findings, "json-ld");
    expect(f.status).toBe("fail");
    expect(f.evidence).toBe("unparseable JSON-LD");
    expect(f.advice.length).toBeGreaterThan(0);
  });

  it("returns ok:false on HTTP 500", async () => {
    state.status = 500;
    state.html = "boom";
    const r = await audit();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("500");
  });

  it("returns ok:false on non-HTML content", async () => {
    state.contentType = "application/json";
    state.html = "{}";
    const r = await audit();
    expect(r.ok).toBe(false);
  });

  it("is deterministic: two audits of the same page are byte-identical", async () => {
    const a = await audit();
    const b = await audit();
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(JSON.stringify(a.findings)).toBe(JSON.stringify(b.findings));
  });

  it("caps evidence at the 200-char bound", async () => {
    state.html = `<html><head><title>${"X".repeat(500)}</title></head><body></body></html>`;
    const r = await audit();
    if (!r.ok) throw new Error("expected ok");
    const f = byCheck(r.findings, "title");
    expect(f.evidence.length).toBeLessThanOrEqual(210);
  });

  it("returns ok:false when the page is SSRF-blocked (no test seam)", async () => {
    // Unroutable loopback with a blocked port: the guard throws, auditPageSeo catches.
    const r = await auditPageSeo("http://127.0.0.1:9/");
    expect(r.ok).toBe(false);
  });
});
