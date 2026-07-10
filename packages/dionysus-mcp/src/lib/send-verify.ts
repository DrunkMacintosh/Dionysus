import * as cheerio from "cheerio";

/** Lowercase, collapse all whitespace runs to single spaces, and trim. */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The distinctive text a public page must carry to count as the approved post (§3: verify, never assume). */
export function verificationSnippet(content: {
  title?: string;
  body?: string;
}): string {
  const title = normalizeForMatch(content.title ?? "");
  if (title.length >= 8) return title;
  const body = normalizeForMatch(content.body ?? "");
  return body.slice(0, 60).trim();
}

/**
 * True when the approved snippet appears in the page. Uses cheerio to extract
 * rendered text (so entity-decoded, cross-tag phrases match), wrapped in a
 * try/catch — the stage-1 tier-4 lesson that cheerio can blow up (RangeError)
 * on pathological HTML — with a raw-containment fallback. Empty snippet -> false.
 */
export function htmlContainsSnippet(html: string, snippet: string): boolean {
  if (!snippet) return false;
  try {
    const $ = cheerio.load(html);
    if (normalizeForMatch($.root().text()).includes(snippet)) return true;
  } catch {
    /* stage-1 lesson: parser blowups must not escape — fall through to raw */
  }
  return normalizeForMatch(html).includes(snippet);
}
