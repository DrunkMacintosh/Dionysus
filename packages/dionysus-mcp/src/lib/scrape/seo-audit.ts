// Stage 6h Task 1 — deterministic on-page SEO/AEO audit (D25, spec §employees).
// Every finding is a machine-checked FACT of the fetched page: evidence is a
// verbatim value read from the HTML (200-char cap), the literal "absent", or the
// literal "unreachable"; advice comes from the constant map below. No model is
// involved anywhere in this file — fabrication is impossible by construction.
import * as cheerio from "cheerio";
import { safeFetch, type SafeFetchOptions } from "../ssrf.js";

export type SeoFinding = {
  check: string;
  status: "pass" | "warn" | "fail";
  evidence: string;
  advice: string;
};
export type SeoAuditResult =
  | { ok: true; findings: SeoFinding[] }
  | { ok: false; error: string };

const EVIDENCE_CAP = 200;
const cap = (s: string): string => (s.length > EVIDENCE_CAP ? s.slice(0, EVIDENCE_CAP) : s);

// Hardcoded advice — deterministic constants, never generated.
const ADVICE: Record<string, string> = {
  "title": "Add a <title> of 10-60 characters — it is the search result headline.",
  "title-length": "Keep the <title> between 10 and 60 characters so it displays untruncated.",
  "meta-description": "Add a meta description of 50-160 characters — it is the search result snippet.",
  "meta-description-length": "Keep the meta description between 50 and 160 characters.",
  "h1": "Add exactly one <h1> stating what the page is about.",
  "h1-multiple": "Use exactly one <h1>; demote the others to <h2>.",
  "canonical": "Add a <link rel=\"canonical\"> to prevent duplicate-content dilution.",
  "og-title": "Add og:title so shares render a proper card.",
  "og-description": "Add og:description so shares render a proper card.",
  "json-ld": "Add schema.org JSON-LD — AI assistants and rich results rely on structured data.",
  "json-ld-invalid": "Fix the JSON-LD block — it is present but not valid JSON.",
  "viewport": "Add a viewport meta tag — mobile rendering affects ranking.",
  "robots-txt": "Add a robots.txt so crawlers know what to index.",
  "sitemap-xml": "Add a sitemap.xml so crawlers discover every page.",
  "llms-txt": "Add an llms.txt — AEO: AI assistants look for it when citing sources.",
};

function finding(check: string, status: "pass" | "warn" | "fail", evidence: string, adviceKey?: string): SeoFinding {
  return { check, status, evidence: cap(evidence), advice: status === "pass" ? "" : ADVICE[adviceKey ?? check] ?? "" };
}

export async function auditPageSeo(url: string, fetchOpts?: SafeFetchOptions): Promise<SeoAuditResult> {
  // The page itself: unreadable → the audit honestly does not exist (ok:false).
  let body: string;
  try {
    const res = await safeFetch(url, fetchOpts);
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `HTTP ${res.status}` };
    if (!res.contentType.toLowerCase().includes("html")) return { ok: false, error: `Not HTML (${res.contentType || "unknown content-type"})` };
    body = res.body;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const findings: SeoFinding[] = [];
  try {
    const $ = cheerio.load(body);

    // 1. title — present + 10-60 chars.
    const title = $("title").first().text().trim();
    if (!title) findings.push(finding("title", "fail", "absent"));
    else if (title.length < 10 || title.length > 60) findings.push(finding("title", "warn", `"${title}" (${title.length} chars)`, "title-length"));
    else findings.push(finding("title", "pass", `"${title}"`));

    // 2. meta description — present + 50-160 chars.
    const desc = $('meta[name="description"]').attr("content")?.trim() ?? "";
    if (!desc) findings.push(finding("meta-description", "fail", "absent"));
    else if (desc.length < 50 || desc.length > 160) findings.push(finding("meta-description", "warn", `"${desc}" (${desc.length} chars)`, "meta-description-length"));
    else findings.push(finding("meta-description", "pass", `"${desc}"`));

    // 3. h1 — exactly one.
    const h1s = $("h1");
    if (h1s.length === 0) findings.push(finding("h1", "fail", "absent"));
    else if (h1s.length > 1) findings.push(finding("h1", "warn", `${h1s.length} h1 elements`, "h1-multiple"));
    else findings.push(finding("h1", "pass", `"${h1s.first().text().trim()}"`));

    // 4. canonical.
    const canonical = $('link[rel="canonical"]').attr("href")?.trim() ?? "";
    findings.push(canonical ? finding("canonical", "pass", canonical) : finding("canonical", "warn", "absent"));

    // 5-6. og:title / og:description.
    const ogTitle = $('meta[property="og:title"]').attr("content")?.trim() ?? "";
    findings.push(ogTitle ? finding("og-title", "pass", `"${ogTitle}"`) : finding("og-title", "warn", "absent"));
    const ogDesc = $('meta[property="og:description"]').attr("content")?.trim() ?? "";
    findings.push(ogDesc ? finding("og-description", "pass", `"${ogDesc}"`) : finding("og-description", "warn", "absent"));

    // 7. JSON-LD — present AND parseable (AEO/schema.org).
    const ldBlocks = $('script[type="application/ld+json"]');
    if (ldBlocks.length === 0) findings.push(finding("json-ld", "warn", "absent"));
    else {
      const parsedTypes: string[] = []; let invalid = false;
      ldBlocks.each((_, el) => {
        try {
          const parsed: unknown = JSON.parse($(el).text());
          const t = (parsed as { "@type"?: unknown })?.["@type"];
          if (typeof t === "string") parsedTypes.push(t);
        } catch { invalid = true; }
      });
      if (invalid) findings.push(finding("json-ld", "fail", "unparseable JSON-LD", "json-ld-invalid"));
      else findings.push(finding("json-ld", "pass", parsedTypes.length > 0 ? `@type: ${parsedTypes.join(", ")}` : "valid JSON-LD"));
    }

    // 8. viewport.
    const viewport = $('meta[name="viewport"]').attr("content")?.trim() ?? "";
    findings.push(viewport ? finding("viewport", "pass", viewport) : finding("viewport", "warn", "absent"));
  } catch (e) {
    // Parser blowup on adversarial HTML → the audit honestly does not exist.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  // 9-11. Well-known same-origin files. The page proved reachable above, so a
  // failure here is the file's own absence/unreachability — a warn, never a throw.
  for (const [check, path] of [["robots-txt", "/robots.txt"], ["sitemap-xml", "/sitemap.xml"], ["llms-txt", "/llms.txt"]] as const) {
    let evidence = "absent"; let status: "pass" | "warn" = "warn";
    try {
      const res = await safeFetch(new URL(path, url).toString(), fetchOpts);
      if (res.status >= 200 && res.status < 300) { status = "pass"; evidence = `HTTP ${res.status}`; }
    } catch { evidence = "unreachable"; }
    findings.push(finding(check, status, evidence));
  }

  return { ok: true, findings };
}
