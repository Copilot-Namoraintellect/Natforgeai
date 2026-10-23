# CORE_LIFECYCLE_CONTRACT — WBS-R4 Cross-Stream Checkpoint

> **Status:** COMMITTED — Stream A (core autonomous lifecycle)
> **Branch:** `feature/r4-a-core-autonomy` @ `33600ac`
> **Accepted common base:** `2f21a8fc959070b79cfb9c237a5b87922dc42f08`
> **Date:** 2026-06-29
> **Audience:** Stream C (distribution/publishing), Stream E (financial reliability), integration owner
> **Rule:** Streams C and E must NOT modify the files or semantics listed under "Owned authority" and must consume shared surfaces only through the exported contracts named below. Any needed change is a cross-stream contract conflict — stop and escalate.

This contract is deliberately concise. It fixes trigger identities, lifecycle states, continuation identities, shared billing boundaries, and the shared queue/trigger files, exactly as committed by Stream A.

---

## 1. Lifecycle states (owned by Stream A)

16 states, single source of truth `WorkflowState` in `api/lib/workflow/engine.ts:12-28`, mirrored by the `campaigns.workflowState` enum (`db/schema.ts:304-323`):

```
business_onboarding → strategy_pending → strategy_generated → strategy_approved
→ creatives_generating → creatives_ready → audience_generating → audience_ready
→ schedule_generated → launch_approval_required → publication_pending → campaign_live
→ engagement_active → leads_converting → optimisation_active → completed
```

Governed mutation authority: `transitionCampaignState(campaignId, userId, action)` (`engine.ts:123-206`) — one DB transaction, valid-transition enforcement, atomic `workflow_transition` audit event. **All lifecycle state writes must route through it.**

Known direct-write exceptions (accepted R1/R3 behaviour, do not "fix" unilaterally):
- `api/lib/agents/distribution-agent.ts:168-180` — enters `schedule_generated` directly (also replaces `workflowContext`).
- `api/lib/billing/cost-control.ts:152-159` — cost pause writes `launch_approval_required` + `paused` directly, then records durable `costPause` provenance.
- `api/campaign-router.ts` / `api/autonomous-workflow-router.ts` — initial-state writes at campaign creation.

Post-live states (`campaign_live` and beyond) are driven only by the lease-protected pass: `runLeaseProtectedPostLiveLifecyclePass` (`api/lib/workflow/post-live-lifecycle-leased-pass.ts:150`), Redis lease `natforge:p1:post-live-lifecycle` (TTL 120s, heartbeat 30s), scheduler `startPostLiveLifecycleScheduler` (`post-live-lifecycle-scheduler.ts:170`, default 5 min, **env-gated `POST_LIVE_LIFECYCLE_ENABLED`, default OFF**, wired in `api/boot.ts:49-53`).

## 2. Trigger identities (owned by Stream A)

| Trigger | Identity / entry point | Fired by |
|---|---|---|
| Agent-run completion | `onAgentRunComplete(runId)` — `api/lib/workflow/triggers.ts:50` | `api/agent-router.ts:172,208`, `api/campaign-router.ts:328,373`, budget-resume dispatch |
| Approval resolution | `onApprovalResolved(approvalId, decision, userId)` — `triggers.ts:391` (ownership-scoped re-read) | `api/approval-router.ts:766` post-commit, approval-continuation reconciler |
| Strategy approval kickoff | `onStrategyApproved(campaignId, userId, approvalId)` — `triggers.ts:618` | `onApprovalResolved` strategy_review branch, budget-resume `strategy_approval` kind |
| Cost-pause resume | `resumeWorkflowAfterApprovedCostIncrease({userId, campaignId, approvalId?})` — `api/lib/workflow/budget-resume.ts:105` | `onApprovalResolved` budget_increase branch, reconciler |
| Next-cycle seed | `triggerNextCycleAfterLearningPromotion({userId, campaignId})` — `api/lib/workflow/next-cycle-trigger.ts:83` | `dispatchNextCycleAfterLearningPromotion` (`approval-continuation.ts:292`), called from the learning-promotion branch of `onApprovalResolved` and from the reconciler |
| Next-cycle dispatch | `dispatchNextCycleInstruction({userId, campaignId, instructionId?})` — `api/lib/workflow/next-cycle-dispatcher.ts:302` | `dispatchNextCycleAfterLearningPromotion`, `autonomousWorkflow.retryNextCycleDispatch` |
| Crash-recovery sweep | `runApprovalContinuationSweep()` — `api/lib/workflow/approval-continuation.ts:509` | `api/boot.ts` once at boot (fire-and-forget, NOT env-gated) |
| Post-live learning | `runGovernedPostLiveLearningTrigger({campaignId})` — `api/lib/learning/post-live-learning-trigger.ts:91` | post-live lifecycle pass (`post-live-lifecycle-pass.ts:97`), eligible only in `engagement_active`/`leads_converting` |
| Go-live | `go_live` via governed transition | `api/lib/workflow/publishing-runner.ts:688` |

