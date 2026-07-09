import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { computeCostUsd } from "../lib/pricing.js";

export async function recordCost(
  identity: Identity,
  args: { model: string; inputTokens: number; outputTokens: number; note?: string },
): Promise<{ llmCallId: string; costUsd: number | null }> {
  const costUsd = computeCostUsd(args.model, args.inputTokens, args.outputTokens);
  const row = await prisma.llmCall.create({
    data: {
      businessId: identity.businessId,
      model: args.model,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      costUsd,
      note: args.note ?? null,
    },
  });
  return { llmCallId: row.id, costUsd };
}

export async function checkBudget(identity: Identity): Promise<{
  allowed: boolean;
  tokensUsedToday: number;
  maxTokensPerDay: number;
  reason?: string;
}> {
  const business = await prisma.business.findUnique({
    where: { id: identity.businessId },
  });
  if (!business) {
    return {
      allowed: false,
      tokensUsedToday: 0,
      maxTokensPerDay: 0,
      reason: "Unknown business — failing closed (spec §14).",
    };
  }
  const startOfDayUtc = new Date();
  startOfDayUtc.setUTCHours(0, 0, 0, 0);
  const agg = await prisma.llmCall.aggregate({
    where: { businessId: identity.businessId, ts: { gte: startOfDayUtc } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  const tokensUsedToday =
    (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
  const allowed = tokensUsedToday < business.maxTokensPerDay;
  return {
    allowed,
    tokensUsedToday,
    maxTokensPerDay: business.maxTokensPerDay,
    ...(allowed ? {} : { reason: "Daily token budget exhausted." }),
  };
}
