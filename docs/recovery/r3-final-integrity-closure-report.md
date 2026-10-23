# WBS-R3 — Remaining Autonomy & Integrity Closure: Final Report

**Branch:** `recovery/r3-integrity-closure`
**Final HEAD:** `093f946`
**Starting authority:** `5def870` (recovery/r2-production-activation, R2 verdict READY_FOR_PRODUCTION_GATE)
**Tree:** clean, all commits pushed to origin.

---

## Verdict

**READY_FOR_R2_5_PRODUCTION_GATE**

All four evidence-backed forward-path gaps from the R1.7 audit are closed with
narrow, convention-compatible corrections. No schema/migration change, no
production mutation, no live provider activity, no merge to main.

## Commits created (4, each pushed immediately)

| Commit | Package | Summary |
|---|---|---|
| `6027500` | R3.1 GAP18 | Governed credit reservations wired into the keyed agent-run path |
| `aad645e` | R3.2 GAP24 | Calendar intake converged onto the publishing queue authority |
| `6061fe5` | R3.3 GAP25 | Encrypted page tokens no longer serialized to clients |
| `093f946` | R3.4 GAP29 | Launch-reject withdrawal + BullMQ-independent immediate-row execution |

## Gap verdicts

### GAP18 — reservation unwired → CLOSED

