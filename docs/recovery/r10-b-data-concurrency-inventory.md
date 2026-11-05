# R10-B Data Integrity & Real-MySQL Concurrency — Database / Transaction Inventory + Concurrency Threat Model (B0/B1)

> **Stream:** R10-B Data Integrity, Real MySQL & Concurrency (`feature/r10-b-data-concurrency`)
> **Programme base:** `799f6b4cb351ebe969f97da606324605fdf2a07b` (R9-X `MISSION_CONTROL_V1_READY`)
> **Date:** 2026-11-11
> **Purpose:** inspected-before-editing inventory of every database,
> transaction, locking, CAS, idempotency and worker-interaction surface
> relevant to Mission Control data integrity under real relational-database
> concurrency; plus the production concurrency threat model (B1). No code was
> changed to produce this inventory; every claim below was verified by reading
> the repository at the frozen base.

---

## B0 — Part 1: Database / transaction inventory

### 1. DB library / driver / connection

| Item | Value | Location |
|---|---|---|
| ORM | `drizzle-orm` `^0.45.1` | `package.json` |
| Driver | `mysql2` `^3.14.1` (MySQL wire protocol) | `package.json` |
| Connection factory | `drizzle(env.databaseUrl, { mode: "planetscale", schema: fullSchema })` — lazy singleton | `api/queries/connection.ts:10-16` |
| Pooling | mysql2 default pool created implicitly by the Drizzle mysql2 driver (default `connectionLimit` 10). **No explicit pool tuning, no per-tenant pooling, no separate read pool.** | `api/queries/connection.ts` |
| Env source | `env.databaseUrl` ← `DATABASE_URL` (required) | `api/lib/env.ts:32` |
| Schema source | `db/schema.ts` (single source of truth) + `db/relations.ts`, merged into the Drizzle client | `api/queries/connection.ts:3-6` |
| Dialect config | `drizzle.config.ts` → `dialect: "mysql"`, `out: "./db/migrations"` | `drizzle.config.ts` |

`mode: "planetscale"` is set on the client. With the `mysql2` driver this
mode does not remove transaction support (it is an HTTP-driver concern), but
it is recorded here because it is a non-default client configuration that
R10-X should re-confirm before production cut-over.

### 2. Migration mechanism

| Item | Value |
|---|---|
| Tool | `drizzle-kit` `^0.31.8`; scripts `db:generate` / `db:migrate` / `db:push` |
| Artefacts | `db/migrations/*.sql` + `db/migrations/meta/_journal.json` |
| Journal head | idx 37 = `0037_r9_mission_control_foundation` — the canonical, still-unexecuted R9 migration |
| Chain | 38 journal entries, `0000`…`0037`; single linear chain, no branches in the journal |
| Retired provisionals | Stream-local `0037_*` provisionals (R9-A/B/C/D/E/F) were converged into the single canonical `0037_r9_mission_control_foundation` at R9-X (`docs/recovery/r9-x-migration-convergence.md`). They must **not** be recreated. |
| Execution authority | Migration commands are operator-run npm scripts only. No API route, worker path or agent tool can execute migrations (verified: no router imports `drizzle-kit`; see B7). |

### 3. Transaction usage map

`db.transaction()` (Drizzle transactional executor) is used in:

- `api/lib/billing/credit-engine.ts`, `credit-reservation-engine.ts`
- `api/lib/creative/image-render-finalization.ts`, `creative-generation-claim.ts`
- `api/lib/policy/policy-store.ts`
- `api/lib/publish/publish-package-queue-persistence.ts`
- `api/lib/queue/terminal-replay.ts` (`withTerminalReplayTransaction`)
- `api/lib/agents/strategy-agent.ts`, `api/lib/workflow/engine.ts`, `publishing-runner.ts`
- `api/lib/strategic-governance/strategic-governance-engine-binding.ts`
- Several legacy routers (`admin-router`, `approval-router`, `banking-router`, `budget-portfolio-router`, `integration-router`, …)

**Mission Control authority stores (R9-A/B/C/D/E/F) do NOT use
multi-statement transactions.** Every durable effect is a single autocommit
INSERT or a single guarded UPDATE:

