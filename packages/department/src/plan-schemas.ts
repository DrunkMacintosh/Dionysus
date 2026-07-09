import { z } from "zod";
import { parseWithRetry } from "./schemas.js";

export const RouteActionProposalSchema = z.object({
  employeeRole: z.string().min(1),
  type: z.string().min(1),
  rationale: z.string().min(1),
  features: z.record(z.unknown()).optional(),
});

export const RouteProposalSchema = z.object({
  waypoints: z.array(z.object({
    title: z.string().min(1),
    goal: z.string().min(1),
    actions: z.array(RouteActionProposalSchema).min(1),
  })).min(1).max(6),
});
export type RouteProposal = z.infer<typeof RouteProposalSchema>;

export function parseRouteProposal(raw: string, retryFn: (err: string) => Promise<string>): Promise<RouteProposal> {
  return parseWithRetry(RouteProposalSchema, raw, retryFn);
}
