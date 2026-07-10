import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import type { Identity } from "../identity.js";
import { assertContentBound, startExecution, completeExecution } from "./lifecycle.js";
import { safeFetch, type SafeFetchOptions } from "../lib/ssrf.js";
import { verificationSnippet, htmlContainsSnippet } from "../lib/send-verify.js";

// ---------------------------------------------------------------------------
// submitVerifiedSend — D29 at the publish moment; §3 honesty.
//
// NOT MCP-registered, and it must stay that way (D27.2 spirit: no agent-
// assertable send or outcome). An agent can never claim a post happened — this
// closes the loop from the OUTSIDE by fetching the real public URL and proving
// the approved content is actually live before recording verifiedAt/outcome.
//
// The FLOW ORDER below is the contract (see brief): the publish-moment hash
// gate runs BEFORE the network is touched (a tampered binding never reaches
// safeFetch); verification writes land while the action is STILL executing and
// completeExecution is LAST, so a crash mid-way leaves a retryable `executing`
// row with postedUrl recorded and verifiedAt null — never an `executed` action
// missing its verification fields.
// ---------------------------------------------------------------------------

export type SubmitVerifiedSendInput = { routeActionId: string; postedUrl: string };
export type SubmitVerifiedSendResult = { runId: string; verifiedAt: Date; outcome: "verified" };

function parseObject(json: string): Record<string, unknown> {
  // Defensive parse (the 4b parsed-null lesson): JSON.parse("null") yields null
  // (typeof "object"), a bare number/string yields a non-object — both must fall
  // back to {} so property reads below never throw.
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
  } catch {
    /* fall through to {} */
  }
  return {};
}

export async function submitVerifiedSend(
  identity: Identity,
  input: SubmitVerifiedSendInput,
  fetchOpts?: SafeFetchOptions,
): Promise<SubmitVerifiedSendResult> {
  // 1. Parse + validate the URL (http/https only) BEFORE any DB or network effect.
  let url: URL;
  try {
    url = new URL(input.postedUrl);
  } catch {
    throw new Error(`Invalid postedUrl: "${input.postedUrl}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid postedUrl scheme "${url.protocol}": only http and https are allowed.`);
  }

  // 2. Scoped action load; the send is valid only from "approved" (first attempt)
  //    or "executing" (retry). Anything else -> /invalid transition/.
  const action = await prisma.routeAction.findFirst({
    where: { id: input.routeActionId, businessId: identity.businessId },
  });
  if (!action) {
    throw new Error(`RouteAction ${input.routeActionId} not found in this business scope.`);
  }
  if (action.status !== "approved" && action.status !== "executing") {
    throw new Error(
      `Invalid transition: RouteAction ${action.id} is "${action.status}"; a verified send requires status "approved" (first attempt) or "executing" (retry).`,
    );
  }

  // 3. Publish-moment content gate (D29): the bound asset must still hash to the
  //    approved contentHash. A tampered binding throws HERE — before the network.
  await assertContentBound(identity, action.id);

  // 4. First attempt: open a run. Retry (already executing): KEEP the runId — do
  //    NOT call startExecution again.
  let runId: string;
  if (action.status === "approved") {
    runId = "manual:" + randomBytes(8).toString("hex");
    await startExecution(identity, { routeActionId: action.id, runId });
  } else {
    if (!action.runId) {
      throw new Error(`RouteAction ${action.id} is executing without a runId — cannot retry a verified send.`);
    }
    runId = action.runId;
  }

  // 5. Record the posted URL — auditable even if verification then fails.
  await prisma.routeAction.updateMany({
    where: { id: action.id, businessId: identity.businessId },
    data: { postedUrl: input.postedUrl },
  });

  // 6. Load the bound asset (scoped), parse defensively, derive the snippet.
  const assetId = action.assetId;
  if (!assetId) throw new Error(`RouteAction ${action.id} has no bound asset.`);
  const asset = await prisma.asset.findFirst({ where: { id: assetId, businessId: identity.businessId } });
  if (!asset) throw new Error(`Asset ${assetId} not found in this business scope.`);
  const content = parseObject(asset.contentJson);
  const title = typeof content.title === "string" ? content.title : undefined;
  const body = typeof content.body === "string" ? content.body : undefined;
  const snippet = verificationSnippet({ title, body });
  if (!snippet) {
    throw new Error(`Cannot verify RouteAction ${action.id}: the approved content yields no verification snippet.`);
  }

  // 7. Fetch the public page through the SSRF-guarded fetcher.
  const res = await safeFetch(input.postedUrl, fetchOpts);

  // 8. Verify the approved snippet is present in the page's VISIBLE content. On a
  //    mismatch we throw and leave the action `executing` (retryable) — §3: we
  //    never record a verified outcome for a page we could not confirm.
  if (!htmlContainsSnippet(res.body, snippet)) {
    throw new Error(
      `Verification failed: the posted page does not contain the approved content for RouteAction ${action.id}. The action remains executing and is retryable once the live page carries the approved copy.`,
    );
  }

  // 9. Success: stamp verifiedAt/outcome while STILL executing, then complete LAST
  //    (crash-safe ordering — see file header).
  const verifiedAt = new Date();
  await prisma.routeAction.updateMany({
    where: { id: action.id, businessId: identity.businessId, status: "executing" },
    data: { verifiedAt, outcome: "verified" },
  });
  await completeExecution(identity, { routeActionId: action.id });

  return { runId, verifiedAt, outcome: "verified" };
}