| Store | Write pattern |
|---|---|
| `api/lib/mission-authority/mission-authority-store.ts` | insert-first + unique-anchor convergence |
| `api/lib/mission-planning/mission-planning-store.ts` | insert-first + unique anchors; CAS version guards |
| `api/lib/mission-scheduling/mission-scheduling-store.ts` | insert-first + unique anchors; CAS version guards |
| `api/lib/execution-coordination/execution-coordination-store.ts` | insert-first + unique anchors; optimistic-CAS state transitions |
| `api/lib/mission-state-recovery/mission-state-recovery-store.ts` | insert-first + unique anchors; optimistic-CAS lifecycle |
| `api/lib/mission-governance/mission-governance-store.ts` | insert-only receipts + unique `(userId, governanceDecisionId)` anchor |

This is a deliberate design property: convergence is achieved by
**deterministic identity + durable unique indexes + insert-only rows +
optimistic CAS**, not by holding locks across multiple statements. The
consequence for R10-B: deadlock/rollback surface in the authority paths is
minimal, and every multi-row atomicity requirement that *does* exist
(terminal-replay claims, billing holds) already lives behind an explicit
transaction helper.

### 4. Unique constraints & idempotency anchors — Mission Control (canonical `db/schema.ts`)

| Table | Durable unique anchor(s) | Identity | Owner |
|---|---|---|---|
| `mission_proposals` | `mp_mission_identity_uidx`(`missionId`); `mp_user_mission_uidx`(`userId`,`missionId`) | deterministic `mis1:` sha256 over {tenant, business, sourceCandidate, missionType, scopeKey, constraintSetFingerprint} | R9-A |
| `mission_lifecycle_events` | `mle_lifecycle_identity_uidx`(`lifecycleEventId`) | deterministic `misl1:` | R9-A |
| `mission_plans` | `mplans_plan_identity_uidx`(`planId`); `mplans_user_plan_uidx`(`userId`,`planId`); `mplans_user_mission_version_uidx`(`userId`,`missionId`,`planVersion`) | deterministic `pln1:`; version anchor serializes concurrent plan versions | R9-B |
| `mission_plan_tasks` | `mptasks_task_identity_uidx`(`taskId`); `mptasks_user_task_uidx`(`userId`,`taskId`) | deterministic `tsk1:` | R9-B |
| `mission_plan_lifecycle_events` | `mpl_lifecycle_identity_uidx`(`lifecycleEventId`) | deterministic `mpl1:` | R9-B |
| `mission_task_plan_snapshots` | `mtps_plan_fingerprint_uidx`(`planFingerprint`); `mtps_coordinate_fingerprint_uidx`(`userId`,`missionId`,`planId`,`planFingerprint`) | content-addressed | R9-C |
| `mission_dependency_edges` | `mde_dependency_id_uidx`; `mde_user_dependency_uidx`; `mde_natural_key_uidx`(`userId`,`missionId`,`planId`,`pred`,`succ`,`type`) | deterministic `dep1:` + natural key | R9-C |
| `mission_schedules` | `msch_schedule_id_uidx`(`scheduleId`); `msch_user_schedule_uidx`(`userId`,`scheduleId`) | content-addressed `sch1:` | R9-C |
| `mission_schedule_lifecycle_events` | `msle_lifecycle_identity_uidx`(`lifecycleEventId`) | deterministic `msl1:` | R9-C |
| `execution_actions` (dispatch intent) | `exa_action_identity_uidx`(`executionActionId`); `exa_user_action_uidx`(`userId`,`executionActionId`); `exa_user_idempotency_uidx`(`userId`,`idempotencyKey`) | deterministic `exa1:` + server-minted `idem1:` (never client-generated) | R9-D |
| `execution_attempts` | `exr_attempt_identity_uidx`(`attemptId`); `exr_user_attempt_uidx`(`userId`,`attemptId`); `exr_user_action_attempt_uidx`(`userId`,`executionActionId`,`attemptNumber`) | deterministic `exr1:` | R9-D |
| `execution_lifecycle_events` | `exl_lifecycle_identity_uidx`(`lifecycleEventId`) | deterministic `exl1:` | R9-D |
| `mission_state_records` | `msr_state_identity_uidx`(`missionStateId`); `msr_user_state_uidx`(`userId`,`missionStateId`) | deterministic `mst1:` | R9-E |
| `mission_task_states` | `mts_state_identity_uidx`(`taskStateId`); `mts_user_state_uidx`(`userId`,`taskStateId`) | deterministic `tst1:` | R9-E |
| `mission_recovery_candidates` | `mrc_identity_uidx`(`recoveryCandidateId`); `mrc_user_recovery_uidx`(`userId`,`recoveryCandidateId`) | deterministic `rcn1:` | R9-E |
| `mission_operational_timeline_events` | `mote_identity_uidx`(`timelineEventId`); `mote_user_timeline_uidx`(`userId`,`timelineEventId`) | deterministic `mot1:` | R9-E |
| `mission_governance_decisions` | `mgd_decision_id_idx`(`governanceDecisionId`) | deterministic `mgd1:` | R9-F |
| `approval_requests` | `approval_requests_idempotency_key_idx`(`idempotencyKey`) — nullable, unique when present | deterministic `mgov1:` hash per bound decision (mission actions); legacy hashed keys for R5 flows | shared ledger (R6-X canonical) |

