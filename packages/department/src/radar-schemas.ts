import { z } from "zod";
import { parseWithRetry } from "./schemas.js";

/** Hard cap on persisted observations per night. Over-cap output is TRUNCATED (strongest-first
 * per the prompt), never rejected — a hard-fail would throw the whole night away (4e bundle item). */
export const MAX_OBSERVATIONS = 8;

export const ObservationsSchema = z.object({
  observations: z.array(z.object({
    title: z.string().min(1),
    body: z.string().min(1),
    sourceUrl: z.string().url(),
    relevance: z.number().min(0).max(10),
    confidence: z.number().min(0).max(1),
  })).transform((obs) => obs.slice(0, MAX_OBSERVATIONS)),
});
export type ObservationsOutput = z.infer<typeof ObservationsSchema>;

export function parseObservations(raw: string, retryFn: (err: string) => Promise<string>): Promise<ObservationsOutput> {
  return parseWithRetry(ObservationsSchema, raw, retryFn);
}
