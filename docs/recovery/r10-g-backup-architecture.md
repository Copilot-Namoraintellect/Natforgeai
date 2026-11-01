# R10-G BACKUP ARCHITECTURE, AUTHORITY & SECURITY (G3 / G4 / G9)

> **Stream:** R10-G (`feature/r10-g-backup-dr`)
> **Status:** design + implementation harness; awaiting OneGrid infrastructure
> **Companion docs:** `r10-g-recovery-asset-inventory.md` (what),
> `production-recovery-objectives-contract.md` (how fast),
> `r10-g-disaster-scenarios.md` (what goes wrong),
> `backup-monitoring-contract.md` (observability), `r10-g-onegrid-implementation-checklist.md`
> (execution), `r10-g-recovery-rehearsal-plan.md` (acceptance).

---

## 1. Core principle

> **Backup success != recovery success.**
> The pipeline below is a *recovery pipeline*. Every backup set is born with
> its verification artefacts, and no backup set is "successful" until
> `verify-backup.sh` has passed and the offsite replication has acknowledged.

## 2. 3-2-1 architecture (G3)

```
                        ┌────────────────────────────────────────────┐
                        │              OneGrid production host        │
                        │                                             │
  mysqldump ──┐         │  /var/backups/natforge/ (mode 0700, owner   │
  (nightly,   ├────────►│  backup-op only)                              │
  02:00)      │         │    ├── set-YYYYmmddTHHMMSSZ/                  │
              │         │    │    ├── db/dump.sql.gz.enc   (AES-256-GCM)│
  config/env  ├────────►│    │    ├── config/env-inventory.redacted.json│
  (redacted)  │         │    │    ├── config/web.config (from git)      │
              │         │    │    ├── assets/data-public.tar.gz.enc     │
  media tar ──┤         │    │    ├── release-manifest.json             │
              │         │    │    └── MANIFEST.sha256 (plaintext, signed│
  release     ├────────►│    │        set contents)                     │
  manifest    │         │    └── set-…/ (prior sets, pruned by retention)│
              │         │                                             │
              │         │  copy 1 (primary) : local backup volume/dir   │
              │         └───────────────┬─────────────────────────────┘
              │                         │  encrypted push (TLS), distinct
              │                         ▼  credentials, append-only ACL
              │         ┌────────────────────────────────────────────┐
              │         │  copy 2 (offsite): S3-compatible bucket /   │
              │         │  OneGrid secondary site  *(TBD — OneGrid)*  │
              │         │  ── versioning ON, object-lock/immutability  │
              │         │     where supported, lifecycle retention     │
              │         └────────────────────────────────────────────┘
              │
              ▼  git (code authority, off-site by construction)
```

**The three copies:** (1) production database itself, (2) local encrypted
backup set, (3) offsite encrypted replica.
**Two locations/media classes:** production host storage vs offsite object
store/secondary site — different failure domains (host compromise/loss vs
site/region loss).
**One offsite independently protected copy:** encryption key is *not* stored
with the offsite copy; offsite credentials are distinct from production
runtime credentials and grant write/append + lifecycle-hold only (no
delete-by-compromise of locked objects).

### 2.1 Requirements checklist (G3)

