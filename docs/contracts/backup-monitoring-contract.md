# BACKUP MONITORING CONTRACT (R10-G → R10-E)

> **Status:** PROPOSED — requirements for the R10-E monitoring stream
> **Producer:** R10-G (`feature/r10-g-backup-dr`)
> **Consumer:** R10-E (monitoring & observability), operations
> **Date:** 2026-11-01
> **Rule:** the backup pipeline emits facts; R10-E owns alerting, dashboards
> and escalation. Backup alerting must not live inside the application
> runtime (G4 — runtime agents cannot suppress backup alerts).

---

## 1. Scope

Monitoring for the backup/DR pipeline defined in
`r10-g-backup-architecture.md`: nightly backup sets, offsite replication,
verification, retention, and restore events. Application-level monitoring
(mission health, governance decisions, dispatch outcomes) is R10-E's separate
remit — this contract covers only backup/DR signals.

## 2. Facts emitted by the backup pipeline

Every run of `scripts/backup/run-backup.sh` writes a machine-readable
`backup-run.json` into the set directory (and a rolled-up copy to the
monitoring ingest path configured at implementation). Closed top-level shape
(versioned; additive only):

```jsonc
{
  "schemaVersion": 1,
  "runId": "bkp-<UTC ISO8601>",
  "setId": "set-20261114T020001Z",
  "startedAt": "…", "finishedAt": "…", "durationMs": 0,
  "status": "SUCCESS | FAILED | PARTIAL",
  "failureStage": "dump | config | assets | manifest | scan | encrypt | verify | offsite | null",
  "source": {
    "database": { "hostRole": "production", "name": "…", "tableCount": 118, "dumpBytes": 0, "dumpSha256": "…" },
    "config":   { "filesCaptured": 0, "redacted": true, "scanClean": true },
    "assets":   { "tarBytes": 0, "tarSha256": "…", "fileCount": 0 },
    "release":  { "gitSha": "…", "branch": "…", "dirty": false, "buildId": "…" }
  },
  "verification": {
    "manifestOk": true, "rehashMismatches": 0,
    "decryptRoundTripOk": true, "dumpSanityOk": true, "verifiedAt": "…"
  },
  "offsite": {
    "targetRole": "offsite-primary",
    "pushed": true, "ackAt": "…", "objects": 0, "bytes": 0,
    "immutabilityApplied": true
  },
  "retention": { "keptSets": 0, "prunedSets": ["…"], "prunePlan": "daily=14,weekly=8,monthly=12" }
}
```

Restore runs emit a symmetric `restore-run.json` (`status`,
`sourceSetId`, `targetRole` — must never equal `production` unless the
scenario is a declared disaster recovery, `integrityVerdict`, timings).
**Restore events are append-only facts; nothing in the app may edit them.**

## 3. Required monitoring signals (R10-E MUST alert on)

| Signal | Source field | Alert condition (initial) |
|---|---|---|
| Last successful backup | max `finishedAt` where `status=SUCCESS` | age > 26 h (nightly job + slack) → page |
| Backup age (RPO exposure) | `source.database` timestamp vs now | age > 24 h → `rpo_at_risk` |
| Backup size anomaly | `dumpBytes`/`tarBytes` vs trailing 14-day median | deviation > 50% (either direction) → investigate (silent dump-shrink is a corruption symptom; bloat is a capacity symptom) |
| Verification result | `verification.*` | any `false` or `rehashMismatches > 0` → page; set marked untrusted |
| Offsite-copy result | `offsite.pushed`, `offsite.ackAt`, `immutabilityApplied` | not acked within 6 h of set completion → `offsite_replication_failed`; `immutabilityApplied=false` → config drift alert |
| Restore-test age | last rehearsal `restore-run.json` (`r10-g-recovery-rehearsal-plan.md`) | > 90 days → `restore_rehearsal_overdue` (escalating) |
| Retention status | `retention.keptSets` vs plan; offsite lifecycle state | fewer sets than plan guarantees, or lifecycle rule missing → `retention_gap` |
| Alert-state health | R10-E heartbeat of this contract's ingest | no `backup-run.json` received by 04:00 local → **the silence itself is an alert** (`backup_monitoring_silent`) |
| PARTIAL/FAILED runs | `status`, `failureStage` | immediate page with `failureStage` |

## 4. Alert-authority rules

1. **Runtime cannot suppress.** No tRPC route, agent tool, worker, or env flag
   in the app can silence, ack, or reroute these alerts. Alert routing config
   lives in R10-E, writable only by the monitoring operator role.
2. **Fail-visible.** A missing fact is a fact: silence triggers §3 row 8.
3. **No secrets in signals.** Sizes, hashes, ids, timings only — never dump
   content, never env values, never key material.
4. **Correlation rule.** `app_down` + `backup_failed` simultaneously ⇒
   escalate as potential compromise (run S8 of `r10-g-disaster-scenarios.md`
   playbook), not two independent pages.

## 5. Dashboards (initial, R10-E implements)

- **Backup health panel:** last-success age, last-7-day success sparkline,
  size trend line, offsite ack lag, next rehearsal due date.
- **Recovery readiness panel:** restore-test age, retention coverage,
  immutability state, DR-gate status from the acceptance report.

## 6. Versioning

`schemaVersion` starts at 1. R10-E consumes unknown `schemaVersion` by
alerting `backup_monitoring_schema_unknown` (fail visible), never by dropping.
