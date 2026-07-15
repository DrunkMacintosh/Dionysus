import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { prisma } from "dionysus-mcp/db";
import { runSeo } from "../src/run-seo.js";

// A local http server IS the founder's landing page (the 6e run-cro pattern): the
// Product.url points at it and deps.fetchOpts opens the private port. auditPageSeo
// does a REAL fresh fetch (no fetch stub) — so the dedup hash is computed over the
// actually-fetched page facts, and an unreadable server exercises the real degrade.
let server: http.Server;
let base = "";

// Mutable server state so a single server can be flipped healthy<->500 (the UNREADABLE
// + retry case) and the served <title> can be changed (the DEDUP change-detection case).
let mode: "healthy" | "boom" = "healthy";
let currentTitle = "SEO Audit Test Landing Page"; // 27 chars → in the 10-60 pass band

// The bare page: a valid title + one h1 → 2 passes; NO meta description → 1 fail; and
// canonical/og:title/og:description/json-ld/viewport absent + robots/sitemap/llms 404 →
// 8 warns. Deterministic counts the HAPPY case asserts against.
const pageHtml = (): string =>
  `<html><head><title>${currentTitle}</title></head><body><h1>Welcome to the test page</h1></body></html>`;

// __testAllowPrivate lets safeFetch reach the ephemeral loopback port; 127.0.0.1 is an
// IP literal so the default DNS lookup resolves it with no lookupFn seam.
const seams = { __testAllowPrivate: true } as never;
const deps = { fetchOpts: seams };

const actionCount = (biz: string) => prisma.routeAction.count({ where: { businessId: biz } });
const assetCount = (biz: string) => prisma.asset.count({ where: { businessId: biz } });
const seoActionCount = (biz: string) =>
  prisma.routeAction.count({ where: { businessId: biz, type: "seo-audit" } });

async function reset(biz: string): Promise<void> {
  await prisma.asset.deleteMany({ where: { businessId: biz } });
  await prisma.routeAction.deleteMany({ where: { businessId: biz } });
  await prisma.routeWaypoint.deleteMany({ where: { businessId: biz } });
  await prisma.route.deleteMany({ where: { businessId: biz } });
  await prisma.objective.deleteMany({ where: { businessId: biz } });
  await prisma.product.deleteMany({ where: { businessId: biz } });
}

