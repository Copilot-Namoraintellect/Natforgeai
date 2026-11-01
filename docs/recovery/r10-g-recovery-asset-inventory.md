# R10-G RECOVERY ASSET INVENTORY (G0) & DATA CRITICALITY (G1)

> **Stream:** R10-G Backup, Disaster Recovery & Business Continuity (`feature/r10-g-backup-dr`)
> **Programme base:** `799f6b4cb351ebe969f97da606324605fdf2a07b`
> **Status:** pre-infrastructure inventory. The OneGrid production server is
> still being configured by the provider; this inventory is design-time truth
> gathered from the repository, `db/schema.ts` and deployment artefacts.
> Server-side paths marked *(TBD — OneGrid)* must be confirmed on the
> implementation checklist (`r10-g-onegrid-implementation-checklist.md`).
> **Secrets discipline:** this document references *classes* and *locations*
> of secret material only. No secret value appears here, and none may ever be
> copied into backup design documentation.

---

## 1. Recovery asset inventory (G0)

Every asset NatForgeAI requires for full recovery, its authoritative
location, and its recovery mechanism. "Irreplaceable" means loss cannot be
reconstructed from any other source; "rebuildable" means a defined
re-derivation path exists (see §3).

| # | Asset class | Authoritative location | Recovery mechanism | Replaceability |
|---|-------------|------------------------|--------------------|----------------|
| 1 | **Database** — 118 tables (`db/schema.ts`): identity/auth (`users`, `two_factor_challenges`), subscriptions/billing (`subscription_tiers`, `subscriptions`, `payments`, `credit_wallets`, `credit_transactions`, `credit_reservations`, `banking_details`), CRM/marketing core (`businesses`, `campaigns`, `campaign_assets`, `leads`, `lead_activities`, `content_posts`, `schedules`, `automations`, `analytics`, `templates`, `generated_images`), social/R5 authority (`social_integrations`, `social_profiles`, `social_signals`, `social_interpretations`, `social_engagement_events`, `social_listening_states`, `opportunity_candidates`, `opportunity_evidence`, `opportunity_handoffs`, `opportunity_suppressions`, `policy_decisions`, `business_policies`, `engagement_executions`, `engagement_receipts`, `engagement_response_contents`, `engagement_webhook_events`), R6 lead autonomy (`lead_identities`, `lead_identity_provenance`, `lead_identity_merges`, `lead_scores`, `lead_score_snapshots`, `lead_qualifications`, `lead_qualification_reviews`, `lead_privacy_states`, `nurture_handoff_decisions`, `nurture_touch_records`, `sales_handoffs`, `conversion_events`, `conversion_lifecycle_events`), R7 optimisation (`business_outcomes`, `business_outcome_lifecycle_events`, `attribution_results`, `attribution_lifecycle_events`, `business_learning_records`, `business_learning_lifecycle_events`, `experiments`, `experiment_assignments`, `experiment_results`, `experiment_outcome_evidence`, `experiment_lifecycle_events`, `budget_portfolio_snapshots`, `budget_portfolio_proposals`, `budget_portfolio_allocation_instructions`, `optimisation_governance_decisions`), R8 strategic intelligence (`strategic_memory_records`, `strategic_memory_lifecycle_events`, `business_change_events`, `business_change_lifecycle_events`, `external_sources`, `external_signals`, `external_signal_lifecycle_events`, `strategic_reasoning_bundles`, `strategic_reasoning_records`, `strategic_reasoning_lifecycle_events`, `strategic_opportunity_risk_candidates`, `strategic_opportunity_risk_relations`, `strategic_opportunity_risk_lifecycle_events`, `strategic_governance_decisions`, `business_dna_snapshots`, `strategy_snapshots`), R9 mission control (`mission_proposals`, `mission_lifecycle_events`, `mission_plans`, `mission_plan_tasks`, `mission_plan_lifecycle_events`, `mission_schedules`, `mission_schedule_lifecycle_events`, `mission_task_plan_snapshots`, `mission_dependency_edges`, `mission_governance_decisions`, `mission_state_records`, `mission_task_states`, `mission_recovery_candidates`, `mission_operational_timeline_events`, `execution_actions`, `execution_attempts`, `execution_lifecycle_events`), queue/ops (`publishing_queue`, `queue_replay_requests`, `queue_replay_active_claims`, `queue_terminal_failures`, `agent_runs`, `image_render_claims`, `creative_generation_claims`, `handoff_dispatch_receipts`, `outreach_recommendations`, `optimisation_logs`, `learning_records`, `video_render_jobs`), platform (`audit_events`, `system_alerts`, `system_settings`, `ai_usage`) | MySQL 8 on the production host *(TBD — OneGrid)*; connection string in `.env` (`DATABASE_URL`) | Nightly (min.) logical dump via `scripts/backup/backup-database.sh`; point-in-time via binlog *(TBD — OneGrid capability)*; restore via `scripts/restore/run-restore.sh` | Irreplaceable — Tier A/B (§3) |
| 2 | **Migration history** | `db/migrations/` (SQL 0000–0037) + `db/migrations/meta/_journal.json` + 38 snapshots | Versioned in git; verified at restore by comparing applied-journal state vs `db/schema.ts`; canonical `0037_r9_mission_control_foundation` is artefact-only (NOT executed) as of this base | Rebuildable from git, but the **applied-state on the server** is irreplaceable runtime truth — captured in every DB backup and recorded by the restore verifier |
| 3 | **Application artefacts** | `dist/boot.js`, `dist/worker.js`, `dist/public/` (built by `npm run build`: Vite frontend + esbuild API/worker bundles) | Rebuildable from source at a pinned git SHA; release identity captured per backup by `scripts/backup/capture-release-manifest.sh` | Rebuildable |
| 4 | **Repository / version identity** | Git remote `origin` (GitHub), branch + commit SHA, tags | Off-site by construction (git host); every backup set records `git rev-parse HEAD`, branch, dirty-flag | Rebuildable (authoritative copy off-site) |
| 5 | **Environment configuration** | `.env` / `.env.production` on the server *(TBD — OneGrid)*; `.env.example` is the in-repo template (no secrets) | Structure from `.env.example`; live values are secrets — recovered from the secret store (row 6), never from backup payloads. Backup captures a **redacted key inventory + non-secret values only** (`scripts/backup/backup-config.sh`) | Template rebuildable; values irreplaceable (secret store) |
| 6 | **Secrets references** | `APP_SECRET` (JWT), `DATABASE_URL` credential, `FIREBASE_SERVICE_ACCOUNT` / `serviceAccountKey.json`, `OPENAI_API_KEY`, `SMTP_PASS`, `META_APP_SECRET`, `LINKEDIN_CLIENT_SECRET`, OAuth/integration tokens in DB (`social_integrations`, `two_factor_challenges`), Creatify/Bannerbear/Templated.io keys | Production secret store *(TBD — OneGrid)*; DB-stored tokens restored with the database; every backup payload is secret-scanned before leaving the host (`scripts/backup/lib/secret-scan.ts`) | Irreplaceable — recovered from provider consoles/secret store, never from backups |
| 7 | **IIS configuration** | `public/web.config` (URL-rewrite: `/api`, `/generated`, `/uploads` → Node on `127.0.0.1:3001`; SPA fallback; cache control) + any OneGrid site bindings *(TBD — OneGrid)* | In git (`web.config`); server bindings documented on the OneGrid checklist and captured (no secrets) by `backup-config.sh` | Rebuildable |
| 8 | **PM2 / runtime configuration** | PM2 process list + `pm2 save` dump (`~/.pm2/dump.pm2`) on Linux VPS; on OneGrid Windows/IIS: Windows Service / process supervisor *(TBD — OneGrid)*; port (`3000`/`3001`) from `web.config`/deploy docs | Documented startup commands (`DEPLOY_GUIDE.md`); checklist records exact start commands + service identity | Rebuildable |
| 9 | **Workers / schedulers** | `api/worker.ts` (BullMQ publishing + content-generation workers, requires `REDIS_URL`); in-process schedulers in `api/boot.ts` (publishing runner, credit renewal, post-live lifecycle — default off, approval-continuation sweep, engagement sweeps, listening polling) | Code is rebuildable; **in-flight queue state lives in Redis (row 10)**; resumes safely post-restore because R9 exact-once anchors make re-delivery convergent (`ER_DUP_ENTRY` → `idempotent_replay`) | Code rebuildable; queue state recoverable by re-derivation + idempotent replay |
| 10 | **Redis persistence** | BullMQ queues + distributed lease locks (`api/lib/queue/bullmq.ts`, post-live lease) *(TBD — OneGrid)* | **Not authoritative.** Queues are re-derivable from DB truth (publishing_queue, schedules, claims with heartbeats/leases); Redis backup optional (AOF) for warm restart, never required for correctness | Rebuildable by design (R9 exact-once + lease expiry) |
| 11 | **Uploaded / static assets** | `data/public/generated/` (rendered media), `data/public/uploads/` (logos/uploads), `public/templates/previews/` | Filesystem backup (tar into backup set); media referenced from DB (`generated_images`, `campaign_assets`) so rows + blobs are restored together | Blobs re-derivable only by re-paying provider renders — treat as **irreplaceable in practice** (Tier B) |
| 12 | **Provider configuration metadata** | `social_integrations`, `social_profiles`, `banking_details`, `system_settings`, `templates`, `external_sources` | Restored with the database; OAuth app registrations/secrets live at providers (row 6) | Metadata irreplaceable (DB); secrets at providers |
| 13 | **Audit records** | `audit_events` (unique `eventFingerprint`; exactly-one per durable effect across R5–R9) | In the DB backup; restore verifier asserts continuity (monotonic `id`, fingerprint uniqueness, no gaps) | Irreplaceable — Tier A |
| 14 | **Operational state** | `mission_state_records`, `mission_task_states`, `mission_recovery_candidates`, `mission_operational_timeline_events`, `queue_replay_active_claims`, `agent_runs`, `system_alerts` | State rows are in the DB backup; **R9-E state is derived** — after restore it must re-derive from R9-A/B/C/D history, never be trusted as-set (see `r10-g-recovery-rehearsal-plan.md`) | Derived state rebuildable from Tier A history |
| 15 | **Certificates / config dependencies** | TLS certificates (Let's Encrypt on VPS / OneGrid-managed *(TBD)*), Firebase service account file, `drizzle.config.ts`, `tsconfig*.json`, `package.json`/`package-lock.json` | Certs re-issuable (ACME) or provider-managed; service account from secret store; configs in git | Rebuildable |

### 1.1 Explicitly out of scope as backup payloads

- `node_modules/`, `dist/` (rebuildable), local `.env`/`.env.*` on dev
  machines, `serviceAccountKey.json` (git-ignored; secret store only),
  log files, PM2/WebDeploy local caches, any file matched by the
  pre-flight secret scan (backup aborts instead of copying it).

## 2. Where each asset lives at restore time (summary matrix)

| Layer | Asset rows | Backup vehicle | Restore vehicle |
|---|---|---|---|
| Data authority | #1 DB (Tier A tables), #13 audit, #12 provider metadata | nightly encrypted dump + binlog PIT *(TBD)* | `run-restore.sh` → MySQL → verifier |
| Evidence/value | #1 DB (Tier B tables), #11 media blobs | dump + filesystem tar in same backup set | restore + hash manifest re-check |
| Config/identity | #5 env structure, #7 IIS, #8 runtime, #15 certs/configs | redacted config capture + release manifest | re-apply from template + secret store |
| Code | #3 artefacts, #4 repo | release manifest only (git is the backup) | `npm ci && npm run build` at pinned SHA |
| Ephemeral | #9 workers, #10 Redis | none required (by design) | re-derive + idempotent resume |

## 3. Data criticality classification (G1)

### Tier A — CRITICAL AUTHORITY DATA (irreplaceable; loss = authority loss)

These rows *are* the authority their streams own. They are immutable or
append-only, exact-once anchored, and cannot be re-derived from anything else.
Restore must preserve identities, order and immutability byte-for-byte.

| Domain | Tables | Why critical |
|---|---|---|
| Mission authority | `mission_proposals`, `mission_lifecycle_events` | `mis1:`/`obj1:` mission/objective identities; append-only `misl1:` facts |
| Plans / tasks | `mission_plans`, `mission_plan_tasks`, `mission_plan_lifecycle_events` | plan/task identity + lifecycle |
| Schedules | `mission_schedules`, `mission_schedule_lifecycle_events`, `mission_task_plan_snapshots`, `mission_dependency_edges` | schedule identity + frozen plan snapshot binding |
| Governance decisions | `mission_governance_decisions`, `optimisation_governance_decisions`, `strategic_governance_decisions`, `policy_decisions` | `mgd1:`/`ogd1:` receipts; decision policy of record |
| Approvals | `approval_requests` | shared human-approval ledger (campaign/budget/optimisation/mission/strategic); binding hashes |
| Execution intents / results | `execution_actions`, `execution_attempts`, `execution_lifecycle_events` | `exa1:`/`exr1:`/`exl1:` — dispatch intent + attempt truth; no duplicate dispatch may ever be introduced by a restore |
| Recovery state | `mission_state_records`, `mission_task_states`, `mission_recovery_candidates`, `mission_operational_timeline_events` | `mot1:` timeline; derived state + advisory `rcn1:` candidates |
| Audit evidence | `audit_events` | exactly-one ledger per durable effect across all streams |
| Business outcome / learning | `business_outcomes`, `business_outcome_lifecycle_events`, `business_learning_records`, `business_learning_lifecycle_events`, `conversion_events`, `conversion_lifecycle_events` | outcome truth (`out1:`) + value lifecycle + governed learning |
| Attribution / experiments / budget | `attribution_results`, `attribution_lifecycle_events`, `experiments`, `experiment_assignments`, `experiment_results`, `experiment_outcome_evidence`, `experiment_lifecycle_events`, `budget_portfolio_snapshots`, `budget_portfolio_proposals`, `budget_portfolio_allocation_instructions` | credit allocation truth, governed experiment results, bounded proposals |
| Lead autonomy authority | `lead_identities`, `lead_identity_provenance`, `lead_identity_merges`, `lead_scores`, `lead_score_snapshots`, `lead_qualifications`, `lead_qualification_reviews`, `lead_privacy_states`, `nurture_handoff_decisions`, `nurture_touch_records`, `sales_handoffs`, `opportunity_handoffs`, `handoff_dispatch_receipts` | `lid1:` identity, evidence scoring, governed qualification, exact-once handoffs |
| Platform access/security | `users`, `two_factor_challenges`, `system_settings` | authentication identity, OTP challenges, platform config |

### Tier B — IMPORTANT BUSINESS DATA (irreplaceable; loss = data loss, not authority loss)

User/business content and evidence with no regeneration path: `campaigns`,
`campaign_assets`, `businesses`, `leads`, `lead_activities`, `content_posts`,
`schedules`, `automations`, `analytics`, `templates`, `generated_images`,
`publishing_queue`, `credit_wallets`, `credit_transactions`,
`credit_reservations`, `payments`, `subscriptions`, `subscription_tiers`,
`banking_details`, `social_signals`, `social_interpretations`,
`social_engagement_events`, `engagement_*`, `opportunity_candidates`,
`opportunity_evidence`, `opportunity_suppressions`, `lead_activities`,
media blobs (#11), provider metadata (#12). Restored from the same dump;
RPO drives loss window (see `production-recovery-objectives-contract.md`).

### Tier C — REBUILDABLE / DERIVED (loss acceptable within RTO; rebuild path defined)

| Asset | Rebuild path |
|---|---|
| `dist/` build artefacts | `npm ci && npm run build` at pinned SHA (release manifest) |
| Redis queues / leases | DB-driven re-derivation + BullMQ idempotent replay; lease expiry bounds staleness |
| `mission_state_records`, `mission_task_states` | R9-E re-derivation from restored Tier A history (restore harness step 7) |
| `queue_replay_active_claims`, `agent_runs` (transient rows) | Sweep/re-claim; exact-once convergence anchors prevent duplicates |
| `node_modules`, caches, logs | Reinstall / drop |
| Media blobs (bounded) | Re-render at provider cost — last resort only |

### 3.1 Criticality rules

1. Tier A tables are restored **first and verified** — the recovery
   integrity verifier (`scripts/restore/restore.ts gather` + `verify`)
   fails the restore on any Tier A mismatch.
2. Tier B shares the same dump; no separate handling beyond the same
   hash/manifest discipline.
3. Tier C is never restored blindly: derived mission state is re-derived,
   stale claims are expired, workers are started only after verification
   (no stale worker resumes with old authority — G7).
4. A backup that contains Tier A/B data is itself a **secret-class asset**
   even after redaction, because business data + tokens are sensitive;
   encryption and access isolation (G3/G9) apply to every copy.