Every anchor above is tenant-predicated (`userId` is a leftmost anchor
column everywhere except global identity columns, which are themselves
deterministic over tenant-scoped material). Cross-tenant collision is
therefore structurally inert: a foreign row is a *different row*, never a
violating row, and every read is `userId`-predicated.

### 5. CAS / update patterns (audited per module)

| Module | Pattern | Loser behaviour |
|---|---|---|
| `execution-coordination-store.transitionDispatchState` | read-check → `UPDATE … WHERE version = expected` → re-read verify (no `affectedRows` check) | Identical racing transition: loser re-reads winner's row, observes `version = current+1` and the expected `toState`, and returns success (benign convergent outcome — the row transitioned exactly once). Divergent transition: re-read shows different `toState` ⇒ `EXECUTION_TAMPER`. This is **tolerated lost-update on identical transitions**, documented in §B1 R5/R12. |
| `mission-state-recovery-store` recovery lifecycle CAS | same read-check + version-guarded UPDATE + re-read verify | same as above (convergent success on identical transition; conflict on drift) |
| `queue/terminal-replay.claimTerminalReplayRequest` | INSERT into `queue_replay_active_claims` (unique authority) **inside a transaction** + conditional `UPDATE … WHERE status='requested'` with **`affectedRows === 1` check** | Claim loser gets `ER_DUP_ENTRY` on the claim row (or affectedRows 0) ⇒ `{claimed:false}`. **This is the reference claim idiom in the repo.** |
| `billing/credit-engine.ts`, `credit-reservation-store.ts` | conditional UPDATE + `affectedRows === 0 ⇒ conflict` | loser fails closed |
| `creative/creative-generation-claim.ts` | conditional UPDATE + `affectedRows` checks | loser fails closed |
| `business-learning-store`, `business-change-store`, `conversion-store` | conditional UPDATE + `affectedRowsOf` checks | loser fails closed |
| `agents/stale-strategy-run.ts` | conditional UPDATE + `affectedRows` check | loser fails closed |

**Finding CAS-0 (FIXED in R10-B — drizzle mutation-result shape misread;
code defect, no schema change):** `drizzle-orm@0.45.1` + `mysql2` resolves
`db.update()/insert()/delete()` to a **`[ResultSetHeader, FieldPacket[]]`
tuple** (verified at runtime against the installed driver: `res` is an
array; `res[0].affectedRows` is the only correct read). Eight governed
stores read `result.affectedRows` directly — always `undefined` in
production, so their CAS guards permanently saw `affectedRows = 0` — and
`transitionMissionStatus` read `Array.isArray(result) ? result.length`
(tuple length 2), so its CAS-loss backstop never fired. Net production
effect before this fix: the affectedRows-checked CAS paths were either
always-fail-closed (availability loss: schedule status, mission lifecycle,
conversion, qualification, opportunity, outcome, lead-identity,
strategic-memory, business-change) or never-detecting (mission lifecycle).
All paths remained fail-closed in the *authority* sense (no widening) —
and all were invisible until now because the canonical migrations are
unexecuted and every prior suite ran against dual-shape in-memory fakes
(`{affectedRows, [0]:self}`). R10-B normalized all nine read sites to
extract `result[0]` when the result is an array (behaviour-identical
against the dual-shape fakes; correct against the real driver). See the
acceptance report §CAS for the file list and the harness proof.

