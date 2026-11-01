# R10-C — RUNTIME, WORKERS & AUTONOMOUS EXECUTION RESILIENCE — RUNTIME INVENTORY (C0)

> **Stream:** R10-C Runtime Resilience
> **Branch:** `feature/r10-c-runtime-resilience`
> **Frozen programme base:** `799f6b4cb351ebe969f97da606324605fdf2a07b` (R9-X Mission Control)
> **Date:** 2026-11-10
> **Scope:** repository-native runtime surfaces only. NO OneGrid, NO production
> workers, NO live provider calls, NO production queue mutation, NO deployment.
> **Blocking carry-over:** `mission-control-to-production-resilience-contract.md`
> §2.6 (worker resilience) is the R9-X → R10 handoff this stream prepares for.

---

## 1. Purpose

This inventory enumerates every runtime, worker, scheduler, queue, job handler,
timer, poller, retry loop, heartbeat, lease, lock, cron, startup/shutdown hook,
recovery hook, dead-letter pattern, callback worker, provider execution worker
and Mission Control consumer present in the repository at the frozen base. It
is the C0 input for the R10-C runtime-resilience contract: each surface below is
classified by the *resilience hazard* it poses (duplicate delivery, stale
lease, crash window, queue duplication, restart, interruption) so the contract
(`docs/contracts/autonomous-runtime-resilience-contract.md`) can bind the
runtime authority boundaries that keep those hazards from ever creating
duplicate authority, false success, uncontrolled retry or widened Mission
Control scope.

---

## 2. Process / runtime model

| Surface | Location | Model | Resilience hazard |
|---|---|---|---|
| API server process | `api/boot.ts` | Hono + Vite dev / `dist/boot.js` prod (`npm start`). Starts schedulers + workers + cron in-process. | A single process hosts both the HTTP surface and background loops; a crash interrupts in-flight work with no durable-claim boundary. |
| Standalone worker process | `api/worker.ts` | `node dist/worker.js`. BullMQ `publishing-jobs` + `content-generation-jobs` workers. Graceful `SIGINT`/`SIGTERM` → `stopPublishingWorker`/`stopContentGenerationWorker`/`closeBullMqConnection`. | Worker restart currently only closes the BullMQ handle; it does not re-derive durable execution intent, reconcile uncertainty, or prove no duplicate side effect across restarts. |
| Process supervision | `deploy.sh`, `deploy-vps.sh`, `deploy-local.sh`, PM2 references in docs | PM2 is the documented process manager. **OneGrid is NOT available (R10 gate).** | Restart under a supervisor is exactly the crash/restart window the contract must make safe. |

There is **no** repository-native worker identity, worker registry, heartbeat
liveness table, or runtime state machine at the base. Worker "identity" is
implicit (a process + a BullMQ `Worker` instance). This is the gap R10-C fills.

---

## 3. Queues & job handlers

| Queue / handler | Location | Durable identity | Retry | Dead-letter |
|---|---|---|---|---|
| `publishing-jobs` | `api/lib/queue/bullmq.ts` (`getPublishingQueue`), `publishing-worker.ts` | Job id `publish-<queueItemId>` (deterministic, `toPublishingBullMqJobId`). Job data is **identity-only** (`queueItemId`,`userId`,`platform`); the immutable publish package is reloaded durably via `loadQueuePublishPackagePlan` (`api/lib/publish/publish-package-queue-persistence.ts`). | `attempts: 3`, exponential backoff 60s. `UnrecoverableError` + permanent readiness failures (`precondition_failed`, `unrecoverable`) are **not** retried. | Terminal failures persist one `queue_terminal_failures` row (`api/lib/queue/terminal-failure.ts`). |
| `content-generation-jobs` | `api/lib/queue/bullmq.ts` (`getContentGenerationQueue`), `content-generation-worker.ts` | Job id `content-generation-<jobId>`. Data carries `claimId`/`ownerToken`. | `attempts: 1`. | Same `queue_terminal_failures` authority. |

**Queue duplication / duplicate delivery:** BullMQ `Queue.add` with a
deterministic `jobId` gives the repository-native at-most-once enqueue for a
given logical id, but **BullMQ does not bound at-least-once delivery to a
worker**: a stalled job can be re-delivered, and a worker that processes a job
without a durable exclusive claim can double-execute after a crash. The R10-C
claim/lease contract (C4) is the authority boundary BullMQ lacks.

