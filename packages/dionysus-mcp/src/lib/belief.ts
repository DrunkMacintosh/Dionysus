// Stage 5c — the pure CRAFT-belief scoring core. NO DB, NO identity, NO Date.now():
// evidence + an injected `now` in, a bounded confidence + honest labeled stance out.
//
// A 5c belief is about CRAFT — what drafts this founder accepts as-is — derived from
// real founder-acceptance behavior. It is NEVER a performance/market claim and NEVER
// carries a fabricated metric (measured-outcome beliefs are 5d). The summary reports
// raw COUNTS only. Honest guards (spec §16): an evidence-count threshold below which a
// belief is labeled low-confidence, and recency decay so stale evidence weighs less.

/** The whitelisted craft feature dimensions a belief may key on (spec §16 line 189). */
export const BELIEF_FEATURE_DIMS = ["channel", "format", "hook", "timing", "audience", "mode"] as const;

/** Below this many acceptance events, a belief is labeled low-confidence ("still learning"). */
export const MIN_EVIDENCE_FOR_CONFIDENCE = 3;

/** Recency half-life: evidence this many days old contributes half-weight to confidence. */
export const RECENCY_HALFLIFE_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type FeatureEvidence = {
  acceptedAsIs: number;
  acceptedWithEdits: number;
  rejected: number;
  lastEventAt: Date | null;
};

export type BeliefStance = "positive" | "negative" | "neutral";

export type CraftBelief = {
  confidence: number;
  stance: BeliefStance;
  lowConfidence: boolean;
  summary: string;
};

/**
 * Canonical key from the whitelisted craft dims PRESENT (string-valued) in featuresJson,
 * sorted so key order in the JSON is irrelevant. `""` when none present / unparseable.
 */
export function canonicalFeatureKey(featuresJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(featuresJson);
  } catch {
    return "";
  }
  if (parsed === null || typeof parsed !== "object") return "";
  const record = parsed as Record<string, unknown>;
  const parts: string[] = [];
  for (const dim of BELIEF_FEATURE_DIMS) {
    const value = record[dim];
    if (typeof value === "string" && value.length > 0) parts.push(`${dim}=${value}`);
  }
  return parts.sort().join("&");
}

/** Recency weight in (0,1]: 1 for a same-day event, halving every RECENCY_HALFLIFE_DAYS. */
function recencyWeight(lastEventAt: Date | null, now: Date): number {
  if (!lastEventAt) return 0;
  const ageDays = Math.max(0, (now.getTime() - lastEventAt.getTime()) / MS_PER_DAY);
  return Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS);
}

/**
 * Score a feature's founder-acceptance evidence into a bounded confidence + honest stance.
 * positive = tends to accept as-is; negative = tends to reject / heavily edit; neutral = no
 * signal. Confidence scales with the evidence count (saturating), the accept/reject balance,
 * and recency — and is HARD-CAPPED low while evidence is thin (honest low-confidence label).
 */
export function scoreCraftBelief(evidence: FeatureEvidence, now: Date): CraftBelief {
  const { acceptedAsIs, acceptedWithEdits, rejected } = evidence;
  const total = acceptedAsIs + acceptedWithEdits + rejected;
  const lowConfidence = total < MIN_EVIDENCE_FOR_CONFIDENCE;

  if (total === 0) {
    return { confidence: 0, stance: "neutral", lowConfidence: true, summary: "Still learning — no drafts yet." };
  }

  const positive = acceptedAsIs + 0.5 * acceptedWithEdits;
  const net = (positive - rejected) / total;
  const stance: BeliefStance = net > 0.15 ? "positive" : net < -0.15 ? "negative" : "neutral";

  const evidenceWeight = total / (total + MIN_EVIDENCE_FOR_CONFIDENCE);
  const recency = recencyWeight(evidence.lastEventAt, now);
  let confidence = Math.abs(net) * evidenceWeight * recency;
  if (lowConfidence) confidence = Math.min(confidence, 0.4);
  confidence = Math.max(0, Math.min(1, confidence));

  const counts = `${acceptedAsIs} accepted as-is, ${acceptedWithEdits} edited, ${rejected} rejected`;
  const lead =
    stance === "positive"
      ? "Tends to approve these drafts with little editing"
      : stance === "negative"
        ? "Tends to reject or heavily edit these drafts"
        : "Mixed signal so far";
  const tail = lowConfidence ? " Still learning — low confidence." : "";
  const summary = `${lead} (${counts}).${tail}`;

  return { confidence, stance, lowConfidence, summary };
}
