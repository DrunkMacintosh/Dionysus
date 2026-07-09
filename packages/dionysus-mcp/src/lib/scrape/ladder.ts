import * as cheerio from "cheerio";
import { safeFetch, type SafeFetchOptions } from "../ssrf.js";

export type ScrapeResult = {
  tier: 1 | 2 | 3 | 4;
  url: string;
  title?: string;
  description?: string;
  text?: string;
  error?: string;
};

const TEXT_CAP = 5000;

export async function scrapeLadder(
  url: string,
  fetchOpts?: SafeFetchOptions,
): Promise<ScrapeResult> {
  // Tier 1: fetch raw HTML (SSRF-guarded)
  let body: string;
  let contentType: string;
  try {
    const res = await safeFetch(url, fetchOpts);
    if (res.status < 200 || res.status >= 300) {
      return { tier: 4, url, error: `HTTP ${res.status}` };
    }
    body = res.body;
    contentType = res.contentType;
  } catch (e) {
    return { tier: 4, url, error: e instanceof Error ? e.message : String(e) };
  }
  if (!contentType.includes("html")) {
    return { tier: 4, url, error: `Not HTML (${contentType || "unknown content-type"})` };
  }

  // Tier 2: metadata
  const $ = cheerio.load(body);
  const title =
    $("title").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    undefined;
  const description =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    undefined;

  // Tier 3: visible text
  $("script, style, noscript, svg, nav, footer").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, TEXT_CAP) || undefined;

  if (text) return { tier: 3, url, title, description, text };
  if (title || description) return { tier: 2, url, title, description };
  return { tier: 1, url };
}
