# PRODUCTION OBSERVABILITY CONTRACT (WBS-R10-E)

> **Canonical contract for the R10-E observability, operations & incident
> control capability.**
> Branch `feature/r10-e-observability-operations`; frozen programme base
> `799f6b4cb351ebe969f97da606324605fdf2a07b` (R9 Mission Control,
> `MISSION_CONTROL_V1_READY`).
> **Contract version:** `production-observability/v1`
> **Engine version:** `production-observability-engine/v1`
> **Implementation:** `api/lib/observability/`; router `observability`
> (`api/observability-router.ts`).
> **Environment posture:** repository-level only. The OneGrid server is not
> ready: no OneGrid access, no production deployment, no production telemetry
> claims, no live provider calls, no production monitoring installation.
> This contract is what R10-A/R10-X later bind to real infrastructure.
> **Inventory:** `docs/recovery/r10-e-observability-inventory.md`
> **Handoff:** `docs/contracts/observability-to-production-platform-contract.md`

---

## 1. Purpose and authority boundary

R10-E answers one question: **what is happening on the platform, is it
healthy, and where must an operator look — without ever becoming the
authority for any of it.** It owns operational telemetry, platform health
derivation, incident identity/lifecycle, alert classification and
deduplication, the append-only operational event store, and read-only
diagnostic surfaces.

**Core principles (preserved verbatim on every surface):**

```
observability != authority
monitoring observes; monitoring never authorizes
health is derived from evidence — never set
absence of telemetry means UNKNOWN, never HEALTHY
uncertainty is reported as UNCERTAIN, never converted to success
incident suppression requires explicit operator/policy authority
deduplication compresses presentation, never deletes evidence
provider health never authorizes switching provider or account
```

Monitoring **may**: observe, classify, alert, correlate, recommend operator
attention.

Monitoring **must NOT**: authorize execution, approve recovery, change
autonomy, change policy, change mission scope, change provider, change
credentials, rewrite history, hide uncertainty, or suppress audit.

R10-E must never: mark platform health without evidence; set, close or
suppress an incident without a governed, audited operator transition; mint
retry or recovery authority; mutate mission state, execution history or any
upstream business/mission authority row; disable monitoring or backup;
authorize a provider switch; execute shell, SQL, tools or provider calls; or
read secrets. The audit ledger (`audit_events`) remains the single
material-fact authority; R10-E adds only additive operational audit event
types.

## 2. Ownership map

| Plane | Owner | R10-E posture |
|---|---|---|
| Mission authority / planning / scheduling | R9-A/B/C | untouched |
| Execution history | R9-D | immutable read-only input |
| Mission operational state / recovery candidates | R9-E | read-only aggregate consumption (E10) |
| Governance decisions / approvals | R9-F | read-only backlog counting |
| Business KPIs / analytics | analytics stream | untouched |
| **Operational telemetry envelope** | **R10-E** | typed, versioned, sanitized |
| **Append-only operational event store** | **R10-E** | `operational_events`; exact-once; safe metadata only |
| **Platform health model + derivation** | **R10-E** | evidence-derived; model may never set |
| **Incident identity + lifecycle** | **R10-E** | deterministic `inc1:`; audited transitions |
| **Alert classification + dedup/correlation** | **R10-E** | deterministic `alt1:` anchor; bounded aggregation |
| **Service health observations** | **R10-E** | `service_health_observations` snapshots |
| **Worker / DB / provider / security / backup health semantics** | **R10-E** | observation models only — runtime resilience is R10-C, concurrency is R10-B, security controls R10-F, backup authority R10-G |
| **Operator read surface** | **R10-E** | read-only tRPC namespace `observability` |
| **Operator control commands** (suspend execution, disable provider, safe mode, kill switch) | R10-H / R10-X (future) | contract-only boundary; explicitly rejected here |

## 3. Telemetry envelope (E1)

Every operational fact enters through one typed, versioned envelope.
`eventId` is deterministic — `evt1:` + SHA-256 over the normalized
identity coordinates — so a retried or raced emission converges to exactly
one durable row (structural exact-once).

