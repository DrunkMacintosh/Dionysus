// §15 stage-6h eval gate — the SEO/AEO Strategist, wired into the nightly as the NINTH
// section (between cro and outreach), is
//   (inv1) ZERO-MODEL BY CONSTRUCTION (the honesty core): a FULL nightly where the seo
//     section DRAFTS an audit — its asset carrying the served page's UNIQUE marker title —
//     while an OTHER section (the copywriter) makes a real model call, yet NO harness call
//     input ever carries the marker. runSeo takes no harness, so the page content is
//     STRUCTURALLY unable to reach a model. The probe is the recorded-input list: it CAN
//     see the marker (the marker is verbatim in the persisted asset this same run) and it
//     DID see other calls ("Action: draft") — yet not one carried the page content.
//   (inv2) FACTS-ONLY: the served page has the marker title and NO meta description → the
//     audit body carries the verbatim marker AND the machine-checked line
//     `[FAIL] meta-description — absent`; the rationale's "N fail, M warn" equals the
//     [FAIL]/[WARN] line counts read back OUT of the body (machine consistency, not trust).
//   (inv3) NEVER-AUTO + EXCLUSIONS: the audit lands proposed + approval-null + asset-bound
//     on the seo role; the copywriter (which runs AFTER seo) never double-drafts it —
//     exactly ONE seo-audit asset after a full nightly that ALSO drafted a plain post; and
//     approving the action leaves the bound asset's kind "seo-audit" (the kind the cockpit
//     send-queue excludes — the actual read-path filter is pinned in the cockpit suite).
//   (inv4) HONEST DEGRADE + REAL RETRY: night 1 the target 500s → seo skipped "page
//     unreadable", zero seo actions/assets; night 2 the SAME product row, server healthy →
//     the audit drafts. An unreadable page retries, never wedges.
//   (inv5) DEDUP HONESTY (two-sided): approve the drafted audit (clearing the proposed-only
//     ONE-STANDING gate); an UNCHANGED page → skip "page unchanged since last audit", still
//     ONE audit; CHANGE the served title → the findings hash changes → a SECOND audit drafts
//     (the dedup is alive, not an always-skip).
//   (inv6) NON-MCP: TOOL_SCHEMAS stays exactly 11 — SEO is a department pipeline, never an
//     agent-assertable tool.
//
// A local node:http server IS the founder's own landing page: mode "healthy" serves the
// current `title` (with NO meta description → a real [FAIL]) and 404s the well-known files;
// mode "boom" 500s every path (the unreadable-page degrade). The Product.url points at it
// and seoFetchOpts opens the loopback port (`__testAllowPrivate`) so auditPageSeo does a
// REAL fresh fetch — the dedup hash is computed over the actually-fetched page facts. The
// harness answers only the NON-seo sections: the copywriter's "Action: draft" call (radar
// stays quiet, so the observations payload is a safe default). It records every input so a
// test can prove the marker reached no model call. Tenants live under biz_seoeval_* so this
// gate never collides with other suites; tests in a file run sequentially, so the mutable
// server state (`mode`/`title`) is safe to flip per night.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import { prisma } from "dionysus-mcp/db";
import { CONFIG_KEY_ENV } from "dionysus-mcp/lib/secret-box";
import type { SafeFetchOptions } from "dionysus-mcp/lib/ssrf";
import type { MetricTransport } from "dionysus-mcp/tools/analytics";
import { TOOL_SCHEMAS } from "dionysus-mcp/server";
import type { Harness, AgentDef } from "../src/llm/types.js";
import type { HnTransport } from "../src/tools/hn-source.js";
import { runNightly } from "../src/run-nightly.js";
import type { NightlyDeps } from "../src/run-nightly.js";

// The UNIQUE page-content probe: the served page's <title>. 27 chars → inside the 10-60
// pass band (a PASS still renders it verbatim into the audit body), and unmistakable if it
// were ever to leak into a model call. Nothing in the harness fixtures below contains it, so
// its presence in ANY recorded call input would prove the page content reached a model.
const MARKER = "SEOEVAL_UNIQUE_MARKER_TITLE";

// The served landing page: the current `title`, one <h1>, and NO meta description (→ a real
// [FAIL] meta-description). Everything else absent → warns. Deterministic facts the audit reads.
let mode: "healthy" | "boom" = "healthy";
let title = MARKER;
const pageHtml = (): string =>
  `<html><head><title>${title}</title></head><body><h1>Welcome to the SEO eval page</h1></body></html>`;

// The copywriter's draft payload (parseDraft accepts it) and the quiet-radar observations
// payload. Neither carries the marker — the marker only ever lives on the served page.
const DRAFT_JSON = JSON.stringify({ channel: "hackernews", kind: "post", content: { title: "Note", body: "A crisp launch note for HN." } });
const OBSERVATIONS_JSON = JSON.stringify({ observations: [] });

