# WBS-R4E Financial Autonomy Matrix

> **Status:** COMMITTED — Stream E (financial autonomy / reliability / self-healing)
> **Branch:** `feature/r4-e-financial-reliability`
> **Common base:** `2f21a8fc959070b79cfb9c237a5b87922dc42f08`
> **Consumes:** `docs/recovery/r4-core-lifecycle-contract.md` (Stream A, `e981e3a`)
> **Companion contract:** `docs/contracts/financial-reliability-contract.md` (E5)

This matrix inventories every surviving billable or externally costly operation, names its
stable identity and lifecycle, classifies its crash windows, and records the E-stream
disposition (fixed in this branch / already sufficient / escalated). Row references are
`file:line` at the time of writing.

Shared authorities (not re-derived per row): governed reservation engine
(`api/lib/billing/credit-reservation-engine.ts:195,248,304`), claim-first ledger
(`api/lib/billing/credit-engine.ts:168,487`), runner reference caller
(`api/lib/agents/runner.ts:81`), affordability gate (`api/lib/billing/cost-control.ts:81,190,134`).

---

## 1. Strategy generation

| Field | Value |
|---|---|
| Operation | `runStrategyAgent` + `chargeForStrategyRun` / `reconcileStrategyRunCharge` — `api/lib/agents/strategy-agent.ts:1276,1154,1195` |
| Workflow boundary | (a) `agentRouter.runStrategyAgent` `api/agent-router.ts:185-208`; (b) campaign-create auto-start `api/campaign-router.ts:259-378`; (c) `regenerateFromProfile` `api/campaign-router.ts:841-909`; (d) `regenerateStrategyForApproval` `api/campaign-router.ts:1246-1314`; (e) next-cycle dispatch `api/lib/workflow/next-cycle-dispatcher.ts:115-126` (no production caller) |
| Stable operation identity | `strategy-run-${runId}` — server-derived from the durable `agentRuns.id` (frozen by Stream A contract §4) |
| Reservation identity | none (keyed claim-first deduction, not reserve→settle) |
| Quota check | `enforceCostControl(userId, 3)` inside `runStrategyAgent` (`strategy-agent.ts:1376-1384`) |
| Budget check | same gate |
| Charge point | post-success only: validated output persisted, snapshot materialised (`strategy-agent.ts:1548-1573`), then charge |
| Settlement point | immediate ledger deduct under `strategy-run-${runId}` |
| Release/refund | none needed by construction on failure paths (charge never fires); `reconcileStrategyRunCharge` fails closed on malformed/foreign/refunded evidence (`strategy-agent.ts:1195-1255`) |
| Retry identity | yes — same runId ⇒ same key ⇒ `alreadyDeducted`; reused runs reconcile instead of re-charging |
| Crash windows | crash between provider success and charge persistence = missed charge (recovered by the reconcile-on-reuse paths); charge succeeded then `recordAiUsage` fails = charge stands, run advances (service delivered) |
| Owning module | `api/lib/agents/strategy-agent.ts` + callers |
| Sufficiency | **SUFFICIENT after this stream.** Boundary (b) charged nothing before this stream — see "Strategy charge-gap reconciliation" below. Boundary (e) remains uncharged (dead code; escalated). |

**Strategy charge-gap reconciliation (Stream A known seam).** The run-completion →
`chargeForStrategyRun` seam now holds at every live boundary:

- Fresh runs at every live boundary are charged exactly once under the stable server-derived
  identity `strategy-run-${runId}`. `deductCredits` is claim-first on the unique
  `credit_transactions.idempotencyKey` (`credit-engine.ts:198-265`): a duplicate trigger,
  retry, restart, or concurrent double-execution of the same run's charge collapses onto one
  ledger row; the loser of a true race re-reads the committed row, verifies
  user/wallet/type/amount, and reports `alreadyDeducted` without a second debit.
- Reused completed runs reconcile (`reconcileStrategyRunCharge`): exact user/campaign/runId
  metadata verification, fail-closed on conflicting or refunded evidence, deduct-at-most-once.
