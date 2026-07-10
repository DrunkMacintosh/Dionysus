import { describe, it, expect } from "vitest";
import { levenshtein } from "../src/lib/edit-distance.js";

describe("levenshtein", () => {
  it("identity is 0; empty-vs-string is the string length", () => {
    expect(levenshtein("draft", "draft")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });
  it("known distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("flaw", "lawn")).toBe(2);
    expect(levenshtein("Show HN: We built X", "Show HN: We built Y")).toBe(1);
  });
  it("symmetric on a sample", () => {
    expect(levenshtein("abcdef", "azced")).toBe(levenshtein("azced", "abcdef"));
  });
});