// The fake harness for the NON-seo sections: the copywriter draft when the input is a draft
// instruction, else the quiet radar/default payload. Records every input so a test can search
// the whole model-traffic set for the marker. runSeo never touches this harness — that is the
// invariant under test.
function nightlyHarness(calls?: string[]): Harness {
  return {
    async runAgent(_def: AgentDef, input: string) {
      calls?.push(input);
      if (input.includes("Action: draft")) return { finalOutput: DRAFT_JSON };
      return { finalOutput: OBSERVATIONS_JSON };
    },
    async completeOnce() { return "unused"; },
  };
}

// seoFetchOpts opens the ephemeral loopback port for the REAL page fetch; a throwing metric
// transport guarantees nothing dials out for metrics (no source is connected either); a
// zero-signal HN transport keeps radar quiet (no radar model call, no proposals).
const seams: SafeFetchOptions = { __testAllowPrivate: true };
const failMetrics: MetricTransport = async () => { throw new Error("no metric endpoint in seo eval"); };
const quietHn: HnTransport = async () => ({ status: 200, body: JSON.stringify({ hits: [] }) });

function nightlyDeps(calls?: string[]): NightlyDeps {
  return { harness: nightlyHarness(calls), models: { brain: "fake" },
    hnTransport: quietHn, metricTransport: failMetrics, seoFetchOpts: seams };
}

const TENANTS = ["biz_seoeval_zero", "biz_seoeval_facts", "biz_seoeval_auto", "biz_seoeval_degrade", "biz_seoeval_dedup"];
const seoActions = (biz: string): Promise<number> => prisma.routeAction.count({ where: { businessId: biz, type: "seo-audit" } });
const seoAssets = (biz: string): Promise<number> => prisma.asset.count({ where: { businessId: biz, kind: "seo-audit" } });

// FK-safe teardown (edges → nodes → revisions → snapshots → integrations → assets → actions →
// waypoints → routes → objectives → products); leaves the Business row alone. Children first.
async function wipeChildren(businessId: string): Promise<void> {
  await prisma.memoryEdge.deleteMany({ where: { businessId } });
  await prisma.memoryNode.deleteMany({ where: { businessId } });
  await prisma.routeRevision.deleteMany({ where: { businessId } });
  await prisma.metricSnapshot.deleteMany({ where: { businessId } });
  await prisma.integration.deleteMany({ where: { businessId } });
  await prisma.asset.deleteMany({ where: { businessId } });
  await prisma.routeAction.deleteMany({ where: { businessId } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId } });
  await prisma.route.deleteMany({ where: { businessId } });
  await prisma.objective.deleteMany({ where: { businessId } });
  await prisma.product.deleteMany({ where: { businessId } });
}

// The standard nightly fixture: an active objective/route/waypoint + a latest Product whose
// url points at the local page. Returns the active waypoint id so a test can hang a plain post
// off it (so the DRAFTS section really runs). No analytics → the CRO section stays skipped.
async function seedBusiness(businessId: string, productUrl: string): Promise<string> {
  await wipeChildren(businessId);
  await prisma.business.upsert({ where: { id: businessId },
    create: { id: businessId, name: businessId, maxTokensPerDay: 100000 },
    update: { maxTokensPerDay: 100000 } });
  const obj = await prisma.objective.create({ data: { businessId, kind: "growth", target: "100 signups", metric: "signups", status: "active" } });
  const route = await prisma.route.create({ data: { businessId, objectiveId: obj.id, source: "composed", status: "active" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId, routeId: route.id, order: 1, title: "Launch", goal: "go live", status: "active" } });
  await prisma.product.create({ data: { businessId, url: productUrl, readTier: 3, title: "Acme CLI", description: "Ship faster from the command line." } });
  return wp.id;
}

// A plain undrafted copywriter proposal so the DRAFTS section actually runs — proving the
// copywriter is active this night yet still never touches the seo audit. Its rationale is
// deliberately marker-free, so a copywriter call carrying the marker could only come from a leak.
async function addPlainPost(businessId: string, waypointId: string): Promise<string> {
  const row = await prisma.routeAction.create({ data: {
    businessId, waypointId, employeeRole: "copywriter", type: "post", status: "proposed",
    rationale: "Launch note for the community.",
    featuresJson: JSON.stringify({ channel: "hackernews" }) } });
  return row.id;
}

let server: http.Server;
let base = "";