- Campaign-create auto-start (the one uncharged live path) now charges fresh runs and
  reconciles reused runs (`api/campaign-router.ts`), with a logged soft-fail so a billing
  fault can never strand the lifecycle.
- Lifecycle replay-detection compatibility: the key format `strategy-run-${runId}` is
  unchanged, honouring Stream A contract §4.

Proof: `api/campaign-router.test.ts` (create-flow charge/reconcile assertions),
`api/lib/agents/strategy-agent.test.ts:1901-2055`, and the E2 exact-once suite
(`api/lib/billing/exact-once-financial-acceptance.test.ts`).

## 2. Creative agent hero pack

| Field | Value |
|---|---|
| Operation | `runCreativeAgent` — `api/lib/agents/creative-agent.ts:965` (up to 2 OpenAI calls, one charge) |
| Workflow boundary | `agentRouter.runCreativeAgent` (`api/agent-router.ts:511`); `processContentGenerationJob` (`api/lib/jobs/content-generation-job.ts:343`); approval-resolution auto-run (`api/lib/workflow/triggers.ts:902-909`) |
| Stable operation identity | `creative-success:{campaignId}:{source}:{id}` — `creative-agent.ts:903-915`; `id` is the durable operation/job row id |
| Reservation identity | none (claim-first post-success deduction); creative-generation claim (not billing) serialises submission |
| Quota check | `enforceCostControl` + `checkCredits` (`creative-agent.ts:849-869`) |
| Budget check | same gate |
| Charge point | post-success only, after posts/assets persisted (`creative-agent.ts:2357-2373`) |
| Settlement | immediate keyed deduct; `alreadyDeducted` replay at `creative-agent.ts:955-962` |
| Release/refund | no charge on any pre-billing failure; billing failure marks pack run failed, content retained, nothing deducted |
| Retry identity | yes for same operation row; a new row = new billable operation by design |
| Crash windows | crash between provider spend and deduction = missed charge (claim sweep does not re-bill; content-terminal-replay short-circuit inherits this); TOCTOU between pre-check and post-success deduct can fail after cost is sunk |
| Owning module | `api/lib/agents/creative-agent.ts` (+ Stream C internals) |
| Sufficiency | **SUFFICIENT for double-charge** (keyed, caller-stable, claim-serialised). Missed-charge window documented; the dormant claims/finalization path is the designed successor (Stream C activation decision). |

## 3. Audience discovery / distribution (workflow auto-advance)

| Field | Value |
|---|---|
| Operation | `runAudienceAgent` / `runDistributionAgent` via `runAgent` keyed path — `api/lib/workflow/triggers.ts:216-224,252-261` |
| Workflow boundary | `onAgentRunComplete` auto-advance (agent-router fire-and-forget / campaign-router / budget-resume dispatch) |
| Stable operation identity | `agent-audience-${sha256("workflow/agent-billing@v1:audience:{campaignId}:{creativeRunId}")}`; `agent-distribution-${sha256(...distribution:{campaignId}:{audienceRunId}")}` — `api/lib/workflow/agent-billing-identity.ts` |
| Reservation identity | yes — `reserveWalletCredits`, `reservationReference = externalIdempotencyKey = identity` (`runner.ts:119-128`) |
| Quota check | `enforceCostControl` (runner) + `canRunAutonomousWorkflow` (trigger) |
| Budget check | both gates |
| Charge point | `settleWalletCredits` on chargeable completion (`runner.ts:205-210`) |
| Settlement | settle-on-success inside runner; deterministic settle key `{identity}:settle` |
| Release/refund | provider/schema/quota failure → `releaseWalletCredits` `{identity}:release`; other failures settle (charge retained, legacy mirror) |
| Retry identity | yes — pure function of durable run ids; replay collapses onto one reservation/settle/release |
| Crash windows | settle-failure crash left the run `running` forever → permanent forward stall; **fixed** by the WBS-R4E stale-run reaper extension (§E4). Crash after settle before context update = external-cost leak only (no extra charge). |
| Owning module | workflow triggers + runner + reservation engine |
| Sufficiency | **SUFFICIENT** (reference reservation pattern; test-covered by `runner-reservation-billing.test.ts`, `agent-billing-identity.test.ts`, E2 suite). |

