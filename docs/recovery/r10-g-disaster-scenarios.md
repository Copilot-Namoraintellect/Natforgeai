# R10-G DISASTER SCENARIOS & RECOVERY PROCEDURES (G8)

> **Stream:** R10-G (`feature/r10-g-backup-dr`)
> **Status:** prepared procedures for the OneGrid production era. None of
> these has been executed against production (the server is still being
> configured); each defines **detect → contain → recover → validate → resume**
> with the harnesses in `scripts/backup` and `scripts/restore`.

Every scenario ends with the same two gates: (1) the recovery integrity
verifier (`scripts/restore/verify-recovery-integrity.mjs`) passes, and (2) the
Mission Control connected acceptance subset (`r10-g-recovery-rehearsal-plan.md`
§4) is green. A recovery is not complete until both gates pass.

---

## S1 — Application-server loss (host/VM dies, OS unbootable, accidental termination)

- **Detect:** health endpoint down + PM2/service failure + provider alert; R10-E alert `app_down`.
- **Contain:** confirm DB intact (separate volume/process); freeze deploys; snapshot surviving volumes read-only if possible for forensics.
- **Recover:** provision replacement host → restore latest verified backup set (`scripts/restore/run-restore.sh`) → rebuild app at the release manifest's pinned SHA → re-bind config from secret store → start service.
- **Validate:** `verify-recovery-integrity.mjs` green; smoke checks (login, tRPC ping, dashboard); schema/migration identity match.
- **Resume:** re-enable traffic; workers start after verification (never before); post-incident note in R10-X log.

## S2 — Database corruption (MySQL data-dir damage, failed migration, torn writes)

- **Detect:** app `ER_` corruption errors, failed migration run, failed backup sanity, table-check warnings (`mysqlcheck`).
- **Contain:** stop app + workers (no writes against corrupt truth); snapshot corrupt datadir read-only for forensics; do not "repair in place" beyond checks — restore beats repair for authority data.
- **Recover:** clean MySQL instance → restore latest verified dump → if binlog/PITR available *(TBD OneGrid)*, roll forward to last good minute; otherwise accept ≤ 24 h RPO point.
- **Validate:** integrity verifier; spot-check Tier A tables (mission/governance/approval counts vs last known good snapshot); migration journal matches pre-incident state.
- **Resume:** start app read-only-smoke → full traffic; investigate corruption cause before next deploy.

## S3 — Accidental deletion (table dropped, rows deleted, wrong `DELETE`, repo force-push)

- **Detect:** audit/row-count anomaly, user report, migration mismatch alert; offsite backup age unaffected.
- **Contain:** revoke the offending credential's write path; capture binlog *(if enabled)* to identify the exact window; prevent app restarts that would write into the gap.
- **Recover:** restore **parallel** scratch instance from the last pre-deletion verified set; extract/ diff only the lost objects; re-apply surgically (or full swap if the deletion is broad). For repo: `git reflog` + branch restore from remote; never force-push shared branches.
- **Validate:** restored rows carry identical identities (deterministic `mis1:`/`out1:`/`exa1:` ids re-derive identically); duplicate-anchor check proves no double-insert; verifier green.
- **Resume:** confirm app-level counts; log the guardrail gap (permissions/migration-path fix) in R10-X log.

## S4 — Failed deployment (bad build/migration breaks production)

- **Detect:** failed post-deploy verification (`scripts/verify-deployment.mjs`), error-rate spike, failed migration step.
- **Contain:** stop rollout; keep previous `dist/` (deployments are versioned by SHA — never overwrite in place); halt workers if schema is ahead of code.
- **Recover:** rollback = re-point service to previous build dir + previous migration state; if the migration already ran and is irreversible, treat as S3 (scratch restore + surgical re-apply).
- **Validate:** verifier green at the rolled-back schema/SHA pair; migration journal exactly matches pre-deploy state.
- **Resume:** fix forward on a branch; re-deploy only after offline build + verification pass.

## S5 — Worker corruption (worker process crash-loop, poisoned job, Redis flush)

- **Detect:** PM2 restart loop, BullMQ stalled-job alerts, worker log fatals; DB authority unaffected.
- **Contain:** stop workers (app keeps serving); snapshot Redis (AOF) if available; identify poison job id.
- **Recover:** workers hold **no authority** — restart clean; queues re-derive from DB (`publishing_queue`, schedules, claims); expired leases/claims are re-claimed by heartbeat rules; poison job is quarantined (moved to `queue_terminal_failures` semantics), not replayed blindly.
- **Validate:** no duplicate side effects: exact-once anchors (`ER_DUP_ENTRY → idempotent_replay`) prove redelivery converges; spot-check recent `execution_attempts` for doubled `SUCCEEDED`.
- **Resume:** workers one at a time; watch `UNCERTAIN`/`FAILED_FINAL` rates (R10-E metrics).

## S6 — Redis loss (process/volume loss, eviction, flushall)

