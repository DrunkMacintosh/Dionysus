// Stage 6g Task 3 — the runOutreach pipeline: the Outreach/PR employee drafts the
// founder's PENDING pitch requests, each grounded in the target's actual page.
//
// FOUNDER-TARGETED ONLY (the anti-fabrication rule for contacts): an outreach target
// exists ONLY because the founder named it on /pitch. runOutreach drafts EXISTING
// requests; no model call ever invents, discovers, or proposes a target. Zero pending
// requests → zero model calls (the pending-check precedes everything, so a no-request
// night makes zero budget/fetch/model noise beyond one scoped query).
//
// PAGE-GROUNDED (the honesty core, the 6e discipline): a pitch whose
// personalizationEvidence is not a verbatim (whitespace-normalized, non-empty)
// substring of the freshly-fetched target page is fabricated familiarity — DROPPED
// before any write; the request stays undrafted and retries next night.
//
//   pending outreach-pitch requests (assetId null, oldest-first) — NONE → skipped, zero noise
//     → checkBudget (fail-closed, D28/D34 — BEFORE any fetch/model call, callers catch)
//     → cap the oldest MAX_PITCHES_PER_NIGHT (the remainder retries next night, reported)
//     → per request:
//         parse targetUrl/targetName from featuresJson (malformed → skip+log, never throw)
//         → FRESH scrapeLadder fetch (SSRF-guarded; unreadable → skip+log, NO model call,
//           the request stays undrafted → retries next night)
//         → ctx: a PLAIN instruction + a PLAIN own-product block (trusted own data)
//           + fence("target-page", text) — ONLY the target page is fenced (D20: it is
//           attacker-influenceable DATA; the own product is ours, trusted, plain)
//         → parsePitch (one harness retry)                             [T1 schema]
//         → GROUNDING: normalized evidence must be a NON-EMPTY verbatim substring of the
//           normalized page text, else DROPPED + logged (stays undrafted → retries)
//         → PERSIST a bound outreach-email asset {title: subject, body} + setActionAsset
//     → return ok { drafted, skipped, dropped, remaining }.
//
// Never-auto throughout: the action stays `proposed`, approvedAt null — the founder sends
// it by hand from their own mail client (spec: "Draft-only until a first-class email
// integration ships"). Identity is ambient (D27.1); every read/write is tenant-scoped.
// All model traffic is the injected Harness (D34). NOT MCP — a department pipeline
// (a direct import like runCro); the whitelist stays 11.
import type { Identity } from "dionysus-mcp/identity";
import { prisma } from "dionysus-mcp/db";
import { checkBudget } from "dionysus-mcp/tools/cost-budget";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import { scrapeLadder } from "dionysus-mcp/lib/scrape/ladder";
import type { SafeFetchOptions } from "dionysus-mcp/lib/ssrf";
import type { Harness } from "./llm/types.js";
import { loadPrompt } from "./prompts.js";
import { fence } from "./tools/fetch-page.js";
import { parsePitch, type PitchOutput } from "./pitch-schemas.js";

// The cap is per business per night: draft the oldest MAX; the remainder retries next
// night (reported, never silent). Keeps a burst of founder requests from a budget spike.
export const MAX_PITCHES_PER_NIGHT = 3;

export type OutreachDeps = { harness: Harness; models: { brain: string }; fetchOpts?: SafeFetchOptions };
export type OutreachResult =
  | { status: "ok"; drafted: string[]; skipped: number; dropped: number; remaining: number } // drafted = actionIds; skipped = unreadable/malformed this night; dropped = grounding failures; remaining = deferred beyond tonight's cap (retries next night, reported)
  | { status: "skipped"; reason: string };

// Whitespace-collapse + lowercase both sides so a verbatim quote grounds even across
// incidental spacing/case drift between the page and the model's echo (the 6e norm).
const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

// Parse a request's founder-supplied target from featuresJson. A malformed / target-less
// row yields null so the caller SKIPS it (logged) rather than throwing the whole night.
function parseTarget(featuresJson: string): { targetUrl: string; targetName: string } | null {
  try {
    const f = JSON.parse(featuresJson) as { targetUrl?: unknown; targetName?: unknown };
    if (typeof f.targetUrl !== "string" || !f.targetUrl) return null;
    if (typeof f.targetName !== "string" || !f.targetName) return null;
    return { targetUrl: f.targetUrl, targetName: f.targetName };
  } catch {
    return null;
  }
}

