import { z } from "zod";
import { parseWithRetry } from "./schemas.js";

export const PredictionSchema = z.object({
  personas: z.array(z.object({
    persona: z.string().min(1), reaction: z.string().min(1), score: z.number().min(0).max(10),
  })).min(3).max(7),
  engagementScore: z.number().min(0).max(10),
  verdict: z.string().min(1),
  topConcerns: z.array(z.string()).max(5),
  confidence: z.number().min(0).max(1),
});
export type Prediction = z.infer<typeof PredictionSchema>;

export function parsePrediction(raw: string, retryFn: (err: string) => Promise<string>): Promise<Prediction> {
  return parseWithRetry(PredictionSchema, raw, retryFn);
}
