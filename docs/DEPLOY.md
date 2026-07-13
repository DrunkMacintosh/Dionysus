# DEPLOY — the dogfood bootstrap runbook (Windows-first)

Run the built Dionysus system for real on this machine: a fail-closed **preflight doctor**,
idempotent **business provisioning**, a local **LLM gateway**, the **cockpit**, and the
**nightly** on a schedule. The core loop was executed against a scratch database as this stage's
acceptance — exactly the steps listed in [§10](#10-what-was-actually-executed-acceptance).
Commands that need a real external account or a machine-level change are called out as
**FOUNDER-ONLY** and were *not* run here; two commands are documented-but-unverified and say so
inline (the cockpit server serving requests in §4, and the live discovery smoke in §8).

Shell is **PowerShell** (Windows PowerShell 5.1 or PowerShell 7). Chain steps with `;`.
Git Bash is broken on this box — do not use it.

---

## 1. Prerequisites & build

- **Node 22+** (verified here: Node v24.18.0) and **pnpm 9** (verified here: pnpm 9.15.0).

```powershell
node --version        # expect v22+ (v24.18.0 here)
pnpm --version        # expect 9.x  (9.15.0 here)
pnpm install          # installs the workspace; postinstall runs `prisma generate`
```

Build in dependency order (mcp is the shared core, department and cockpit depend on it):

```powershell
pnpm -F dionysus-mcp build ; pnpm -F department build ; pnpm -F cockpit build
```

> `pnpm -F cockpit build` runs `next build`. The other two run `tsc`. If a build fails, fix it
> before continuing — the CLIs below import from each package's `dist/`.

---

## 2. The production database

Dionysus uses SQLite via Prisma. **Prisma resolves relative `file:` URLs against the schema
directory (`packages/dionysus-mcp/prisma/`), not the repo root** — so in production use an
**absolute** path to avoid surprises:

```powershell
# Pick a real, backed-up location and create the folder:
New-Item -ItemType Directory -Force -Path D:\Dionysus\data | Out-Null
$env:DATABASE_URL = "file:D:/Dionysus/data/dionysus.db"   # ABSOLUTE — the safe choice

# Create / migrate the schema:
pnpm -F dionysus-mcp exec prisma db push
```

Back up by copying the file while no writer is active:

```powershell
Copy-Item D:\Dionysus\data\dionysus.db "D:\Dionysus\data\dionysus.$(Get-Date -Format yyyyMMdd-HHmmss).bak"
```

`DATABASE_URL` must be set in **every** terminal/process that talks to the DB (gateway is the one
exception — it does not open the DB itself; the cockpit, provision, login-link, nightly and
preflight all do).

---

## 3. Secrets generation (PowerShell)

Two secrets are 32 random bytes, base64-encoded. **Use the `RandomNumberGenerator` instance API** —
the static `::GetBytes(int)` overload does **not** exist on Windows PowerShell 5.1 (.NET Framework);
the instance form below works on both 5.1 and 7:

```powershell
# DIONYSUS_CONFIG_KEY — base64 of EXACTLY 32 bytes (AES-256 key for analytics-config decryption).
$b = New-Object 'byte[]' 32 ; ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($b) ; [Convert]::ToBase64String($b)

# COCKPIT_SESSION_SECRET — 32 random bytes -> 44-char base64 (>= 16 chars, so preflight passes).
$s = New-Object 'byte[]' 32 ; ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($s) ; [Convert]::ToBase64String($s)
```

Each prints a 44-character base64 string that decodes to exactly 32 bytes. **Do NOT** use
`Get-Random` for key material — it is not a cryptographic RNG.

Put them (and the rest of the environment) in a **dot-sourced** PowerShell file you **never commit**.
Create `.env.dogfood.ps1` at the repo root:

```powershell
# .env.dogfood.ps1  —  SECRETS. Never commit (already gitignored via .env.*.ps1).
$env:DATABASE_URL         = "file:D:/Dionysus/data/dionysus.db"
$env:DIONYSUS_BUSINESS_ID = "dogfood-co"                      # the gateway runs as this business
$env:DIONYSUS_CONFIG_KEY  = "<paste-the-44-char-base64>"      # from the one-liner above
$env:COCKPIT_SESSION_SECRET = "<paste-the-44-char-base64>"    # from the one-liner above
$env:COCKPIT_BASE_URL     = "http://localhost:3000"           # where cockpit is reachable
$env:GATEWAY_UPSTREAM_URL = "<your-model-provider-base-url>"  # FOUNDER: a real provider, e.g. .../v1
$env:GATEWAY_UPSTREAM_KEY = "<your-model-provider-api-key>"   # FOUNDER: the upstream key
$env:GATEWAY_TOKEN        = "<a-shared-local-token>"          # gateway <-> nightly shared secret
$env:GATEWAY_LOCAL_URL    = "http://127.0.0.1:8787/v1"        # where the nightly calls the gateway
```

> `.gitignore` already covers the secrets file and the runtime artifacts (`.env.*.ps1`, `data/`,
> `logs/`, `*.db`) — verify with `git check-ignore .env.dogfood.ps1 data logs` before you create
> them. **`.env.dogfood.ps1` is the ONLY place secrets live on disk**; every other script
> dot-sources it and contains none.

Dot-source it into any terminal that needs the env:

```powershell
. .\.env.dogfood.ps1
```

---

## 4. Run the services (each in its own terminal)

**Terminal A — the LLM gateway** (a local, `127.0.0.1`-only metered proxy). It refuses to start
without `DIONYSUS_BUSINESS_ID` (ambient identity, D27.1) **and** `GATEWAY_UPSTREAM_URL`
(fail-closed, D28):

```powershell
. .\.env.dogfood.ps1
pnpm -F dionysus-mcp start:gateway
# -> llm-gateway up for dogfood-co on 127.0.0.1:8787 -> <upstream> (D28 hard cap active)
```

Optional gateway env: `GATEWAY_PORT` (default **8787**), `GATEWAY_TOKEN` (when unset the gateway
accepts unauthenticated *local* callers — a WARN, not a failure).

**Terminal B — the cockpit** (Next.js founder UI). Needs `DATABASE_URL` and a
`COCKPIT_SESSION_SECRET` of at least 16 chars:

```powershell
. .\.env.dogfood.ps1
pnpm -F cockpit start          # serves http://localhost:3000 (run `pnpm -F cockpit build` first)
```

---

## 5. Provision a business & issue the first login link

Provisioning is validated and **idempotent** — re-running by the same id updates name / owner /
cap and never duplicates or destroys child rows:

```powershell
. .\.env.dogfood.ps1
# node scripts/provision-business.mjs <id> <name> <ownerEmail> [maxTokensPerDay]
pnpm -F dionysus-mcp provision dogfood-co "Dogfood Co" founder@example.com
# -> provisioned dogfood-co (created) — owner founder@example.com, cap 100000 tokens/day
# -> NEXT: issue a login link — node packages/cockpit/scripts/issue-login-link.mjs dogfood-co founder@example.com
```

`id` must match `^[a-z0-9_-]{3,40}$`, `ownerEmail` must look like an email, and
`maxTokensPerDay` (optional, default 100000) must be a positive integer — otherwise it exits 1
with the validation message and writes nothing.

Issue a magic login link. This script imports the mcp DB layer; run it **from the repo root**
(verified) with `DATABASE_URL` set — it also works from `packages/cockpit` (verified). It prints a
URL (15-minute expiry); open it in the browser to sign in. The link's host comes from
`COCKPIT_BASE_URL` (default `http://localhost:3000`):

```powershell
. .\.env.dogfood.ps1
node packages/cockpit/scripts/issue-login-link.mjs dogfood-co founder@example.com
# -> http://localhost:3000/auth/<token>
```

---

## 6. The nightly on a schedule

The nightly sweep (`pnpm --filter department nightly`) wakes every business for one unattended
routine — radar → metrics → learn → strategy → drafts — each section best-effort and
per-business isolated. Per-section failures are **reported, not fatal**: the sweep prints a JSON
report and **exits 0**.

Save this wrapper as `D:\Dionysus\scripts\run-nightly.ps1`. It sets the env, runs the sweep, and
appends stdout+stderr to a dated log. It uses **cmd-level redirection** (`cmd /c "... >> log 2>&1"`)
on purpose: PowerShell 5.1 wraps a native command's stderr as a terminating `NativeCommandError`,
so a naive `... 2>&1 | Out-File` (especially with `$ErrorActionPreference='Stop'`) would abort the
wrapper on the nightly's harmless "config key not set" notice **before** the report is written.
The form below was verified to append the full report and the exit marker:

```powershell
# D:\Dionysus\scripts\run-nightly.ps1 — the scheduled nightly wrapper.
# NO SECRETS LIVE HERE: the env (DATABASE_URL, DIONYSUS_CONFIG_KEY, GATEWAY_LOCAL_URL,
# GATEWAY_TOKEN, ...) is dot-sourced from the gitignored .env.dogfood.ps1 — this wrapper
# is safe to commit, and a `git add -A` can never pick up a credential from it.
Set-Location "D:\Dionysus"
. .\.env.dogfood.ps1
$logDir = "D:\Dionysus\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("nightly-{0:yyyy-MM-dd}.log" -f (Get-Date))
("`n==== nightly {0:o} ====" -f (Get-Date)) | Out-File -FilePath $log -Append -Encoding utf8
cmd /c "pnpm --filter department nightly >> `"$log`" 2>&1"
("==== exit {0} ====" -f $LASTEXITCODE) | Out-File -FilePath $log -Append -Encoding utf8
```

**FOUNDER-ONLY — register the scheduled task** (this changes machine state; it was *not* run here).
Registers a daily 03:00 task that runs the wrapper:

```powershell
schtasks /Create /TN "Dionysus Nightly" /SC DAILY /ST 03:00 /RL LIMITED /F `
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\Dionysus\scripts\run-nightly.ps1\""
```

Inspect, run on demand, or remove it:

```powershell
schtasks /Query  /TN "Dionysus Nightly"
schtasks /Run    /TN "Dionysus Nightly"
schtasks /Delete /TN "Dionysus Nightly" /F
```

---

## 7. Preflight — run before the first boot and after any env change

The preflight doctor is **fail-closed**: it FAILs only when a service genuinely cannot work, and
WARNs on degradable config. It never prints a secret value — only presence/length/byte-count.

```powershell
. .\.env.dogfood.ps1
pnpm -F dionysus-mcp preflight            # all services; also: preflight gateway | cockpit | nightly
```

Reading the output — three tags:

- **[PASS]** — the check is satisfied.
- **[WARN]** — degradable; the service still runs. Examples: `GATEWAY_TOKEN` unset (unauthenticated
  local callers), `COCKPIT_BASE_URL` unset (magic links print `localhost`), `DIONYSUS_CONFIG_KEY`
  unset (metric ingestion skipped), `GATEWAY_LOCAL_URL` unset (defaults to `127.0.0.1:8787/v1`).
- **[FAIL]** — the service refuses to work. Examples: `GATEWAY_UPSTREAM_URL` unset ("the gateway
  refuses to boot without an upstream"), `COCKPIT_SESSION_SECRET` shorter than 16 chars
  ("sessions would be weak"), `DATABASE_URL` unset or the DB unreachable, a malformed
  `DIONYSUS_CONFIG_KEY` (a wrong key silently corrupts every decrypt — worse than absent).

Exit code is **0 iff there are no FAILs** (warnings do not fail the exit).

---

## 8. Bootstrapping objectives & routes (operator path)

A freshly-provisioned business has no objective yet, so the nightly's radar/learn/strategy/drafts
sections honestly **skip** ("no objective to sense against", etc.). The current operator path to
seed an objective + route and exercise the discover/propose pipelines is the department live-smoke
script:

```powershell
. .\.env.dogfood.ps1
pnpm -F department smoke        # node scripts/live-smoke.mjs — needs a working gateway upstream
```

A founder-facing onboarding flow (objective/route creation from the cockpit) is future work.

---

## 9. What still needs the founder (honest next-steps)

These are deliberately **not** automated here — they need a real account, key, or hosting decision:

- **GitHub push** — the `DrunkMacintosh` remote needs re-auth before the branch can be pushed.
- **A real model-provider key** for `GATEWAY_UPSTREAM_URL` / `GATEWAY_UPSTREAM_KEY` — the gateway
  proxies to whatever OpenAI-compatible upstream you configure; without a real one the nightly's
  model-calling sections fail honestly (see below).
- **A real analytics source** for cockpit `/connect` — until one is connected, metric ingestion
  reports `skipped`, not failed.
- **Hosting / the platform layer** — container-per-business, the wake webhook + HMAC, `TrustPolicy`,
  and push notifications remain deferred to the real platform layer (a founder decision).

---

## 10. What was actually executed (acceptance)

The core loop below was run end-to-end against a **scratch** DB
(`file:D:/Dionysus/data/dogfood-scratch.db`), then the scratch DB and logs were deleted. Results:

| Step | Command | Outcome |
|------|---------|---------|
| Schema | `prisma db push` (scratch DB) | OK — DB created, schema in sync |
| Provision (create) | `provision dogfood-co "Dogfood Co" founder@example.com` | OK — `created`, cap 100000 |
| Provision (idempotent) | re-run with cap `50000` | OK — `updated`, cap 50000, no dupes |
| Provision (invalid) | `provision AB ...` | OK — exit 1, `invalid id`, nothing written |
| Login link | `issue-login-link.mjs dogfood-co founder@example.com` | OK — printed `http://localhost:3000/auth/<token>` |
| Preflight (all) | secrets set + dummy upstream | OK — 6 PASS, 4 WARN, 0 FAIL, exit 0 |
| Preflight (FAIL taxonomy) | gateway w/o upstream; cockpit 8-char secret | OK — correct FAILs, exit 1, **no secret value shown** |
| Gateway boot | `start:gateway` with `DIONYSUS_BUSINESS_ID` | OK — `llm-gateway up ...`; refuses w/o the id |
| Nightly (gateway down) | `pnpm --filter department nightly` via the wrapper | OK — radar `failed` ("Connection error."), others `skipped`, **sweep exit 0**, log appended |

The nightly report under a downed gateway (verified) — honest per-section statuses, exit 0:

```json
[
  {
    "businessId": "dogfood-co",
    "radar":    { "status": "failed",  "reason": "Connection error." },
    "metrics":  { "status": "skipped", "reason": "no connected source or no reading" },
    "learn":    { "status": "skipped", "reason": "no route to learn from" },
    "strategy": { "status": "skipped", "reason": "plan working/young, no evidence target, or a revision already standing" },
    "drafts":   { "status": "skipped", "reason": "nothing undrafted on the active waypoint" }
  }
]
```
