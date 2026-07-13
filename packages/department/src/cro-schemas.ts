import { z } from "zod";
import { parseWithRetry } from "./schemas.js";

/** Hard cap on persisted conversion findings per page audit. Over-cap output is TRUNCATED
 * (highest-impact-first per the prompt), never rejected — a hard-fail would throw the whole
 * audit away (the 6a truncate-not-reject lesson). */
export const MAX_CRO_FINDINGS = 5;

export const CroFindingsSchema = z.object({
  findings: z.array(z.object({
    issue: z.string().min(1),          // the conversion leak, one sentence
    evidence: z.string().min(8),        // a VERBATIM quote from the page (the grounding anchor)
    recommendation: z.string().min(1),  // the ready-to-apply fix
    snippet: z.string().optional(),     // optional copy/markup the founder can paste
  })).transform((f) => f.slice(0, MAX_CRO_FINDINGS)), // truncate-not-reject (the 6a lesson)
});
export type CroFindingsOutput = z.infer<typeof CroFindingsSchema>;

export function parseCroFindings(raw: string, retryFn: (err: string) => Promise<string>): Promise<CroFindingsOutput> {
  return parseWithRetry(CroFindingsSchema, raw, retryFn);
}