**Finding CAS-1 (no schema change required; documented, harness-verified):**
the R9-D/R9-E re-read-verify CAS does not inspect `affectedRows`. Under a
genuine concurrent race on the *same* transition, the loser's UPDATE matches
zero rows yet the function returns success after re-reading the winner's
commit. The durable outcome is still exactly-one transition (InnoDB row-lock
serialization + version guard make the double-UPDATE idempotent), so no
authority widening occurs; the observable difference is only *who believes
they performed the transition*. Where the transition gates a side effect
(dispatch), the harness must assert the durable rows (one attempt, one
result), not the caller's return value — see B4 scenario 5/12.

### 6. Dispatch intent / callback / recovery / approval persistence

| Concern | Mechanism | Convergence anchor |
|---|---|---|
| Dispatch intent | `execution_actions` row (`DISPATCH_PREPARED`), immutable action envelope; raw parameters never persist (only `actionParametersHash`) | `exa_user_idempotency_uidx` |
| Attempt | `execution_attempts` row per dispatch (`exr1:`), `externalReference` = deterministic `ext1:` server-issued provider reference | `exr_user_action_attempt_uidx` |
| Result / callback | `recordAttemptResult` performs a **null→value CAS** on the attempt row (`resultStatus IS NULL ⇒ set`); `externalReference` binding is deterministic; conflicting replay ⇒ `EXECUTION_REPLAY_CONFLICT`; terminal action replay converges to the recorded attempt with zero new effects (X7.28) | attempt identity + null→value CAS |
| Retry | never self-authorized: retry candidates are **read-only projections** (`retry_candidate_emitted` facts); an executed retry is a *new* execution action under *fresh* R9-F authority | new `exa1:`/`idem1:` |
| Recovery | `mission_recovery_candidates` (`rcn1:`) bound to the exact failed/uncertain attempt; governance binding via frozen R9-F gate revalidation; consumption is a read-only handoff projection | `mrc_user_recovery_uidx` |
| Approval consumption | `assertMissionActionConsumable` is a **pure, read-only gate** (no consumption write, no consumed-flag): every dispatch revalidates decision + ledger approval + policy version + expiry + binding hash from durable rows immediately before the side-effect boundary | `mgd_decision_id_idx` + `approval_requests_idempotency_key_idx` |

### 7. Queue / worker DB interaction

| Surface | Mechanism |
|---|---|
| Job queue | BullMQ over Redis (`api/lib/queue/bullmq.ts`): publishing + content-generation workers (`api/worker.ts`). Delivery semantics: **at-least-once** (BullMQ design); idempotent job ids derived from durable row ids (`toPublishingBullMqJobId(queueItemId)`). |
| Terminal failure / replay | `queue_terminal_failures`, `queue_replay_requests`, `queue_replay_active_claims` (`db/schema.ts:1476-1590`). Claim = unique claim-row insert + guarded status UPDATE inside `withTerminalReplayTransaction`; owner-hash rotation (`rotateContentRecoveryClaimOwnerHash`) revokes stale claims. |
| Worker crash safety | claim transaction rollback on crash (claim row + status update are atomic); after commit-before-ack, BullMQ redelivers and the unique claim/replay anchors converge the duplicate. |
| Publishing queue persistence | `publishing_queue` legacy table + `publishing-queue` worker DB updates. |
| Engagement execution (R5-C) | `engagement_executions` with `er_execution_idx` unique on deterministic `executionId`; `hdr_execution_identity_uidx` on inbound delivery identity — both pre-mission-control idempotency ancestors. |

### 8. Test-DB posture (pre-R10-B)