## 4. Audience-intelligence agent

| Field | Value |
|---|---|
| Operation | `runAudienceIntelligenceAgent` → `runAgent({agentType:"audience"})` unkeyed — `api/lib/agents/audience-intelligence-agent.ts:323-331` |
| Workflow boundary | (a) `agentRouter.runAudienceIntelligence` `api/agent-router.ts:871-875`; (b) launch-approval auto-run `triggers.ts:427-431`; (c) pre-creative inside `onStrategyApproved` `triggers.ts:879`; (d) budget-resume continuation `budget-resume.ts:85-98` |
| Stable operation identity | **NONE on any path** — every execution takes the runner's legacy unkeyed up-front deduction |
| Reservation identity | none |
| Quota check | runner `enforceCostControl`; (b) also `canRunAutonomousWorkflow` |
| Budget check | same |
| Charge point | up-front unkeyed `deductCredits` (`runner.ts:147-154`), 3 credits |
| Settlement | immediate |
| Release/refund | provider/schema/quota classes only via `adminAdjustCredits` (`runner.ts:298-311`) |
| Retry identity | **no** — a recovered continuation re-runs the LLM with a fresh deduction |
| Crash windows | crash after deduct before persist → net charge for unfinished step; resume re-dispatch double-charges |
| Owning module | `api/lib/agents/audience-intelligence-agent.ts` + consume-only dispatch sites |
| Sufficiency | **INSUFFICIENT — escalated.** Minting a per-step identity requires plumbing a key from the four dispatch sites, all of which live in Stream A consume-only files (`triggers.ts`, `budget-resume.ts`). Proposed identity format is fixed in the E5 contract (`agent-audience-intel-${sha256(...)}`); integration owner to coordinate with Stream A. The stale-run reaper now unblocks stalled continuations, which makes this gap visible as a re-charge on retry rather than a permanent stall — documented in the E5 contract. No-data early return remains uncharged (test-covered). |

## 5. Engagement reply generation

| Field | Value |
|---|---|
| Operation | `generateReply` → `runAgent({agentType:"engagement"})` — `api/lib/agents/engagement-agent.ts:111-119` |
| Workflow boundary | Meta/IG/WhatsApp webhook → `processInboundWebhook` → atomic event claim → `runClaimedEvent` → `handleNewMessage` (`api/lib/engagement/inbound.ts:298-361`); manual `agentRouter.runEngagementAgent` (`api/agent-router.ts:713-724`) |
| Stable operation identity | **FIXED (webhook path):** `engagement-reply:{provider}:{externalEventId}` via `buildEngagementReplyBillingIdentity(dedupKey)` (`engagement-agent.ts`). Manual invocations remain unkeyed (each click is a new billable operation by design). |
| Reservation identity | yes on webhook path — runner keyed reservation |
| Quota check | `enforceCostControl`; no campaign gate (webhook is not workflow-scoped) |
| Budget check | same |
| Charge point | settle-on-success inside runner |
| Settlement | `{identity}:settle` |
| Release/refund | provider/schema/quota → `{identity}:release` |
| Retry identity | **yes for webhook events after this stream** — redelivery/recovery replays the same reservation; previously the reply-row dedup masked a duplicate LLM charge on every recovery |
| Crash windows | crash after provider success before reply insert → redelivery now replays the same reservation instead of double-charging |
| Owning module | `api/lib/agents/engagement-agent.ts` + `api/lib/engagement/inbound.ts` |
| Sufficiency | **SUFFICIENT for the webhook path after this stream** (tests in `api/lib/agents/__tests__/engagement-agent.test.ts`). |

## 6. Sales agent

