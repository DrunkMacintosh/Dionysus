import { z } from "zod";

export const ClaimSchema = z.object({
  text: z.string().min(1),
  kind: z.enum(["EXTRACTED", "INFERRED"]),
  sourceUrl: z.string().url().optional(),
}).refine((c) => c.kind !== "EXTRACTED" || !!c.sourceUrl,
  { message: "EXTRACTED claims require a sourceUrl" });
export type Claim = z.infer<typeof ClaimSchema>;

export const HistorianOutputSchema = z.object({
  cases: z.array(z.object({
    name: z.string(), platform: z.string(), mode: z.string(),
    rank: z.number().int().min(1), claims: z.array(ClaimSchema),
  })).min(1).max(5),
});
export type HistorianOutput = z.infer<typeof HistorianOutputSchema>;

export const StrategistOutputSchema = z.object({
  historicalArc: z.unknown(), modernizedPlan: z.unknown(),
  insight: z.string().min(1), confidence: z.number().min(0).max(1),
});
export type StrategistOutput = z.infer<typeof StrategistOutputSchema>;

export async function parseWithRetry<T>(
  schema: z.ZodType<T>, raw: string, retryFn: (errorSummary: string) => Promise<string>,
): Promise<T> {
  const attempt = (s: string): T | null => {
    try { return schema.parse(JSON.parse(extractJson(s))); } catch { return null; }
  };
  const first = attempt(raw);
  if (first !== null) return first;
  const second = attempt(await retryFn("Output was not valid JSON matching the schema. Return ONLY corrected JSON."));
  if (second !== null) return second;
  throw new Error("Model output failed schema validation after one retry.");
}

function extractJson(s: string): string {
  const start = s.indexOf("{"); const end = s.lastIndexOf("}");
  return start >= 0 && end > start ? s.slice(start, end + 1) : s;
}
