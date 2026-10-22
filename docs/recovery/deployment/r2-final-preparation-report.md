# WBS-R2 — Final Production Preparation Report

## 1. Identity

| Item | Value |
|---|---|
| Branch | `recovery/r2-production-activation` |
| HEAD | `30bb53b80056…` (full SHA after this report's commit; pre-report HEAD `30bb53b`) |
| Accepted recovery base | `53d42969cac76afc5e5bb1509c4e33f16224991f` (R1 READY) |
| Working tree | CLEAN |
| Remote | `origin/recovery/r2-production-activation` in sync |

## 2. Commits created (R2 programme)

| Commit | Slice |
|---|---|
| `1923cde` | R2.1 server/runtime rebuild baseline runbook |
| `f5ab59d` | R2.2 repeatable deployment package (4 scripts + README) |
| `0589392` | R2.3 configuration/secrets readiness manifest + placeholder template |
| `30bb53b` | R2.4 disposable migration rehearsal tooling + procedure |

## 3. Files created/modified

- `docs/recovery/deployment/r2.1-server-runtime-baseline.md`
- `scripts/deployment/README.md`, `verify-release.ps1`, `install-and-build.ps1`, `start-runtime.ps1`, `rollback.ps1`
- `docs/recovery/deployment/r2.3-configuration-manifest.md`, `env.production.template`
- `docs/recovery/deployment/r2.4-migration-rehearsal.md`
- `scripts/deployment/migration-rehearsal.ps1`, `verify-schema-parity.mjs`
- This report.

No production files, no source code outside `scripts/deployment/`, no secrets anywhere.

## 4. Server/runtime baseline (R2.1 summary)

Windows Server + IIS (URL Rewrite/ARR) reverse-proxying `/api`,`/generated`,`/uploads` to Node on `127.0.0.1:3001`; Node 20.x LTS + npm 10.x; PM2 process model (`natforgeai` API + `natforgeai-worker` when Redis present); frontend `vite build` → `dist/public` served by IIS with SPA fallback; `npm start` → `dist/boot.js`; standalone `dist/worker.js` (Redis-required) with in-process runner fallback; schedulers: credit renewal (always), publishing worker/BullMQ + content worker (prod+Redis), post-live lifecycle + metrics observation (both flag-gated OFF); **MySQL** via `DATABASE_URL` (drizzle-kit migrate over the canonical 27-migration chain); persistent `data/public/{generated,uploads}`; dotenv loading with fail-closed production required vars (`APP_SECRET`, `DATABASE_URL`, `FIREBASE_SERVICE_ACCOUNT`, `REDIS_URL`); health via tRPC `health.getSystemHealth` (public) + admin health procedures (no plain HTTP `/health` exists); PM2/IIS logging; restart order MySQL → Redis → PM2 → IIS.

## 5. Deployment package status (R2.2)

COMPLETE and locally validated. Four phases (preparation gate → install/build validation → attended start with health checks → rollback), all dry-run by default, `-Execute` gated, fail-closed. Demonstrated on this machine: release gate fails closed (no PM2, no `.env`), build script refuses without Vite keys, start script skips the worker without Redis, rollback rejects invalid release dirs.

## 6. Configuration/secrets readiness (R2.3 summary)

Full inventory produced: 4 boot-critical (secret, manual), 6 build-time Firebase keys (manual), core-function credentials (OpenAI, Meta, LinkedIn, Stripe, mail, 64-hex `TOKEN_ENCRYPTION_KEY`), platform extras (Facebook/Twitter/TikTok), feature/scheduler flags with code defaults, tuning/pricing family, test-only vars. Every entry classified required/optional, sensitive/not, source `file:line`, expected secret store, repo-inferable, manual-supply. Placeholder-only `env.production.template` created. **No secret values exist anywhere in the repository.**

## 7. Missing required values (block deployment, not preparation)

`APP_SECRET`, `DATABASE_URL` (MySQL DSN), `REDIS_URL`, `FIREBASE_SERVICE_ACCOUNT`, `TOKEN_ENCRYPTION_KEY`, `OPENAI_API_KEY`, all 6 `VITE_FIREBASE_*`, `META_APP_ID/SECRET`, `LINKEDIN_CLIENT_ID/SECRET`, Stripe trio, mail credentials (SMTP or SendGrid), `PUBLIC_APP_URL` confirmation, `OWNER_UNION_ID`, optional provider keys (HeyGen/Runway/Creatify/Bannerbear/Templated) per feature enablement. Plus server-side prerequisites: MySQL 8 + Redis instances, IIS with URL Rewrite/ARR, PM2.

## 8. Migration rehearsal result (R2.4)

Tooling complete and validated: chain integrity PASS (27/27, sequential, terminal snapshot present); execution **stopped before any database access** because no disposable `DATABASE_URL` exists on this machine — exactly the R2.4-prescribed behaviour (exit 2 with printed procedure). Acknowledgment guard and accidental-production guard verified. Parity probe (`information_schema` vs terminal snapshot 0026) ready for the rehearsed target.

## 9. Migrations still unexecuted in production

**All 27 canonical migrations** (`0000_vengeful_triathlon` … `0026_add_publishing_queue_metadata`). No production database was accessed; production schema state is unknown by design. A fresh production DB applies the full chain; a legacy DB needs a baseline comparison first.

## 10. Unresolved blockers

None within R2 authority. Everything outstanding is a deployment-time action requiring the missing values above and separate authority.

## 11. Exact actions that would constitute the FIRST production mutation

In order, each requiring explicit operator authority outside this programme:

1. Provisioning writes: create the production MySQL schema/user and Redis instance; create DNS/host entries.
2. Secret placement: write the real `.env` (from the R2.3 manifest) onto the server — the first time secret material exists on the host.
3. **First irreversible mutation:** `drizzle-kit migrate` (or `migration-rehearsal.ps1` semantics) against the production `DATABASE_URL` — creates/alter all 27 migrations' tables in the production database.
4. `pm2 start dist/boot.js` / `dist/worker.js` with production env (binds 127.0.0.1:3001, connects to production DB/Redis — first live reads/writes).
5. IIS site creation + 443 binding pointing at `dist/public` (first external traffic path).
6. Any activation of live providers (OpenAI calls, Meta/LinkedIn OAuth, Stripe webhooks) and scheduler flags (`POST_LIVE_*_ENABLED=true`).

## 12. Verdict

**READY_FOR_PRODUCTION_GATE**

All preparation artefacts exist, are validated as far as possible without
production access, and are safe-by-default. The gate to production is now
purely operational: supply the missing configuration, rehearse migrations on
a disposable target, then execute the §11 sequence under separate authority.