| Field | Value |
|---|---|
| Operation | `generateFollowUpSequence` / `generateProposal` / `generateMeetingPrompt` — `api/lib/agents/sales-agent.ts:105-113,176-184,241-249` |
| Workflow boundary | `agentRouter.runSalesAgent` `api/agent-router.ts:731-770` |
| Stable operation identity | none (manual actions; each invocation is a new billable operation by design) |
| Reservation / quota / charge | legacy unkeyed up-front deduction; runner `enforceCostControl`; provider/schema/quota refund classes |
| Retry identity | n/a — no automatic retry surface |
| Crash windows | crash between deduct and LLM = charged, no run |
| Owning module | `api/lib/agents/sales-agent.ts` |
| Sufficiency | **SUFFICIENT** for the mission's double-charge scope (no duplicate-trigger/replay surface). Optional per-lead keys (`sales:{leadId}:{action}`) recorded as future hardening in the E5 contract. |

## 7. Publishing (queue-item publication)

| Field | Value |
|---|---|
| Operation | `publishSinglePost` — `api/lib/workflow/publishing-runner.ts:739`; provider dispatch at `platforms.ts` + governed adapter |
| Workflow boundary | BullMQ worker (`api/lib/queue/publishing-worker.ts`), legacy cron (`publishing-runner.ts:1509`, no-Redis fallback), global tRPC `publishing.publishDuePosts` (`api/publishing-router.ts:364`), manual `publishing.publishPost`, launch resolution, calendar intake |
| Stable operation identity | provider side: durable canonical receipt + `derivePublicationOperationId` (`publishing-runner.ts:1190`) replays success with zero provider calls; job side: deterministic `publish-{queueItemId}` (`api/lib/queue/bullmq.ts:102`) |
| Reservation identity | none |
| Quota check | `rateLimitUser(..., "publish")` (`publishing-runner.ts:850`); balance enforced by the deduction itself |
| Budget check | none beyond balance |
| Charge point | up-front 1-credit deduction before decrypt + provider submission (`publishing-runner.ts:1076-1091`) |
| Settlement | immediate |
| Release/refund | none (retry skip keyed on `status === "retrying"`) |
| Retry identity | **FIXED:** charge now keyed `publishing:{queueItemId}` — a crash between deduct and status flip, or the cron/worker/manual overlap, collapses onto one ledger row per queue item |
| Crash windows | residual: crash after provider success before receipt commit can re-dispatch to the provider without a provider-side idempotency key (duplicate external post is possible; the charge is not duplicated). Terminal replay's exactly-one-deduction evidence gate is unchanged. |
| Owning module | `api/lib/workflow/publishing-runner.ts` (billing point = this stream; execution internals shared with Stream C) |
| Sufficiency | **SUFFICIENT for double-charge after this stream** (`publishing-runner.test.ts` charge-key assertion). Residual duplicate-external-post window + the unscoped `publishDuePosts` trigger documented in the E5 contract. |

## 8. Safety check (publish/distribution-bundled)

| Field | Value |
|---|---|
| Operation | `checkContentSafety` — `api/lib/safety/checker.ts:15-135` (OpenAI per call) |
| Workflow boundary | `publishing-runner.ts:595` (charged), `distribution-agent.ts:114-121` (skipDeduction), content-router preflights (skipDeduction) |
| Stable operation identity | none; result persisted per queue item so it runs once per item |
| Quota check | `checkCredits` (1 credit); insufficient → degrades to medium risk by design |
| Charge point | unkeyed up-front deduction (`checker.ts:50-56`) — standalone invocations only |
| Release/refund | **none**; a provider failure after the deduct keeps the credit |
| Retry identity | per queue item yes (persisted result); second queue item for same content re-charges |
| Owning module | `api/lib/safety/checker.ts` |
| Sufficiency | **WEAK but bounded** (1 credit, once per item, degradation path is free). Missing provider-failure refund recorded as security debt in the E5 contract; not changed to avoid altering Stream C publish-path semantics mid-flight. |

## 9. Legacy image generation job (`image.create`)

