# R10-E Observability, Operations & Incident Control — E0 Inventory

> Stream: `feature/r10-e-observability-operations`
> Base: frozen R9 programme head `799f6b4cb351ebe969f97da606324605fdf2a07b`
> Date: 2026-11-10
> Verdict scope: repository-level observability contracts, telemetry semantics,
> incident models, health logic, alerting rules and safe diagnostic surfaces.
> OneGrid: NOT accessed. Production deployment: NOT executed. No production
> telemetry claims.

---

## 0. Method

Inventory taken by direct inspection of the repository at the frozen R9 base
before any R10-E edit. Every claim below cites the file that evidences it.
Where a capability does not exist, this document says so explicitly — an
absence is never silently treated as healthy (E15).

## 1. Business observability vs platform observability

The repository already separates the two, and R10-E preserves that boundary.

**Business observability** (owned by the business streams; R10-E never mutates it):

| Surface | Location | Notes |
|---|---|---|
| Audit ledger (`audit_events`) | `db/schema.ts`, `api/lib/audit/audit-event.ts`, `api/lib/audit/audit-store.ts` | Canonical material-event taxonomy, immutable envelopes, fingerprint dedup. WBS7A/WBS7B. |
| R9-E mission operational timeline (`mot1:`) | `api/lib/mission-state-recovery/`, `mission_operational_timeline_events` | Per-mission append-only timeline; labels only. |
| R9-E mission health / state projections | `mission-state-projection.ts`, `mission-state-derivation.ts` | Derived mission health (HEALTHY/DEGRADED/BLOCKED/AT_RISK/FAILED/UNCERTAIN/COMPLETED). |
| Mission control handoff projection | `mission-state-to-mission-control/v1` (21 keys) | Read-only downstream projection. |
| Analytics router metrics | `api/analytics-router.ts` | Business KPIs (impressions, clicks, conversions…). |
| Admin operations projections | `api/operations-router.ts`, `api/lib/governance/*-operations-summary.ts` | Bounded operational rollups per business. |

**Platform observability** (the R10-E subject; pre-existing surfaces inventoried here):

| Surface | Location | Notes |
|---|---|---|
| Health router | `api/health-router.ts` | `getSystemHealth` (public): DB ping, Redis ping, BullMQ worker presence, two post-live scheduler readiness checks, API. `getQueueHealth`, `getAIUsageHealth`, `getPublishingHealth` (admin). R5/R6 readiness rollups (admin). Alert management (admin). |
| System alerts | `api/lib/alerts.ts`, `system_alerts` table | `critical/warning/info` × `publishing/queue/worker/redis/openai/billing/system`. One-hour same-category dedup on insert. Acknowledge/resolve admin mutations audited via `admin-audit`. |
| Structured logger | `api/lib/logger.ts` | Single-line JSON-ish; explicit key redaction (`token/password/secret/apikey/authorization/credential` → `***`; `sk-…`, `Bearer …` patterns). No correlation-id propagation, no version attribution. |
| Audit admin mutations | `api/lib/governance/admin-audit.ts` | `admin.*` actions recorded to `audit_events`. |
| Queue / worker runtime | `api/lib/queue/bullmq.ts` | `getPublishingWorker()`, `getContentGenerationWorker()`, `getPublishingQueueStats()` (waiting/active/failed). No heartbeat model, no crash-loop detection, no version drift tracking. |
| Post-live schedulers | `api/lib/workflow/post-live-lifecycle-scheduler.ts`, `post-live-metrics-observation-scheduler.ts` + `*-health.ts` resolvers | In-process scheduler status + readiness resolution. |
| Reliability | `api/lib/reliability/provider-timeout.ts` | Central provider request timeout wrapper. |
| Safety checker | `api/lib/safety/checker.ts` | Content safety screening. |
| Redis | `api/lib/redis.ts` | Config + client; health via ping only. |
| Rate limiter | `api/lib/rate-limiter.ts` | Per-IP/per-user buckets. |
| DB connection | `api/queries/connection.ts` | Pool via `getDb()`; health via `SELECT 1` latency only. No pool-saturation, deadlock, CAS-conflict or schema-version telemetry. |
| Env / release identity | `api/lib/env.ts` | `isProduction`, feature flags, provider keys. **No `RELEASE_VERSION`/build-sha/env-name variable exists** — release/version telemetry must be added by R10-E. |
| Error handling | tRPC `TRPCError` codes + `ErrorMessages` (`contracts/constants.ts`) | No platform-wide error taxonomy or diagnostic codes. |
| PM2/runtime hooks | none found in repo (deploy scripts reference process managers; no `ecosystem.config`, no runtime heartbeat hooks) | Absence recorded honestly. |
| Deployment/version metadata | `public/web.config`, deploy scripts | No version endpoint or release identity. |
| Backup monitoring references | none (R10-G stream scope) | Absence recorded honestly — E12 defines observation semantics only. |
| Dashboards / admin views | Admin panel pages exist for business/admin surfaces; no platform-operations dashboard | R10-E adds read-only diagnostic APIs only (E13); no UI. |

## 2. Item-by-item inventory (E0 checklist)

