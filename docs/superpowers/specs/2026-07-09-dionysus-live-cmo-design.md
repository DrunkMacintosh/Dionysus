# Design: Dionysus — a live, per-business AI CMO on Hermes Agent

**Date:** 2026-07-09
**Status:** DRAFT v2 — risk stress-test amendments applied (2026-07-09); awaiting user review
**Scope:** Architectural pivot — from the single-shot Next.js pipeline to a live agentic CMO built on the Hermes Agent runtime. Supersedes the deterministic step-engine and the hand-rolled Stage-1 orchestration/memory layers.

## Name & metaphor

The product/agent is **Dionysus** — the CMO (god of festivity and persuasion: gets the crowd to show up). It runs on **Hermes Agent** (Nous Research's self-improving agent framework — the messenger/runtime). Dionysus directs a department of specialist **employees** (persistent subagents). Hermes carries; Dionysus persuades.

## Context

The current prototype (intake → SSRF-guarded scrape ladder → product read → brand kit, plus Stage-1 tenancy/auth/memory/budgets) is a **deterministic Next.js pipeline**. The vision is a **live agent that controls its own skills from founder intent**, runs a **department of specialist employees that accumulate expertise**, plans a **route of waypoints toward a goal**, and re-personalizes that plan as results come in. Hermes already provides the tool layer, planning/learning loops, delegation, memory, cron, browser tooling, and 20+ chat surfaces we would otherwise hand-roll.

**Deadline note:** the July 17 hackathon constraint is dropped for this design — this is the real product. The existing Next.js app remains available as a standalone demo; it is not the target architecture.

**Market position (added 2026-07-09).** The nearest competitor is **Okara** (okara.ai, $66–99/mo — agents for SEO/GEO/copy/Reddit/HN/X, review-queue gated); the broader category (Blaze, MarketOwl, Jasper agents, HubSpot Breeze, Ceres, TheAICMO) has already converged on approval-gated drafts as the modal pattern, and the best-rated products all gate. Dionysus differentiates on what the category verifiably lacks: the case-led route, **visible outcome attribution** (the learning loop — the retention driver users cite), and **community-channel compliance** (authentic founder posting on Reddit/HN/PH, where platforms are actively at war with agent slop). A 2026-07-09 mapping of Okara's agent roster onto the department closed four real gaps (GSC integration, long-form copy, the SEO/AEO Strategist — D25, CRO patch artifacts) and deliberately rejected two: an auto-executing "coding agent" (conflicts with D20) and automated link brokering (spam-adjacent; see Non-goals).

### Decision record (brainstorming, 2026-07-09)

- **D1 — Runtime: Hermes Agent** (adopt, don't reinvent Stages 2–4).
- **D2 — Approach 1:** native self-improving Hermes skills for judgment; proven deterministic TS plumbing (scrape+SSRF, brand extraction, cost) stays behind one MCP server.
- **D3 — Surface C:** chat primary (Telegram/web-chat) + web cockpit.
- **D4 — Dashboard data source A:** MCP tools persist to the existing Prisma schema; Hermes `state.db` holds agent memory. Two stores, clean split.
- **D5 — Tenancy:** one Hermes profile per business (`hermes -p biz_<id>`), **each in its own container/VM — required, not optional** (amended 2026-07-09): Hermes profiles are state-scoped and explicitly *not* sandboxed (every profile's agent has full host-user filesystem access; a real cross-tenant memory leak is documented upstream in multi-tenant use), so the container is the tenancy boundary and the profile is just state.
- **D6 — Department: persistent employees** (memory + skills accumulate from day one; on-demand compute; dedicated-daemon upgrade per always-on role).
- **D7 — Strategy is case-led; six modes are the internal taxonomy.** Founder chooses among 5 researched real-world cases (or composes); the six launch modes tag/organize cases under the hood.
- **D8 — Route = objective + ordered waypoints.** Advance waypoint-by-waypoint; founder iterates the plan at the start; agent-proposed mid-route changes go through approval.
- **D9 — Execution = draft-review + verified send (public-URL / official API, never stored cookies).** Drafts auto-surface with a chat bar to iterate; on approve, either (a) the founder posts in their own logged-in browser and confirms the **public post URL**, which `dionysus-mcp` fetches (SSRF-guarded) to verify the post exists, or (b) under a founder-connected account (OAuth), Dionysus posts via the platform's **official API** and verifies by the returned post ID. The action is marked `executed` only after verification; outcome is captured via `/r/[slug]` click tracking + public/API metric polling. Server-side browser automation is used only to *read/verify public pages*, never to post as the founder with stored credentials. **Default posture is channel-class-shaped (amended 2026-07-09):** on owned feeds (X/LinkedIn) the post-approval default is (b) **connected-API auto-publish** — the market norm; manual posting there is heavier than the accepted standard; on community/launch channels (Reddit/HN/Product Hunt) path (a) **assisted-manual is the only mode** (Reddit's ToS prohibits promotional automation and its anti-slop enforcement removes ~25k posts/day; Product Hunt's API has no launch mutation) — positioned as the authenticity differentiator, not a limitation.
- **D10 — Graduated autonomy:** per-action-class trust policy (auto / batch-review / always-ask) reconciles "live & unattended" with "founder veto."
- **D11 — Reasoning standard:** every reasoning/creating subagent follows the [andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) discipline (see §3).
- **D12 — Objective:** the founder sets a measurable goal; the system optimizes the route toward it and reports progress.
- **D13 — Memory: hybrid waypoint-anchored evolution graph.** A live graph we own (`MemoryNode`/`MemoryEdge`, anchored to waypoints, fast causal recall) consolidated periodically by [graphify](https://github.com/Graphify-Labs/graphify) into a deep queryable + visual knowledge graph exposed to Hermes over graphify's MCP server (see the Memory system section).
- **D14 — Pre-flight simulation (staged).** A core in-house **Simulator** (synthetic focus group via persona-subagents) predicts audience reaction before send; a deep [MiroFish](https://github.com/666ghj/MiroFish) service is an optional, gated enhancement for high-stakes moments (see Optional enhancements). Simulation output is always labeled a *prediction*, never fact.
- **D15 — Video (Videographer + Kling via MCP).** A **Videographer** employee produces platform-native short-form video by collaborating with the Designer (brand visuals), Copywriter (hooks/captions), and Strategist (concept), calling **Kling** through a `kling-mcp` tool to generate/assemble clips, then routing the result through human approval → Simulator → verified send. Because video generation is expensive, it uses a **two-gate approval** (storyboard approved before any generation call; render approved before send) + a per-video budget ceiling. Kling access is **confirmed** (2026-07-09): official public API (KlingAI Open Platform; international endpoint `api-singapore.klingai.com`; prepaid resource packages — ~$0.70 per 5s 1080p clip per reseller pricing) with multiple existing community MCP wrappers (e.g. `199-mcp/mcp-kling`), so `kling-mcp` adopts/wraps one rather than building from scratch. The previously-referenced "Motion video MCP" does not exist; real fallback engines are the fal.ai / PiAPI / Higgsfield MCP servers (which expose Kling plus alternatives).
- **D16 — Learning loop.** Real outcomes evolve strategy via feature-tagged attribution → an evidence-weighted belief layer (`confidence` on `learning` nodes) → real-time market sensing → an evidence-weighted **explore/exploit** decision policy toward the objective. Evidence accumulating in Prisma gates procedural change in Hermes; beliefs are per-business; weak evidence is labeled weak (see the Learning loop section). **Customer-visible value leads with explainable attribution** ("this post drove 12 signups — that's why the plan changed"), which retains founders even at the small N a typical business generates; evidence-weighted optimization is the long-run layer that engages as evidence allows (amended 2026-07-09).
- **D17 — Social Media Manager (consolidation, not addition).** The Community Manager is elevated into the **Social Media Manager**: the always-on social radar (duty-cycled trend + reputation listening, reactive opportunity/trendjacking, cross-platform engagement) and the **primary feeder of the learning loop's real-time market sensing**. Social is where the live market state and trends surface; this gives that sensing a clear always-on owner without role sprawl (a consolidation, not a new hire). **Sensing is duty-cycled and budget-capped, never "continuous" (amended 2026-07-09):** X reads are metered (~$0.005/read, no free tier — naive continuous polling would alone run ~$1.5k/mo) and LinkedIn/TikTok expose no permitted listening API, so the radar polls on a per-tier budgeted cadence, prefers RSS/official feeds, and respects each channel's ToS/economics posture (D19).
- **D18 — Outreach/PR + Conversion Optimizer (completing the acquisition loop).** Two employees fill the last functional gaps: an **Outreach / PR Manager** (borrowed-audience acquisition — personalized, approval-gated pitches to newsletters/podcasters/influencers/community-mods + directory & launch-platform distribution) and a **Conversion Optimizer** (CRO — reads the product's own landing page + funnel, recommends conversion fixes the founder implements). Department becomes 11 (12 with D25); the loop is complete: drive traffic → from borrowed audiences → to a converting destination → measured and learned.
- **D19 — Platform-ToS compliance.** Assisted-manual posting is the compliant default; connected-API auto-posting only where a platform's ToS permits; sensing via permitted APIs/RSS over scraping. Channels carry a ToS posture Dionysus respects (see Compliance, security & measurement).
- **D20 — Prompt-injection hardening + capability sandbox.** All ingested web/social content is fenced as untrusted data; marketing profiles run with `execute_code`/terminal/filesystem disabled; only typed, `businessId`-scoped MCP tools act (see Compliance, security & measurement).
- **D21 — Real-outcome measurement.** A first-class analytics integration feeds real conversions to `goal_progress` + the learning loop; until connected, the system optimizes labeled *proxy* metrics and never claims unmeasured "users" (see Compliance, security & measurement).
- **D22 — Founder-attention budget (added 2026-07-09).** Founder attention is a budgeted resource like tokens: approvals consolidate into a **daily digest** (interrupts reserved for time-sensitive/high-stakes items) with a **≤10–15 min/day review target**, and **draft edit-distance is instrumented as the leading churn indicator** — the category's verified failure mode is approval degenerating into editing (Jasper's month-four wall; Sintra's ideas-8/execution-2 collapse), not the existence of the gate.
- **D23 — Pricing floor (added 2026-07-09).** Tiers start at **≥ $99/mo, credit-metered from day one**: sub-$50 AI tools show ~23% gross revenue retention (a churn trap regardless of margin), and metering is never introduced retroactively (Sintra's unlimited→metered conversion collapsed its trust).
- **D24 — Hermes insulation layer (added 2026-07-09).** Pin the Hermes version (staged, soak-tested upgrades — upstream ships ~250k changed lines per fortnight with uncataloged migrations and same-week rollbacks); run **our own auth/rate-limit proxy** in front of every profile's `api_server` (upstream auth is a single static bearer token, unauthenticated if unset, no rate limiting); build **our own per-role orchestration layer** over `delegate_task` (per-call model/bundle pinning doesn't exist upstream; MoA is a per-response ensemble, not per-role routing). Treat all Hermes internals (state.db schema, config keys, skills layout) as unstable pre-1.0.
- **D25 — SEO/AEO Strategist: the 12th employee (added 2026-07-09).** Pulled in from non-goals after the competitive mapping against Okara (whose SEO + GEO agents are headline features): keyword/on-page recommendations (emitted as ready-to-apply patch/snippet artifacts, drafts-only — D20 intact), long-form content briefs for the Copywriter, and **AEO/GEO** — getting the brand cited by ChatGPT / Google AI Overviews (schema, llms.txt, authority citations). Grounded in Google Search Console + analytics data (D21); lands in build stage 6 and is useful once GSC is connected. The rejected Okara counterparts stay rejected: no agent code execution against the founder's site (the CRO/SEO emit patches, never apply them), no automated link brokering.

## Goals

- From natural-language intent, Dionysus researches winning cases, proposes a route of waypoints toward a founder-set objective, staffs a department, and drives execution with founder-approved, verified posting (public-URL confirmation or official API, never stored cookies).
- Each business has its own isolated Dionysus (profile) with its own memory, skills, budget, and an evolving, personalized plan.
- The plan compounds — it drifts from a borrowed case playbook toward a bespoke, data-earned route via the Growth Analyst.
- Every reasoning/creating subagent reasons to a verifiable standard (§3).
- Guardrails from day one: nothing publishes without approval; verified execution (public-URL / API); no fabricated numbers (including reconstructed history); channel norms obeyed verbatim; per-business budget fails closed.

## Non-goals (explicit boundary)

No planning-loop reinvention (Hermes owns it). No porting deterministic plumbing to Python (stays TS behind MCP). Out of scope for this spine, each its own future stage: **paid-ads management**, **full CRM / audience ledger**, **email lifecycle/drip**, **cross-business learning** (aggregate platform intelligence — powerful, needs a privacy design), fine-tuned per-business models, teams/roles. *(SEO/AEO was originally out of scope; pulled in as D25 after the 2026-07-09 competitive mapping.)* Rejected outright, not deferred: **automated backlink building / link brokering** (spam-adjacent, Google-penalized, conflicts with the constitution) and **agent code execution against the founder's site** (an auto-"coding agent" conflicts with D20 — the CRO/SEO emit patch artifacts the founder applies).

## 1. Architecture — topology

```
┌─ Founder ─────────────────────────────────────────────────────────┐
│  chat (Telegram / web-chat)          web cockpit (Next.js)         │
│                                      · route + waypoints           │
│                                      · draft-review (chat-to-iterate)│
│                                      · subagents store · timeline  │
└───────────────┬───────────────────────────────┬──────────────────┘
                │ chat                            │ read (Prisma) · drive+observe (api_server behind our auth proxy — D24) · activity rows (Prisma)
                ▼                                 ▼
┌─ Hermes profile  `hermes -p biz_<id>` ────────────────────────────┐
│  DIONYSUS (coordinator) — frontier neurons                        │
│  holds objective + route + brand memory + budget; delegates;      │
│  reviews; enforces the reasoning standard; queues for approval     │
│                                                                    │
│   delegate_task ─▶ Historian · Strategist · Copywriter · Designer ·│
│                    Social · Analyst · Growth · Simulator ·          │
│                    Videographer · Outreach · CRO · SEO/AEO          │
│                                                    (12 employees)   │
│   browser tools ─▶ verified posting on target platforms            │
└───────────────┬───────────────────────────────────────────────────┘
                │ MCP client
                ▼
┌─ dionysus-mcp  (Node/TS server) ──────────────────────────────────┐
│  read_product · extract_brand · persist_* · record_cost ·         │
│  check_budget · click_stats · goal_progress   (proven plumbing)    │
└───────────────┬───────────────────────────────────────────────────┘
                ▼
        Prisma/SQLite (structured state — see §10)   ← cockpit's data source
```

Four Hermes primitives, used deliberately: **delegate_task** = employees (wrapped by our per-role orchestration layer — model + bundle assignment happens in our code, not the framework's; D24); **bundles** = job descriptions; **profiles** = tenancy state (the security boundary is the per-business container — D5); **MoA** (optional) = a per-response quality ensemble for Dionysus's hard reasoning turns (not per-role model routing). Plus Hermes **browser tools** for verified execution. The cockpit reaches each profile's `api_server` through **our auth/rate-limit proxy** (D24).

## 2. The department

**Dionysus (coordinator)** — frontier neurons (Kimi K2.6 / Claude / Nous Portal, swappable via `hermes model`). Holds the objective, the route, brand memory, and budget; delegates; reviews every output; enforces the reasoning standard; queues drafts for approval. Never does grunt work. His management layer is a top-level `dionysus/SKILL.md` naming the roster, the delegation rules, and the constitution.

**Employees** — each a **bundle** (skills) + **persona** (bundle `instruction`) + **model tier** (cheap for volume):

| Employee | Job | Model | Cadence |
|---|---|---|---|
| Market Historian | Discover winning cases; reconstruct each one's full marketing history | cheap + web | up-front (Discovery) |
| Strategist | Playbook synthesis (case → arc + modernized plan + pro insight); route/waypoint shaping | mid/frontier | up-front + on revision |
| Copywriter | Channel-native drafts (reddit/x/linkedin/ph/captions) + long-form (blog posts/articles, briefed by Strategist / SEO-AEO) | cheap | parallel fan-out per channel |
| Social Media Manager | Social radar: duty-cycled trend + reputation listening (budget-capped, ToS-postured — D17/D19), reactive opportunity (trendjacking), cross-platform engagement/replies; primary feeder of the learning loop's market signals | cheap | duty-cycled always-on (budgeted cron + hooks; dedicated-daemon role) |
| Designer | Brand judgment (tone/taglines/palette curation from `extract_brand`'s raw CSS signals) + posters / OG images | cheap + image | on task |
| Analyst | Descriptive: traction digests, attribution | cheap | cron |
| Growth Analyst | Prescriptive: analyze own activities + live market position; re-personalize the plan toward the objective | mid | after each action + weekly |
| Simulator | Pre-flight synthetic focus group: persona-subagents predict reaction/sentiment/norm-backlash before send | cheap | before approve; on plan variants |
| Videographer | Short-form video (TikTok/Reels/Shorts): concept→storyboard→Kling generation→assembly, brand-native, collaborating with Designer/Copywriter/Strategist | cheap orchestration + Kling gen (metered, capped) | on task (two-gate) |
| Outreach / PR Manager | Borrowed-audience acquisition: personalized, approval-gated pitches to newsletters/podcasters/YouTubers/influencers/community-mods + directory & launch-platform distribution; relationship history in the memory graph | cheap | on task + always-on follow-up |
| Conversion Optimizer | CRO: reads the product's own landing page + signup/onboarding funnel, finds conversion leaks, recommends fixes + emits ready-to-apply patch/snippet artifacts the founder applies (drafts-only, never executes — D20); A/B via the learning loop | cheap | on task + on traffic-without-conversion signal |
| SEO/AEO Strategist | Search + AI-assistant visibility (D25): keyword/on-page recommendations (patch artifacts, drafts-only), long-form content briefs for the Copywriter, AEO/GEO — brand citations in ChatGPT / AI Overviews (schema, llms.txt, authority placement); grounded in GSC + analytics data | cheap + web | on task + monthly re-scan (needs GSC connected — D21) |

Cost hierarchy is literal: expensive coordinator (few tokens: plans/reviews) over a cheap-model workforce (volume). Per-role model assignment is **ours, not the framework's** (verified 2026-07-09): `delegate_task` supports per-call context + toolset pinning but not model or bundle pinning, and MoA is a per-response ensemble — so the coordinator's delegation wrapper assigns each employee its model + bundle content at spawn time (D24).

## 3. Reasoning standard (cross-cutting — D11)

Every reasoning/creating subagent inherits a shared `reasoning-standard` skill (included in each employee bundle, enforced by Dionysus), adapting the [andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) principles to marketing work:

1. **Think before creating** — state the interpretation of the founder's intent + a brief plan *before* producing output; never silently assume what they want.
2. **Goal-driven execution with verification loops** — tie each output to a declarative goal and a verify check. E.g. strategy → *verify: cites ≥2 SWOT items and rejects 2 modes*; content → *verify: no number absent from source context; the obeyed channel norm is quoted*; Discovery → *verify: every historical claim cites a real source URL or is tagged INFERRED*.
3. **Minimal, understood changes** — when revising a draft, the plan, or the brand voice, change only what the task requires and what you understand; no orthogonal side-effects (don't quietly restyle the whole plan to fix one waypoint).
4. **Plan-then-verify for multi-step work** — `[step] → verify: [check]`, surfaced so the founder and the reviewer can see the reasoning.

These verify-checks are the same assertions the eval fixtures test (§15), so the standard is enforced in code, not just prompt text.

## 4. Skills & pools

- **Skill** = `~/.hermes/skills/<category>/<name>/SKILL.md` (+ `references/`, `templates/`, `scripts/`, `assets/`). Frontmatter: name, ≤60-char description, version, `metadata.hermes.{tags,category,requires_toolsets,config}`. Sections: When to Use, Procedure, Pitfalls, Verification.
- **Authoring:** ship a `skills/cmo/` set seeded per profile; grow via `/learn`; self-improve via `skill_manage`.
- **Pools = bundles** (`~/.hermes/skill-bundles/<slug>.yaml`): named skill set + shared `instruction` (constitution/persona). The **six launch modes are six bundles** (D7, internal taxonomy); each employee is a bundle. Checked into the repo for reproducibility.
- Deterministic capabilities are **MCP tools** (§8), not skills; skills call them.

## 5. Persistent employees (D6)

Each employee has three durable things — its **bundle**, its **self-improving skills**, and its **memory** (role-tagged `learning` nodes in the evolution graph, keyed by `(businessId, role)` — see the Memory system section) — and one ephemeral thing: the **compute** (spawned per task via `delegate_task` through our per-role wrapper — D24 — hydrated with that employee's memory + bundle, released after). Employees grow from day one without idling daemons. Read is a `businessId`+role-scoped traversal from the current waypoint (the generalized `buildBusinessContext` pattern). Upgrade path: promote an always-on role — canonically the **Social Media Manager**, whose duty-cycled social listening (D17) needs a standing schedule — to its own dedicated profile/daemon.

## Memory system (D13)

Dionysus's memory is a **hybrid waypoint-anchored evolution graph** — a live graph we own for fast causal recall, consolidated periodically by graphify into a deep, queryable, visual knowledge graph. This replaces the earlier scattered memory mentions and the flat `EmployeeMemory` table.

**Types & store split.** Working memory + conversational episodic + procedural (skills) + the Honcho business-model live in **Hermes `state.db`** (the agent's *cognitive* memory). Structured episodic (actions/outcomes/feedback/cost), semantic facts (brand/ICP/objective/positioning), route state, and the **evolution graph** live in **Prisma** (the *operational* record the cockpit/analytics/budgets read), written via MCP tools. Rule: *if the cockpit, budgets, analytics, or another employee needs it → Prisma via MCP; if it's only Dionysus's conversational continuity → Hermes.*

**Live layer (write path).** `MemoryNode` + `MemoryEdge`, anchored to the plan:
- **Node types:** waypoint, action, outcome, learning, market-observation, case, revision. Per-employee craft = `learning` nodes tagged with role (this subsumes the old flat `EmployeeMemory`).
- **Edge types:** `next` (waypoint spine), `caused` (action→outcome), `informed-by` (case→strategy→waypoint), `supersedes` (new learning→stale belief), `references` (asset→norm).
- Every node/edge is `businessId`-scoped. Structured writes are synchronous via MCP; learning nodes are non-blocking.
- **Read = traversal:** `buildAgentContext(businessId, role, routeId)` traverses from the current waypoint node — ancestor path (how we got here) + neighborhood (what happened around here) + role-scoped learning nodes — priority-ordered, budget-capped (the generalized, tested `buildBusinessContext` pattern). Causal, plan-aware recall, not flat recency.

**Consolidation + query + viz (graphify).** On the consolidation cadence (cron) — **consolidation *is* the graphify rebuild** — export the business corpus (route docs, learnings, assets, cases, outcomes) + the live evolution graph and run graphify, producing the deep knowledge graph: `query` / `path A B` / `explain`, EXTRACTED-vs-INFERRED edge confidence, Leiden community clustering. Exposed to that business's Hermes profile via **graphify's MCP server** (Python↔Python). Its **`graph.html` is the cockpit's memory/evolution visualization** — unifying the memory graph and the Timeline (§6.8) into one clickable artifact.

**Staleness / supersede.** `supersedes` edges + node `confidence`/`ts` make stale beliefs graph-navigable; the **Growth Analyst** detects market shifts and writes supersede edges, so re-planning corrects the *record*, not just the plan.

**Isolation (load-bearing).** Hermes-side isolation is **state-scoped only** (per-business profile → own `state.db`); profiles do not sandbox, so the real Hermes-side boundary is the per-business container (D5). And Prisma is one shared DB, so **every graph/memory read+write stays `businessId`-scoped**, gated by the auth session→business mapping and enforced in the MCP tools — the surviving core of Stage-1 tenancy and the exact hole the earlier security review caught. Non-negotiable.

**Two learning mechanisms, composed.** Hermes refines *procedure* (skills self-improve); the graph accumulates *knowledge* (what's true about this business/market). Nodes inform *when* to apply skills; skill improvements encode generalized *how*. Kept separate so neither corrupts the other.

**Caveats.** graphify rebuilds (not live) → the live Prisma layer carries per-action writes, graphify runs on cadence. Its semantic pass over docs needs a model (cost sized to the free endpoint / Nous Portal).

## Learning loop (D16) — how Dionysus evolves toward results

The metabolism that turns real outcomes into better strategy — what makes Dionysus a CMO that *improves*, not just operates. **Its customer-visible value leads with explainable attribution** — the founder sees *which action produced which outcome and why the plan changed* — which retains at small N; autonomous optimization is the long-run layer that engages as evidence accumulates (D16, amended 2026-07-09). Four mechanisms tie the existing organs (outcome capture, memory graph, Growth Analyst, objective, consolidation) into a results-optimizing cycle:

1. **Feature-tagged attribution.** Every `RouteAction` carries its features (channel, format, hook-type, timing, audience segment, mode); its real outcome links back via a `caused` edge. Learning attaches to *features* (which generalize), not to individual posts (which don't).
2. **Evidence-weighted belief layer.** Beliefs are `learning` `MemoryNode`s with `confidence`, each wired by `caused` edges to the outcomes supporting them. Confidence rises with corroborating evidence, decays with recency, and `supersedes` when contradicted.
3. **Real-time market sensing.** The **Social Media Manager** (duty-cycled, budget-capped polling via permitted APIs/RSS + hooks — not scraping, and priced per platform: X reads are metered — see Compliance) — with the Growth Analyst (periodic re-scan) — writes `market-observation` nodes, so beliefs track the live category, not a stale snapshot. Social is the primary sensing surface.
4. **Decision policy — evidence-weighted explore/exploit toward the objective.** Choosing the next waypoint/action weights options by `belief-confidence × expected progress-to-objective`, exploiting proven winners while exploring where evidence is thin. This is "direct future strategy for best results."

**The cycle:** act (verified send) → measure (real outcome) → attribute (feature tags + `caused` edge) → update beliefs (confidence ±, supersede) → sense market → consolidate (graphify distills + clusters winners) → decide (explore/exploit) → act.

**Priming (early evidence is thin).** Case studies seed priors (Market Historian), the Simulator supplies cheap synthetic signal, and real outcomes — always weighted highest — override both as they arrive. Dionysus starts with borrowed wisdom and converges to earned, business-specific wisdom.

**Prisma gates Hermes (the ordering that prevents hallucinated learning).** A belief becomes strong in the **Prisma graph** (evidence accumulates, confidence crosses a threshold); only *then* is it promoted into a **Hermes skill self-improvement**. Evidence-in-Prisma gating procedural-change-in-Hermes is what stops a single lucky post from rewriting a skill.

**Curation is per-business.** Profile isolation means beliefs are this business's, not generic; graphify consolidates *its* graph. Cross-business meta-learning stays out of scope (privacy) — the obvious future.

**Honest guards.** Evidence-count thresholds before a belief drives a decision; recency decay; confidence shown honestly (a 2-observation belief is labeled *low-confidence* — the no-fabricated-numbers rule applied to learnings); every belief links to real outcome nodes (no free-floating assertions — enforced by the §3 reasoning standard). Marketing attribution is noisy (small N, confounders, delayed effects), so the system reports "still learning, low confidence" rather than faking certainty.

## 6. The workflow

```
Intake ─▶ Discovery ─▶ Case brief ─▶ Route (objective + waypoints) ─▶ Staffing ─▶ Execution ─▶ Adaptive loop ─▶ Timeline
                                          ▲ founder iterates at start        │  (draft-review + verified send)
                                          └──────────── waypoint revisions (approved) ◀────────┘
```

1. **Intake** — founder feeds the product URL (`read_product`).
2. **Discovery** — Market Historian finds real winning-marketing cases for comparable products and reconstructs each one's marketing history **from cited real sources** (articles, founder interviews, wayback) via web search/browse. Every claim is tagged **EXTRACTED** (backed by a source URL) or **INFERRED** (reasoned); unsourced claims are labeled low-confidence, never presented as fact. Reconstructing history is exactly where models confabulate, so source-grounding is mandatory here — the signature beat cannot be built on plausible fiction.
3. **Case brief** — surfaces the **5 most famous cases**, each with: the historical playbook, a **modernized implementation plan** (adapted to today's channels/norms), and a **professional insight/critique**.
4. **Route (objective + waypoints — D8, D12)** — founder sets a measurable **objective** (e.g. "first 100 users," "500 waitlist by launch"). Dionysus proposes a **route**: ordered **waypoints** (intermediate goals) toward the objective, each holding actions. Founder **follows a case's route or composes their own**, and **iterates the plan at the start** (chat + cockpit) before committing. Advance waypoint-by-waypoint; a completed waypoint unlocks the next.
5. **Staffing** — Dionysus **auto-staffs** the roster the route needs from the subagents store. The founder **may add** store subagents that fit their strategy, each with a **mandatory rationale**; the rationale is injected into Dionysus's coordinator context and the added employee's brief, persisted as a strategy signal, and Dionysus **confirms how it will use the addition and flags conflicts** with the route. `RouteStaffing { routeId, subagentId, source, rationale?, addedAt }`.
6. **Execution (pre-flight + draft-review + verified send — D9, D14)** — an employee finishes an action → the **draft auto-surfaces** in the cockpit review view with a **chat bar to iterate** (conversational refinement). Before approve, the **Simulator** runs a pre-flight synthetic focus group (persona-subagents modeling the target community) predicting reaction/sentiment/norm-backlash, shown beside the draft as a **labeled prediction**; high-stakes actions can opt into a deep MiroFish simulation (optional stage). On **approve**, one of two paths (per §7 autonomy; the default is channel-class-shaped — owned feeds default to (b), community/launch channels are (a)-only — D9): (a) **assisted-manual** — the founder posts in their own logged-in browser and confirms the **public post URL**, which `verify_post` fetches to confirm the post exists; or (b) **connected-API** — Dionysus posts via the platform's official API (founder-granted OAuth) and verifies by the returned post ID. The `RouteAction` is marked `executed` only after verification; outcome is captured via `/r/[slug]` click tracking + public/API metric polling. **No founder platform cookies are stored server-side**, and nothing is marked done unverified.
7. **Adaptive loop** — two granularities: the **next-action recommender** (tactical, after each action) proposes the next step from current state; the **Growth Analyst** (strategic, per-action light + weekly deep) analyzes activities + live market position + conversion data and proposes **re-personalized waypoint/plan changes** toward the objective. Both land as `proposed` items in the approval queue with rationale; the plan drifts from borrowed playbook to bespoke.
8. **Timeline** — a cockpit evolution view: event markers (route start, case chosen, subagent added with rationale, assets shipped, plan revised with why, milestones) + a **traction trajectory** (clicks/waitlist/conversions) + agent-written **phase summaries**. Backed by existing tables + a `TimelineEvent` model Dionysus uses to promote significant moments.

## 7. Autonomy & approval policy (D10)

A per-action-class **trust policy** the founder sets, reconciling "live/unattended" with "founder veto":

- **always-ask** — high-stakes (a launch post, anything novel/off-playbook, budget-relevant): full draft-review + approval every time.
- **batch-review** — medium (weekly threads, routine posts): produced and queued; founder reviews a batch.
- **auto** — low-risk (replies to clearly positive comments, internal analysis): runs unattended, logged to the timeline, reversible.

Autonomy interacts with §6.6: at low autonomy the founder posts (their browser) and the product verifies the public URL; a founder can **connect a platform account (OAuth)** and grant an action class the autonomy for Dionysus to post via that platform's **official API** and report back (still verified by the returned ID, still logged, still reversible). Hermes's built-in command-approval backstops dangerous tools regardless. **Expensive-generation exception:** video is never fully `auto` — it always requires the pre-generation storyboard gate (founder approves the storyboard before any Kling call) so credits are never spent on an unapproved concept.

**Founder-attention budget (D22).** The approval queue is digest-first: non-urgent items batch into one daily review (target ≤10–15 min/day); only time-sensitive or high-stakes items interrupt. The cockpit instruments **edit-distance on approved drafts** — rising edit rates are the leading indicator that approval is degenerating into editing (the category's verified month-four churn pattern) and trigger voice/skill recalibration before the founder churns. **Platform-audit cap:** TikTok/Meta/YouTube app audits review the human-consent UX (TikTok requires per-post privacy selection by the creator), so the `auto` tier is additionally capped per platform by what its audit posture permits (D19).

## 8. MCP tool server (`dionysus-mcp`, Node/TS)

Wraps proven TS plumbing + owns structured persistence. Zod-typed tools: `read_product(url)` (SSRF-guarded ladder → `Product`), `extract_brand(url)` (**deterministic** CSS colors/fonts → `BrandKit`; brand *judgment* — tone/taglines/palette curation — is the Designer *skill*, not this tool), `build_agent_context(businessId, role, routeId)` (one call returns the full memory-graph traversal — keeps the hot path to a single round-trip, not many), `persist_asset/route/waypoint(...)`, `record_cost(...)` (→ `LlmCall`, unpriced→null), `check_budget(businessId)` (fail-closed), `verify_post(url)` (fetches a public post URL to confirm the post exists — the D9 verification), `record_outcome(routeActionId, metrics)`, `click_stats(businessId, since)`, `goal_progress(businessId)` (proxy metrics until analytics connected, real conversions after — D21), `generate_video(storyboard)` (Kling via `kling-mcp`; metered/capped; post-storyboard-approval only). Reuses `lib/ssrf.ts`, `lib/scrape/*`, `config/prices.ts`, `lib/llm/pricing.ts` and keeps their vitest suite. **The hot path is this one server; the graphify / kling / mirofish MCP servers are cold — called only on the consolidation cadence, for video, or for high-stakes simulation.**

## 9. Surfaces

- **Chat:** Hermes gateway (Telegram + web-chat) — day-to-day, approvals, nudges.
- **Cockpit** (existing Next.js, extended): route + waypoint view; the **draft-review view** (draft + chat bar + approve/send); the **subagents store** (backed by Hermes Skills Hub + curated bundles); the **timeline**; a **live-activity panel**; budget + audit. **Data dependencies are deliberately minimal**: it *reads* authoritative state from **Prisma** (route/queue/timeline/budget); it *drives + observes* the agent via `api_server` — **confirmed a full control plane (verified 2026-07-09):** run creation (`POST /v1/runs`), SSE event streams of tool calls/lifecycle, human-approval endpoints (`/v1/runs/{id}/approval`), and a session REST API — while activity rows persisted to Prisma by `dionysus-mcp` tools + Hermes hooks remain the authoritative record. All cockpit→profile traffic passes through **our auth/rate-limit proxy** (D24; upstream auth is a single static token with no rate limiting).
- **Auth:** existing magic-link gates the cockpit and maps a business to its profile.

## 10. Data model

**Keep:** `Product`, `BrandKit`, `Asset`, `LlmCall`, `Business`, `WaitlistEntry`, `ClickEvent`, `Referral`, `FeedbackEvent`.
**Add:**
- `Objective { businessId, kind, target, metric, dueDate?, status }` — the north star (D12).
- `Route { id, businessId, objectiveId, source: case|composed, caseRef?, status }`.
- `RouteWaypoint { id, routeId, order, title, goal, status: locked|active|done }`.
- `RouteAction { id, waypointId, employeeRole, type, status: proposed|approved|executing|executed|rejected, rationale?, features?(json), metrics?(json), outcome?, verifiedAt? }` — `features` (channel/format/hook/timing/audience/mode) + `metrics` (captured outcome numbers) power the learning loop's attribution.
- `RouteStaffing { routeId, subagentId, source: dionysus|founder, rationale?, addedAt }`.
- `MemoryNode { id, businessId, type, role?, waypointId?, title, body, confidence, ts }` — the evolution graph's nodes (type ∈ waypoint|action|outcome|learning|market-observation|case|revision). Subsumes the old flat `EmployeeMemory` (per-employee craft = `learning` nodes tagged with role).
- `MemoryEdge { id, businessId, fromId, toId, kind }` — kind ∈ next|caused|informed-by|supersedes|references. `@@index([businessId])` on both; all queries `businessId`-scoped.
- `TimelineEvent { businessId, kind, title, detail, significance, ts }` — significant moments Dionysus promotes; the Timeline and the memory graph's `graph.html` are two views of the same evolution.
- `SimulationResult { businessId, routeActionId, engine: focus_group|mirofish, prediction(json), confidence, ts }` — pre-flight prediction attached to an action; rendered as a labeled prediction, never fact.
- `Case { businessId, name, platform, historicalArc(json), modernizedPlan(json), insight, mode, rank, sources(json), confidence }` — the 5 discovered cases; `sources` links each historical claim to a real URL (EXTRACTED vs INFERRED), surfaced in the brief so the founder (and judges) can check.
- `Integration { businessId, kind: analytics|platform_oauth, provider, config(encrypted), status }` — connected analytics (real conversions for `goal_progress` / the learning loop) + platform OAuth tokens (ToS-permitted auto-posting, D19); secrets encrypted at rest.
**Retires (superseded by Hermes):** `CampaignStep` + the deterministic step-engine; the *global* `RunSummary` memory role (→ Hermes memory for Dionysus; the evolution graph for employees); the flat `EmployeeMemory` table (→ role-tagged `learning` nodes in the memory graph; the assembly pattern is reused as graph traversal); Stage-1 row-based tenancy (→ profiles, Prisma reads still `businessId`-scoped).
**Two stores:** Prisma (structured state, cockpit reads) + Hermes `state.db` (agent memory/sessions).

## 11. Guardrails (constitution)

Four levels: **bundle `instruction`** (no fabricated numbers/stats/testimonials; obey channel self-promo norms verbatim; drafts only) + **the reasoning standard's verify loops** (§3) + **the approval queue with verified send** (§6.6, public-URL / official API) + **MCP `check_budget`** (fail-closed) — backed by Hermes command-approval and the SSRF guard. A norm-violating post is refused/flagged by the Copywriter, quoting the rule. Simulation output (Simulator or MiroFish) is always labeled a *prediction*, never fact — the no-fabricated-numbers rule extends to synthetic-crowd metrics. Likewise a learning/belief is only as strong as its linked evidence; weak-evidence beliefs are labeled *low-confidence*, never asserted as established fact. **Outreach is personalized, approval-gated, and non-mass** — Dionysus pitches real people one at a time with a founder-approved message, never spray-and-pray; the anti-spam ethos extends to earned-media outreach exactly as it does to channel posts. **Discovery's historical claims are source-cited (EXTRACTED) or labeled INFERRED** — the no-fabricated-numbers rule covers reconstructed marketing history, since that beat drives the whole strategy phase. Platform-ToS compliance, prompt-injection fencing + capability sandbox, and honest proxy-vs-real measurement are the fifth level — see Compliance, security & measurement (D19–D21).

## Cost envelope & tiers

The architecture is ambitious per business, so cost is a first-class constraint, not an afterthought. Four mechanisms keep per-business spend under a healthy fraction of the tier price:

- **Model tiering does the heavy lifting.** The frontier coordinator spends few tokens (plan/review); the 12 workers run on cheap/free models (NVIDIA-free / Nous-Portal for prototyping, cheap paid at scale). The cost ledger (§8 `record_cost`) measures the split live.
- **Duty-cycle the always-on parts.** The Social Media Manager does not stream continuously — it *polls* on a cron cadence + reacts to hooks, so the profile hibernates (Modal/Daytona) between ticks. "Always-on" means reachable + scheduled, not continuously inferring. Sensing carries hard per-platform budget lines: X reads are pay-per-use (~$0.005/read — naive continuous polling ≈ $1.5k/mo, never that), and URL-bearing X posts cost ~$0.20 each (13× base); the ledger records both.
- **Gate the expensive layers by tier.** graphify consolidation cadence (e.g. weekly on Launch, daily on Scale), MiroFish (Scale / pay-per-use), video generation (metered credit add-on), Simulator depth (few personas on Launch, more on Scale) — each maps to `Business.maxTokensPerDay` + per-tier feature flags.
- **The per-business daily budget (fail-closed) is the backstop.** Tiers set `maxTokensPerDay`; exceeding it pauses gracefully.

**Design constraint:** tiers start at **≥ $99/mo, credit-metered from day one** (D23 — sub-$50 AI tools show ~23% gross revenue retention; metering is never introduced retroactively), and per-business monthly LLM+compute spend should sit at ≤ ~30–40% of the tier price (healthy SaaS gross margin). The mechanisms above enforce it; the real number is **measured by the cost ledger once the spine runs** (build stage 1), not asserted — consistent with the no-fabricated-numbers ethos. Container-per-business ops (how many concurrent business containers a host runs) is sized against the same measurement.

## Compliance, security & measurement (D19–D21)

Three context-level risks the first (technical) review missed, resolved here.

**Platform ToS compliance (D19).** The promise is "won't get you banned," so the product must not itself break platform rules. **Assisted-manual posting is universally compliant and the only mode on community/launch channels** (Reddit/HN/Product Hunt — founder posts; product verifies the public URL). **On owned feeds, connected-API auto-posting is the post-approval default where a platform's ToS explicitly permits automation** (D9, amended 2026-07-09), via official APIs with founder OAuth — never where prohibited, never via credential-replay browser automation. **Sensing prefers official APIs / RSS / the founder's own connected read-scope over scraping**; where a platform forbids scraping, the Social Media Manager senses by permitted means only. Each channel in the store carries a **ToS posture** (auto-post allowed? scraping allowed? API available?) that Dionysus respects — "channel norms are law" extended to platform ToS. `verify_post` prefers the platform API, falling back to a single public fetch of a founder-provided URL (reading one's own public post is generally fine).

The registry's current facts (verified 2026-07-09; economics/policy re-checked per platform before each channel ships):

| Platform | Auto-post API | Listening | Posture |
|---|---|---|---|
| Reddit | ✗ — ToS prohibits promo bots; free tier non-commercial; new OAuth apps manually approved; anti-slop AI removes ~25k posts/day | ✗ commercial-only, hand-negotiated | **assisted-manual only — the flagship compliance story** |
| X | ✓ pay-per-use ($0.015/post; $0.20 with URL) — API automation ToS-clean | metered ($0.005/read, 2M/mo cap) | connected-API default; listening budget-capped |
| LinkedIn | ✓ Community Management API (legal entity + tier approval; ~100 posts/day/member; 60-day tokens) | ✗ no public search/feed API | connected-API after approval |
| Product Hunt | ✗ no launch mutation in the v2 API | ✓ free read API | launch is a human step; monitoring via API |
| TikTok | ✓ post-audit only (unaudited: 5 users, private-only); per-post human privacy selection required | ✗ | audit reviews human-consent UX — constrains `auto` |
| Instagram | ✓ business/creator accounts only; 25 posts/day cap; Meta app review | limited (30 hashtags/7d + mentions webhooks) | connected-API after review |
| YouTube | ✓ quota-bound (no paid tier; unaudited-project uploads locked private) | thin (search quota) | connected-API after audit |

**Prompt-injection hardening + capability sandbox (D20).** Dionysus ingests untrusted content everywhere (scraped sites, competitor pages, social posts, case-study pages, outreach replies) and runs on Hermes, which ships terminal + `execute_code` + browser tools. So: (1) **all ingested external content is fenced as untrusted DATA, never instructions** — the memory-fence pattern (D13) applied to everything read from the open web; (2) **marketing profiles run with `execute_code`, terminal, and filesystem tools DISABLED** — a marketing agent never needs arbitrary code execution, and removing it removes the worst injection blast radius. The only actions are the Zod-typed, `businessId`-scoped MCP tools; browser tools read/verify public pages only (no auth actions). Hermes command-approval + the human approval gate are defense-in-depth; the real boundary is *fenced content + no code-exec + typed tools only + isolation*.

**Real-outcome measurement (D21).** The objective is "first 100 users," but users sign up on the *founder's* product — invisible to Dionysus without a connection. A **first-class analytics integration** (GA4 / Plausible / PostHog, a read-only DB connection, or a lightweight Dionysus snippet) feeds `goal_progress` and the learning loop **real conversions**, not just tracked-link clicks; **Google Search Console** joins the same integration family (free API — search/ranking data for the learning loop and the SEO/AEO Strategist, D25). Until connected, the system is honest: it optimizes **proxy** metrics (clicks, waitlist) and labels objective progress "proxy-based — connect analytics for real conversion data." The no-fabricated-numbers ethos forbids claiming "users" it can't measure. Connected credentials (analytics + platform OAuth) live in `Integration`, encrypted at rest.

## 12. Provisioning & deploy

On sign-in: provision the profile **in its own container** (`hermes -p biz_<id>` — D5), seed the `cmo/` skill pool + mode-bundles + employee bundles + the `reasoning-standard` skill, register standing cron routines, start the gateway behind the auth proxy. **Deploy:** Hermes is a long-running process — one container/VM per business via Docker / Modal / Daytona (serverless hibernate, ~free when idle, fits "free credits for prototyping"); the Hermes version is **pinned**, upgrades staged + soak-tested (D24). Cockpit stays on Vercel over `api_server` (through the proxy). Model: NVIDIA-free / Nous Portal for prototyping; swap to paid per role when quality pays.

## 13. What carries / retires

- **Carries:** SSRF guard, scrape ladder, brand extraction, cost pricing, the Prisma schema base, the dashboard UI, magic-link auth, eval-fixture discipline, provider learnings.
- **Repurposed:** budget guard → `check_budget` MCP tool; provider seam → Hermes model config; cards → cockpit views over MCP-written rows.
- **Retires:** deterministic step-engine + fixed arc; hand-rolled global memory; row-based tenancy. Accepted cost of the pivot.

## 14. Error handling

MCP tools: Zod-validated, structured errors the agent can reason about/retry; SSRF and budget fail closed; tier-4 scrape returns the designed "couldn't read" result. Verified-send failures (post didn't land) mark the action `approved` but not `executed`, and surface for retry — never a false "done." Agent-off-rails contained by drafts-only + verified send + approval + autonomy policy + Hermes command-approval. Memory writes non-blocking; budget/verify checks block.

## 15. Testing

- **MCP tools:** existing vitest suite (83 tests) + per-tool wrapper/persistence tests.
- **Reasoning standard:** eval fixtures assert the verify-checks — strategy cites ≥2 SWOT + rejects 2 modes; content has no ungrounded number + quotes the norm; revisions touch only the targeted element (minimal-change check).
- **Department:** a scripted delegation run (Hermes local backend, mock model) asserts expected employee delegations, persisted rows, and that nothing reaches `executed` without an approval + a verify.
- **Execution:** browser-verify path tested against a fixture platform page (post-present assertion) incl. the failure path (post absent → not `executed`).
- **Cockpit:** Playwright on route/waypoint view, draft-review chat, timeline, live panel.
- **Memory graph:** node/edge writes, `buildAgentContext` waypoint traversal (ancestor path + neighborhood + role scope, ordering/cap), supersede-edge staleness, `businessId` isolation on every read/write, and the graphify consolidation rebuild.
- **Learning loop:** feature-tag attribution (`caused` edges), belief-confidence update (evidence ±, recency decay), supersede on contradiction, evidence-weighted explore/exploit selection toward the objective, and weak-evidence labeling.
- **Attention budget:** digest batching, interrupt-class routing, and edit-distance capture on approved drafts (D22).

## 16. Open questions

### Resolved by the risk stress-test (2026-07-09)

1. ~~`delegate_tool` interface for per-subagent pinning~~ → **Closed (negative).** The tool is `delegate_task`; it pins context + toolsets per call but **not model or bundle**, and MoA is a per-response ensemble, not per-role routing. Per-role assignment lives in our delegation wrapper (D24). Remaining sub-question: wrapper mechanism — inline skill content into `context` vs per-role profiles.
3. ~~`api_server` shape~~ → **Closed (positive).** A full control plane: `POST /v1/runs`, SSE event streams (tool calls/lifecycle), approval endpoints, session REST + chat streams. The cockpit rides it directly, behind our proxy (D24).
4. ~~Which platforms expose official post APIs~~ → **Closed**, encoded as the D19 registry table: X (pay-per-use), LinkedIn (entity + tier approval), TikTok/Instagram/YouTube (post-audit/capped) — yes; Reddit and Product Hunt — no (assisted-manual / human step). Remaining sub-question: whether TikTok/Meta/YouTube audits approve an *agent-posting* UX at all (audits review human-consent flows).
7. ~~Kling integration~~ → **Closed.** Official public API confirmed (Singapore endpoint, prepaid packages) + existing community MCP wrappers (`199-mcp/mcp-kling` et al.); fal.ai/PiAPI/Higgsfield MCP servers are real fallbacks (the "Motion MCP" does not exist). Remaining: official per-unit pricing (page bot-blocks; ~$0.70/5s clip per resellers) + per-video cap tuning.
10. ~~Per-platform ToS/API registry~~ → **Closed** into the D19 table (with the audit-posture caveat in item 4).

### Still open

2. graphify integration specifics: corpus export format + rebuild cadence, MCP server wiring per profile, and the semantic-pass cost per rebuild. Whether the Prisma evolution graph is the sole live substrate (assume yes; Hermes memory stays cognitive-only). (Repo verified healthy 2026-07-09: MIT, very active, ships an MCP server — but it's a coding-assistant tool; marketing corpora exercise only its document pathway.)
5. Cross-profile routing if an always-on employee is promoted to its own profile.
6. MiroFish integration: REST backend exists but it's a monolithic Vue+Python app — sidecar-isolate it (AGPL-3.0 verified; legal review before commercial launch); per-simulation cost cap (upstream warns "high consumption," recommends <40 rounds, publishes no cost data); requires an OpenAI-compatible endpoint + Zep Cloud. **Staleness watch: no pushes since late May 2026.**
8. Real per-business monthly cost — measured by the cost ledger once the spine runs (build stage 1); tier cadences/gating tune to the Cost & tiers margin target. Also: max concurrent business containers one host can run.
9. Whether graphify's code/doc-oriented graph extraction produces useful *marketing* knowledge — validated in build stage 5; our own live graph + queries is the guaranteed fallback if it underperforms.
11. Which analytics providers to support first (GA4 / Plausible / PostHog / read-only DB, + Google Search Console for search/ranking data — feeds D25) for real-conversion measurement (D21).
12. *(new)* Reddit commercial API pricing is unverified third-party reporting (~$12k/mo minimum) — moot unless a compliant Reddit listening use-case emerges.

## Thesis risks (validated by building, not speccing)

Three risks no amount of spec-writing resolves — they're answered by getting one real business through the loop (build stages 1–2). Recorded so they're chosen knowingly, not stumbled into.

- **Framework bet (Hermes).** The architecture is deeply coupled to Hermes's skills/bundles/profiles/delegate/memory. Hermes is young (v0.18, fast-moving) and its profile-per-user model targets a solo operator, not a multi-tenant SaaS. **Verified (2026-07-09):** profiles are state-scoped, not sandboxed; core memory operations bypass the hook system (upstream multi-tenant issue with a documented cross-tenant leak, maintainer-unanswered); `delegate_task` lacks per-role model/bundle pinning; churn runs ~250k changed lines per fortnight with uncataloged migrations; no public multi-tenant SaaS on Hermes exists. **De-risk:** the bet proceeds only with D24's insulation layer + D5's container requirement; stage 2's exit criterion is proving containerized provisioning + isolation on real profiles; keep the MCP boundary thick so the *business logic* isn't Hermes-specific — noting honestly that the department layer (bundles/personas/skills) is Hermes-native and is a rewrite if the bet fails.
- **PMF tension (autonomy vs effort).** The safe default is high-touch, yet the founder pays *because they're out of time*. If the trustworthy default is laborious, the value prop erodes. **Stress-tested (2026-07-09):** the market has converged on approval-gated drafts (Jasper, HubSpot Breeze, Blaze — the category's best-rated products all gate) and there is no evidence of churn from the gate itself; the verified failure mode is **approval degenerating into editing** (Jasper's month-four wall; Sintra's ideas-8/execution-2 collapse), and the accepted norm on owned feeds is approve → API auto-publish, not manual posting. **De-risk:** owned-feed default flipped to connected-API (D9), founder attention budgeted + edit-distance instrumented (D22), and real founders through the loop to tune the line further.
- **Compounding-moat reality.** Small businesses generate tiny N; the belief layer may never reach useful confidence before churn, and the Simulator's synthetic signal is itself unvalidated. "Gets smarter over time" may stay weak for the typical user. **De-risk:** measure real belief-confidence trajectories on early businesses; validate the Simulator against a few real outcomes before trusting it; if the per-business moat is thin, cross-business learning (currently out of scope) may be where the compounding actually lives. **Partially resolved by reframe (2026-07-09):** attribution *visibility* is the category's verified retention driver even at small N (D16, amended) — stage 5 delivers customer-visible value before, and whether or not, N ever supports autonomous optimization.

## Optional enhancements (gated)

**Deep market simulation (MiroFish, D14).** A process-isolated [MiroFish](https://github.com/666ghj/MiroFish) service (multi-agent OASIS-based social simulation) that Dionysus calls via an MCP tool for high-stakes moments (launch posts, major pivots) to predict crowd reaction at higher fidelity than the in-house Simulator. **Three prerequisites gate shipping it:** (1) a hard per-simulation **cost cap** — thousands of interacting agents can dwarf the rest of Dionysus's spend; (2) **AGPL-3.0** handling — run as a separate service called over an API, never code-linked into the proprietary app, with legal review before commercial launch; (3) **prediction-labeling** — outputs surfaced strictly as predictions. Off the critical path; the in-house Simulator (core) is the everyday pre-flight.

## 17. Build order (staging, no dates)

**Prerequisite:** import the existing Next.js prototype (SSRF guard, scrape ladder, brand extraction, Prisma schema, 83-test vitest suite) into this repo — `D:\Dionysus` currently contains only this spec.

1. `dionysus-mcp` server wrapping existing TS plumbing + persistence (proves the bridge; reuses tests). Measure real per-business cost via the ledger to validate the Cost & tiers envelope early. (`api_server` shape is now verified — stage 1 confirms it empirically behind our proxy.)
2. One business profile + Dionysus coordinator skill + `reasoning-standard` skill + Market Historian & Strategist end-to-end on a real URL → **Discovery + Case brief** (the reasoning spine). Capability sandbox (no `execute_code`/terminal/filesystem) + untrusted-content fencing (D20) from the first profile. Profile runs **containerized** on a **pinned Hermes version**, behind the **auth/rate-limit proxy**, through our **per-role delegation wrapper** (D5, D24) — **proving containerized multi-tenant isolation is this stage's exit criterion.**
3. Objective + Route/Waypoints + start-of-plan iteration; Copywriter parallel fan-out.
4. Draft-review view + Simulator pre-flight + **verified send with the channel-class defaults** (connected-API auto-publish on owned feeds; assisted-manual + `verify_post` public-URL verification on community/launch channels — D9) + the approval digest + edit-distance instrumentation (D22) + outcome capture (closes the loop).
5. Memory graph (`MemoryNode`/`MemoryEdge` + `buildAgentContext` traversal) and graphify consolidation/MCP; the learning loop (feature-tagged attribution, evidence-weighted beliefs, explore/exploit decision policy); the next-action recommender + Growth Analyst re-personalization reading the graph; analytics integration (D21) so the loop measures real conversions, not just proxies.
6. Autonomy policy; remaining employees (Social Media Manager [duty-cycled always-on/dedicated daemon], Designer, Analyst, Videographer, Outreach/PR Manager, Conversion Optimizer, SEO/AEO Strategist [D25 — lands last in this stage; needs the GSC integration]); the six mode-bundles. Videographer's `kling-mcp` (wrapping the official Kling API / an existing community MCP server) + two-gate/cost cap lands here. CRO reuses `read_product`; Outreach uses the verified-send path over email/DM. Channels carry the D19 registry's ToS posture; connected-API posting only where a platform permits.
7. Subagents store surface; Timeline; provisioning automation + deploy (Modal/Daytona) + live-activity panel.
8. (optional, gated) MiroFish deep market simulation as a process-isolated MCP service — see Optional enhancements.