| Requirement | Design |
|---|---|
| Encryption | AES-256-GCM per file, key = scrypt(passphrase ∥ set salt); passphrase lives in the production secret store, injected into the backup job only (never on the app host filesystem, never in the repo, never in logs). `scripts/backup/lib/encrypt.ts` |
| Retention | Default: 14 daily + 8 weekly + 12 monthly sets, computed by pure `prunePlan()` (`lib/retention.ts`); enforced locally *and* by offsite bucket lifecycle rules (defence in depth) |
| Versioning / immutability | Offsite bucket: versioning ON; object-lock/immutability (or provider lifecycle hold) for the retention window where supported — *TBD OneGrid capability; mandated on the checklist* |
| Monitoring | Every run emits `backup-run.json` (status, sizes, hashes, timing, verification result); R10-E consumes per `backup-monitoring-contract.md`; failure → alert (not suppressible by runtime agents) |
| Backup verification | Same-run: manifest re-hash, decrypt round-trip on one file, `mysqldump` sanity (table count > 0, footer present); periodic: full restore rehearsal (G12) |
| Access isolation | Local dir `0700` owned by `backup-op` (dedicated OS user, not the app user, not root's daily user); offsite ACL dedicated to backup role; app runtime user has **no** read access to `/var/backups` |

## 3. Backup authority model (G4)

Backup authority is **separate from application runtime authority**.

| Capability | Runtime app / AI agents | Backup operator (`backup-op`) |
|---|---|---|
| Disable backup job | **NO** | yes (cron/systemd + offsite lifecycle) |
| Delete backup sets | **NO** | yes, local (offsite deletion requires second factor / lifecycle-break process) |
| Change retention | **NO** | yes, versioned config + audit |
| Change backup destination | **NO** | yes, versioned config + audit |
| Retrieve encryption passphrase | **NO** | yes, via secret store read for the job only |
| Disable offsite replication | **NO** | yes (break-glass, two-person rule) |
| Suppress backup alerts | **NO** | monitoring is outside the app path; alert routing lives in R10-E |
| Read backup payloads | **NO** | yes (for restore) — and every restore is audited |

Enforcement is structural, not policy-only:

1. **OS-level:** the app runs as `natforge-app` (or IIS app-pool identity);
   backups run as `backup-op`; `/var/backups/natforge` is `0700 backup-op`.
   The app user is not in the backup group. On Windows/IIS: separate service
   account for the scheduled backup task, ACL on backup root denying the
   app-pool identity.
2. **Network-level:** offsite credentials are a distinct access key held only
   in the backup job's environment (secret store), with bucket policy denying
   delete where object-lock applies; the app host's runtime env never contains
   them.
3. **Code-level:** nothing in `api/` imports backup modules; there is **no
   tRPC procedure, no agent tool, no router** that touches backup paths,
   retention, or keys. The backup harness lives exclusively under
   `scripts/backup` + `scripts/restore` and runs outside the API process.
   (Verifiable: `grep -r "scripts/backup" api/ src/` → no matches.)
4. **Agent isolation:** runtime AI/agents (including Mission Control at any
   autonomy level) execute inside the API/worker processes and therefore
   inherit the OS/network boundary above. No prompt, model, or agent plan can
   reach backup material — **AGENT_BACKUP_ACCESS=False** by construction, not
   by instruction.

### 3.1 Authority invariants

- `I1`: No single credential can both run the app and destroy all backups
  (different users, different offsite key, immutability window).
- `I2`: Ransomware running as the app user cannot encrypt or delete backups
  (filesystem deny + offsite immutability).
- `I3`: Backup config changes are themselves audited (git-ops or append-only
  job log) — silent destination/retention drift is detectable.
- `I4`: The backup job fails closed: any error (dump, scan, hash, encrypt,
  offsite ack) marks the run FAILED and alerts; a partial set is never
  reported as success.

## 4. Backup security controls (G9)

| Control | Implementation |
|---|---|
| Backup credentials unavailable to agents | §3 (structural isolation) |
| Backup storage separate from runtime | separate path, separate user, separate offsite account; backups never under the web root or app dir |
| Deletion requires separate authority | local delete = `backup-op`; offsite delete = lifecycle-break + second person; retention config change = versioned + audited |
| Encryption at rest | AES-256-GCM; passphrase via secret store; salt per set; no key material in manifests or logs |
| Sensitive data not logged | scripts log sizes/hashes/status only; pre-flight `secret-scan` aborts a set if a payload matches secret patterns (AWS keys, private-key blocks, `APP_SECRET=…`, connection strings with passwords, JWT-looking blobs) |
| Restore operations audited | `run-restore.sh` appends to an append-only restore log (who/when/set id/target/verdict); restores also write a `restore-run.json` inside the recovery environment |
| No prompt/model access to payloads | no LLM call anywhere in the pipeline; payloads never leave the host except to the encrypted offsite bucket |
| Integrity | `MANIFEST.sha256` covers every file in a set; tamper ⇒ verify fails; verifier re-checks after every copy/transfer |
| Pre-flight hygiene | `backup-config.sh` redacts env values (key names + non-secret values only); `serviceAccountKey.json`, `.env` raw files, `node_modules`, logs are excluded by the manifest builder |

## 5. Components (repo layout)

```
scripts/backup/
  README.md                     operator guide
  run-backup.sh                 orchestrator (nightly job entrypoint)
  backup-database.sh            mysqldump wrapper (credentials via env only)
  backup-config.sh              redacted config/env/IIS/runtime capture
  capture-release-manifest.sh   git SHA / build identity
  verify-backup.sh              manifest re-hash + decrypt round-trip + sanity
  lib/manifest.ts               backup-set manifest build/verify (pure)
  lib/retention.ts              prune-plan computation (pure)
  lib/encrypt.ts                AES-256-GCM encrypt/decrypt helpers
  lib/secret-scan.ts            pre-flight secret-pattern scan (pure)
  lib/redact-env.ts             .env → redacted inventory (pure)
  lib/backup-set.ts             set assembly orchestration (Node)
scripts/restore/
  run-restore.sh                disposable-environment restore sequence
  verify-recovery-integrity.mjs post-restore authority/audit integrity checks
```

All scripts refuse to run if pointed at a database host other than the one
explicitly configured for their role (backup script takes a dump; restore
script targets a scratch/recovery instance only — see `run-restore.sh`
guards) and never embed credentials.