`strategy_review`, `campaign_launch`, `budget_increase`, `high_value_proposal`(learning-promotion only), and `brand_risk` are the only approval types whose resolution dispatches a lifecycle continuation.

## 3. Continuation identities (owned by Stream A)

Continuation state lives in `campaigns.workflowContext` (JSON, preserved-superset writes). There is **no continuation column on `approval_requests`** — the approval row is located from campaign lineage via `approvalRequestId`.

| Identity | Shape | Written by |
|---|---|---|
| Strategy approval lineage | `strategyApprovalLineage = {creativeBriefFingerprint, strategyRunId, strategySnapshotId, strategyVersion, businessDnaSnapshotId, strategyHashSha256, approvalRequestId, status}` | `triggers.ts` on strategy completion; `next-cycle-dispatcher.ts` for cycle N+1 |
| Launch approval lineage | `launchApprovalLineage = {creativeBriefFingerprint, approvalRequestId, status}` | `triggers.ts:278-290` |
| Cost-pause provenance | `costPause = {kind: agent_run_complete\|strategy_approval\|launch_audience_intelligence, continuationId, reason, recordedAt, workflowState, budgetIncreaseApprovalId?}` | `cost-control.ts` via `recordWorkflowCostPause` (strict fail-closed parser `cost-pause.ts`) |
| Next-cycle instruction | `nextCycle = {instructionId, status: ready\|dispatched\|failed}` | `next-cycle-persistence.ts` |

Semantics fixed by Stream A (R4):
- `costPause.budgetIncreaseApprovalId` binds a pause to the exact `budget_increase` approval that resumes it; legacy pauses without the field resume under any approved budget decision. Unbound decisions fail closed (`PRECONDITION_FAILED`) in `executeApprovalDecision`.
- Next-cycle `instructionId = sha256(campaignId + strategyHashSha256 + sorted approved proposal fingerprints)` — identical learning material mints an identical instruction (dedup authority). A `ready` instruction is never clobbered by a different id (throws); a `dispatched`/`failed` instruction is CAS-replaced by newly promoted material; identical `failed` resets to `ready` only via `retry: true` / `retryFailedNextCycleInstruction` / `autonomousWorkflow.retryNextCycleDispatch`.
- Campaign bootstrap idempotency: `workflowContext.bootstrapIdempotencyKey` (client-supplied, optional) dedupes `campaign.create` and `autonomousWorkflow.startCampaignWorkflow` replays.
- Reconciliation authority: `classifyApprovalContinuation` (`approval-continuation.ts:126`) + `reconcileApprovalContinuation` — re-dispatch only through the Section 2 entry points; every non-`none` expectation is corroborated by the durable identities above.

## 4. Shared billing call boundaries

**Lifecycle-side rule:** Stream A never mutates wallets. All agent-run billing goes through the governed reservation authority:

- `reserveWalletCredits` / `settleWalletCredits` / `releaseWalletCredits` — `api/lib/billing/credit-reservation-engine.ts:195,248,304` (the only transaction-owning billing authority).
- Reference caller pattern: `api/lib/agents/runner.ts:81` (`runAgent`) — mint caller-stable billing identity (`api/lib/workflow/agent-billing-identity.ts`) → reserve before run → settle on chargeable completion (`buildAgentRunBillingSettleKey`) → release on provider/schema failure (`buildAgentRunBillingReleaseKey`).
- Pre-flight affordability gate: `enforceCostControl` / `canRunAutonomousWorkflow` / `pauseWorkflowForCostLimit` — `api/lib/billing/cost-control.ts:81,190,134`.
- Flat strategy estimate: `getEstimatedAgentCost("strategy") = 3` credits (`cost-tracker.ts:95`); strategy charge key `strategy-run-${runId}` (`strategy-agent.ts`).

**Contract for Stream E:** these key formats and ledgers are read by lifecycle dedup and must remain stable:
- `credit_transactions.idempotencyKey` values `creative-success:{campaignId}:approval:{approvalId}` and `strategy-run-${runId}` — lifecycle replay-detection depends on them.
- Settlement deducts through the accepted ledger `deductCredits` (`credit-engine.ts:168`); wallet-mutation semantics are unchanged by R4.
- `costPause` provenance shape (Section 3) is lifecycle-owned; Stream E must not add/remove keys without coordinating (parser is strict fail-closed).

**Contract for all streams:** never call `deductCredits` directly for a governed agent run; always reserve→settle/release via `runner.ts`.

## 5. Shared queue / trigger files

**Consume-only (call the listed exports; do not modify the files):**

