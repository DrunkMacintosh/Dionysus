import * as cheerio from "cheerio";
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { extractBrandSignals, type BrandSignals } from "../lib/brand.js";
import { safeFetch, type SafeFetchOptions } from "../lib/ssrf.js";

const MAX_STYLESHEETS = 5;
const STYLESHEET_BYTE_CAP = 500_000;

export async function extractBrand(
  identity: Identity,
  url: string,
  fetchOpts?: SafeFetchOptions,
): Promise<{ brandKitId: string } & BrandSignals> {
  const page = await safeFetch(url, fetchOpts);
  const $ = cheerio.load(page.body);
  const base = new URL(page.finalUrl);

  const hrefs: string[] = [];
  $('link[rel="stylesheet"]').each((_i, el) => {
    const href = $(el).attr("href");
    if (href) hrefs.push(href);
  });

  const cssSources: string[] = [];
  for (const href of hrefs.slice(0, MAX_STYLESHEETS)) {
    let cssUrl: URL;
    try {
      cssUrl = new URL(href, base);
    } catch {
      continue;
    }
    if (cssUrl.origin !== base.origin) continue; // same-origin only
    try {
      const css = await safeFetch(cssUrl.toString(), {
        ...fetchOpts,
        maxBytes: STYLESHEET_BYTE_CAP,
      });
      cssSources.push(css.body);
    } catch {
      continue; // a failed stylesheet never fails the extraction
    }
  }

  const signals = extractBrandSignals(page.body, cssSources);
  const row = await prisma.brandKit.create({
    data: {
      businessId: identity.businessId,
      url,
      colorsJson: JSON.stringify(signals.colors),
      fontsJson: JSON.stringify(signals.fonts),
    },
  });
  return { brandKitId: row.id, ...signals };
}
