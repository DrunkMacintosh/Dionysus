// Stage 6k — the Videographer's generation phase (spec: two-gate + cost cap).
// GATE 1 already happened: only APPROVED storyboards are eligible. This pipeline
// turns each into a generated video via the connected video Integration + the
// injected transport, and lands the result as a NEW PROPOSED video-post action
// + asset — GATE 2 is the founder's normal approval, where they watch the actual
// video before anything is posted. Dionysus never claims the video matches the
// storyboard (it cannot verify video content) — the rationale says so.
//
//   eligibility FIRST (approved storyboard actions with no video-post yet; none →
//     skip, ZERO transport calls) → Integration kind "video" connected → transport
//     configured → checkBudget (fail-closed) → cap MAX_VIDEOS_PER_NIGHT oldest
//     first (remainder reported) → per item: getDecryptedConfig (unreadable →
//     skip+log, zero calls) → transport({endpoint, apiKey, prompt}) (error /
//     malformed / non-http(s) url → skip+log, stays ungenerated, RETRIES next
//     night) → persist proposed video-post + video asset → recordCost (D28: the
//     generation EVENT is ledgered; per-unit pricing unknown → costUsd null).
// The apiKey lives only between decrypt and the transport call — never logged,
// never persisted, never in a reason string. NOT MCP — whitelist stays 11.
import type { Identity } from "dionysus-mcp/identity";
import { prisma } from "dionysus-mcp/db";
import { checkBudget, recordCost } from "dionysus-mcp/tools/cost-budget";
import { getConnectedVideoSource, getDecryptedConfig } from "dionysus-mcp/tools/integration";
import { upsertRouteAction } from "dionysus-mcp/tools/plan";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";

export const MAX_VIDEOS_PER_NIGHT = 1;
export type VideoGenTransport = (input: { endpoint: string; apiKey: string; prompt: string }) =>
  Promise<{ url: string } | { error: string }>;
export type VideoGenDeps = { transport?: VideoGenTransport };
export type VideoGenResult =
  | { status: "ok"; generated: string[]; skippedItems: number; awaiting: number }
  | { status: "skipped"; reason: string };

const isHttpUrl = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

// The storyboard body ends with "Caption: ..." (draft-waypoint's formatStoryboard).
const captionOf = (body: string): string | null => {
  const captured = /\nCaption: (.+)$/s.exec(body)?.[1];
  return captured ? captured.trim() : null;
};

export async function runVideoGen(identity: Identity, deps: VideoGenDeps): Promise<VideoGenResult> {
  const businessId = identity.businessId;

  // 1. ELIGIBILITY FIRST (cheap DB reads; a night with nothing to generate makes
  // zero integration/budget/transport noise). Approved actions with a bound
  // STORYBOARD asset, minus those already generated (a video-post action whose
  // features carry this storyboardActionId, ANY status — idempotent across nights).
  const approved = await prisma.routeAction.findMany({
    where: { businessId, status: "approved", assetId: { not: null } }, orderBy: { createdAt: "asc" } });
  const eligible: Array<{ actionId: string; waypointId: string; channel: string; title: string; body: string }> = [];
  for (const action of approved) {
    if (!action.assetId) continue;
    const asset = await prisma.asset.findFirst({ where: { id: action.assetId, businessId, kind: "storyboard" } });
    if (!asset) continue;
    const already = await prisma.routeAction.findFirst({
      where: { businessId, type: "video-post", featuresJson: { contains: `"storyboardActionId":"${action.id}"` } } });
    if (already) continue;
    let title = ""; let body = "";
    try {
      const content = JSON.parse(asset.contentJson) as { title?: unknown; body?: unknown };
      title = typeof content.title === "string" ? content.title : "";
      body = typeof content.body === "string" ? content.body : "";
    } catch {
      continue; // malformed storyboard content — never generate from something unreadable
    }
    if (!title || !body) continue;
    eligible.push({ actionId: action.id, waypointId: action.waypointId, channel: asset.channel, title, body });
  }
  if (eligible.length === 0) return { status: "skipped", reason: "no approved storyboards awaiting generation" };

  // 2. GATES: a connected video source, a configured transport, then budget fail-closed.
  const source = await getConnectedVideoSource(identity);
  if (!source) return { status: "skipped", reason: "no video source connected" };
  if (!deps.transport) return { status: "skipped", reason: "no video transport configured" };
  const budget = await checkBudget(identity);
  if (!budget.allowed) throw new Error(`Video generation blocked: budget exhausted or unavailable (${budget.reason ?? "over cap"}).`);

  // 3. CAP: metered generation — the oldest approved storyboard first; the rest
  // honestly wait (reported in the section detail).
  const batch = eligible.slice(0, MAX_VIDEOS_PER_NIGHT);
  const awaiting = eligible.length - batch.length;

  const generated: string[] = [];
  let skippedItems = 0;
  for (const item of batch) {
    // 4a. The config decrypts per item (it is small; a rotated key mid-batch stays honest).
    // ConnectedIntegration exposes `id` (the config-free view) — decrypt by that scoped id.
    const config = await getDecryptedConfig(identity, source.id);
    const endpoint = typeof config?.endpoint === "string" ? config.endpoint : "";
    const apiKey = typeof config?.apiKey === "string" ? config.apiKey : "";
    if (!endpoint || !apiKey) {
      skippedItems++;
      console.error(`video-gen: source config unreadable for action ${item.actionId} — skipped (zero calls).`);
      continue;
    }
    // 4b. The prompt is OUR OWN storyboard (trusted, founder-approved) — plain.
    const prompt = `${item.title}\n\n${item.body}`;
    let outcome: { url: string } | { error: string };
    try {
      outcome = await deps.transport({ endpoint, apiKey, prompt });
    } catch (error: unknown) {
      outcome = { error: error instanceof Error ? error.message : "transport error" };
    }
    if ("error" in outcome || !isHttpUrl(outcome.url)) {
      skippedItems++;
      console.error(`video-gen: generation failed for action ${item.actionId} — stays ungenerated, retries next night.`);
      continue;
    }
    // 4c. GATE 2 material: a NEW proposed action + asset. The founder watches the
    // video at the URL before approving; nothing is posted by Dionysus.
    const caption = captionOf(item.body);
    const { actionId } = await upsertRouteAction(identity, {
      waypointId: item.waypointId, employeeRole: "videographer", type: "video-post",
      rationale: `Video generated from the approved storyboard "${item.title}" — REVIEW THE VIDEO before approving; Dionysus cannot verify its content.`,
      features: { channel: item.channel, video: true, storyboardActionId: item.actionId } });
    const { assetId } = await persistAsset(identity, {
      channel: item.channel, kind: "video",
      content: { title: item.title, body: `Video: ${outcome.url}${caption ? `\n\nCaption: ${caption}` : ""}` },
      routeActionId: actionId });
    await setActionAsset(identity, actionId, assetId);
    // 4d. D28: the generation EVENT is ledgered (per-unit pricing unknown → costUsd null).
    await recordCost(identity, { model: "video-gen", inputTokens: 0, outputTokens: 0,
      note: `video generation for video-post ${actionId} (storyboard ${item.actionId})` });
    generated.push(actionId);
  }

  return { status: "ok", generated, skippedItems, awaiting };
}