- All R6–R9 acceptance suites run the **real services/stores** against
  per-file in-memory fake DBs (`makeFakeDb`) that replicate the Drizzle
  chain shape and the durable unique indexes, with `vi.mock` on
  `api/queries/connection`. No suite opens a real database; this was an
  explicit deferral ("REAL_MYSQL concurrency remains the R10 /
  pre-production gate" — repeated in every R-stream report).
- Consequence: single-threaded, cooperative-concurrency assertions only.
  Genuine multi-session contention, InnoDB locking, deadlock victim
  behaviour, disconnect mid-transaction and pool exhaustion were **not**
  covered before this stream.

---

## B1 — Part 2: Concurrency threat model

Scope: production races against the Mission Control authority model
(R9-A/B/C/D/E/F + shared approval ledger + queue/replay machinery). For
every race: **authority owner → durable anchor → unique constraint →
transaction boundary → expected winner → expected loser → safe replay.**

Isolation assumptions for the analysis: InnoDB, default REPEATABLE READ,
single autocommit statements for authority writes (per §3), row locks held
to statement end; `ER_DUP_ENTRY`=1062 unique violations;
`ER_LOCK_DEADLOCK`=1213 / `ER_LOCK_WAIT_TIMEOUT`=1205 possible only where
multi-row transactions run (billing, creative claims, replay claims,
workflow engine) — authority paths hold no cross-row locks by design.

### R1 — same mission proposed twice
- **Owner:** R9-A `propose`. **Anchor:** `mis1:` deterministic identity. **Constraint:** `mp_user_mission_uidx`. **Tx:** single INSERT.
- **Winner:** first committer. **Loser:** 1062 → re-read → material match ⇒ `idempotent_replay` (same row, zero new events); material drift ⇒ `MISSION_REPLAY_CONFLICT`.
- **Replay:** full re-proposal is safe; lifecycle facts `misl1:` are deterministic and converge.

### R2 — same plan created concurrently
- **Owner:** R9-B plan formation. **Anchors:** `pln1:` identity + `mplans_user_mission_version_uidx`. **Tx:** single INSERT per row (plan + tasks).
- **Winner:** first committer of a given planVersion. **Loser:** version-anchor 1062 ⇒ conflict/replay converge; same planId replay ⇒ `idempotent_replay`.
- **Note:** plan + task inserts are separate statements; a crash between them leaves a plan row whose task set is incomplete — detected by the plan-completeness projection (`taskSetFingerprint`), not by rollback. Acceptable because plans are inert task-definition authority (no execution semantics).

### R3 — same task scheduled concurrently
- **Owner:** R9-C schedule creation. **Anchor:** `sch1:` content-addressed schedule identity. **Constraint:** `msch_user_schedule_uidx`. **Tx:** single INSERT.
- **Winner:** first committer. **Loser (identical inputs):** identical `sch1:` ⇒ 1062 ⇒ `idempotent_replay`. **Loser (different inputs):** both schedules legitimately exist; supersession/staleness lifecycle (deterministic `msl1:` facts) resolves authority.
- **Replay:** re-scheduling same material converges to one schedule.

### R4 — same approval consumed concurrently
- **Owner:** R9-F (gate) + R9-D/R9-E (consumption). **Anchor:** none — the gate is **read-only**; there is no mutable "consumed" flag on `approval_requests`.
- **Constraint:** `approval_requests_idempotency_key_idx` bounds approval *creation* to one row per bound decision.
- **Tx:** none (pure function over durable rows).
- **Winner/loser:** not applicable — N concurrent consumers each revalidate independently; all observe the same decision+approval+policy snapshot, so all either pass or all fail closed (stale policy, expiry, rejection). Human rejection permanently blocks the decision identity (`APPROVAL_REJECTED_BY_HUMAN`, `permanent`).
- **Replay:** unlimited safe; no state to corrupt.

### R5 — same execution action claimed (dispatched) concurrently
- **Owner:** R9-D `dispatchExecutionAction`. **Anchor:** dispatch-state CAS on `execution_actions.version` from `DISPATCH_PREPARED`; attempt anchor `exr_user_action_attempt_uidx`. **Tx:** none — a chain of single autocommit statements (transition → attempt insert → adapter call → result CAS → terminal transition).
- **Winner:** the UPDATE that holds the row lock first. **Loser:** its version-guarded UPDATE matches 0 rows; re-read verify makes it *observe the converged row* (see Finding CAS-1) and continue down the dispatch path.
- **Durable guarantee (the invariant that matters):** exactly one attempt row (identical deterministic `exr1:` for both contenders — second insert is `idempotent_replay`), exactly one `DISPATCHED` transition fact, exactly one terminal result via the null→value CAS. The adapter may be invoked by both contenders ⇒ provider-side dedup responsibility, see R20/B5.
- **Replay:** redispatch of a terminal action converges to the recorded attempt (X7.28), zero new effects.

### R6 — same dispatch intent created concurrently
- **Owner:** R9-D `prepareExecutionAction`. **Anchor:** `exa1:` + server-minted `idem1:`. **Constraints:** `exa_user_action_uidx`, `exa_user_idempotency_uidx`. **Tx:** single INSERT.
- **Winner:** first committer. **Loser:** 1062 → material match ⇒ `idempotent_replay`; same idem key with different action ⇒ `EXECUTION_REPLAY_CONFLICT`. Client-supplied idempotency keys are impossible (server-derived; boundary rejects client authority fields).

### R7 — same provider callback processed concurrently
- **Owner:** R9-D `recordExecutionResult`. **Anchor:** attempt identity + null→value result CAS + deterministic `ext1:` reference binding. **Tx:** single UPDATE (result) + lifecycle INSERTs (deterministic ids).
- **Winner:** first result UPDATE. **Loser (identical callback):** re-reads committed result ⇒ converges, zero duplicate facts. **Constraints:** attempt uniqueness makes a duplicated callback idempotent by construction.

### R8 — conflicting callback race
- **Owner:** R9-D. **Anchor:** same as R7. **Winner:** first committer. **Loser:** the immutable-core/`resultHash` drift check fails closed (`EXECUTION_REPLAY_CONFLICT`) — a recorded result is never overwritten by a different one.
- **Guarantee:** **no false success**: an ambiguous/conflicting second outcome cannot flip `FAILED`→`SUCCEEDED`; uncertainty is a first-class terminal class (`UNCERTAIN`), never silently promoted.

### R9 — same retry requested concurrently
- **Owner:** R9-E recovery proposal (advisory) + R9-F (fresh authority for the retried action). **Anchor:** `rcn1:` deterministic over {tenant, business, mission, task/action, failure class, latest authoritative attempt, recoveryType}. **Constraint:** `mrc_user_recovery_uidx`. **Tx:** single INSERT.
- **Winner:** first committer. **Loser:** 1062 → `idempotent_replay`. Retries never broaden scope (`RETRY_SCOPE_BROADENED` floors REVIEW_REQUIRED); execution of a recovery is a *new* governed action (R5 chain).

### R10 — same recovery requested concurrently
- Same anchors as R9. Recovery governance binding (`bindRecoveryGovernance`) and consumption (`consumeRecovery`) are version-CAS guarded; concurrent consumption by different operators fails closed on stale version; identical replay converges.

### R11 — mission-state projection refreshed concurrently
- **Owner:** R9-E `observe`/state derivation. **Anchor:** `mst1:` deterministic over authoritative inputs; `msr_user_state_uidx`; version CAS on mutable state rows. **Tx:** single statements.
- **Winner:** first committer per identity. **Loser (same inputs):** same `mst1:` ⇒ converge. **Loser (drifted inputs):** new deterministic identity (or stale-version conflict) — never a silent overwrite of a fresher observation.

### R12 — CAS loser behaviour (cross-cutting)
- Two idioms coexist (§5): **affectedRows-checked CAS** (replay claims, billing, creative, learning/change/conversion stores) — loser fails closed immediately; **re-read-verify CAS** (R9-D dispatch transitions, R9-E recovery lifecycle) — loser of an *identical* transition observes success, loser of a *divergent* transition fails closed (`EXECUTION_TAMPER` / conflict).
- Harness obligation (B4 s12): assert durable row state and effect counts, not caller-facing return values, for re-read-verify CAS paths.

### R13 — worker crash during DB transaction
- **Surface:** `withTerminalReplayTransaction` claim path; billing holds; creative claims. **Anchor:** transaction atomicity.
- **Outcome:** InnoDB rolls back the whole transaction on connection loss; the claim row and status update disappear together — no partial claim. Next worker re-reads `requested` and claims cleanly.

### R14 — worker crash after commit but before acknowledgement
- **Surface:** BullMQ job handlers, replay executors. **Anchor:** deterministic idempotency anchors + claim unique rows.
- **Outcome:** at-least-once redelivery; duplicate execution converges at the anchors (R5-R11); duplicate claim rejected by `queue_replay_active_claims` uniqueness. No orphan authority.

### R15 — DB disconnect mid-transaction
- **Surface:** all tx users. **Outcome:** mysql2 surfaces a connection/PROTOCOL error; server rolls back; callers that do not handle it fail closed (no silent commit). Terminal-replay claim: `ActiveClaimTakenError`/`ClaimInvalidStateError` mapping never converts a disconnect into a claim. Harness scenario 15 asserts error classification, not success.

### R16 — deadlock / deadlock victim
- **Authority paths:** negligible by construction (single-statement autocommit writes; no lock ordering across rows).
- **Tx surfaces:** billing/creative/workflow multi-row transactions can deadlock under contention; callers must treat 1213/1205 as retryable at the job layer (BullMQ retry) and as *failure, never success*, at the authority layer. No authority path catches 1213 and proceeds as if committed (verified by grep audit — see B7/B9 evidence).

### R17 — transaction retry
- Safe iff anchored: every retried write converges on its deterministic unique anchor (idempotent_replay) or fails closed (replay conflict). No retry path mints fresh identities for the same logical effect.

### R18 — stale read
- REPEATABLE READ snapshots can serve a stale row version to a concurrent reader. Defences: version-CAS write guards (stale writer loses), insert-not-readable tamper checks, governance gate **re-run at dispatch time** (never trusts a cached verdict), recovery consumption revalidation. Stale reads degrade availability (conflict errors), never authority.

### R19 — duplicate queue delivery
- BullMQ at-least-once; deterministic job ids (`toPublishingBullMqJobId`) collapse same-item re-enqueue; DB anchors collapse same-effect re-execution; claim table collapses same-replay claims.

### R20 — idempotency-key collision attack
- **Client-side:** impossible — `idem1:`/`mgov1:` keys are server-derived (sha256 over server material); routers use `z.strictObject` and reject client-supplied authority fields.
- **Attacker-forged collision:** a forged key that happens to equal an existing anchor hits 1062 → material-match check → different material ⇒ hard conflict, never a merge. Tenant-predicated anchors make cross-tenant key reuse inert (different rows).

### Cross-tenant / cross-business collision attempts (harness scenarios 18-19)
- **Cross-tenant:** anchors are tenant-predicated; a foreign tenant's insert lands in its own row; reads are `userId`-scoped; every consumption gate re-verifies ownership from durable rows (approval `userId` must equal decision `userId`; businessId binding equality enforced in `assertMissionActionConsumable`). Forgery fails closed — there is no shared unscoped anchor to steal.
- **Cross-business:** identity anchors are per-tenant (not per-business), so a same-tenant cross-business write can insert — but every *consumption* gate binds `businessId` verbatim from the governed decision/approval and fails closed on mismatch. Mission Control rows record `businessId` at creation; downstream gates re-verify it.

---

## Verified-at-inventory claims (evidence anchors)

| Claim | Evidence |
|---|---|
| No tx in R9 authority stores | grep `\.transaction\(` over `api/lib/mission-*`, `api/lib/execution-coordination` → 0 hits |
| Unique anchors as tabulated | `db/schema.ts:4534-5210`, `:2128`, `:786` |
| Insert-first + ER_DUP_ENTRY convergence idiom | `execution-coordination-store.ts:34-77`, `mission-governance-store.ts:121-169` |
| Re-read-verify CAS (Finding CAS-1) | `execution-coordination-store.ts:296-356`, `mission-state-recovery-store.ts:296-345` |
| Reference claim idiom (affectedRows + tx) | `queue/terminal-replay.ts:256-310` (`claimTerminalReplayRequest`), `:114-128` (`withTerminalReplayTransaction`) |
| Approval gate read-only | `mission-governance/mission-approval.ts:252-378` (pure function, no DB handle) |
| Dispatch chain ordering + terminal replay convergence | `execution-coordination-service.ts:677-936` |
| Canonical migration authority | `db/migrations/meta/_journal.json` idx 37; `docs/recovery/r9-x-migration-convergence.md` |
| Client authority-field rejection | `z.strictObject` router schemas across R9 routers; contract error `*_CLIENT_AUTHORITY_FIELD_FORBIDDEN` |