// Seed a tenant with an objective/route/active-waypoint + a latest Product. `url` is the
// server path by default; pass an explicit url (e.g. "" for the no-url case, or /boom) to override.
async function seedTenant(biz: string, opts: { url?: string; noProduct?: boolean } = {}): Promise<string> {
  await reset(biz);
  await prisma.business.upsert({ where: { id: biz },
    create: { id: biz, name: biz, maxTokensPerDay: 100000 },
    update: { maxTokensPerDay: 100000 } });
  const obj = await prisma.objective.create({ data: { businessId: biz, kind: "signups", target: "100", metric: "users", status: "active" } });
  const route = await prisma.route.create({ data: { businessId: biz, objectiveId: obj.id, source: "case", status: "active" } });
  const wp = await prisma.routeWaypoint.create({ data: { businessId: biz, routeId: route.id, order: 1, title: "Launch", goal: "20 signups", status: "active" } });
  if (!opts.noProduct) {
    await prisma.product.create({ data: { businessId: biz, url: opts.url ?? `${base}/page`, readTier: 3, title: "Acme CLI" } });
  }
  return wp.id;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (mode === "boom") { res.writeHead(500); res.end("boom"); return; }
    // Well-known same-origin files: 404 → the audit records them as warn "absent".
    if (req.url === "/robots.txt" || req.url === "/sitemap.xml" || req.url === "/llms.txt") {
      res.writeHead(404); res.end("nope"); return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(pageHtml());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe("runSeo (fresh deterministic audit -> page-change dedup -> never-auto checklist)", () => {
  it("HAPPY: the audit lands as a proposed seo-audit action + bound checklist asset with an auditHash", async () => {
    mode = "healthy"; currentTitle = "SEO Audit Test Landing Page";
    const BIZ = "biz_seo_happy";
    await seedTenant(BIZ);
    const res = await runSeo({ businessId: BIZ }, deps);

    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    // The served bare page → exactly 1 fail (meta-description absent) + 8 warns.
    expect(res.fail).toBe(1);
    expect(res.warn).toBe(8);

    const actions = await prisma.routeAction.findMany({ where: { businessId: BIZ } });
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    // Never-auto: a proposed seo-audit on the seo role, approvedAt null, asset bound.
    expect(action.status).toBe("proposed");
    expect(action.type).toBe("seo-audit");
    expect(action.employeeRole).toBe("seo");
    expect(action.approvedAt).toBeNull();
    expect(action.assetId).toBeTruthy();
    // features { channel: "seo", seo: true }
    expect(action.featuresJson).toContain('"seo":true');
    expect(action.featuresJson).toContain('"channel":"seo"');
    expect(action.id).toBe(res.actionId);

    // The bound checklist asset: seo / seo-audit; body carries the verbatim title AND the
    // closing machine-checked line; content JSON carries a 64-hex auditHash.
    const asset = await prisma.asset.findFirst({ where: { id: action.assetId!, businessId: BIZ } });
    expect(asset!.channel).toBe("seo");
    expect(asset!.kind).toBe("seo-audit");
    expect(asset!.routeActionId).toBe(action.id);
    const content = JSON.parse(asset!.contentJson) as { title: string; body: string; auditHash: string };
    expect(content.title).toContain("SEO/AEO audit"); // the checklist label carries the page url
    expect(content.body).toContain("SEO Audit Test Landing Page"); // the verbatim page title, in the body
    expect(content.body).toContain("machine-checked fact"); // the closing honesty line
    expect(content.body).toContain("[FAIL] meta-description — absent");
    expect(content.auditHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("NO-URL: a product with an empty url → skipped, zero actions", async () => {
    const BIZ = "biz_seo_nourl";
    await seedTenant(BIZ, { url: "" });
    const res = await runSeo({ businessId: BIZ }, deps);
    expect(res).toEqual({ status: "skipped", reason: "no product page on record" });
    expect(await actionCount(BIZ)).toBe(0);
    expect(await assetCount(BIZ)).toBe(0);
  });

  it("NO-WAYPOINT: no active waypoint → skipped, zero actions", async () => {
    const BIZ = "biz_seo_nowp";
    await seedTenant(BIZ);
    await prisma.routeWaypoint.updateMany({ where: { businessId: BIZ }, data: { status: "done" } });
    const res = await runSeo({ businessId: BIZ }, deps);
    expect(res).toEqual({ status: "skipped", reason: "no active waypoint" });
    expect(await actionCount(BIZ)).toBe(0);
  });

  it("ONE-STANDING: a proposed seo-audit WITH a bound asset suppresses a re-run", async () => {
    mode = "healthy"; currentTitle = "SEO Audit Test Landing Page";
    const BIZ = "biz_seo_standing";
    const wpId = await seedTenant(BIZ);
    // Seed a proposed seo-audit WITH a bound asset (visible on /drafts) — the standing predicate.
    const action = await prisma.routeAction.create({ data: { businessId: BIZ, waypointId: wpId, employeeRole: "seo", type: "seo-audit", status: "proposed", featuresJson: JSON.stringify({ channel: "seo", seo: true }) } });
    const asset = await prisma.asset.create({ data: { businessId: BIZ, routeActionId: action.id, channel: "seo", kind: "seo-audit", contentJson: JSON.stringify({ title: "prior", body: "prior", auditHash: "deadbeef" }) } });
    await prisma.routeAction.update({ where: { id: action.id }, data: { assetId: asset.id } });

    const res = await runSeo({ businessId: BIZ }, deps);
    expect(res).toEqual({ status: "skipped", reason: "audit already pending review" });
    expect(await seoActionCount(BIZ)).toBe(1); // still exactly the one standing
  });

  it("ORPHAN does NOT block: an assetless proposed seo-audit → the run proceeds and drafts a NEW audit", async () => {
    mode = "healthy"; currentTitle = "SEO Audit Test Landing Page";
    const BIZ = "biz_seo_orphan";
    const wpId = await seedTenant(BIZ);
    // An assetless proposed seo-audit (a partial-failure orphan — invisible on /drafts) MUST NOT
    // wedge the employee forever: the standing predicate requires assetId != null.
    await prisma.routeAction.create({ data: { businessId: BIZ, waypointId: wpId, employeeRole: "seo", type: "seo-audit", status: "proposed", featuresJson: JSON.stringify({ channel: "seo", seo: true }) } });

    const res = await runSeo({ businessId: BIZ }, deps);
    expect(res.status).toBe("ok");
    // 2 seo-audit actions now: the orphan + the newly drafted one (exactly 1 has a bound asset).
    expect(await seoActionCount(BIZ)).toBe(2);
    expect(await assetCount(BIZ)).toBe(1);
    const withAsset = await prisma.routeAction.count({ where: { businessId: BIZ, type: "seo-audit", assetId: { not: null } } });
    expect(withAsset).toBe(1);
  });

  it("UNREADABLE + retry: a 500 page → skipped, zero actions; healthy next run drafts", async () => {
    const BIZ = "biz_seo_500";
    await seedTenant(BIZ);
    mode = "boom";
    const first = await runSeo({ businessId: BIZ }, deps);
    expect(first).toEqual({ status: "skipped", reason: "page unreadable" });
    expect(await actionCount(BIZ)).toBe(0);

    // The page recovers → the next night drafts (an unreadable page retries, never wedged).
    mode = "healthy"; currentTitle = "SEO Audit Test Landing Page";
    const second = await runSeo({ businessId: BIZ }, deps);
    expect(second.status).toBe("ok");
    expect(await seoActionCount(BIZ)).toBe(1);
  });

  it("DEDUP: an unchanged page is never re-proposed; a REJECTED audit's hash still blocks; a changed page drafts again", async () => {
    mode = "healthy"; currentTitle = "SEO Audit Test Landing Page";
    const BIZ = "biz_seo_dedup";
    await seedTenant(BIZ);

    // Run 1 → drafts the first audit.
    const first = await runSeo({ businessId: BIZ }, deps);
    expect(first.status).toBe("ok");
    expect(await seoActionCount(BIZ)).toBe(1);

    // REJECT it: the founder said "not this again until the page changes". Rejecting clears the
    // proposed-only ONE-STANDING gate so the DEDUP path (which checks ANY status) is the one exercised.
    await prisma.routeAction.updateMany({ where: { businessId: BIZ, type: "seo-audit" }, data: { status: "rejected" } });

    // Run 2 against the IDENTICAL page → the rejected audit's stored hash matches → honest skip.
    const second = await runSeo({ businessId: BIZ }, deps);
    expect(second).toEqual({ status: "skipped", reason: "page unchanged since last audit" });
    expect(await seoActionCount(BIZ)).toBe(1); // no second audit — the dedup held

    // CHANGE the served title → the findings hash changes → a SECOND audit drafts (dedup is not an always-skip).
    currentTitle = "A Completely Different Landing Page Title";
    const third = await runSeo({ businessId: BIZ }, deps);
    expect(third.status).toBe("ok");
    expect(await seoActionCount(BIZ)).toBe(2);
  });

  it("DEDUP FAIL-OPEN: a latest seo-audit asset with malformed contentJson can't be compared → a fresh audit drafts", async () => {
    mode = "healthy"; currentTitle = "SEO Audit Test Landing Page";
    const BIZ = "biz_seo_malformed";
    const wpId = await seedTenant(BIZ);
    // A prior seo-audit whose stored asset content is NOT valid JSON (a corrupt/partial write).
    // It is REJECTED (not proposed) so ONE-STANDING doesn't fire and the DEDUP path is the one
    // exercised — but JSON.parse throws inside step 5, so the stored hash can't gate. The malformed
    // branch must fail-open (a fresh audit of the current page is never a fabrication), not wedge.
    const prior = await prisma.routeAction.create({ data: { businessId: BIZ, waypointId: wpId, employeeRole: "seo", type: "seo-audit", status: "rejected", featuresJson: JSON.stringify({ channel: "seo", seo: true }) } });
    const asset = await prisma.asset.create({ data: { businessId: BIZ, routeActionId: prior.id, channel: "seo", kind: "seo-audit", contentJson: "not json" } });
    await prisma.routeAction.update({ where: { id: prior.id }, data: { assetId: asset.id } });

    const res = await runSeo({ businessId: BIZ }, deps);
    expect(res.status).toBe("ok"); // fail-open: the unparseable hash did not block a fresh audit
    // The rejected prior + the newly drafted audit → 2 seo-audit actions; exactly the fresh one is proposed+bound.
    expect(await seoActionCount(BIZ)).toBe(2);
    const proposedWithAsset = await prisma.routeAction.count({ where: { businessId: BIZ, type: "seo-audit", status: "proposed", assetId: { not: null } } });
    expect(proposedWithAsset).toBe(1);
  });
});
