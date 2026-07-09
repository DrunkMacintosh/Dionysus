export type GatewayUsage = {
  inputTokens: number;
  outputTokens: number;
  usageMissing: boolean;
};

const MISSING: GatewayUsage = { inputTokens: 0, outputTokens: 0, usageMissing: true };

function fromUsageObject(usage: unknown): GatewayUsage | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const input = u["prompt_tokens"];
  const output = u["completion_tokens"];
  if (typeof input !== "number" || typeof output !== "number") return null;
  return { inputTokens: input, outputTokens: output, usageMissing: false };
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
