# R10-G ONEGRID IMPLEMENTATION CHECKLIST (G11)

> **Stream:** R10-G (`feature/r10-g-backup-dr`)
> **Status:** PREPARED — for execution once the OneGrid production server is
> ready. **Do not execute against OneGrid before that point.** No step in this
> checklist has been run; every box is pending.
> **Rule:** completing this checklist enables the backup pipeline; it does
> **not** constitute disaster-recovery acceptance — that requires the R10-X
> restore rehearsal (`r10-g-recovery-rehearsal-plan.md`).

Legend: `[ ]` pending · verify each line with the noted command or artefact.

---

## 1. Discovery (fill in, then mirror to `r10-g-recovery-asset-inventory.md`)

- [ ] 1.1 Database: MySQL version, datadir path, service name — `mysqld --version; systemctl status mysql` *(or OneGrid equivalent)*
  - Record: version `____` datadir `____` service `____`
- [ ] 1.2 Application directory: `____` (contains `dist/`, `node_modules/`, `.env`)
- [ ] 1.3 Config locations: `.env` path `____`; `web.config` served from `____`; IIS site name `____` (or reverse-proxy equivalent)
- [ ] 1.4 Runtime configuration: process supervisor (PM2 / Windows Service / IIS node handler) `____`; app port `____` (expected `3001` per `web.config`)
- [ ] 1.5 Worker runtime: separate process for `dist/worker.js`? `____`; `REDIS_URL` source `____`
- [ ] 1.6 Asset dirs: `data/public/generated`, `data/public/uploads` absolute paths `____`
- [ ] 1.7 Service accounts: app identity `____`; create dedicated **backup identity** `backup-op` (non-admin for app; no app-login rights)
- [ ] 1.8 Existing backup facility from provider (snapshots?) `____` — note: provider snapshots are **not** a substitute for encrypted logical dumps; they may complement copy 2

## 2. Backup destination (local — copy 2 of the 3)

- [ ] 2.1 Create `/var/backups/natforge` (or agreed path) — `install -d -o backup-op -g backup-op -m 0700 /var/backups/natforge`
- [ ] 2.2 Verify app identity **cannot** read it: `sudo -u <app-user> ls /var/backups/natforge` → must be DENIED
- [ ] 2.3 Capacity: ≥ 3× largest expected set × retention (14 daily + 8 weekly + 12 monthly); record free space `____`

## 3. Offsite destination (independently protected — copy 3)

- [ ] 3.1 Offsite target chosen: S3-compatible bucket / OneGrid secondary site `____` *(record region/site)*
- [ ] 3.2 Versioning ON; object-lock / immutability / lifecycle-hold enabled for the retention window where supported — record provider capability: `yes|no|partial`
- [ ] 3.3 Dedicated offsite access key (distinct from runtime keys), policy: PutObject/GetObject/List + lifecycle-hold only; **no** bucket-wide delete — attach policy doc ref `____`
- [ ] 3.4 Offsite key stored in production secret store under `BACKUP_OFFSITE_*`; **not** in `.env` on the app host
- [ ] 3.5 Test push + ack of one canary object from the backup job context only

## 4. Encryption

- [ ] 4.1 Generate strong backup passphrase; store in secret store (`BACKUP_PASSPHRASE_REF`); never write to disk on app host
- [ ] 4.2 Rotate procedure documented (re-encrypt sets on rotation) — one page in ops vault
- [ ] 4.3 Confirm no key material appears in any manifest/log (`grep -Ril "BEGIN\|PRIVATE KEY" /var/backups` → empty)

## 5. Scheduling

- [ ] 2.1-style cron/systemd timer entry: nightly 02:00 local, as `backup-op`:
  `BACKUP_CONFIG=/etc/natforge/backup.env scripts/backup/run-backup.sh`
- [ ] 5.2 Timer unit files committed to ops repo (auditable config change, G3 I3)
- [ ] 5.3 Random-offset/backup-window note: expected set duration `____` (must finish before 04:00 for the monitoring silence-alert)

## 6. Retention

- [ ] 6.1 Apply prune plan daily=14 / weekly=8 / monthly=12 (initial; adjust via versioned config only)
- [ ] 6.2 Offsite lifecycle rule mirrors the plan (belt-and-braces with local prune)
- [ ] 6.3 Record first prune run output in the ops log

## 7. Monitoring wiring (per `backup-monitoring-contract.md`)

- [ ] 7.1 `backup-run.json` ingest path configured in R10-E
- [ ] 7.2 Alerts armed: `backup_failed`, `offsite_replication_failed`, `backup_monitoring_silent`, `rpo_at_risk`, `restore_rehearsal_overdue`, `retention_gap`, size-anomaly
- [ ] 7.3 Alert routing: on-call operator; **no application role on the route**
- [ ] 7.4 Dashboard panels live (backup health + recovery readiness)

## 8. Firewall / access

- [ ] 8.1 Offsite endpoint egress allowed from host only for the backup job's network context
- [ ] 8.2 SSH: key-only, disable password login; record admin access list `____`
- [ ] 8.3 MySQL bound to localhost (or app-only interface); remote root denied — `SELECT user,host FROM mysql.user;`
- [ ] 8.4 `/var/backups` excluded from any web-servable path; confirm no vhost maps to it

## 9. Restore target

- [ ] 9.1 Disposable recovery environment identified: scratch VM/container on OneGrid or local; **never the production DB**
- [ ] 9.2 Restore guard config: `RESTORE_TARGET_ROLE=recovery` recorded; `run-restore.sh` refuses `production` targets without the disaster-recovery flag
- [ ] 9.3 Recovery env has MySQL 8 matching production minor version

## 10. Validation commands (run after each of the first 3 real backups)

- [ ] 10.1 `./scripts/backup/verify-backup.sh --set <setId> --full` → manifestOk + decryptRoundTripOk + dumpSanityOk
- [ ] 10.2 Table count vs `information_schema` on source: equal
- [ ] 10.3 Offsite listing shows set + `backup-run.json`, versioning marker present
- [ ] 10.4 `scripts/restore/verify-recovery-integrity.mjs` against a scratch restore → `INTEGRITY_PASS`
- [ ] 10.5 Mission Control acceptance subset on the scratch restore → green (R10-X gate input)

## 11. Sign-off

- [ ] 11.1 Operator: `____` date `____`
- [ ] 11.2 Backup authority holder: `____` date `____`
- [ ] 11.3 R10-E monitoring owner: `____` date `____`
- [ ] 11.4 First **restore rehearsal** scheduled (date `____`) — the checklist is incomplete until §10.4–10.5 have run at least once in the recovery environment
