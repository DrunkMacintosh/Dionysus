import { z } from "zod";
import { parseWithRetry } from "./schemas.js";

export const DraftSchema = z.object({
  channel: z.string().min(1),
  kind: z.string().min(1),
  content: z.object({ title: z.string().optional(), body: z.string().min(1) }),
});
export type Draft = z.infer<typeof DraftSchema>;

export function parseDraft(raw: string, retryFn: (err: string) => Promise<string>): Promise<Draft> {
  return parseWithRetry(DraftSchema, raw, retryFn);
}
