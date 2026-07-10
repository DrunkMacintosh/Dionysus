import { z } from "zod";
import { parseWithRetry } from "./schemas.js";

export const ObservationsSchema = z.object({
  observations: z.array(z.object({
    title: z.string().min(1),
    body: z.string().min(1),
    sourceUrl: z.string().url(),
    relevance: z.number().min(0).max(10),
    confidence: z.number().min(0).max(1),
  })).max(8),
});
export type ObservationsOutput = z.infer<typeof ObservationsSchema>;

export function parseObservations(raw: string, retryFn: (err: string) => Promise<string>): Promise<ObservationsOutput> {
  return parseWithRetry(ObservationsSchema, raw, retryFn);
}
