import { z } from "zod";
import { parseWithRetry } from "./schemas.js";

export const PitchSchema = z.object({
  subject: z.string().min(1),                  // the email subject line
  body: z.string().min(20),                    // the pitch email body (the founder sends it)
  personalizationEvidence: z.string().min(8),  // a VERBATIM quote from the target's page (the grounding anchor)
});
export type PitchOutput = z.infer<typeof PitchSchema>;

export function parsePitch(raw: string, retryFn: (err: string) => Promise<string>): Promise<PitchOutput> {
  return parseWithRetry(PitchSchema, raw, retryFn);
}
