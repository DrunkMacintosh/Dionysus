import * as cheerio from "cheerio";

/** Lowercase, collapse all whitespace runs to single spaces, and trim. */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The distinctive text a public page must carry to count as the approved post (§3: verify, never assume).
 * NOTE: a short/generic body snippet may collide with unrelated page copy — guaranteeing the snippet is
 * distinctive enough to be a reliable verification key is the CALLER's concern (Task 4), not this lib's.
 */
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
 * True when the approved snippet appears in the page's VISIBLE posted content.
 * Uses cheerio to extract rendered text (so entity-decoded, cross-tag phrases
 * match), first stripping never-visible tags (script/style/noscript/template —
 * mirroring scrape/ladder.ts's strip) so a match in a <script>, comment, meta,
 * or attribute cannot masquerade as a verified post. On valid HTML that parses,
 * a non-match returns FALSE — it does NOT fall through to raw containment.
 * Empty snippet -> false.
 */
export function htmlContainsSnippet(html: string, snippet: string): boolean {
  if (!snippet) return false;
  try {
    const $ = cheerio.load(html);
    $("script, style, noscript, template").remove();
    return normalizeForMatch($.root().text()).includes(snippet);
  } catch {
    // stage-1 tier-4 lesson: a cheerio parser blowup (RangeError on pathological
    // HTML) must not escape. Raw containment here is a parser-blowup rescue ONLY,
    // never the happy-path matcher — on valid HTML a comment/attribute/script
    // match must NOT count as verified, so this line is unreachable when load()
    // succeeds.
    return normalizeForMatch(html).includes(snippet);
  }
}