| Field | Value |
|---|---|
| Operation | `imageRouter.create` — `api/image-router.ts:153-214`; external worker completes via `image.update:216-278` |
| Stable operation identity | none (no client attempt token exists on this legacy contract) |
| Reservation identity | none |
| Quota check | **FIXED:** `enforceCostControl` added (balance-only `checkCredits` before) |
| Budget check | same gate |
| Charge point | up-front 2-credit deduction before job row insert |
| Settlement | immediate |
| Release/refund | **FIXED:** `creditsCharged` is now persisted on the job row, making the worker-failure refund branch live (`image.update:263-275` was dead — the schema default 0 never satisfied `creditsCharged > 0`) |
| Retry identity | none — a client retry of the same logical request double-charges; the designed successor is the (dormant, default-off) image-render claims path with `img-deduction:{requestAttemptKey}` (`api/lib/creative/image-render-finalization.ts:605`) |
| Crash windows | crash between deduct and row insert = charge with no job (rare; insert follows deduct immediately) |
| Owning module | `api/image-router.ts` |
| Sufficiency | **SUFFICIENT after this stream** for refund correctness and budget gating; retry-key gap documented (claims mode is the designed fix; activation is a Stream C decision). |

## 10. Premium leaflet render (legacy claims-OFF path)

| Field | Value |
|---|---|
| Operation | `generatePremiumLeaflet` — `api/lib/creative/service.ts:1005`; OpenAI/Bannerbear/Templated.io/internal providers |
| Stable operation identity | none for billing (deliberately fresh `generationRunId` per call); business-level reuse branch returns the prior asset at 0 credits for unchanged intent (`service.ts:1074-1175`) |
| Reservation identity | none |
| Quota check | `assertCanAfford` = `enforceCostControl` + `checkCredits` (`service.ts:1237`) |
| Charge point | post-render, post-fidelity-gate keyed **nothing** — `deductCredits` unkeyed (`service.ts:2231-2247`) |
| Release/refund | pre-charge failures free; no post-charge refund |
| Retry identity | no — crash between deduct and image-row insert re-renders + re-deducts |
| Owning module | `api/lib/creative/service.ts` (+ dormant claims machinery) |
| Sufficiency | **PARTIAL.** Post-success charging + reuse + gates are sound; the missing key leaves a double-charge crash window. Not key-modified in this stream because the dormant claims-ON path (`img-deduction:{requestAttemptKey}`, single-finalization-transaction) is the designed exact-once successor and the parity tests (`creative-service-image-claims-off-parity.test.ts`) pin current behavior; activation is a Stream C product decision. Escalated in the E5 contract. |

## 11. Premium video (Creatify)