**Terminal replay (recovery hook):** `api/lib/queue/terminal-replay*.ts`,
`terminal-replay-executor.ts`, `terminal-content-replay-executor.ts` +
`admin-router-terminal-replay.test.ts` establish a *controlled* replay seam
(`inspectPublishingJob`/`inspectContentGenerationJob`): reconciliation first
inspects an existing deterministic job, then replays only what it can prove.
This is the closest existing "safe resume" pattern and is the model for C6.

---

## 4. Schedulers, timers, pollers, cron

| Scheduler | Location | Interval | Lease / lock | Overlap / failure policy |
|---|---|---|---|---|
| Credit renewal | `api/lib/jobs/credit-renewal.ts` (`startCreditRenewalScheduler`) | daily | **none** (process-local singleton) | n/a |
| Post-live lifecycle reconciliation | `api/lib/workflow/post-live-lifecycle-scheduler.ts` + `post-live-lifecycle-leased-pass.ts` | configured | **Redis distributed lease** `natforge:p1:post-live-lifecycle`, TTL 120s, heartbeat 30s, owner token, guarded revalidation before each campaign, safe release | skips overlapping passes; a stale owner cannot delete another owner's lease |
| Post-live metrics observation | `api/lib/workflow/post-live-metrics-observation-scheduler.ts` + `post-live-metrics-observation-leased-pass.ts` | 300s default | same Redis lease pattern (`post-live-metrics-observation-leased-pass-dev-lease.test.ts`) | same |
| Social listening polling | `api/lib/social-listening/polling-scheduler.ts` | 300s default | process-local singleton; default OFF (`SOCIAL_LISTENING_POLLING_ENABLED`) | fails closed `OPERATOR_ACTION` without provider seams |
| Publishing runner (dev cron) | `api/lib/workflow/publishing-runner.ts` (`startPublishingRunner`) | cron | none (dev path) | n/a |
| Workflow triggers | `api/lib/workflow/triggers.ts` | event/schedule | dedup via `triggers-strategy-review-dedup.test.ts` | n/a |

**Finding:** the Redis lease-protected pass (`post-live-lifecycle-leased-pass.ts`)
is the strongest existing lease primitive — acquire/renew-with-owner-token/
guarded-revalidate/safe-release — but it is (a) Redis-only (not a durable DB
claim with a fencing token), (b) pass-scoped, not job-scoped, and (c) not
bound to any execution authority. R10-C generalises it into a durable,
authority-bound, fenced job lease.

---

## 5. Heartbeat / liveness

There is **no** worker heartbeat registry, no stale-worker detector, no
version-drift detector, and no duplicate-worker-identity guard. The only
liveness signals are:
- the lease-pass internal heartbeat (`post-live-lifecycle-leased-pass.ts`, renews a Redis key), and
- Redis/BullMQ connection error alerts (`api/lib/redis.ts`, `api/lib/alerts.ts`).

**Finding:** C3 (heartbeat/liveness) is net-new capability. The contract
explicitly encodes that *absence of heartbeat ≠ proof an external action did
not execute* — a dead worker leaves its in-flight external action UNCERTAIN,
never "not happened".

---

## 6. Leases / locks

| Lock | Store | Scope | Fencing |
|---|---|---|---|
| Post-live lifecycle pass lease | Redis string + owner token | one reconciliation pass | owner token; no monotonic fencing token |
| Post-live metrics observation pass lease | Redis string + owner token | one observation pass | owner token |
| BullMQ job lock | Redis (BullMQ internal) | one active job per worker | BullMQ token, but **not** surfaced to the app for result-write fencing |
| Content-generation claim | `claimId`/`ownerToken` in job data | content job | token carried in job data, not a DB CAS fence |

**Finding:** no DB-native, CAS-guarded, fenced job lease exists. C2/C4 define
`lea1:` lease identity bound to tenant + business + mission/task/action +
jobType + authorityRef + attemptRef, with a fencing epoch so a stale lease
holder cannot persist results after losing ownership.

---

## 7. Mission Control consumers (R9)

| Consumer | Location | What it consumes | Runtime coupling |
|---|---|---|---|
| R9-D Execution Coordination | `api/lib/execution-coordination/*` | R9-A mission / R9-B plan+task / R9-C schedule (guarded seams) + R9-F governance gate; sandbox adapters only (`LIVE_EXECUTION=False`) | Dispatch intent (`exa1:`) insert-first; attempts (`exr1:`) immutable; dispatch state CAS; duplicate dispatch converges; callback binding with forged-reference rejection; retry binds fresh exact R9-F authority and cannot broaden scope. |
| R9-E Mission State/Recovery | `api/lib/mission-state-recovery/*` | R9-D `mission-execution-to-state-recovery/v1` projection + R9-F recovery gate | Derives task operational state; recovery candidates (`rcn1:`) are advisory; consumption re-runs the frozen R9-F gate. |
| R9-F Mission Governance | `api/lib/mission-governance/*` | `approval_requests` ledger + OTP primitive | The single governance authority; R10-C must never introduce a second engine. |

