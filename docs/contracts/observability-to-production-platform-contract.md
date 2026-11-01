# OBSERVABILITY → PRODUCTION PLATFORM HANDOFF CONTRACT (WBS-R10-E → R10-A/R10-X)

> **Handoff contract:** what the actual production environment (OneGrid) must
> later provide so the R10-E repository-level observability capability binds
> to real infrastructure.
> **Contract version:** `observability-to-production-platform/v1`
> **Upstream:** `production-observability/v1` (`docs/contracts/production-observability-contract.md`)
> **Status:** DEFINED, NOT IMPLEMENTED. OneGrid was not accessed; no
> production deployment, no production telemetry claims, no live provider
> calls, no production monitoring installation. OneGrid is not yet ready.
> **Verdict semantics:** this contract being satisfied on OneGrid is a
> pre-production gate owned by R10-A/R10-X, not by R10-E.

---

## 1. What R10-E provides (repository level, complete)

- Typed/versioned operational telemetry envelope with deterministic `evt1:`
  identity and append-only exact-once storage (`operational_events`).
- Deterministic incident identity/lifecycle (`inc1:`/`icl1:`) with governed,
  audited, authority-bearing suppression rules.
- Deterministic alert classification + deduplicated presentation (`alt1:`)
  that folds alert storms without deleting event evidence.
- Evidence-derived platform health model (HEALTHY/DEGRADED/AT_RISK/
  UNAVAILABLE/UNKNOWN) with explicit absence-of-telemetry ⇒ UNKNOWN rules.
- Dimension health semantics for workers/queue/scheduler (E7), database (E8),
  providers (E9), mission control (E10), security signals (E11), backup/DR
  (E12); SLO measurement foundations (E16); read-only operator surface (E13).
- Mission-control operational rollup bound to the canonical R9 tables
  read-only (guarded degradation to UNKNOWN when R9 schema is absent).

## 2. What OneGrid must later provide (binding surface)

| # | Capability | R10-E consumption point | Notes |
|---|---|---|---|
| 1 | Service health collection | `PlatformEvidenceProvider.getApiEvidence` | process up/down, restart counts, uptime |
| 2 | Process monitoring | `getWorkerEvidence` | worker online/offline, heartbeat age, crash loop |
| 3 | CPU / memory / disk | new evidence fields (advisory) | feeds `api`/`workers` dimensions; thresholds TBD by R10-A |
| 4 | API health | `getApiEvidence` | availability, latency, error rate per route class |
| 5 | IIS health | `getApiEvidence` extension | app-pool state, request queue — Windows/OneGrid specific |
| 6 | Worker health | `getWorkerEvidence` | BullMQ worker registry + heartbeat adapter |
| 7 | Scheduler health | `getSchedulerEvidence` | in-process schedulers already expose status; OneGrid must collect it |
| 8 | Database health | `getDatabaseEvidence` | pool saturation, deadlocks, tx failures, schema version — no credential exposure |
| 9 | Redis health | `getQueueEvidence` extension | queue depth, consumer lag |
| 10 | Certificate expiry | new dimension/evidence | expiry within window ⇒ at least DEGRADED |
| 11 | Disk capacity | new evidence field | capacity thresholds ⇒ DEGRADED/AT_RISK |
| 12 | Backup state | `getBackupEvidence` | last success/age/verification/offsite/restore rehearsal — R10-G owns backup authority; R10-E only observes |
| 13 | Provider health | `getProviderEvidence` | latency, status class, timeout rate, callback delay, auth failure — per provider row |
| 14 | Alert delivery | out-bound from `operational_alerts` | email/webhook/OneGrid notification channel; delivery is infrastructure, not authority |
| 15 | Log retention | platform concern | R10-E events persist in MySQL; platform logs follow retention policy set by R10-A |
| 16 | Incident correlation | `correlationId` + `alt1:` dedup keys already defined | OneGrid must not break deterministic identities |
| 17 | Release/version identity | `RELEASE_VERSION`/`GIT_SHA` env | feeds `releaseVersion` + `deployment_version` dimension; null ⇒ UNKNOWN (never invented) |

## 3. Binding rules (must hold on OneGrid)

1. **Observability stays read-only.** OneGrid binding must not add execution,
   recovery, governance, provider-switch or kill-switch authority to any
   observability surface. Control commands remain the R10-H/R10-X governed
   command boundary.
2. **Evidence honesty is preserved.** Every bound evidence source must return
   null (⇒ UNKNOWN) when telemetry is absent, never synthesize HEALTHY.
3. **No secrets on the wire.** Provider adapters must emit only safe
   references; credential material never enters `operational_events`.
4. **Identity stability.** `evt1:`/`inc1:`/`alt1:`/`hlt1:` derivation inputs
   must not be augmented with timestamps or randomness; dedup anchors stay
   deterministic.
5. **Alert delivery failure is itself observable.** If the notification
   channel fails, that failure is recorded as an operational event
   (`service: platform`, `diagnosticCode: UNKNOWN` mapping rules) — silently
   dropping alerts is a fail-closed violation.
6. **Clock discipline.** `occurredAt`/`observedAt` come from explicit
   timestamps; OneGrid NTP sync keeps latency/age derivations meaningful.

## 4. Verification gates for R10-A/R10-X (pre-production)

- [ ] Each dimension in §2 bound to a real collector, or explicitly UNKNOWN.
- [ ] Fail-closed drill: stop a collector ⇒ dimension degrades to UNKNOWN,
      never HEALTHY.
- [ ] Alert storm drill: N repeated failures ⇒ one `alt1:` presentation row
      with occurrenceCount = N and N preserved events.
- [ ] Suppression drill: non-critical incident suppressible only with an
      explicit authority reference + audit fact; critical never suppressible.
- [ ] Tenant isolation drill: tenant A cannot read tenant B's incidents or
      events through any bound surface.
- [ ] Release identity present in production, null in dev.

## 5. Explicit non-claims

R10-E does **not** claim: OneGrid access, production deployment, production
telemetry verification, migration execution (0038 is an artefact), live
provider calls, or production monitoring installation. `ONEGRID_ACCESSED=False`,
`PRODUCTION_TELEMETRY_VERIFIED=False`, `DEPLOYMENT_EXECUTED=False`.
