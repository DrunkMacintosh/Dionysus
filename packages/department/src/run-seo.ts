// Stage 6h — the SEO/AEO Strategist's deterministic slice (D25). Zero model
// calls BY CONSTRUCTION: SeoDeps has no harness, so nothing here can spend a
// token or invent a fact. The audit is machine-checked page facts (T1); this
// pipeline decides WHEN it lands as founder-reviewable work:
//   latest Product (no url → skip) → active waypoint (none → skip)
//   → ONE-STANDING (a proposed seo-audit WITH a bound asset → skip; unlike cro,
//     an assetless partial-failure orphan does NOT block — it is invisible on
//     /drafts and must never wedge the employee forever)
//   → auditPageSeo FRESH (unreadable → skip, retries next night)
//   → PAGE-CHANGE DEDUP: sha256(findings) vs the latest seo-audit asset's
//     stored auditHash — unchanged page → skip (reject = "not until it changes")
//   → persist ONE proposed seo-audit action + bound checklist asset (never-auto).
// No checkBudget: it gates model spend (the metrics-section precedent).
import { createHash } from "node:crypto";
import type { Identity } from "dionysus-mcp/identity";
import { prisma } from "dionysus-mcp/db";
import { upsertRouteAction } from "dionysus-mcp/tools/plan";
import { persistAsset, setActionAsset } from "dionysus-mcp/tools/asset";
import { auditPageSeo, type SeoFinding } from "dionysus-mcp/lib/scrape/seo-audit";
import type { SafeFetchOptions } from "dionysus-mcp/lib/ssrf";

export type SeoDeps = { fetchOpts?: SafeFetchOptions };
export type SeoResult =
  | { status: "ok"; actionId: string; fail: number; warn: number }
  | { status: "skipped"; reason: string };

const hashFindings = (findings: SeoFinding[]): string =>
  createHash("sha256").update(JSON.stringify(findings)).digest("hex");

// The checklist the founder reads on /drafts — fixed formatting over T1's facts.
function formatAuditBody(url: string, findings: SeoFinding[]): string {
  const lines = findings.map((f) =>
    `[${f.status.toUpperCase()}] ${f.check} — ${f.evidence}${f.advice ? `. ${f.advice}` : ""}`);
  return [
    `Deterministic SEO/AEO audit of ${url}.`,
    ...lines,
    `Every line above is a machine-checked fact of the fetched page — no model involved.`,
  ].join("\n");
}

export async function runSeo(identity: Identity, deps: SeoDeps): Promise<SeoResult> {
  // 1. Latest Product (scoped, newest). No row / empty url → honest skip.
  const product = await prisma.product.findFirst({
    where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
  if (!product || !product.url) return { status: "skipped", reason: "no product page on record" };

  // 2. Active waypoint on the latest route — the audit's home.
  const route = await prisma.route.findFirst({
    where: { businessId: identity.businessId }, orderBy: { createdAt: "desc" } });
  const activeWaypoint = route ? await prisma.routeWaypoint.findFirst({
    where: { businessId: identity.businessId, routeId: route.id, status: "active" }, orderBy: { order: "asc" } }) : null;
  if (!activeWaypoint) return { status: "skipped", reason: "no active waypoint" };

  // 3. ONE-STANDING: an audit pending review (proposed + asset BOUND = visible on
  // /drafts) suppresses a re-run. assetId!=null on purpose — see the header note.
  const standing = await prisma.routeAction.findFirst({
    where: { businessId: identity.businessId, status: "proposed", type: "seo-audit", assetId: { not: null } } });
  if (standing) return { status: "skipped", reason: "audit already pending review" };

  // 4. FRESH deterministic audit (SSRF-guarded inside). Unreadable → skip, retry.
  const audit = await auditPageSeo(product.url, deps.fetchOpts);
  if (!audit.ok) return { status: "skipped", reason: "page unreadable" };

  // 5. PAGE-CHANGE DEDUP vs the latest audit asset's stored hash (any status —
  // a REJECTED audit's hash also blocks: "don't show me this until it changes").
  const auditHash = hashFindings(audit.findings);
  const latest = await prisma.asset.findFirst({
    where: { businessId: identity.businessId, kind: "seo-audit" }, orderBy: { createdAt: "desc" } });
  if (latest) {
    try {
      const content = JSON.parse(latest.contentJson) as { auditHash?: unknown };
      if (typeof content.auditHash === "string" && content.auditHash === auditHash) {
        return { status: "skipped", reason: "page unchanged since last audit" };
      }
    } catch {
      // Malformed stored content → fail-open toward re-auditing (a fresh audit
      // of the current page is never a fabrication).
    }
  }

  // 6. Persist (never-auto): ONE proposed action + bound checklist asset.
  const fail = audit.findings.filter((f) => f.status === "fail").length;
  const warn = audit.findings.filter((f) => f.status === "warn").length;
  const { actionId } = await upsertRouteAction(identity, {
    waypointId: activeWaypoint.id, employeeRole: "seo", type: "seo-audit",
    rationale: `SEO/AEO audit of ${product.url}: ${fail} fail, ${warn} warn — machine-checked page facts, no model involved.`,
    features: { channel: "seo", seo: true } });
  const { assetId } = await persistAsset(identity, {
    channel: "seo", kind: "seo-audit",
    content: { title: `SEO/AEO audit — ${product.url}`, body: formatAuditBody(product.url, audit.findings), auditHash },
    routeActionId: actionId });
  await setActionAsset(identity, actionId, assetId);

  return { status: "ok", actionId, fail, warn };
}