| Field | Type | Rule |
|---|---|---|
| `eventId` | `evt1:<sha256>` | server-minted deterministic identity; never client-supplied |
| `schemaVersion` | int | `1` |
| `contractVersion` | string | `production-observability/v1` |
| `eventType` | closed enum (§3.1) | closed vocabulary; unknown types rejected |
| `environment` | `development\|staging\|production` | server-resolved from env; default `development` |
| `releaseVersion` | string \| null | server-resolved (`RELEASE_VERSION` / build sha); null when unknown — never invented |
| `service` | closed enum (§3.2) | emitting service |
| `component` | string ≤ 64 | bounded label |
| `operation` | string ≤ 64 | bounded label |
| `severity` | `INFO\|WARNING\|HIGH\|CRITICAL` | closed |
| `status` | `SUCCEEDED\|FAILED\|UNCERTAIN\|PENDING_EXTERNAL` | closed; ambiguity ⇒ `UNCERTAIN` (E15) |
| `correlationId` | string ≤ 64 \| null | caller-scoped correlation; never invented by the store |
| `tenantId` | int \| null | null for platform-scope events |
| `businessId` | int \| null | null unless tenant-scoped |
| `missionId` / `taskId` / `executionAttemptId` | string \| null | opaque references only |
| `provider` | closed enum (§3.3) \| null | provider dimension when applicable |
| `providerReference` | string ≤ 128 \| null | only where safe (job id, request id class); never credentials, tokens, raw URLs with query secrets, or PII |
| `occurredAt` | ISO 8601 | explicit; never invented by the store |
| `observedAt` | ISO 8601 | when the platform observed it; explicit |
| `diagnosticCode` | closed enum (§3.4) | bounded, greppable failure/signal class |
| `safeMetadata` | structured JSON, depth ≤ 6 | sanitized like audit metadata: secret-shaped keys removed deterministically, Error objects and class instances rejected, size-bounded |

**Never stored:** secret values, raw credentials, model chain-of-thought,
unrestricted request/response bodies, raw social content, PII.

### 3.1 Event types (closed)

`api_health_observed`, `database_health_observed`, `worker_heartbeat_observed`,
`worker_crash_observed`, `queue_backlog_observed`, `scheduler_heartbeat_observed`,
`provider_request_observed`, `provider_auth_failure_observed`,
`provider_rate_limit_observed`, `callback_processing_observed`,
`execution_uncertain_observed`, `mission_blocked_observed`,
`governance_backlog_observed`, `recovery_backlog_observed`,
`security_signal_observed`, `backup_signal_observed`,
`incident_detected`, `incident_lifecycle_observed`, `alert_raised`,
`alert_deduplicated`, `slo_measurement_observed`.

### 3.2 Services (closed)

`api`, `database`, `worker`, `scheduler`, `queue`, `mission_control`,
`provider`, `callback`, `recovery`, `security`, `backup`, `platform`.

### 3.3 Providers (closed)

`openai`, `meta`, `linkedin`, `stripe`, `paypal`, `smtp`, `firebase`,
`aws_s3`, `internal`. (`internal` = platform-internal adapters; unknown
external providers are rejected, never guessed.)

### 3.4 Diagnostic codes (closed)

`OK`, `DB_CONNECTIVITY_FAILURE`, `DB_POOL_SATURATION`, `DB_DEADLOCK`,
`DB_TRANSACTION_FAILURE`, `DB_CAS_CONFLICT`, `DB_REPLAY_COLLISION`,
`DB_SCHEMA_VERSION_UNKNOWN`, `WORKER_OFFLINE`, `WORKER_HEARTBEAT_STALE`,
`WORKER_CRASH_LOOP`, `WORKER_VERSION_DRIFT`, `JOB_LEASE_STALE`,
`JOB_STUCK`, `RETRY_STORM`, `DEAD_LETTER_GROWTH`, `QUEUE_BACKLOG_HIGH`,
`SCHEDULER_HEARTBEAT_STALE`, `PROVIDER_TIMEOUT`, `PROVIDER_5XX`,
`PROVIDER_4XX`, `PROVIDER_AUTH_FAILURE`, `PROVIDER_RATE_LIMITED`,
`CALLBACK_DELAY_HIGH`, `RECONCILIATION_BACKLOG_HIGH`,
`EXECUTION_UNCERTAIN`, `MISSION_BLOCKED`, `GOVERNANCE_REVIEW_BACKLOG`,
`APPROVAL_BACKLOG_HIGH`, `RECOVERY_BACKLOG_HIGH`, `STALE_SCHEDULE`,
`STALE_RECOVERY`, `AUTH_FAILURE`, `AUTHORIZATION_FAILURE`,
`CROSS_TENANT_ATTEMPT`, `CROSS_BUSINESS_ATTEMPT`,
`PROMPT_INJECTION_DETECTED`, `TOOL_POLICY_REJECTION`,
`SECRET_SHAPED_PAYLOAD_REJECTED`, `APPROVAL_FORGERY_ATTEMPT`,
`CALLBACK_FORGERY_ATTEMPT`, `PRIVILEGE_ESCALATION_ATTEMPT`,
`BACKUP_JOB_FAILURE`, `BACKUP_STALE`, `BACKUP_VERIFICATION_FAILED`,
`BACKUP_OFFSITE_COPY_MISSING`, `RESTORE_REHEARSAL_STALE`,
`RETENTION_HEALTH_DEGRADED`, `UNKNOWN`.

