import type { Identity } from "../identity.js";
import { checkBudget } from "../tools/cost-budget.js";

export type GateErrorBody = {
  error: {
    type: string;
    message: string;
    tokensUsedToday?: number;
    maxTokensPerDay?: number;
  };
};

export type GateResult =
  | { ok: true }
  | { ok: false; status: number; body: GateErrorBody };

type CheckFn = typeof checkBudget;

export async function gateBudget(
  identity: Identity,
  checkFn: CheckFn = checkBudget,
): Promise<GateResult> {
  let budget: Awaited<ReturnType<CheckFn>>;
  try {
    budget = await checkFn(identity);
  } catch (e) {
    // Log the real detail server-side; never echo DB internals to the client.
    console.error(
      JSON.stringify({
        evt: "gateway:budget_check_error",
        businessId: identity.businessId,
        err: String(e),
      }),
    );
    return {
      ok: false,
      status: 503,
      body: {
        error: {
          type: "budget_check_failed",
          message: "Budget check failed — failing closed (spec §14).",
        },
      },
    };
  }
  // Strict + null-safe: only an on-contract `allowed === true` passes; any
  // off-contract truthy value or null result falls through to the 429 block.
  if (budget && budget.allowed === true) return { ok: true };
  return {
    ok: false,
    status: 429,
    body: {
      error: {
        type: "budget_exhausted",
        message: budget?.reason ?? "Daily token budget exhausted.",
        tokensUsedToday: budget?.tokensUsedToday,
        maxTokensPerDay: budget?.maxTokensPerDay,
      },
    },
  };
}