| Field | Value |
|---|---|
| Operation | `generatePremiumVideo` / `completePremiumVideo` — `api/lib/creative/service.ts:3203,3320`; provider call consumes Creatify credits immediately (`providers/creatify-video-provider.ts:188`) |
| Workflow boundary | `videoRouter.renderVideo` premium (`api/video-router.ts:103-136`); completion via `refreshStatus`, Creatify webhook (`api/boot.ts:87-121`), synchronous-done shortcut |
| Stable operation identity | **FIXED (charge):** `premium-video:{providerJobId}` on the completion deduction — the three racing completion paths collapse onto one ledger row per render job. No pre-call idempotency around the provider call itself. |
| Reservation identity | none |
| Quota check | `assertCanAfford` (`service.ts:3238`) |
| Budget check | same |
| Charge point | post-completion, post-storage (`service.ts:3424-3439`) |
| Release/refund | none needed on success-only charging; provider failure sinks Creatify cost |
| Retry identity | charge yes (after fix); render no |
| Crash windows | crash between provider call and job-row insert → second Creatify job on retry (provider-cost double, first never billable); webhook signature not verified on the Creatify branch (spoofing can only complete/charge the attacker's own jobs — bounded) |
| Feature gate | **FIXED:** `ENABLE_PREMIUM_VIDEO` / `ENABLE_BASIC_DRAFT_VIDEO` are now enforced server-side, fail closed (previously UI-only; any authed API caller could trigger paid provider spend against a disabled feature) |
| Owning module | `api/lib/creative/service.ts` + `api/video-router.ts` |
| Sufficiency | **SUFFICIENT for double-charge after this stream** (`premium-video-billing.test.ts`, `video-router.test.ts`). Pre-call idempotency + webhook signature recorded in the E5 contract. |

## 12. Publishing smoke test

| Field | Value |
|---|---|
| Operation | `publishingRouter.publishSmokeTest` — `api/publishing-router.ts:369-432` (real external post to the user's page) |
| Billing | none; no queue row, receipt, or rate limit |
| Sufficiency | **INSUFFICIENT — documented only.** Unbilled external side effect by design of the diagnostic; flagged in the E5 contract as operator-facing security debt (admin-gating recommended at integration). |

## 13. Unbilled provider surfaces (no wallet movement)

| Operation | Notes |
|---|---|
| `parseIntent` / `improveBrief` (`api/campaign-router.ts:424,508`), `analyseWebsite` / `completeProfileWithAi` (`api/business-router.ts:579,779`) | OpenAI calls with no billing — pre-existing product decision; recorded in the E5 contract. |
| Caption pack (`service.ts:2878-3103`), copy refinement (`service.ts:2789`) | bundled into premium pricing; standalone `generateCaptionPack` is a free LLM endpoint throttled only by the AI rate limit. |
| Audience ingestion adapters (`api/lib/audience/ingest.ts:73-267`) | live Meta/LinkedIn reads with decrypted tokens; durable per-event `dedupHash`; unbilled by design. |
| Distribution-bundled per-post safety LLM calls (`checker.ts:61-80`, skipDeduction) | externally costly, bundled flat into the distribution estimate; invisible to cost-control aggregates (`creditsDeducted: 0`). |
| Conversation/template/learning/analytics/automation/approval/integration/banking routers | verified no billing and no provider cost (grep-audited); approval decisions move no money (downstream rows do). |

## 14. Subscription grant (`subscription.subscribe`)

Client-supplied `confirmedByWebhook` gates a paid-tier insert + `allocateMonthlyCredits` + a
`completed` Stripe payment row with no Stripe verification (`api/subscription-router.ts:84-158`),
and monthly allocation is a read-then-unconditional-update (retry can double-allocate).
**Highest-severity pre-existing finding; deliberately NOT changed** — payment-confirmation
semantics are product behaviour outside this stream's authority. Recorded as NEW_SECURITY_DEBT
in the E5 contract and the final report; integration-owner decision required.

## E4 self-healing classifications (summary)

| Failure class | Classification | Mechanism |
|---|---|---|
| Stale strategy/creative/audience/distribution/engagement/sales run | AUTO_RECOVER | extended exact-once reaper (`api/lib/agents/stale-strategy-run.ts`), fired at the existing forward boundary |
| Abandoned creative/execution claim | AUTO_RECOVER | claim lease + heartbeat + terminal replay executors (existing) |
| Stale/expired reservation | AUTO_RECOVER | `reapStaleCreditReservations` (`api/lib/billing/stale-reservation-reaper.ts`); wiring is integration-owned (boot.ts) |
| Interrupted scheduler / queue claim loss / worker restart | AUTO_RECOVER | BullMQ re-queue + deterministic job ids (existing) |
| Provider transient failure on governed run | AUTO_RECOVER | runner release (no charge) + idempotent retry of the same identity (existing + E2-proven) |
| DB commit ok, process dies | AUTO_RECOVER | claim-first ledger / durable reservation replay |
| Provider ok, DB ack fails | AUTO_RECOVER for keyed paths (identity replay); legacy unkeyed paths documented |
| Redis lease expiry (post-live) | AUTO_RECOVER | CAS lease (existing) |
| Budget exhaustion | AUTO_RECOVER | governed pause → approval → exact resume (E3-proven) |
| Uncertain commit (image-render claims ON path) | FAIL_CLOSED | bounded read-only matrix, never auto-retry (existing) |
| Malformed/refunded/foreign strategy charge evidence | FAIL_CLOSED | `reconcileStrategyRunCharge` CONFLICT (existing) |
| Subscription self-grant, unscoped publishDuePosts, unsigned Creatify webhook | OPERATOR_ACTION / integration decision | documented, not unilaterally redesigned |

*End of matrix. The binding key formats, lifecycle rules and overlap risks are normative in
`docs/contracts/financial-reliability-contract.md`.*