| # | Item | Status at base | Evidence / gap |
|---|---|---|---|
| 1 | Existing logs | Present, unstructured-to-JSON console logger | `api/lib/logger.ts` |
| 2 | Structured logging | Partial (JSON lines, redaction); no event envelope, no correlation/version | `api/lib/logger.ts` |
| 3 | Audit taxonomy | Present, canonical, closed | `AUDIT_EVENT_TYPES` in `api/lib/audit/audit-event.ts` (WBS7A + R4–R9 additive entries) |
| 4 | Metrics | Business metrics only (`analytics`); platform metrics ad hoc inside health-router queries | `api/analytics-router.ts`, `api/health-router.ts` |
| 5 | Health endpoints | Present (`health.*`); coarse `ok/error` per check, `healthy/degraded` aggregate | `api/health-router.ts` |
| 6 | PM2/runtime hooks | Absent | — |
| 7 | Queue/worker monitoring | BullMQ stats + worker presence only; no heartbeat/lease/crash semantics | `api/lib/queue/bullmq.ts` |
| 8 | Scheduler monitoring | Two in-process post-live schedulers with readiness resolvers | `api/lib/workflow/*` |
| 9 | Provider state | Social integration status rows (`social_integrations`) + reliability timeout wrapper; no latency/timeout-rate/callback-delay provider health model | `db/schema.ts`, `api/lib/reliability/` |
| 10 | Database health surfaces | `SELECT 1` latency only | `api/health-router.ts` |
| 11 | Callback/reconciliation state | Publishing queue statuses + terminal failures + replay requests (business-scope) | `db/schema.ts` (`publishing_queue`, `queue_terminal_failures`, `queue_replay_requests`) |
| 12 | Retry/recovery state | R9-E recovery candidates (advisory); R5 queue replay requests | `mission_recovery_candidates`, `queue_replay_requests` |
| 13 | Mission-state observability | R9-E full authority: state records, task states, recovery candidates, timeline, health | `api/lib/mission-state-recovery/` |
| 14 | Current alerting | `system_alerts`: 3 severities × 7 categories, 1h category dedup, ack/resolve | `api/lib/alerts.ts` |
| 15 | Error handling | tRPC codes + constants; no diagnostic-code layer | `api/middleware.ts`, `contracts/constants.ts` |
| 16 | Request correlation | `extractAdminRequestId` for admin mutations only; no platform-wide correlation id | `api/lib/governance/admin-audit.ts` |
| 17 | Trace/correlation IDs | Absent at platform level (workflow attempts exist in business scope) | gap |
| 18 | Deployment/version metadata | Absent | gap |
| 19 | Backup monitoring references | Absent (R10-G scope) | gap |
| 20 | Dashboards / admin views | Business/admin only; no platform ops view | gap |

## 3. Gaps R10-E must close (mapped to programme items)

1. **Typed/versioned operational telemetry** — no envelope, no correlation,
   no release attribution → E1/E6 (`production-observability/v1`,
   `operational_events`).
2. **Deterministic platform health model** — current rollup is
   `ok/error → healthy/degraded` with no UNKNOWN/AT_RISK semantics and no
   evidence-absence rule → E2/E15 (`service_health_observations`, derivation).
3. **Incident identity + lifecycle** — none exists → E3
   (`operational_incidents`, `operational_incident_lifecycle_events`).
4. **Alert classification + deterministic dedup/correlation** — current dedup is
   1-hour same-category coalescing that returns the pre-existing alert id and
   drops the new evidence; no storm bound, no correlation identity → E4/E5
   (`operational_alerts` with deterministic `alt1:` dedup anchor; the new store
   preserves every underlying event — dedup never deletes evidence).
5. **Operational event store** — none → E6.
6. **Worker/queue/scheduler health semantics** — none → E7 (observation only;
   R10-C owns runtime resilience).
7. **DB health semantics** — ping only → E8 (evidence model; no credentials).
8. **Provider health model** — none → E9 (AVAILABLE/DEGRADED/RATE_LIMITED/
   UNAVAILABLE/UNKNOWN; never authorizes switching).
9. **Mission-control operational aggregation** — R9-E is per-mission; no
   cross-mission operational rollup → E10 (read-only consumption of R9 tables).
10. **Security observability signals** — none at platform level → E11.
11. **Backup/DR observation semantics** — none → E12 (R10-G-compatible signals;
    no backup authority).
12. **Operator read surface** — scattered admin endpoints, no unified
    diagnostic surface → E13 (`observability` tRPC namespace, read-only).
13. **Operator action boundary** — undefined → E14 (contract section + explicit
    rejection of control commands; governed commands deferred to R10-H/X).
14. **SLO measurement foundation** — none → E16 (indicators from events;
    no contractual SLA claims).
15. **Release/version identity** — absent → added by R10-E as optional env
    telemetry attribution (`RELEASE_VERSION`, `ENVIRONMENT_NAME`), UNKNOWN when
    absent.

## 4. Boundary statement

R10-E adds **observation** only. It does not own and does not build: mission
authority/planning/scheduling, execution authorization, recovery
authorization, governance, deployment, credentials, backup authority,
migration authority, or autonomy configuration. Existing business
observability surfaces (audit ledger, mission timeline, analytics) are consumed
read-only or left untouched. The canonical `audit_events` taxonomy gains only
additive R10-E operational event types; the audit ledger remains the single
material-fact authority.

OneGrid was not accessed for this inventory; every statement above is verifiable
from repository files at the frozen base.