export async function runOutreach(identity: Identity, deps: OutreachDeps): Promise<OutreachResult> {
  // 1. PENDING FIRST (order is the contract). Proposed outreach-pitch requests not yet
  //    drafted (assetId null), oldest-first. NONE → honest skip with ZERO budget/fetch/
  //    model noise beyond this one scoped query — Dionysus never invents a target.
  const pending = await prisma.routeAction.findMany({
    where: { businessId: identity.businessId, status: "proposed", type: "outreach-pitch", assetId: null },
    orderBy: { createdAt: "asc" } });
  if (pending.length === 0) return { status: "skipped", reason: "no pitch requests pending" };

  // 2. D28/D34: fail closed BEFORE any fetch or model call (the model call is expensive).
  //    Runs AFTER the pending-check so a no-request night never trips the budget gate.
  const budget = await checkBudget(identity);
  if (!budget.allowed) throw new Error(`Outreach blocked: budget exhausted or unavailable (${budget.reason ?? "over cap"}).`);

  // 3. Cap: draft only the oldest MAX_PITCHES_PER_NIGHT tonight; any remainder stays
  //    pending (assetId null) and retries next night. The cap is reported, never silent.
  const batch = pending.slice(0, MAX_PITCHES_PER_NIGHT);
  const remainder = pending.length - batch.length;
  if (remainder > 0) {
    console.error(`outreach: ${remainder} pitch request(s) deferred beyond tonight's cap of ${MAX_PITCHES_PER_NIGHT} (oldest-first; they retry next night).`);
  }

  // 4. The latest own Product (scoped, newest) — TRUSTED own data, so its title/description
  //    goes into the ctx PLAIN (never fenced). Absent → a neutral descriptor; drafting proceeds
  //    (the pitch is still about the founder's product; the grounding is on the TARGET page).
  const product = await prisma.product.findFirst({
    where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
  const productBlock = `Your product: ${product?.title ?? "(no product on record)"}${product?.description ? `\n${product.description}` : ""}`;

  const def = { name: "outreach", model: deps.models.brain,
    instructions: `${loadPrompt("reasoning-standard")}\n\n${loadPrompt("outreach")}`, tools: [] };

  const drafted: string[] = [];
  let skipped = 0;
  let dropped = 0;

  for (const request of batch) {
    // 4a. Parse the founder-supplied target. Malformed / target-less → skip + log, NEVER
    //     throw (one bad request can't sink the whole night's outreach section).
    const target = parseTarget(request.featuresJson);
    if (!target) {
      skipped++;
      console.error(`outreach: skipped request ${request.id} — malformed or target-less features.`);
      continue;
    }

    // 4b. FRESH fetch of the target page (SSRF-guarded). Unreadable → skip + log with NO
    //     model call (never a fabricated pitch about a page we couldn't read); the request
    //     stays undrafted and retries next night when the page may be reachable again.
    const result = await scrapeLadder(target.targetUrl, deps.fetchOpts);
    if (result.error || !result.text) {
      skipped++;
      console.error(`outreach: skipped request ${request.id} — target page unreadable (retries next night).`);
      continue;
    }

    // 4c. Build ctx: the instruction + the own-product block are TRUSTED (plain); ONLY the
    //     target page is attacker-influenceable DATA, so it ALONE is fenced (D20).
    const ctx = [
      `Draft a pitch to "${target.targetName}" for the product below.`,
      productBlock,
      fence("target-page", result.text),
    ].join("\n");

    // 4d. Draft with one harness retry. A malformed output (after the retry) throws — ISOLATE
    //     it per request: one poison pitch must never abort the batch (head-of-line blocking).
    //     Because the cap re-selects the OLDEST first every night, a persistently-poison oldest
    //     request would otherwise starve its siblings indefinitely. Skip + log + continue; the
    //     request stays undrafted (assetId null, status proposed) → it retries next night, and
    //     nothing partial is persisted (the throw is before any write). (Budget throws stay
    //     fail-closed — they happen before the loop, untouched.)
    let pitch: PitchOutput;
    try {
      const raw = await deps.harness.runAgent(def, ctx);
      pitch = await parsePitch(raw.finalOutput, async (err) => (await deps.harness.runAgent(def, err)).finalOutput);
    } catch (error: unknown) {
      skipped++;
      const reason = error instanceof Error ? error.message : "unknown error";
      console.error(`outreach: skipped request ${request.id} — model step failed: ${reason} (retries next night).`);
      continue;
    }

    // 4e. GROUNDING (the honesty core): the personalizationEvidence must be a NON-EMPTY
    //     verbatim (normalized) substring of the freshly-fetched page. An empty/whitespace
    //     quote grounds nothing (`includes("")` trivially matches — a fabrication too).
    //     Fabricated familiarity is DROPPED before any write; the request stays undrafted.
    const evidenceNorm = norm(pitch.personalizationEvidence);
    const pageNorm = norm(result.text);
    if (!(evidenceNorm.length > 0 && pageNorm.includes(evidenceNorm))) {
      dropped++;
      console.error(`outreach: dropped request ${request.id} — personalizationEvidence is not verbatim on the target page (fabricated familiarity).`);
      continue;
    }

    // 4f. PERSIST a bound outreach-email asset (title = subject, body = the pitch) + link it.
    //     Never-auto: the action stays proposed; the founder sends it by hand.
    const { assetId } = await persistAsset(identity, {
      channel: "outreach-email", kind: "outreach-pitch",
      content: { title: pitch.subject, body: pitch.body },
      routeActionId: request.id });
    await setActionAsset(identity, request.id, assetId);
    drafted.push(request.id);
  }

  return { status: "ok", drafted, skipped, dropped, remaining: remainder };
}