Root cause: the WBS8 reservation authority (contract, durable store,
wallet-backed engine) was delivered library-only ("Existing billing callers
are migrated in later slices"); the later slice was lost with WBS20/21. The
real forward path (`runAgent` keyed billing for the R1.3 audience/distribution
chain) still did up-front `deductCredits` + best-effort refund.

Fix: keyed path migrated to `reserveWalletCredits → settleWalletCredits /
releaseWalletCredits`, mirroring accepted outcome-class net balances exactly
(success = charge; provider/schema failure = release; other failure = charge
retained). Legacy unkeyed path untouched. Identity/settle/release keys are
pure functions of the caller-stable billing identity → exact-once under
retry; stale crash-window holds recover via the existing idempotent-retry
policy (no expiry semantics invented). Success-path settle failure propagates
(fail closed); failure-path reconciliation is best-effort + logged, matching
the existing refund convention.

### GAP24 — scheduling disjoint → CLOSED

Finding: publishing already had a single disposition-guarded executor
(BullMQ + due-scan funnel into `publishSinglePost`); the disjoint surface was
the calendar intake — `schedule.create` with a campaign-linked content post
consumed the launch-approval gate and persisted a row with no execution path.

Fix: bridge (`calendar-schedule-convergence.ts`) resolves the declared wall
time through the existing WBS13.2 schedule authority (IANA/DST-safe,
fail-closed, not-before policy) and inserts one durable `publishing_queue`
row with deterministic replay (user + content post + platform + canonical
instant, excluding terminal failures); BullMQ scheduling best-effort with
due-scan coverage when Redis is down. Non-campaign one-offs stay
planning-only (queue is campaign-scoped by schema). Publish success mirrors
`posted` onto same-user schedule rows. Post-live observation/lifecycle
schedulers remain intentionally separate (distinct leases preserved).

### GAP25 — decorative settings → CLOSED

- **Fixed:** `getConnectedPlatforms` no longer serializes
  `pageAccessTokenEncrypted`; clients receive server-derived
  `hasPageAccessToken` (the only use was a truthiness readiness signal).
  AGENTS.md §13 now holds true against code. API test proves the ciphertext
  never leaves the boundary.
- **Verified, no action:** Notifications tab is an honestly-labelled
  "Coming Soon" placeholder (nothing persisted, nothing settable — not a
  decorative setting; wiring it would invent product behaviour).
  `getPlatformConfigStatus` is real read-only configuration reporting with
  live consumers and server-side `NOT_CONFIGURED` enforcement.
- Retained settings proven operational: integrations connected-gate,
  approvalMode, autoPublish, 2FA (R1.7 evidence, plus 93 frontend tests).

### GAP29 — launch/package/queue edges → CLOSED

- **(a)** Rejected launch withdrew nothing: executable rows churned toward
  terminal failure. Now `onApprovalResolved(campaign_launch, rejected)`
  parks campaign-scoped `approved`/`retrying` rows into gated
  `pending_approval` and cancels scheduled BullMQ jobs best-effort.
- **(b/c)** Immediate (NULL `scheduledAt`) approved rows had no
  BullMQ-independent executor (stall on BullMQ outage; publishing-router
  immediate rows never enqueued at all). `publishDuePosts` now owns them via
  `buildImmediatePostsCondition` gated on campaigns holding publication
  authority — preserving the pre-launch approved-but-unscheduled design for
  brand_risk rows — with per-id dedupe across the two selects.
- Verified, not reinvented: package identity, queue identity,
  crash-between-package-and-queue atomicity, duplicate-retry protection,
  and execution-time authority validation all remain owned by the surviving
  WBS13 authority (guarded conditional UPDATE, deterministic BullMQ jobId,
  disposition guard, shared package loader).

### GAP31–34 — DEFINITIONS DO NOT SURVIVE (unchanged from R1.7)

No code, doc, or git-history evidence; no definitions or fixes invented.

## Tests / regressions

Focused integrity regression (all green):
- Reservation/billing/resume: 384 tests (agents, reservation contract/store/
  engine, billing identities, cost-pause, budget-resume).
- R1 autonomy: 76 tests (next-cycle persistence/dispatcher/trigger,
  post-live observation pass/leased/scheduler, R1.9 full E2E harness 8/8).
- Scheduling/publishing/settings: 446 tests (publish lib, schedule router,
  integration router, publishing runner suites, triggers, content studio).

Broadest practical regression — full suite (273 files / 4496 tests):
- **4428 passed, 65 skipped, 3 failed tests + 1 failed suite, all
  pre-existing baseline/env debt** (none in R3-changed files):
  1. `approval-decision-audit.test.ts` (1) — reproduces on the clean tree
     (verified via `git stash`).
  2. `credit-engine.test.ts` dbName guard — requires `DATABASE_URL` (no
     `.env` in worktree; documented R1 baseline).
  3. `creative-generation-claim.test.ts` dbName guard — same env class.
  4. `Campaigns.test.tsx` suite load — `auth/invalid-api-key` (Firebase env
     absent; documented R1 baseline).
- `tsc -b`: clean except the two documented pre-existing type errors in
  `autonomous-closed-loop-acceptance.test.ts`.
- `git diff --check`: clean on every commit.

## Files changed (20, whole programme)

`api/lib/agents/runner.ts` (+2 test files), `api/lib/publish/calendar-schedule-
convergence.ts` (+test), `api/schedule-router.ts` (+test), `api/lib/workflow/
publishing-runner.ts` (+2 test files), `api/lib/workflow/triggers.ts` (+test),
`api/integration-router.ts` (+test), `src/lib/content-studio/logic.ts`,
`src/pages/ContentStudio.tsx`, and 4 `docs/recovery/r3.*` evidence notes.
No database/schema/migration files touched.

## Remaining open integrity gaps

- GAP31–34 (definitions unrecoverable — reported, not invented).
- R1.7 noted admin mutations (`updateUserRole`, `recordPayment`, `deleteUser`)
  write no audit events — deferred as a governance-policy decision (adding
  audit events to admin surfaces is low-risk but was not part of the four
  authorised gaps; recommended for a future governance slice).
- Pre-existing baseline failures above (env-dependent; resolve by supplying
  `DATABASE_URL`/Firebase test env or accepting as documented debt).

## Server-dependent work remaining

None for R3 itself. Standing R2 boundary still applies: production deploy,
production migration execution, live-provider activation, and production
canary remain out of scope and require separate authority (per the R2 final
report, the first production mutation would be: provision secrets/env per
`docs/recovery/deployment/r2.3` configuration manifest, rehearse migrations
against a disposable target with `scripts/deployment/migration-rehearsal.ps1`,
then execute the deployment runbook).

## Final verdict

**READY_FOR_R2_5_PRODUCTION_GATE**