- **Detect:** Redis down/empty alerts; worker fail-closed exit ("Redis is required").
- **Contain:** nothing to contain — Redis is non-authoritative by design.
- **Recover:** restart Redis empty; queues rebuild from DB truth; distributed leases re-form from heartbeat rules.
- **Validate:** idempotent replay convergence as S5; confirm no job is marked done in Redis-but-not-DB (impossible: DB is the ledger).
- **Resume:** workers up; optional AOF persistence re-enabled *(TBD OneGrid)*.

## S7 — Provider credential compromise (OpenAI/SMTP/Meta/LinkedIn/Creatify key leaks)

- **Detect:** provider anomalous-usage alerts, secret-scan hit, suspect egress.
- **Contain:** rotate the compromised credential at the provider **first**; update the secret store; if the DB-stored OAuth tokens are suspect (`social_integrations`), revoke at provider and mark integrations disconnected.
- **Recover:** no restore needed for code/config; if attacker used tokens to mutate provider-side state, re-run affected syncs from DB truth.
- **Validate:** app smoke checks per integration; `audit_events` shows no unauthorized durable effects (review window).
- **Resume:** monitor provider usage; record rotation in ops log (restore-log discipline applies: audited).

## S8 — Ransomware / server compromise

- **Detect:** mass file renames/entropy spike, ransom note, EDR alert, unexpected egress to unknown host.
- **Contain:** isolate host from network (provider console); **do not** pay/log-in interactively beyond triage; snapshot volumes read-only for forensics; disable compromised credentials/keys (S7 for every secret on the box, incl. `APP_SECRET` → force re-login of all sessions).
- **Recover:** treat as full-platform loss (S1+S2 combined) on a **clean** host from the last verified pre-compromise backup set; offsite copy is the trusted source if local backups are encrypted by the attacker — immutability window (G3) must cover the compromise window; rebuild from pinned SHA; secrets from store with full rotation.
- **Validate:** full verifier + acceptance subset; confirm no persistence mechanisms in rebuilt artefacts (clean npm ci, locked-down ports).
- **Resume:** gradual traffic ramp; heightened monitoring for re-entry indicators; incident report to R10-X log.

## S9 — Operator mistake (wrong env, wrong host, dropped wrong table)

- **Detect:** immediate verification failure or human report; audit log of admin actions.
- **Contain:** stop the affected path; capture what was done (shell history, audit events) to scope the blast radius.
- **Recover:** same discipline as S3 — scratch restore from last verified set; surgical re-apply; mistakes against **live** authority are fixed by restore, never by hand-editing authority rows.
- **Validate:** verifier + identity/dup checks.
- **Resume:** post-mortem; add the guardrail (permission narrowing, pre-flight checklist step, confirmation prompt) to the OneGrid checklist.

## S10 — Regional / provider outage (OneGrid site unreachable)

- **Detect:** provider status page + external health probes failing from multiple vantage points.
- **Contain:** nothing local; communicate status; freeze non-urgent deploys.
- **Recover:** business-continuity mode: if a warm standby exists *(future R10 decision)*, promote it from the last offsite set; otherwise RTO = provider restoration + S1 sequence. DNS failover only if a second site exists.
- **Validate:** same gates; RPO measured against last offsite ack timestamp.
- **Resume:** when provider restores, reconcile: restored-by-provider copy vs offsite copy — **the newer verified copy wins only after verification**, never by assumption.

## S11 — Partial backup failure (dump fails mid-run, offsite push fails, disk full)

- **Detect:** `backup-run.json` status FAILED; R10-E alerts `backup_failed` / `offsite_replication_failed`.
- **Contain:** failed sets are quarantined (`.partial` suffix) and never counted toward RPO; disk-pressure alerts paged.
- **Recover:** re-run the job after fixing cause; no restore needed. If the local copy is good but offsite failed, the set is incomplete: either retry push or regenerate — **a set without offsite ack is not verified**.
- **Validate:** verify pass + offsite ack present; monitoring contract green.
- **Resume:** normal schedule; recurring partial failures escalate (job redesign, capacity).

## S12 — Backup corruption (manifest/hash mismatch, undecryptable set)

- **Detect:** `verify-backup.sh` failure, hash mismatch on restore attempt, GCM auth-tag failure.
- **Contain:** mark the set `CORRUPT`; never delete the only other copies until a verified set exists.
- **Recover:** fall back to the next-older verified set; corruption of the **newest** set with no other recent copy = RPO widens to the last good set — report honestly (RPO contract `BREACHED` handling).
- **Validate:** next-older set verifies clean; if corruption recurs across sets, suspect storage/media and migrate backup destination before continuing.
- **Resume:** schedule an extra (out-of-cycle) verified set immediately after any corruption event.

---

## Cross-scenario rules

1. **Authority rows are never hand-edited during recovery.** Restore, don't patch.
2. **No worker resumes before verification** (G7: no stale worker resumes with old authority).
3. **Every restore is audited** (`restore-run.json` + append-only restore log).
4. **RPO/RTO measured per event** and recorded against
   `production-recovery-objectives-contract.md` (objective lifecycle).
5. **Forensics snapshots are read-only** and never mounted into a running app.
