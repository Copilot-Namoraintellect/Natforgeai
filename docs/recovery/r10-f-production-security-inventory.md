# R10-F — Production Security, Secrets & Trust Boundary Inventory (F0)

> Stream: `feature/r10-f-production-security` · Frozen base
> `799f6b4cb351ebe969f97da606324605fdf2a07b` (R9-X mission-control final
> acceptance). Date: 2026-11-10. Status: security inventory — determines the
> secret population, credential-loading code, and trust-boundary surface
> before any R10-F hardening.
>
> **Constraints honoured:** no OneGrid access, no real production secrets were
> read, copied, printed or committed during this inventory. Secret *values*
> are never reproduced here — only variable names, classes and locations.

## 0. Purpose

R10-F defines the production security architecture for the autonomous Mission
Control runtime: distinct least-privilege trust boundaries for autonomous
agents, application services, human administrators and external providers,
plus repository-level secret loading / redaction mechanisms hardened for
production. It owns security *architecture, classification, redaction
machinery and verification* — not deployment (R10-A), not product RBAC (R11).

**Charter principle:** AI/model output is untrusted data; a secret crosses a
trust boundary only through a server-controlled, audited, least-privilege
mechanism; agents never receive infrastructure authority.

## 1. Inventory method

Read-only inspection of: environment variable declarations (`.env.example`,
`.env.production`, `api/lib/env.ts`), credential-loading code
(`api/lib/secrets.ts`, `scripts/lib/load-secrets.ts`), token encryption
(`api/lib/crypto.ts`), the structured logger (`api/lib/logger.ts`), the
canonical audit envelope (`api/lib/audit/audit-event.ts`), auth/session/OTP
(`api/lib/auth/`, `api/lib/session.ts`), tRPC middleware and context
(`api/middleware.ts`, `api/context.ts`), server boot and anonymous HTTP
endpoints (`api/boot.ts`), the worker entry point (`api/worker.ts`), provider
adapters and outbound HTTP (`api/lib/http.ts`, `api/lib/creative/providers/`),
video rendering (`api/lib/video/renderer.ts`), agent execution
(`api/lib/agents/runner.ts`), VCS tracking of config files (`.gitignore`,
`git ls-files`), and synthetic test fixtures. No server was touched; no
schema was changed; no secret value was displayed.

## 2. Environment variable & secret population

Population is centralised in `api/lib/env.ts` (the only runtime env reader).
Sources of truth: `.env.example` (annotated, empty placeholders) and
`.env.production` (filled — see §10 debt). Classification per the F2 taxonomy
(PUBLIC_CONFIGURATION / APPLICATION_SECRET / DATABASE_SECRET / PROVIDER_SECRET /
DEPLOYMENT_SECRET / INFRASTRUCTURE_SECRET / BACKUP_SECRET / BREAK_GLASS_SECRET).

### 2.1 Application secrets — APPLICATION_SECRET

| Variable | Use | Loading path |
|---|---|---|
| `APP_SECRET` | Local-auth JWT signing (`APP_SECRET + "_local"`, HS256, `jose`) | `env.ts` → `api/lib/session.ts`, local-auth router |
| `TOKEN_ENCRYPTION_KEY` | AES encryption of stored OAuth/platform tokens at rest | `env.ts` → `api/lib/crypto.ts` |
| `FACEBOOK_WEBHOOK_VERIFY_TOKEN` | Meta webhook subscription verification (shared secret with provider) | read directly in `api/boot.ts` |
| `OWNER_UNION_ID` | Firebase UID auto-promoted to `admin` on first login | `env.ts` → auth routers |

### 2.2 Database credentials — DATABASE_SECRET

| Variable | Use |
|---|---|
| `DATABASE_URL` | MySQL connection string (user+password embedded). Required in production (`env.ts` `required()`). Reader: Drizzle/`queries/connection` |

