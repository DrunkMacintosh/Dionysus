import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { extractBrandSignals } from "../src/lib/brand.js";
import { extractBrand } from "../src/tools/extract-brand.js";
import { prisma } from "../src/db.js";
import type { LookupFn } from "../src/lib/ssrf.js";

describe("extractBrandSignals (pure)", () => {
  it("finds dominant colors as normalized hex, excluding near-white/black", () => {
    const css = [
      ".a{color:#FF6600}.b{background:#ff6600}.c{border-color:#F60}" +
      ".d{color:#112233}.e{color:#ffffff}.f{color:#000}",
    ];
    const { colors } = extractBrandSignals("", css);
    expect(colors[0]).toBe("#ff6600"); // 3 occurrences (#F60 expands)
    expect(colors).toContain("#112233");
    expect(colors).not.toContain("#ffffff");
    expect(colors).not.toContain("#000000");
  });

  it("finds font families, stripping quotes and generics", () => {
    const css = [`body{font-family:"Inter",-apple-system,sans-serif}h1{font-family:'Space Grotesk',serif}`];
    const { fonts } = extractBrandSignals("", css);
    expect(fonts).toContain("Inter");
    expect(fonts).toContain("Space Grotesk");
    expect(fonts).not.toContain("sans-serif");
    expect(fonts).not.toContain("serif");
  });

  it("also reads inline <style> blocks from the HTML", () => {
    const html = `<html><head><style>.x{color:#123abc}</style></head><body></body></html>`;
    const { colors } = extractBrandSignals(html, []);
    expect(colors).toContain("#123abc");
  });
});

describe("extractBrand (fetch + persist)", () => {
  let server: http.Server;
  let port: number;
  const localLookup: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
  const testOpts = { lookupFn: localLookup, __testAllowPrivate: true } as const;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><head><link rel="stylesheet" href="/site.css"><style>.i{color:#aa11bb}</style></head><body></body></html>`);
      } else if (req.url === "/site.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end(`.hero{background:#aa11bb;font-family:"Fira Sans",sans-serif}`);
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    await prisma.business.upsert({
      where: { id: "biz_brand" },
      create: { id: "biz_brand", name: "Brand Co" },
      update: {},
    });
  });

  afterAll(() => server.close());

  it("fetches linked same-origin stylesheets and persists a scoped BrandKit", async () => {
    const out = await extractBrand({ businessId: "biz_brand" }, `http://local.test:${port}/`, testOpts);
    expect(out.colors).toContain("#aa11bb");
    expect(out.fonts).toContain("Fira Sans");
    const row = await prisma.brandKit.findUnique({ where: { id: out.brandKitId } });
    expect(row?.businessId).toBe("biz_brand");
    expect(JSON.parse(row!.colorsJson)).toContain("#aa11bb");
  });
});
