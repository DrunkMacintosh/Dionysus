/** USD per 1,000,000 tokens. Unknown models are intentionally absent —
 *  computeCostUsd returns null for them (no fabricated numbers, spec §11). */
export const PRICES: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  "claude-sonnet-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  // Nous / NVIDIA-free endpoints: metered as zero-cost until real pricing lands
  "nous-portal-free": { inputPerMTok: 0, outputPerMTok: 0 },
  // D34 dev brain (free NVIDIA hosted tier): priced at zero, not unknown — a
  // known-free model must not read as "unpriced" (which would return null cost).
  "nvidia/nemotron-3-super-120b-a12b": { inputPerMTok: 0, outputPerMTok: 0 },
};