Variant spellings exist in maintenance scripts only (never the server
runtime): `MYSQL_URL`, `DB_URL`, `READ_ONLY_DATABASE_URL` (one-off
diagnostic/fix scripts under `scripts/`, `db/fix.ts`, `list-users.cjs`,
`check-*-columns.cjs`).

### 2.3 Redis credentials — INFRASTRUCTURE_SECRET

| Variable | Use |
|---|---|
| `REDIS_URL` | BullMQ queues, distributed leases, rate limiting. Required in production (`env.ts` boot validation). Separate worker process (`api/worker.ts`) exits hard if unset |

### 2.4 Provider credentials — PROVIDER_SECRET

| Variable(s) | Provider | Use |
|---|---|---|
| `OPENAI_API_KEY` (+ `OPENAI_IMAGE_*` tuning) | OpenAI | agent runs, content safety, image/leaflet rendering |
| `CREATIFY_API_ID` / `CREATIFY_API_KEY` / `CREATIFY_WEBHOOK_URL` | Creatify | URL-to-video generation + inbound webhook |
| `HEYGEN_API_KEY`, `RUNWAY_API_KEY` | HeyGen / Runway | optional premium video |
| `BANNERBEAR_API_KEY`, `TEMPLATED_IO_API_KEY` (+ template IDs) | Bannerbear / Templated.io | premium leaflet rendering |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` | Stripe | billing (secret + webhook verify; publishable is public config) |
| `SMTP_HOST/PORT/SECURE/USER/PASS`, `SMTP_FROM_EMAIL/NAME`, `SENDGRID_API_KEY` | SMTP/SendGrid | OTP delivery, password reset |
| `META_APP_ID/SECRET`, `LINKEDIN_CLIENT_ID/SECRET`, `TIKTOK_CLIENT_KEY/SECRET`, `TWITTER_CLIENT_ID/SECRET`, `FACEBOOK_APP_ID/SECRET` | Meta/LinkedIn/TikTok/Twitter | OAuth flows, social publishing/listening |

### 2.5 Firebase configuration

| Variable | Class | Note |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | PROVIDER_SECRET / INFRASTRUCTURE | path to service-account JSON **or** inline JSON — server-side only |
| `VITE_FIREBASE_*` (6 vars) | PUBLIC_CONFIGURATION | browser-exposed by design via Vite; not secrets |

### 2.6 Deployment / infrastructure / backup / break-glass

| Variable | Class | Note |
|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | DEPLOYMENT_SECRET | local-script GCP auth only; never required by server runtime |
| `GOOGLE_CLOUD_OPENAI_SECRET_NAME/VERSION`, `GOOGLE_CLOUD_PROJECT_ID` etc. | DEPLOYMENT_SECRET | GCP Secret Manager addressing for scripts |
| Backup credentials | BACKUP_SECRET | **none present today** — no backup job exists in-repo; reserved class (F2/F8) |
| Break-glass credentials | BREAK_GLASS_SECRET | **none present today** — model defined in F8, not implemented |

### 2.7 Non-secret configuration (PUBLIC_CONFIGURATION / tuning)

Feature flags (`ENABLE_*`, `CREATIVE_PIPELINE_V2_*`, `POST_LIVE_*`,
`SOCIAL_LISTENING_*`, `ENGAGEMENT_PROVIDER_TRANSPORT_ENABLED`,
`REQUIRE_TWO_FACTOR`), credit pricing (`PREMIUM_*_CREDITS`,
`DAILY/MONTHLY_AI_CREDIT_LIMIT`), lease timings, `PORT`, `NODE_ENV`,
`PUBLIC_APP_URL` — all non-secret; several are deliberately default-OFF
governance switches.

## 3. Credential-loading code

| Path | Role | R10-F determination |
|---|---|---|
| `api/lib/env.ts` | Central runtime env object; `required()` fails production boot on missing `APP_SECRET`/`DATABASE_URL`/`FIREBASE_SERVICE_ACCOUNT`; Redis validated at boot | KEEP — single choke point; document as the only permitted runtime reader |
| `api/lib/secrets.ts` | Optional GCP Secret Manager loader — **explicitly NOT used by the production server runtime**; local scripts only; logs only the secret *name* on failure | KEEP — script-only, fail-soft, no values logged |
| `scripts/lib/load-secrets.ts` | Early `dotenv` + Secret Manager bootstrap for scripts | KEEP — scripts only |
| `api/lib/crypto.ts` | `TOKEN_ENCRYPTION_KEY` encrypt/decrypt of stored OAuth tokens | KEEP — envelope encryption at rest |
| `db/fix.ts`, `scripts/*.cjs`, `check-*-columns.cjs` | Direct DB env variants for maintenance | DOCUMENT — operator-only tooling; never imported by `api/` runtime |

No runtime code path lets a client, model or agent select a secret *name* or
*path*; env access is static and server-side.

## 4. Logs

- `api/lib/logger.ts` — single structured JSON logger (PM2/systemd friendly).
  Existing redaction: key-name matches (`token|password|secret|apikey|
  authorization|credential` → `***`), value patterns (`sk-…`, `Bearer …`,
  `?api_key|token|password|secret|authorization=` query params).
- Raw `console.log/warn/error` still used in `api/boot.ts`, `api/worker.ts`,
  webhook handlers and several routers — bypass the structured sanitizer.
  **Gap (F5):** a repo-wide redaction primitive exists but is not enforced
  outside `logger.ts`.
- No log files are written by the app itself; logs go to stdout/stderr
  (PM2/systemd capture on the server — OneGrid side, R10-A verifies).

## 5. Audit payloads

`api/lib/audit/audit-event.ts` canonical envelope:
- `SENSITIVE_METADATA_KEY` (`token|password|passwd|authorization|secret|
  credential|api[-_]?key|session|cookie`, case-insensitive) removed at every
  nesting level;
- depth cap 8; JSON-like values only; `Error` objects and class instances
  rejected; keys sorted deterministically; immutable deep-frozen events;
  deterministic SHA-256 fingerprint.
- **Determination:** audit metadata hygiene is sound; F5 reuses the same
  key taxonomy for log/error/callback/prompt redaction so all surfaces share
  one classification.

## 6. Prompts / model context

- `api/lib/agents/runner.ts` (`runAgent`) — server-authored prompt + zod
  schema via `generateObject`; model output is parsed, never executed.
- `api/lib/safety/checker.ts` — content safety review over generated content.
- Prompts are composed from business/campaign data (Business DNA, strategy,
  audience) — i.e. *tenant data*, not secrets; F5 adds a secret-shaped-value
  screen so no env/secret-shaped string can be composed into a model-visible
  prompt, and model output is screened before it is persisted or echoed.
- Model-assist boundaries already exist upstream (e.g. R9-A wording-only
  assistance, injection-labelled) — R10-F screens are additive, never
  replacing those per-stream rules.

## 7. Worker environment

`api/worker.ts` — standalone process (`node dist/worker.js`): BullMQ
publishing + content-generation workers over Redis; hard-exits without
`REDIS_URL`; SIGINT/SIGTERM graceful shutdown. Shares the same bundled code
and env as the API process today (single deployment unit). **F4 requires**
the production topology to run workers under a *service identity* with no
infrastructure-admin privilege, even though the repo currently ships one
bundle.

## 8. Access-control paths

| Layer | Mechanism | Notes |
|---|---|---|
| Transport context | `api/context.ts` | `ctx.user` from verified JWT; session payload |
| tRPC middleware | `api/middleware.ts` | `publicQuery` (rate-limited 60/min/IP) / `authedQuery` (auth + `session.verified` OTP gate) / `adminQuery` (role === admin) / AI & publish rate limiters |
| Admin surfaces | `api/admin-router.ts`, `api/operations-router.ts`, banking router | role-gated; `admin_mutation` audited |
| Anonymous HTTP | `api/boot.ts` | OAuth callbacks, `/api/webhooks/:platform` (signature-verified ingestion), tRPC handler |
| Break-glass-ish env switches | `ENABLE_ADMIN_RATE_LIMIT_BYPASS`, `TERMINAL_REPLAY_ADMIN_ENABLED`, `CREATIVE_V2_DIAGNOSTIC_HARNESS_ENABLED`, `FREE_AI_LEAFLET_FALLBACK` | admin/testing toggles — inventoried in F9; none grant secret access |

## 9. Test secrets & hard-coded values

- **Synthetic only.** Fixtures: `api/lib/nurture/nurture-content-boundary.test.ts`
  (AWS documented example key `AKIAIOSFODNN7EXAMPLE`, synthetic `ghp_…`, sample
  RSA header) used to prove content-boundary rejection; `.env.example`
  placeholders are empty.
- Repo-wide pattern scan (F5/F10 tooling) for `sk-…`, `AIza…`, `AKIA…`,
  `-----BEGIN … PRIVATE KEY-----`, `ghp_…`, `xox…` across tracked source
  found **no real hard-coded secrets** — only the documented synthetic
  fixtures above.

## 10. Configuration files & VCS exposure — SECURITY DEBT

| Finding | Severity | Detail |
|---|---|---|
| **`.env.production` is git-tracked** (11 keys incl. `APP_SECRET`, `DATABASE_URL`, `FIREBASE_SERVICE_ACCOUNT`, `VITE_FIREBASE_*`, `OWNER_UNION_ID`) | **CRITICAL** | Live-looking production secret material present in repository history |
| **`.env.backup-20260623-181231` is git-tracked** (14 keys incl. `APP_SECRET`, `DATABASE_URL`, `VITE_FIREBASE_*`, `VITE_KIMI_*`) | **CRITICAL** | Backup copy of the same exposure class |
| `.gitignore` ignores `.env`, `.env.local`, `.env.*.local` but **not** `.env.production` / `.env.backup-*` | HIGH | Pattern gap allowed the above |
| `public/web.config.bak` tracked | LOW | IIS backup artefact; no secret values found in it today |

Remediation executed in this stream (F9 slice): untrack both env files from
VCS (working copies kept on disk), extend `.gitignore`, add a repeatable
secret-scan script. **Rotation of the exposed `APP_SECRET` / `DATABASE_URL` /
Firebase credentials remains mandatory and is assigned to R10-A** — history
already contains the values, so untracking alone does not remediate.

## 11. Attack-surface quick map (full review = F9)

- Anonymous endpoints: OAuth callbacks; webhooks (signature-verified,
  raw-body, exact-once ingestion); tRPC public procedures.
- `child_process`: `api/lib/video/renderer.ts` spawns `ffmpeg` with a fixed
  binary path and argument array — no shell, no interpolation.
- Dynamic `import()`: lazy in-router imports only (static string literals);
  no user-controlled module selection.
- No `eval` / `new Function` found in runtime code.
- Outbound HTTP: `api/lib/http.ts` `HttpClient` is base-URL bound; provider
  adapters use fixed bases; `website-analyser.ts` fetches operator/tenant
  supplied URLs (SSRF-shaped — documented in F9 with existing guards).
- Local FS reads in brand resolvers are path-joined to project dirs.

## 12. Determinations

1. **Reuse, not rebuild:** `env.ts`, `logger.ts` redaction, `audit-event.ts`
   hygiene, `crypto.ts`, OTP auth — all become the foundation; F5 adds the
   missing cross-surface secret-shape screen + a single shared redaction
   module.
2. **Single runtime env choke point** stays `api/lib/env.ts`; scripts keep
   their own loaders; agents never gain an env reader.
3. **Tracked `.env` files are the only live exposure found**; everything else
   is architecture debt (documented, scheduled) rather than active leakage.