describe("§15 stage-6h eval gate — the seo employee is zero-model, facts-only, deduped, draft-only, non-MCP", () => {
  beforeAll(async () => {
    process.env[CONFIG_KEY_ENV] = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    server = http.createServer((req, res) => {
      if (mode === "boom") { res.writeHead(500); res.end("boom"); return; }
      // Well-known same-origin files 404 → the audit records them as warn "absent".
      if (req.url === "/robots.txt" || req.url === "/sitemap.xml" || req.url === "/llms.txt") {
        res.writeHead(404); res.end("nope"); return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(pageHtml());
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server.close();
    for (const b of TENANTS) await wipeChildren(b);
    await prisma.business.deleteMany({ where: { id: { in: TENANTS } } });
  });
  afterEach(() => vi.restoreAllMocks());

  it("inv1 ZERO-MODEL: a full nightly drafts the audit while the copywriter calls the model, yet the page marker reaches NO model call", async () => {
    const BIZ = "biz_seoeval_zero";
    const wpId = await seedBusiness(BIZ, `${base}/page`);
    mode = "healthy"; title = MARKER;
    vi.spyOn(console, "error").mockImplementation(() => {}); // recall best-effort logs are expected
    // A plain undrafted post so the DRAFTS (copywriter) section really calls the model this night.
    await addPlainPost(BIZ, wpId);

    const calls: string[] = [];
    const res = await runNightly({ businessId: BIZ }, nightlyDeps(calls));

    // The seo section drafted a real audit...
    expect(res.seo.status).toBe("ok");
    // ...and the audit asset EXISTS carrying the page's marker verbatim — the page content DID
    // flow into the tenant this run (so the marker's ABSENCE from every call below is meaningful).
    const seoAsset = await prisma.asset.findFirst({ where: { businessId: BIZ, kind: "seo-audit" } });
    expect(seoAsset).not.toBeNull();
    expect(seoAsset!.contentJson).toContain(MARKER);

    // The harness was really exercised this night — the copywriter (an OTHER section) made a real
    // model call. The `calls.some(...)` predicate demonstrably FINDS a present substring here...
    expect(res.drafts.status).toBe("ok");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.includes("Action: draft"))).toBe(true);

    // ...yet the SAME predicate finds the page content in NO call: runSeo takes no harness, so the
    // fetched page is structurally unable to reach a model. This is the honesty core, discriminating.
    expect(calls.some((c) => c.includes(MARKER))).toBe(false);
  });

  it("inv2 FACTS-ONLY: the audit body carries the verbatim marker + [FAIL] meta-description — absent; the rationale counts match the body", async () => {
    const BIZ = "biz_seoeval_facts";
    await seedBusiness(BIZ, `${base}/page`);
    mode = "healthy"; title = MARKER; // marker title, NO meta description on the served page
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await runNightly({ businessId: BIZ }, nightlyDeps());
    expect(res.seo.status).toBe("ok");

    const action = await prisma.routeAction.findFirst({ where: { businessId: BIZ, type: "seo-audit" } });
    expect(action).not.toBeNull();
    const asset = await prisma.asset.findFirst({ where: { id: action!.assetId!, businessId: BIZ } });
    const body = (JSON.parse(asset!.contentJson) as { body: string }).body;

    // Facts, verbatim: the exact served title and the machine-checked absent-meta line (substrings).
    expect(body).toContain(MARKER);
    expect(body).toContain("[FAIL] meta-description — absent");

    // Machine consistency (NOT trust): count the [FAIL]/[WARN] lines OUT of the body and assert the
    // rationale's "N fail, M warn" equals those counts — a fabricated or drifting count fails here.
    const failLines = (body.match(/^\[FAIL\]/gm) ?? []).length;
    const warnLines = (body.match(/^\[WARN\]/gm) ?? []).length;
    const m = action!.rationale!.match(/(\d+) fail, (\d+) warn/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(failLines);
    expect(Number(m![2])).toBe(warnLines);
    // Non-vacuous: the served page really produced a failing meta-description and warns to count.
    expect(failLines).toBeGreaterThanOrEqual(1);
    expect(warnLines).toBeGreaterThanOrEqual(1);
  });

  it("inv3 NEVER-AUTO + EXCLUSIONS: the audit lands proposed/approval-null/asset-bound; the copywriter never double-drafts it; approving keeps kind seo-audit", async () => {
    const BIZ = "biz_seoeval_auto";
    const wpId = await seedBusiness(BIZ, `${base}/page`);
    mode = "healthy"; title = MARKER;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await addPlainPost(BIZ, wpId); // so the DRAFTS section actually runs this night

    const calls: string[] = [];
    const res = await runNightly({ businessId: BIZ }, nightlyDeps(calls));

    expect(res.seo.status).toBe("ok");
    // Non-vacuous: the copywriter really drafted this night (the plain post) yet left the audit alone.
    expect(res.drafts.status).toBe("ok");
    expect(calls.some((c) => c.includes("Action: draft"))).toBe(true);

    // Never-auto: the audit is a PROPOSED, asset-bound, approval-null seo-audit on the seo role.
    const action = await prisma.routeAction.findFirst({ where: { businessId: BIZ, type: "seo-audit" } });
    expect(action).not.toBeNull();
    expect(action!.status).toBe("proposed");
    expect(action!.approvedAt).toBeNull();
    expect(action!.employeeRole).toBe("seo");
    expect(action!.assetId).toBeTruthy();

    // Exactly ONE seo-audit asset — the copywriter (assetless-only + type-excluded in draftWaypoint)
    // never re-drafted the audit into a semantically-wrong post.
    expect(await seoAssets(BIZ)).toBe(1);
    const asset = await prisma.asset.findFirst({ where: { id: action!.assetId!, businessId: BIZ } });
    expect(asset!.kind).toBe("seo-audit");
    expect(asset!.channel).toBe("seo");

    // After the founder APPROVES it, the bound asset's kind stays "seo-audit" — the exact kind the
    // cockpit send-queue excludes (a private checklist has no public URL to verify). The real
    // read-path filter is pinned in the cockpit suite; here we pin the exclusion KEY end-to-end.
    await prisma.routeAction.update({ where: { id: action!.id }, data: { status: "approved", approvedAt: new Date() } });
    const afterApprove = await prisma.asset.findFirst({ where: { id: action!.assetId!, businessId: BIZ } });
    expect(afterApprove!.kind).toBe("seo-audit");
  });

  it("inv4 HONEST DEGRADE + REAL RETRY: night 1 target 500 → seo skipped, zero seo actions; night 2 healthy → the SAME product drafts", async () => {
    const BIZ = "biz_seoeval_degrade";
    await seedBusiness(BIZ, `${base}/page`);
    vi.spyOn(console, "error").mockImplementation(() => {});

    // NIGHT 1 — the page 500s. Honest skip; nothing persisted; the request retries next night.
    mode = "boom"; title = MARKER;
    const night1 = await runNightly({ businessId: BIZ }, nightlyDeps());
    expect(night1.seo).toEqual({ status: "skipped", reason: "page unreadable" });
    expect(await seoActions(BIZ)).toBe(0);
    expect(await seoAssets(BIZ)).toBe(0);

    // NIGHT 2 — the SAME product row, the server now healthy → the retry is real: it drafts.
    mode = "healthy"; title = MARKER;
    const night2 = await runNightly({ businessId: BIZ }, nightlyDeps());
    expect(night2.seo.status).toBe("ok");
    expect(await seoActions(BIZ)).toBe(1);
    expect(await seoAssets(BIZ)).toBe(1);
  });

  it("inv5 DEDUP HONESTY (two-sided): approve the audit; an UNCHANGED page skips; a CHANGED page drafts a SECOND audit", async () => {
    const BIZ = "biz_seoeval_dedup";
    await seedBusiness(BIZ, `${base}/page`);
    mode = "healthy"; title = MARKER;
    vi.spyOn(console, "error").mockImplementation(() => {});

    // NIGHT 1 — drafts audit #1 (proposed + asset).
    const n1 = await runNightly({ businessId: BIZ }, nightlyDeps());
    expect(n1.seo.status).toBe("ok");
    expect(await seoActions(BIZ)).toBe(1);

    // Approve it: the founder said "I'll act on this". Approving clears the proposed-only
    // ONE-STANDING gate, so the DEDUP path (which checks the latest audit of ANY status) is the one
    // exercised next — proving dedup, not one-standing, is what suppresses the unchanged re-run.
    await prisma.routeAction.updateMany({ where: { businessId: BIZ, type: "seo-audit" }, data: { status: "approved", approvedAt: new Date() } });

    // NIGHT 2 — the IDENTICAL page → the stored findings hash matches → honest dedup skip; still ONE.
    const n2 = await runNightly({ businessId: BIZ }, nightlyDeps());
    expect(n2.seo).toEqual({ status: "skipped", reason: "page unchanged since last audit" });
    expect(await seoActions(BIZ)).toBe(1);

    // CHANGE the served title → the findings hash changes → a SECOND audit drafts. The dedup is
    // alive (a real change re-fires), not a blanket always-skip.
    title = "A Completely Different SEO Eval Landing Title";
    const n3 = await runNightly({ businessId: BIZ }, nightlyDeps());
    expect(n3.seo.status).toBe("ok");
    expect(await seoActions(BIZ)).toBe(2);
  });

  it("inv6 WHITELIST: TOOL_SCHEMAS stays exactly 11 and never exposes an SEO tool (SEO is a department pipeline, non-MCP)", () => {
    const names = Object.keys(TOOL_SCHEMAS);
    expect(names).toHaveLength(11);
    for (const forbidden of ["run_seo", "audit_page_seo", "persist_seo_audit"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});
