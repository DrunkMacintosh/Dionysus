# department

The in-process Discovery department. `discover()` (see `src/discover.ts`) runs the
Discovery → Case-brief pipeline: budget pre-check → product read → historian agent
(web_search + fetch_page tools) → citation-entailment check → strategist agent →
persisted Case briefs. Every model call goes through the local **D28 gateway**
(`dionysus-mcp start:gateway`), which meters usage and forwards to an upstream
provider. Identity is ambient and per-process (D27.1) — never a tool parameter.

## Live smoke test (gated — needs real keys)

`scripts/live-smoke.mjs` is the live end-to-end test for the pipeline. It imports
the **built** `dist/` (`dist/llm/harness.js`, `dist/discover.js`), so build first:

```powershell
pnpm --filter department build
```

Then, with the gateway running and the env contract satisfied:

```powershell
pnpm --filter department smoke <product-url>
```

The script **fail-closes**: if any required env var — or the `<product-url>` argument
— is missing, it prints a clear message and exits non-zero (`exit 1`) without making
a model call. This is intentional: no keys, no run.

### Architecture: two hops

The department never talks to NVIDIA directly. It talks to the **local** gateway; the
gateway talks to NVIDIA:

```
live-smoke.mjs / discover()  ──►  local D28 gateway (127.0.0.1:8787)  ──►  NVIDIA hosted API
   department env below                gateway env below                integrate.api.nvidia.com
```

### Env contract — department (the smoke script)

Set these in the shell that runs `pnpm --filter department smoke <product-url>`:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DIONYSUS_BUSINESS_ID` | **yes** | — | Ambient identity (D27.1). A `Business` row with this id must exist (see setup below). |
| `BRAVE_API_KEY` | **yes** | — | Brave Search key for the historian's `web_search` tool. |
| `GATEWAY_LOCAL_URL` | no | `http://127.0.0.1:8787/v1` | Base URL of the **local** gateway the department calls. |
| `DEPARTMENT_BRAIN_MODEL` | no | `nvidia/nemotron-3-super-120b-a12b` | Model id used for both the brain (historian/strategist) and the citation judge. |
| `GATEWAY_TOKEN` | no | `local` is sent if unset | Inbound token for the gateway. If the gateway is started with `GATEWAY_TOKEN`, set the **same** value here so the call is accepted. |

### Env contract — gateway (`dionysus-mcp start:gateway`)

Set these in the shell that runs the gateway (a separate process/terminal):

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DIONYSUS_BUSINESS_ID` | **yes** | — | Ambient identity for the gateway process (must match the department's). |
| `GATEWAY_UPSTREAM_URL` | **yes** | — | `https://integrate.api.nvidia.com/v1` — NVIDIA's OpenAI-compatible endpoint. |
| `GATEWAY_UPSTREAM_KEY` | **yes** | — | Your NVIDIA `nvapi-…` key. The gateway attaches it upstream; it never leaves the local process. |
| `GATEWAY_PORT` | no | `8787` | Local port. If changed, update `GATEWAY_LOCAL_URL` on the department side. |
| `GATEWAY_TOKEN` | no | — | Optional inbound token. If set, the department must send the same value. |
| `DATABASE_URL` | **yes** | — | SQLite datasource (e.g. `file:./prisma/dev.db`). Also needed by the department for budget/persistence. |

> **NVIDIA is prototyping-only (D34).** The hosted NVIDIA API is dev tooling, not
> product traffic. The free tier is rate-limited to **~40 RPM**, so a full discovery
> run (historian tool-loop + per-case citation checks + strategist) is **slow** —
> expect minutes, not seconds.

### The two keys the founder must create

1. **NVIDIA API key** (`nvapi-…`) — create at **build.nvidia.com** (sign in → API
   keys). This is the gateway's `GATEWAY_UPSTREAM_KEY`.
2. **Brave Search API key** — create at **brave.com/search/api** (subscribe to a plan;
   the free tier is enough to smoke-test). This is the department's `BRAVE_API_KEY`.

Never commit either key. They are supplied via environment only.

### One-time setup: create the Business row

`checkBudget` fails closed on an unknown business (Spec §14): if no `Business` row
matches `DIONYSUS_BUSINESS_ID`, discovery is blocked before any model call. Create the
row (with a daily token budget) once, against the same `DATABASE_URL` the gateway and
department use — for example via a Prisma script or `prisma studio`:

```js
// from packages/dionysus-mcp, with DATABASE_URL set
import { prisma } from "./dist/db.js";
await prisma.business.create({
  data: { id: process.env.DIONYSUS_BUSINESS_ID, name: "Smoke Test Co", maxTokensPerDay: 200000 },
});
```

`maxTokensPerDay` defaults to `200000` if omitted. With the row present, the budget
pre-check passes and discovery proceeds.

### Run order (summary)

1. Create the NVIDIA `nvapi-…` key and the Brave key (above).
2. Create the `Business` row for your `DIONYSUS_BUSINESS_ID`.
3. `pnpm --filter department build` and `pnpm --filter dionysus-mcp build`.
4. Terminal A — start the gateway with its env contract:
   `pnpm --filter dionysus-mcp start:gateway`
5. Terminal B — with the department env contract set:
   `pnpm --filter department smoke https://example.com/your-product`
