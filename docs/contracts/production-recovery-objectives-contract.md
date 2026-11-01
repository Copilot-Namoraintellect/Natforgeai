# PRODUCTION RECOVERY OBJECTIVES CONTRACT (R10-G)

> **Status:** PROPOSED — design-time objectives, pending OneGrid infrastructure
> **Branch:** `feature/r10-g-backup-dr`
> **Base:** `799f6b4cb351ebe969f97da606324605fdf2a07b`
> **Date:** 2026-11-14
> **Audience:** R10-E (monitoring), R10-X (production restore rehearsal), OneGrid implementation, operations
> **Binding rule:** these are *targets to be demonstrated*, not contractual SLAs.
> An objective becomes **COMMITTED** only when the R10-X restore drill measures
> it and passes. Until then every figure below is `PROVISIONAL`.

---

## 1. Principle

> **Backup success != recovery success.**
> No recovery objective is met by the existence of a backup file. An objective
> is met only when the full chain — independent protected copy → restore →
> application startup → integrity validation → Mission Control acceptance —
> has been executed and timed in a rehearsal, and the measured result is at or
> inside the target.

## 2. Recovery classes (closed vocabulary)

| Class | Definition | Failure unit |
|---|---|---|
| `DB_RECOVERY` | Restore of the MySQL database into a clean instance and verification pass | database corruption / loss |
| `APP_SERVICE_RECOVERY` | Rebuild + restart of the API/web process on the (existing or replacement) host | app-server loss / failed deployment |
| `WORKER_RECOVERY` | Resume of background workers/queues with correct idempotency | worker corruption / crash |
| `FULL_PLATFORM_RECOVERY` | DB + app + workers + config + assets on a clean target | total host / regional / provider loss |

## 3. Provisional objectives

| Class | RPO (max data loss) | RTO (max restore time) | Basis (assumption) |
|---|---|---|---|
| `DB_RECOVERY` | **≤ 24 h** standard; **≤ 1 h** stretch | **≤ 4 h** | Nightly 02:00 local encrypted dump (G5). Stretch requires binlog/PITR support on the OneGrid MySQL — *TBD, provider capability*. RTO = restore + hash verify + integrity verifier + smoke checks on a warm standby path |
| `APP_SERVICE_RECOVERY` | 0 (stateless; code from git) | **≤ 1 h** | `npm ci && npm run build` at pinned SHA + config from secret store; IIS/site binding re-apply from checklist |
| `WORKER_RECOVERY` | ≤ 5 min of in-flight queue work | **≤ 30 min** | Queues re-derive from DB truth; BullMQ idempotent replay; stale leases/claims expire by heartbeat bound (`CREATIVE_GENERATION_*_LEASE_SECONDS`, post-live lease) |
| `FULL_PLATFORM_RECOVERY` | **≤ 24 h** (Tier A/B data) | **≤ 8 h** target; **≤ 24 h** worst case (cold start, no standby) | Sequence: provision → restore DB (4 h) → config/secret re-bind (1 h) → build + start (1 h) → verify + Mission Control acceptance subset (1 h) → workers (30 min) + buffer |

### 3.1 Measurement definitions

- **RPO** for `DB_RECOVERY` = wall-clock gap between the last *verified*
  backup's `sourceSnapshotAt` and the failure timestamp. A backup that has
  not passed verification (`verify-backup.sh`) does not count toward RPO.
- **RTO** = declared-disaster → service-verified-and-accepting-traffic,
  including verification gates; it explicitly excludes DNS/TTL propagation
  beyond the operator's control (documented, capped by low TTL recommendation).
- Objectives are measured per drill and recorded in the R10-X rehearsal log;
  the tightest sustained pass becomes the new committed figure.

## 4. Assumptions (must be confirmed at OneGrid implementation)

1. MySQL 8 runs on the same OneGrid host as the app (single-node; no managed
   HA) — hence nightly dump + offsite copy rather than replica-based failover.
2. OneGrid provides a second storage location or object bucket for the
   offsite copy; if not, an operator-controlled offsite target (S3-compatible)
   is used. *(TBD — OneGrid)*
3. No binlog PITR in v1 unless the provider enables it; RPO ≤ 24 h stands alone.
4. Single-operator recovery: runbooks assume one on-call operator with the
   backup-operator authority (see `r10-g-backup-architecture.md` §4).
5. GitHub remains the off-site code authority; the pinned-SHA release manifest
   in every backup set makes builds reproducible.
6. `0037_r9_mission_control_foundation` (and all migrations) are applied on the
   production host before R10-G acceptance; migration identity is verified at
   restore against `db/migrations/meta/_journal.json`.

## 5. Objective lifecycle (closed)

`PROVISIONAL → DRILL_MEASURED → COMMITTED → BREACHED(alert) → REVISED`

- `BREACHED`: any real event or drill exceeding a committed figure → incident
  + monitoring alert (`backup-monitoring-contract.md`) + mandatory revision.
- Revisions only tighten or formally re-baseline with a written reason in the
  R10-X log; objectives never silently widen.

## 6. R10-X production restore gate

Per `r10-g-recovery-rehearsal-plan.md`, R10-X cannot claim disaster-recovery
acceptance until a real restore rehearsal on production-like infrastructure
measures: DB restore inside RTO with Tier A identity preservation, app start,
worker resume with zero duplicate side effects, and Mission Control connected
acceptance subset green. Until that drill passes, all figures in §3 remain
`PROVISIONAL` and this contract's status remains `PROPOSED`.
