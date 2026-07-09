import { describe, it, expect } from "vitest";
import { usageFromJson, createSseUsageScanner } from "../src/gateway/usage.js";

describe("usageFromJson", () => {
  it("extracts OpenAI-compatible usage", () => {
    const u = usageFromJson({ usage: { prompt_tokens: 120, completion_tokens: 45 } });
    expect(u).toEqual({ inputTokens: 120, outputTokens: 45, usageMissing: false });
  });

  it("marks usage missing (zeros, never estimates) when absent or malformed", () => {
    expect(usageFromJson({})).toEqual({ inputTokens: 0, outputTokens: 0, usageMissing: true });
    expect(usageFromJson(null)).toEqual({ inputTokens: 0, outputTokens: 0, usageMissing: true });
    expect(usageFromJson({ usage: { prompt_tokens: "x" } })).toEqual({
      inputTokens: 0, outputTokens: 0, usageMissing: true,
    });
  });

  it("degrades negative or fractional token counts to usage-missing", () => {
    expect(usageFromJson({ usage: { prompt_tokens: -5, completion_tokens: 3 } }))
      .toEqual({ inputTokens: 0, outputTokens: 0, usageMissing: true });
    expect(usageFromJson({ usage: { prompt_tokens: 1.5, completion_tokens: 3 } }))
      .toEqual({ inputTokens: 0, outputTokens: 0, usageMissing: true });
  });
});

describe("createSseUsageScanner", () => {
  it("captures usage from the final SSE chunk (OpenAI include_usage style)", () => {
    const s = createSseUsageScanner();
    s.push('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    s.push('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    s.push('data: {"usage":{"prompt_tokens":9,"completion_tokens":2},"choices":[]}\n\n');
    s.push("data: [DONE]\n\n");
    expect(s.result()).toEqual({ inputTokens: 9, outputTokens: 2, usageMissing: false });
  });

  it("handles a data line split across two pushes (line buffering)", () => {
    const s = createSseUsageScanner();
    s.push('data: {"usage":{"prompt_tokens":7,');
    s.push('"completion_tokens":3},"choices":[]}\n\ndata: [DONE]\n\n');
    expect(s.result()).toEqual({ inputTokens: 7, outputTokens: 3, usageMissing: false });
  });

  it("reports usage missing when the stream never carried usage", () => {
    const s = createSseUsageScanner();
    s.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    expect(s.result()).toEqual({ inputTokens: 0, outputTokens: 0, usageMissing: true });
  });
});
