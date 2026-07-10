import { describe, it, expect } from "vitest";
import {
  normalizeForMatch,
  verificationSnippet,
  htmlContainsSnippet,
} from "../src/lib/send-verify.js";

describe("normalizeForMatch", () => {
  it("lowercases, collapses runs of whitespace/newlines/tabs, and trims", () => {
    expect(normalizeForMatch("  Show\t\tHN:\n\n  We  built   X  ")).toBe(
      "show hn: we built x",
    );
    expect(normalizeForMatch("")).toBe("");
    expect(normalizeForMatch("   ")).toBe("");
  });
});

describe("verificationSnippet", () => {
  it("prefers the normalized title when it is meaningful (>= 8 chars)", () => {
    expect(
      verificationSnippet({
        title: "Show HN: We built X",
        body: "some throwaway body text that should be ignored",
      }),
    ).toBe("show hn: we built x");
    // boundary: exactly 8 normalized chars still chooses the title
    expect(verificationSnippet({ title: "New Post", body: "the body" })).toBe(
      "new post",
    );
  });

  it("falls back to the first 60 chars of the body when the title is too short (measured after normalization)", () => {
    // Raw title is 9 chars but normalizes to 2 -> too short -> body wins.
    expect(
      verificationSnippet({
        title: "   Hi   ",
        body: "This is the launch announcement",
      }),
    ).toBe("this is the launch announcement");
    // Long body is capped at 60 chars.
    const snippet = verificationSnippet({
      title: "",
      body: "announcing our new product line for the summer season now today",
    });
    expect(snippet.length).toBe(60);
    expect(snippet).toBe(
      "announcing our new product line for the summer season now to",
    );
  });

  it("returns an empty string when both title and body are empty or missing", () => {
    expect(verificationSnippet({})).toBe("");
    expect(verificationSnippet({ title: "", body: "" })).toBe("");
    expect(verificationSnippet({ title: "   ", body: "   " })).toBe("");
  });
});

describe("htmlContainsSnippet", () => {
  it("returns false for an empty snippet regardless of the html", () => {
    expect(htmlContainsSnippet("<p>anything at all</p>", "")).toBe(false);
    expect(htmlContainsSnippet("", "")).toBe(false);
  });

  it("matches a snippet whose words span multiple inline tags", () => {
    // Raw containment can't see this (the <em> splits the phrase); the cheerio
    // text-extract path joins the text nodes.
    const html = "<h1>Show <em>HN</em>: We built X</h1>";
    expect(htmlContainsSnippet(html, "show hn: we built x")).toBe(true);
    expect(htmlContainsSnippet(html, "show hn: we shipped x")).toBe(false);
  });

  it("decodes HTML entities via the cheerio path (raw containment would miss it)", () => {
    const html = "<p>Tom &amp; Jerry &lt;3 fun</p>";
    // Proof the cheerio path is required: raw html still carries &amp;/&lt;.
    expect(normalizeForMatch(html).includes("tom & jerry <3 fun")).toBe(false);
    expect(htmlContainsSnippet(html, "tom & jerry <3 fun")).toBe(true);
  });

  it("collapses whitespace/newlines in the extracted text before matching", () => {
    const html = "<article><p>Show   HN:\n\n\tWe  built   X</p></article>";
    expect(htmlContainsSnippet(html, "show hn: we built x")).toBe(true);
  });

  it("falls back to raw containment on broken markup without throwing", () => {
    // The snippet lives only in a comment (excluded from cheerio .text()) inside
    // deeply-broken markup: the cheerio path can't match it, so the raw-containment
    // fallback must — and the pathological input must never throw.
    const broken = "<div><span><<>></span><!-- verified-token alpha --></div>";
    expect(() => htmlContainsSnippet(broken, "verified-token alpha")).not.toThrow();
    expect(htmlContainsSnippet(broken, "verified-token alpha")).toBe(true);
    expect(htmlContainsSnippet(broken, "token-not-present")).toBe(false);
  });
});
