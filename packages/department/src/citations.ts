import type { Claim } from "./schemas.js";

/**
 * Citation-entailment checker (spec §6.2 guardrail).
 *
 * Every EXTRACTED claim carries a real source URL. Here we fetch that source
 * and ask a judge whether it actually supports the claim. If the source can't
 * be fetched OR the judge says "not supported", the claim is DOWNGRADED to
 * INFERRED — kept in place with its sourceUrl retained for audit, never dropped
 * and never fabricated. INFERRED claims pass through untouched.
 *
 * Fail toward INFERRED: a fetch that throws is treated as unsupported (an
 * unverifiable claim must never be presented as fact). `judgeFn` is only
 * called for EXTRACTED claims whose source fetched successfully.
 */
export async function checkCitations(
  claims: Claim[],
  deps: {
    fetchFn: (url: string) => Promise<string>;
    judgeFn: (claim: string, sourceText: string) => Promise<boolean>;
  },
): Promise<{ claims: Claim[]; downgraded: number }> {
  let downgraded = 0;
  const out: Claim[] = [];
  for (const c of claims) {
    if (c.kind !== "EXTRACTED" || !c.sourceUrl) { out.push(c); continue; }
    let supported = false;
    try {
      const source = await deps.fetchFn(c.sourceUrl);
      supported = await deps.judgeFn(c.text, source);
    } catch {
      supported = false; // unfetchable source can never support a claim
    }
    if (supported) out.push(c);
    else { downgraded++; out.push({ ...c, kind: "INFERRED" }); }
  }
  return { claims: out, downgraded };
}
