import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { scrapeLadder } from "../src/lib/scrape/ladder.js";
import { readProduct } from "../src/tools/read-product.js";
import { prisma } from "../src/db.js";
import type { LookupFn } from "../src/lib/ssrf.js";

let server: http.Server;
let port: number;
const localLookup: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
const testOpts = { lookupFn: localLookup, __testAllowPrivate: true } as const;

const PAGE = `<html><head>
  <title>Acme Widgets</title>
  <meta name="description" content="Widgets for developers">
</head><body>
  <script>ignore_me()</script>
  <h1>Acme</h1><p>The best widget toolkit for busy developers.</p>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/product") {
      res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE);
    } else if (req.url === "/binary") {
      res.writeHead(200, { "content-type": "application/octet-stream" }); res.end("BLOB");
    } else { res.writeHead(500); res.end("boom"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  await prisma.business.upsert({
    where: { id: "biz_scrape" },
    create: { id: "biz_scrape", name: "Scrape Co" },
    update: {},
  });
});

afterAll(() => server.close());

describe("scrapeLadder", () => {
  it("extracts title, description and visible text (tier 3)", async () => {
    const r = await scrapeLadder(`http://local.test:${port}/product`, testOpts);
    expect(r.tier).toBe(3);
    expect(r.title).toBe("Acme Widgets");
    expect(r.description).toBe("Widgets for developers");
    expect(r.text).toContain("best widget toolkit");
    expect(r.text).not.toContain("ignore_me");
  });

  it("returns structured tier-4 'couldn't read' on server error — never throws", async () => {
    const r = await scrapeLadder(`http://local.test:${port}/nope`, testOpts);
    expect(r.tier).toBe(4);
    expect(r.error).toBeTruthy();
  });

  it("returns tier 4 for non-HTML content", async () => {
    const r = await scrapeLadder(`http://local.test:${port}/binary`, testOpts);
    expect(r.tier).toBe(4);
  });
});

describe("readProduct", () => {
  it("persists a Product scoped to the ambient identity", async () => {
    const out = await readProduct(
      { businessId: "biz_scrape" },
      `http://local.test:${port}/product`,
      testOpts,
    );
    expect(out.productId).toBeTruthy();
    const row = await prisma.product.findUnique({ where: { id: out.productId } });
    expect(row?.businessId).toBe("biz_scrape");
    expect(row?.title).toBe("Acme Widgets");
  });
});