| File | Contract exports |
|---|---|
| `api/lib/workflow/triggers.ts` | `onAgentRunComplete`, `onApprovalResolved`, `onStrategyApproved` |
| `api/lib/workflow/approval-continuation.ts` | `classifyApprovalContinuation`, `reconcileApprovalContinuation`, `runApprovalContinuationSweep`, `dispatchNextCycleAfterLearningPromotion` |
| `api/lib/workflow/next-cycle-trigger.ts` / `next-cycle-dispatcher.ts` / `next-cycle-persistence.ts` | trigger/dispatch/persist + `retryFailedNextCycleInstruction` |
| `api/lib/workflow/budget-resume.ts` | `resumeWorkflowAfterApprovedCostIncrease` |
| `api/lib/workflow/engine.ts` | `transitionCampaignState`, `getWorkflowState`, `createApprovalRequest`, `resolveWorkflowTransition` |
| `api/lib/billing/credit-reservation-engine.ts`, `credit-reservation.ts`, `credit-reservation-store.ts`, `credit-engine.ts` | Section 4 surface |
| `api/lib/queue/bullmq.ts` | `schedulePublishingJob`, `scheduleContentGenerationJob`, `removePublishingJob*`, `inspectPublishingJob`, `pausePublishingQueue`/`resumePublishingQueue`, queue name constants (`publishing-jobs`, `content-generation-jobs`), deterministic job-id builders |
| `api/lib/workflow/post-live-lifecycle-*.ts` (except noted) | leased pass, scheduler start/stop/status, authority/driver/db |
| `api/lib/learning/post-live-learning-trigger.ts` | `runGovernedPostLiveLearningTrigger` |

**Owned by other streams — Stream A consumes, does not modify:**
- Learning derivation internals (`api/lib/learning/learning-cycle-pipeline.ts`, `performance/`, `kpi/`, `analysis/`, `contracts/`, `learning-record-authority.ts`, `learning_records` schema) — Stream D. Lifecycle consumes only sealed approved envelopes: `getApprovedPromotionEnvelopes` (`promotion-service.ts:499`), `resolveApprovedLearningPromotionsForStrategy` (`learning-strategy-consumption.ts:92`).
- Creative generation internals and `creativeGenerationClaims` — Stream C. Lifecycle relies on the creative agent writing the `creative-success:{campaignId}:…` charge key and `contentPosts.metadata.generationRunId` / `creativeBriefFingerprint` (fallback success evidence in `triggers.ts:534-574`).
- Publishing/provider execution internals (`publishing-worker.ts`, `publishing-runner.ts` internals, `publish/`, `integrations/`) — Streams C/E as applicable.

**Shared wiring that no stream may unilaterally change:** `api/boot.ts` (scheduler + sweep wiring), `api/router.ts` (router registry), `api/worker.ts` (queue workers), `api/lib/env.ts` (feature flags: `postLiveLifecycleEnabled`, `postLiveMetricsObservationEnabled`, `redisUrl`), `api/lib/redis.ts`.

## 6. Explicit cross-stream dependencies discovered

1. **Stream C → lifecycle:** `onAgentRunComplete` auto-advance assumes creative/audience/distribution runs mark `agentRuns.status = "completed"` and that creative success leaves the Section 4 charge key or post metadata. If Stream C changes where success is recorded, it must keep those two markers or update `hasSuccessfulCreativeGenerationForApproval` jointly.
2. **Stream C → lifecycle (known seam):** `distribution-agent.ts:168-180` bypasses `transitionCampaignState` when entering `schedule_generated`. If Stream C routes this through the governed path, the `workflow_transition` audit event changes; coordinate so reconciliation/classifiers (state-based) keep matching.
3. **Stream E → lifecycle:** wallet schema, reservation state machine (`reserved→settled|released`, terminal-reject), and the dedup key formats in Section 4 are frozen for R4. Budget-increase approval semantics (binding, `not_bound` no-op, fail-closed unbound decisions) are lifecycle-owned; Stream E's billing changes must treat `costPause`/`budget_increase` as a caller.
4. **Stream D → lifecycle:** `learning_records.status` has one value (`recorded`); "approved/sealed" is a property of the promotion approval row + sealed audit event. Stream A's next-cycle trigger reads only durable envelopes — any Stream D change to envelope validation (`envelopeMatchesContext`) automatically governs cycle seeding.
5. **Stream E start gate:** Stream E may begin — this contract is committed at `33600ac`. Stream C has **no outstanding lifecycle dependency**: it consumes Section 2 entry points and Section 5 queue exports as-is; the one seam (item 2) is documented behaviour, not a blocker.
6. **Integration note:** both post-live schedulers plus the metrics-observation lease (`natforge:p1:post-live-metrics-observation`) remain env-gated OFF by default; the approval-continuation boot sweep is intentionally NOT gated (crash recovery). Integration branch must not flip these flags without ops sign-off (Rule: no deployment decisions in R4 streams).

---

*End of contract. Changes require a Stream A contract revision commit on `feature/r4-a-core-autonomy`.*
