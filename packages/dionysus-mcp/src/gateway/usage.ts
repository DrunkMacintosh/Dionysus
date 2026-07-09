export type GatewayUsage = {
  inputTokens: number;
  outputTokens: number;
  usageMissing: boolean;
};

// Frozen: this singleton is returned by reference, so freezing turns any
// downstream mutation into a thrown error (ESM is strict mode) instead of
// silent cross-request ledger corruption.
const MISSING: GatewayUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  usageMissing: true,
});

function fromUsageObject(usage: unknown): GatewayUsage | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = u["prompt_tokens"];
  const output = u["completion_tokens"];
  // Only non-negative integers are real token counts; negatives/floats degrade
  // to usageMissing rather than poisoning the ledger with fabricated numbers.
  const isValid =
    Number.isInteger(input) &&
    (input as number) >= 0 &&
    Number.isInteger(output) &&
    (output as number) >= 0;
  if (!isValid) return null;
  return { inputTokens: input as number, outputTokens: output as number, usageMissing: false };
}

export function usageFromJson(body: unknown): GatewayUsage {
  if (typeof body !== "object" || body === null) return MISSING;
  return fromUsageObject((body as Record<string, unknown>)["usage"]) ?? MISSING;
}

/** Line-buffered scanner over SSE text. Keeps the LAST usage object seen
 *  (OpenAI include_usage sends it in the final data chunk before [DONE]). */
export function createSseUsageScanner(): {
  push(text: string): void;
  result(): GatewayUsage;
} {
  let buffer = "";
  let captured: GatewayUsage | null = null;

  function scanLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]" || payload === "") return;
    try {
      const obj = JSON.parse(payload) as Record<string, unknown>;
      const usage = fromUsageObject(obj["usage"]);
      if (usage) captured = usage;
    } catch {
      // partial or non-JSON data line — ignore; fail toward usageMissing
    }
  }

  return {
    push(text: string): void {
      buffer += text;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        scanLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    result(): GatewayUsage {
      if (buffer.length > 0) {
        scanLine(buffer); // flush trailing line without newline
        buffer = "";
      }
      return captured ?? MISSING;
    },
  };
}