**Finding:** R9-D already proves exact-once intent + conservative
classification + no-retry-widening *in-process*. What it does not prove is the
*runtime* envelope around it: a durable job queue, a fenced exclusive claim, a
heartbeat/liveness authority, crash-window restart semantics, dead-lettering,
stuck-job detection, draining, and version gating. That envelope is R10-C.

---

## 8. Dead-letter patterns

- `queue_terminal_failures` table (`api/lib/queue/terminal-failure.ts`): one
  durable row per terminally-failed BullMQ job (`unrecoverable` /
  `retries_exhausted`), persistence failures contained and escalated as a
  critical alert.
- `queue_replay_requests` + `queue_replay_active_claims`: governed controlled
  replay with an active-claim guard.
- R9-E `mission_recovery_candidates`: advisory recovery proposals (never
  authorization).

**Finding:** dead-lettering today is per-queue and not bound to mission
failure/uncertainty truth. C8 requires the dead-letter to *preserve* job
identity, authority refs, failure class, attempt refs, timestamps and bounded
diagnostics — and to *never hide* mission failure/uncertainty (R9-E state must
still reflect it).

---

## 9. Callback workers / provider execution workers

- Provider execution today runs through the R9-D **sandbox adapter registry**
  (`execution-adapter-registry.ts`, `createSandboxAdapterHarness`) — in-memory
  fakes only, no live provider calls. Callbacks are bound via
  `recordExecutionResult` with server-issued `ext1:` reference validation and
  duplicate-callback convergence (R9-D `recordAttemptResult` CAS).
- BullMQ publishing/content workers make **no direct provider call** in this
  repo slice beyond the governed publishing runner; live provider execution is
  gated behind R10 §2.

**Finding:** C5 crash windows (ack-before-local-persist, provider ambiguity)
and C14 callback convergence/fail-closed cases are modelled against the R9-D
classification vocabulary (`SUCCEEDED/FAILED_RETRYABLE/FAILED_FINAL/
PENDING_EXTERNAL/UNCERTAIN`) so the runtime envelope composes with it.

---

## 10. Startup / shutdown / recovery hooks

- **Startup:** `api/boot.ts` wires schedulers/workers in-process; `api/worker.ts`
  is the standalone worker entry. No startup hook re-reads durable execution
  intent or reconciles pre-shutdown uncertainty.
- **Shutdown:** `api/worker.ts` `gracefulShutdown` closes BullMQ handles on
  `SIGINT`/`SIGTERM`; the lease passes release their Redis leases. There is no
  drain phase (stop-accepting / finish-safe-in-flight / persist / release
  leases / leave-ambiguous-external-UNCERTAIN) — C10 defines it.
- **Recovery hooks:** controlled terminal replay (§3, §8) and R9-E recovery
  candidates are the only recovery surfaces.

---

## 11. Inventory → contract coverage map

| Inventory finding | Contract clause |
|---|---|
| No worker identity / registry / heartbeat | C1 (runtime contract), C3 (liveness) |
| No durable authority-bound fenced job lease | C2 (job/lease identity), C4 (safe claim) |
| BullMQ at-least-once delivery + crash double-execute risk | C4 (duplicate delivery converges), C5 (crash windows) |
| No restart re-read/revalidate of durable intent | C6 (safe resume) |
| Retry only via fresh R9-F authority in-process; runtime retry plumbing absent | C7 (retry boundary) |
| Dead-letter per-queue, not mission-bound | C8 (dead-letter), C9 (stuck detection) |
| No drain phase | C10 (graceful shutdown) |
| No worker/job version gate | C11 (version safety) |
| No runtime health projection | C12 (R10-E observability handoff) |
| Sandbox-only adapters; no shell/SQL/secret executor in the runtime path | C13 (rogue worker) |

---

## 12. Out-of-scope confirmation (this stream does NOT own)

Mission authority (R9-A), planning (R9-B), scheduling authority (R9-C),
execution authorization (R9-F), recovery authorization (R9-E/F), provider
credentials, provider business semantics, production deployment, database
administration, autonomy configuration. No OneGrid access; no production
workers; no live provider calls; no production queue mutation; canonical
`0037` and provisional R10 migrations are **not executed** — R10-X converges.