## 4. Platform health model (E2, E15)

Health classes (closed): `HEALTHY`, `DEGRADED`, `AT_RISK`, `UNAVAILABLE`,
`UNKNOWN`. Health is a **pure deterministic function of evidence**; no model
or client can set it, and missing evidence derives `UNKNOWN` — never
`HEALTHY`. Dimensions: `api`, `database`, `workers`, `scheduler`, `queue`,
`mission_control`, `providers`, `callback_processing`, `recovery_backlog`,
`backup_freshness`, `security_controls`, `deployment_version`.

Worst-of aggregation over dimension health with explicit `UNKNOWN` handling
derives platform health (`derivePlatformHealth`). A dimension with no
evidence reports `UNKNOWN` and degrades the aggregate to at most `DEGRADED`
with an explicit `unknownDimensions` list — it is never silently skipped.

## 5. Incident model (E3)

Deterministic identity: `incidentId = inc1:` + SHA-256 over `{environment,
service, component, failureClass, scopeKey}` where `scopeKey` binds
tenant/business scope when the incident is tenant- or business-scoped. A
duplicate detection for the same coordinates **converges to the open
incident** — duplicate evidence is appended as an operational event and
bumps `occurrenceCount`, but never mints a second incident (connected
acceptance #13/#14).

Lifecycle (closed, audited, append-only facts `icl1:`):
`OPEN → INVESTIGATING → MITIGATING → MONITORING → RESOLVED → CLOSED`.
`SUPPRESSED` exists only as an explicit, authority-bearing operator
transition: it requires an admin caller, a non-empty
`suppressionAuthority` reference (operator attestation id or policy id) and
a reason, is itself audited, and **critical-severity incidents cannot be
suppressed at all**. Agents can never suppress, close, or hide an incident.

## 6. Alert model (E4)

Severities (closed): `INFO`, `WARNING`, `HIGH`, `CRITICAL`. Alert rules are
deterministic mappings from operational events/incident state to alerts.
Every alert states: what happened, what is affected, the current safety
state, whether execution is continuing, whether autonomous action is
suspended, and whether operator attention is required. Alerts are raised by
rules over the event store — never ad hoc.

## 7. Alert deduplication and correlation (E5)

Deterministic alert identity: `alt1:` + SHA-256 over `{environment,
dedupKey}` where `dedupKey` is derived from the failure class and affected
target (e.g. `provider:outage:meta`, `worker:crash_loop:publishing-1`,
`db:connectivity:primary`, `queue:backlog:publishing`,
`callback:failures:class:signature-x`). An alert with the same identity and
an open (unresolved) presentation folds into the existing alert:
`occurrenceCount` increments, `lastSeenAt` advances, the underlying event is
still appended to the event store, and a fold event (`alert_deduplicated`)
is recorded. Resolution re-arms the identity. Dedup windows are bounded;
event history is never deleted by dedup. The store preserves every event
even when alert presentation is aggregated — **deduplication must not
delete evidence**.

## 8. Operational event store (E6)

`operational_events` is append-only. Immutable `evt1:` identity with a
durable unique anchor `(userScope, eventId)`; tenant/business isolation via
first-class nullable columns; safe metadata only (same hygiene as the audit
envelope); correlation and release/version attribution on every row. No
secrets, no chain-of-thought, no mutation of upstream authority. Persistence
is defined in `db/schema.ts` and the provisional migration
`0038_r10_e_observability_operations` — **artefact only, NOT executed**
(R10-X owns canonical R10 sequencing; canonical R9 0037 is untouched).

## 9. Dimension health semantics (E7–E12)

- **Runtime / worker (E7):** heartbeat age, job-lease age, scheduler
  heartbeat, stuck job, repeated crash, retry storm, dead-letter growth,
  queue backlog, worker version drift. Observation only — R10-C owns
  runtime resilience; R10-E derives health from reported evidence.
- **Database (E8):** connection availability, pool saturation, latency,
  deadlocks, transaction failures, migration/schema version, CAS conflicts,
  replay collisions. No credential exposure; no migration execution.
  Conceptually coordinated with R10-B, not merged.
- **Provider (E9):** `AVAILABLE`, `DEGRADED`, `RATE_LIMITED`,
  `UNAVAILABLE`, `UNKNOWN` from latency, HTTP status class, timeout rate,
  callback delay, reconciliation backlog, authentication failure. Provider
  health **must not** automatically authorize switching provider/account —
  that decision remains governed elsewhere.
- **Mission Control operational (E10):** aggregate read-only counts over R9
  tables — active missions, blocked missions, uncertain actions, failed
  actions, pending external results, recovery candidates, governance
  blocks, approval backlog, stale schedules, stale recoveries. R9-E mission
  state authority is consumed read-only, never duplicated.
- **Security observability (E11):** auth failures, authorization failures,
  cross-tenant/cross-business attempts, prompt-injection detections,
  tool-policy rejections, secret-shaped payload rejection, approval/callback
  forgery attempts, privilege-escalation attempts. Sensitive payloads are
  never logged — classification + bounded labels only.
- **Backup / DR (E12):** last successful backup, backup age, verification,
  offsite-copy state, restore-rehearsal age, retention health, backup job
  failures — observation semantics compatible with R10-G. The application
  runtime gains no backup authority; absent signal ⇒ `UNKNOWN` (E15).

## 10. Fail-closed rules (E15)

| Condition | Derivation |
|---|---|
| Execution result ambiguous | report `UNCERTAIN` |
| Provider health unknown | never claim `AVAILABLE` |
| Worker heartbeat stale | never claim `HEALTHY` |
| DB telemetry absent | `UNKNOWN`, not `HEALTHY` |
| Backup signal unavailable | never claim backup healthy |
| Security telemetry unavailable | never silently claim secure |
| Release version unknown | `releaseVersion: null`, dimension `deployment_version: UNKNOWN` |

## 11. SLO / service measurement foundation (E16)

Measurable indicators computed deterministically over the event store:
API availability, API latency, worker heartbeat freshness, queue lag,
execution uncertainty rate, provider timeout rate, callback delay, DB
latency, deadlock rate, incident detection delay, recovery backlog, backup
freshness. These are **measurement foundations only** — no contractual SLA
is invented or claimed.

## 12. Operator surface and action boundary (E13/E14)

Read-only namespace `observability` (§13 of this contract's implementation):
platform/service health, incidents, alerts, mission-control operational
health, provider/worker/database/backup health, security signals,
operational timeline, SLO measurements. Every read is mutation-free and
tenant/business predicated where scoped.

Operator control commands (acknowledge incident is implemented here as an
audited lifecycle transition; **suspend mission execution, disable provider,
emergency safe mode, kill switch are NOT implemented** in R10-E) belong to a
separate governed command boundary owned by R10-H/R10-X. The R10-E router
rejects such command shapes explicitly so observability can never become a
control plane by accident.

## 13. R11 forward compatibility (E19)

Telemetry carries nullable `organisationId`-ready scope keys (today:
`tenantId`/`businessId`), health dimensions are keyed strings, and the read
surface returns per-scope aggregations — so future enterprise controls
(organisation/business-unit/brand/market views, role dashboards, executive
Mission Control, SLA reporting, audit/compliance reporting) can project over
the same event store. No R11 enterprise UI is implemented here.

## 14. Verbatim disclaimers

```
observability != authority
absence of telemetry means UNKNOWN, never HEALTHY
deduplication compresses presentation, never deletes evidence
provider health never authorizes switching provider or account
monitoring observes; monitoring never authorizes
```
