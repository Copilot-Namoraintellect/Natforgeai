# FINANCIAL_RELIABILITY_CONTRACT — WBS-R4E Cross-Stream Authority

> **Status:** COMMITTED — Stream E (financial autonomy / reliability / self-healing)
> **Branch:** `feature/r4-e-financial-reliability`
> **Common base:** `2f21a8fc959070b79cfb9c237a5b87922dc42f08`
> **Date:** 2026-06-29
> **Audience:** Stream C (distribution/publishing), Stream D, R4-X integration owner
> **Supersedes/extends:** Stream A `CORE_LIFECYCLE_CONTRACT` §4 (billing call boundaries) with the
> key formats and recovery semantics below. Where this contract names a Stream A consume-only
> file, treat that file as unchanged; Stream A's lifecycle semantics remain authoritative there.
> **Rule:** downstream streams consume the modules named in §11 and MUST NOT duplicate billing
> identity construction, reservation lifecycle handling, or self-healing machinery. Key formats
> in §2 are frozen for R4 — lifecycle replay-detection and reconciliation depend on them.

---

## 1. Scope and invariants

This contract governs every financially sensitive retry: billable operations, externally costly
operations, credit holds, budget gates, and their recovery. The binding invariant:

> **One logical operation → at most one authoritative billable charge.**
> Retries, duplicate triggers, process restarts, and concurrent duplicate executions of the same
> logical operation must collapse onto one durable charge; uncertain failures fail closed, never
> blind-replay.

Security invariants (normative):

1. **Fail closed by default.** A billing mutation with missing/uncertain authority rejects;
   there is no insecure fallback when DB/Redis/provider authority is unavailable.
2. **Server-derived identities only.** Billing identity is always derived from durable
   server-side coordinates (run ids, queue ids, event ids). Never from client-supplied
   ownership or billing fields, and never from wall-clock time or randomness inside an identity.
3. **Ledger authority.** `credit_transactions.idempotencyKey` is the unique claim authority
   (`credit-engine.ts:198-265`); `credit_reservations` is the unique hold authority
   (`credit-reservation-store.ts`). Replays are verified (user/wallet/type/amount) before being
   reported as replays; conflicting reuse of a key fails closed with `CONFLICT`.
4. **No silent money movement.** Every deduction/refund/release has a durable row with safe
   attribution metadata (no secrets, no provider internals beyond names/ids).
5. **Authorization at boundaries.** Billing-mutating tRPC endpoints keep their middleware
   (`authedQuery` minimum, `aiActionQuery` for AI actions, `adminQuery` for admin); user
   isolation is owner-scoped at the DB layer.

## 2. Billing key registry (FROZEN formats)

| Operation | Key / identity | Derivation | Owner |
|---|---|---|---|
| Strategy run charge | `strategy-run-${runId}` | `agentRuns.id` (server) | strategy-agent |
| Strategy settle/release via reservation | reservationReference = `strategy-run-${runId}` (if ever reservation-wrapped) | same | — |
| Creative success charge | `creative-success:{campaignId}:{source}:{id}` | durable operation/job row id | creative-agent |
| Audience step | `agent-audience-${sha256("workflow/agent-billing@v1:audience:{campaignId}:{creativeRunId}")}` | upstream completed run id | agent-billing-identity |
| Distribution step | `agent-distribution-${sha256("workflow/agent-billing@v1:distribution:{campaignId}:{audienceRunId}")}` | upstream completed run id | agent-billing-identity |
| Audience-intelligence (PROPOSED — pending Stream A plumbing) | `agent-audience-intel-${sha256("workflow/agent-billing@v1:audience-intel:{campaignId}:{continuationId}")}` | dispatch continuation id | contract only |
| Interpretation model charge | `interpretation:${sha256("intelligence/interpretation-billing@v1:{businessId}:{signalId}:{signalVersion}:{signalContentHash}:{classifierVersion}")}` | trigger-boundary mint, passed as runAgent billingIdempotencyKey | model-boundary |
| Engagement webhook reply | `engagement-reply:{provider}:{externalEventId}` | webhook event identity | engagement-agent |
| Publishing attempt charge | `publishing:{queueItemId}` | publishing queue row id | publishing-runner |
| Premium video completion | `premium-video:{providerJobId}` | provider render job id | creative service |
| Image render claims path (dormant) | `img-deduction:{requestAttemptKey}` | client attempt + intent fingerprint | image-render-finalization |
| Reservation settle (generic) | `{billingKey}:settle` via `buildAgentRunBillingSettleKey` | billing key | runner |
| Reservation release (generic) | `{billingKey}:release` via `buildAgentRunBillingReleaseKey` | billing key | runner |
| Settlement deduction row | `sha256("credit-reservation-settle:{reservationId}:{settleKey}")` via `buildSettleDeductionIdempotencyKey` | reservation + settle key | reservation engine |
| Stale reservation reap | `stale-reap:{reservationId}` | reservation id | stale-reservation-reaper |

Rules:

- A key must be a pure function of durable material. Adding `Date.now()`, random ids, or
  attempt counters to a key forfeits replay protection and violates this contract.
- One key space per logical operation. A retried logical step re-enters with the SAME key; a
  genuinely new operation mints a new key (new run row, new queue row, new event).
- Key length must respect the 255-char `idempotencyKey` column.

## 3. Reservation lifecycle (authoritative)

State machine (`api/lib/billing/credit-reservation.ts:155-188`):

```
reserved ──settleKey──▶ settled (terminal)
reserved ──releaseKey─▶ released (terminal)
terminal + different transition → CreditReservationError RESERVATION_TERMINAL_STATE (fail closed)
same-key replay → idempotent_replay (no wallet effect)
```

- `reserveWalletCredits` (`credit-reservation-engine.ts:195`): ensure wallet → row-lock wallet
  (`SELECT ... FOR UPDATE`) → insert hold → capacity check (balance − outstanding ≥ 0, spend
  limit). Exact replay never re-validates capacity and never double-counts its own hold.
- `settleWalletCredits` (`:248`): lock wallet → guarded settle transition → deduct exactly
  `settledAmount` via `deductCredits` with the deterministic deduction key. Settlement and
  deduction commit together; failure rolls back to `reserved`.
- `releaseWalletCredits` (`:304`): guarded release transition only. A hold is logical; release
  creates no refund row and never touches the wallet.
- Capacity authority: `availableBalance = wallet.balance − SUM(reservedAmount WHERE state='reserved')`
  (`getAvailableCreditBalance`, lock-free read).

**Never** mutate wallets or reservations outside these three functions.

## 4. Charge / settlement / refund semantics

- **Governed agent runs** (runner keyed path, `runner.ts:112-212`): reserve before the provider
  call → settle on chargeable completion → release on provider/schema/quota failure. Other
  failure classes settle (charge retained) — this mirrors the legacy refund classes exactly.
  Never call `deductCredits` directly for a governed agent run.
- **Post-success direct charges** (strategy, creative, publishing, premium video, legacy
  image): claim-first keyed `deductCredits`. The key is the whole replay protection; without a
  key a charge is NOT retry-safe.
- **Refunds**: `refundCredits` (`credit-engine.ts:487`) is idempotent under a key; the runner's
  legacy classes refund via `adminAdjustCredits` (unkeyed by convention — a refund replay
  double-credits, so refund keys are mandatory wherever replay is possible).
- **Release ≠ refund**: releasing a reservation frees capacity without moving money; refunding
  returns deducted credits. Settled reservations cannot be released (no refund-through-release).

## 5. Strategy billing identity (Stream A seam — reconciled)

- Charge key `strategy-run-${runId}` is frozen. `chargeForStrategyRun` charges a validated run
  exactly once; `reconcileStrategyRunCharge` verifies durable evidence for a reused run and
  deducts at most once, failing closed on malformed/foreign/refunded rows.
- All live entry points now route through one of the two (agent-router, campaign-create
  auto-start, both regeneration mutations). The campaign-create flow charges fresh runs and
  reconciles reused runs, with a logged soft-fail so a billing fault cannot strand the lifecycle.
- Latent: `dispatchNextCycleInstruction` (no production caller) does not charge; when wired to a
  scheduler it MUST add the same charge/reconcile treatment.

## 6. Creative, audience, distribution identities

- Creative: `creative-success:{campaignId}:{source}:{id}` is the success charge and the
  lifecycle replay-detection key (Stream A contract §4). Content-post metadata
  (`generationRunId`, `creativeBriefFingerprint`) remains fallback success evidence.
- Audience/distribution: `agent-billing-identity.ts` builders are the only minting authority.
  The identity is a pure function of durable upstream run ids and is stable across retries.
- Manual router invocations without an event/step identity remain unkeyed: each manual click is
  a new billable operation BY DESIGN. Do not add keys to manual paths that lack a durable
  coordinate; add a durable operation row instead.

## 7. Engagement / publishing / video identities

- Engagement webhook path: `engagement-reply:{provider}:{externalEventId}` (minted by
  `buildEngagementReplyBillingIdentity` from the pipeline's event dedupKey). Redeliveries and
  lease-recovery replays settle at most once. Manual engagement invocations stay unkeyed.
- Publishing: one charge per queue item under `publishing:{queueItemId}`; retries with status
  `retrying` skip the charge; terminal replay's exactly-one-deduction evidence gate
  (`establishBillingEvidence`) is unchanged and now trivially satisfied.
- Premium video: one charge per render job under `premium-video:{providerJobId}` across all
  completion paths (refresh, webhook, synchronous shortcut). Feature flags
  `ENABLE_PREMIUM_VIDEO` / `ENABLE_BASIC_DRAFT_VIDEO` are enforced server-side, fail closed.

## 8. Retry identity rules

1. Mint at the workflow trigger boundary from durable coordinates; pass into the runner/charge
   site. Never mint inside a retry loop from fresh randomness.
2. Reserve → provider call → settle/release: the reservation id, settle key, and release key are
   all pure functions of the one billing key.
3. Crash between any two steps: re-enter with the same key; the ledger/hold authorities make
   the re-entry idempotent (E2 suite proves each window).
4. Concurrency: the unique authorities (idempotency key, reservation identity, wallet row lock,
   guarded transitions) serialize duplicates; losers verify and report replays.
5. Cross-user isolation: reservation identity includes `userId` (payload
   `buildCreditReservationIdentityPayload`); a key minted for user A can never settle user B's
   hold, and reuse under a different user fails closed (E2 adversarial test).

## 9. External-call safe pattern (required shape)

```
1. durable operation row first (agentRuns/queue row/event claim)   ← identity anchor
2. affordability gate (enforceCostControl / canRunAutonomousWorkflow)
3. reserve under the billing key            (governed path)  or  keyed claim-first charge point
4. ONE provider call with timeout + abort
5. settle (success) or release (classified failure)   — deterministic keys
6. durable success markers BEFORE any retry can re-enter
```

- External retries must not create duplicate billable effects: the retry re-enters at step 3/5
  under the same identity, never at step 4 with a fresh identity.
- Provider-success-but-DB-ack-failure: the identity replay absorbs the retry; the provider may
  be called again (external cost) but the wallet effect stays exact-once. Provider-side
  idempotency keys are recommended where the provider supports them (residual duplicate-external-
  post window in publishing is tracked under §13).
- Do not wrap uncertain commit outcomes in auto-retry; classify and fail closed (image-render
  claims matrix is the reference).

## 10. Budget pause / resume rules (consume; lifecycle-owned semantics)

- Gates: `enforceCostControl` (balance + daily/monthly system limits), `canRunAutonomousWorkflow`
  (campaign affordability + pause-on-insufficient with continuation provenance).
- **WBS-R4E gate semantics:** forward-dispatch gates pass a `continuation` and reject paused
  campaigns; bare affordability probes omit it and are gated on credits only — this is what makes
  the budget-resume affordability recheck reachable. Do not add a continuation to probe calls.
- Pause: `pauseWorkflowForCostLimit` records durable `costPause` provenance BEFORE the state
  clobber and creates at most one pending `budget_increase` approval per campaign.
- Resume: `resumeWorkflowAfterApprovedCostIncrease` (Stream A-owned) claims by exact
  kind+continuationId, restores the pre-pause state, dispatches exactly one continuation through
  the existing trigger pathways. Stream A's approval-binding semantics (`approvalId`,
  `not_bound`) take precedence where present.
- The resume cycle itself never moves money; charges stay inside the dispatched continuations
  under their own identities.

## 11. Modules downstream streams must consume (do not duplicate)

| Module | Consume for |
|---|---|
| `api/lib/billing/credit-reservation-engine.ts` | reserve/settle/release (the only hold authority) |
| `api/lib/billing/credit-reservation.ts` | state machine, identity payload builders, error taxonomy |
| `api/lib/billing/credit-engine.ts` | `deductCredits`/`refundCredits` (claim-first ledger), `isMySqlDuplicateKeyError` |
| `api/lib/billing/cost-control.ts` | `enforceCostControl`, `canRunAutonomousWorkflow`, `pauseWorkflowForCostLimit` |
| `api/lib/billing/cost-tracker.ts` | `getEstimatedAgentCost` per agent type |
| `api/lib/billing/stale-reservation-reaper.ts` | stale-hold recovery (`reapStaleCreditReservations`) |
| `api/lib/agents/runner.ts` | `runAgent` + `buildAgentRunBillingSettleKey/ReleaseKey` |
| `api/lib/workflow/agent-billing-identity.ts` | audience/distribution identity minting |
| `api/lib/agents/stale-strategy-run.ts` | stale-run terminalisation (all workflow agent types) |
| `api/lib/agents/engagement-agent.ts` | `buildEngagementReplyBillingIdentity` |
| `api/lib/agents/strategy-agent.ts` | `chargeForStrategyRun` / `reconcileStrategyRunCharge` |

## 12. Overlap-risk files (coordinate before changing)

| File | Why risky |
|---|---|
| `api/lib/billing/cost-control.ts` | Stream A also edits it (approval binding); semantic merge required at integration |
| `api/lib/workflow/budget-resume.ts` | Stream A consume-only; resume semantics lifecycle-owned |
| `api/lib/agents/runner.ts` | shared by all agents; settle/release classes mirror legacy refunds |
| `api/lib/agents/strategy-agent.ts` | charge key frozen by Stream A §4 |
| `api/lib/agents/creative-agent.ts`, `api/lib/creative/service.ts` | Stream C internals; billing points touch Stream C rows |
| `api/lib/workflow/publishing-runner.ts` | billing point is Stream E; execution internals shared with Stream C |
| `api/lib/engagement/inbound.ts` | event pipeline (Stream D/C territory); only the billing key passes through |
| `api/lib/agents/engagement-agent.ts` | engagement semantics not owned by E; identity builder is |
| `api/campaign-router.ts` | Stream A callouts (create flow, `onAgentRunComplete`); billing calls added by E |
| `api/video-router.ts`, `api/image-router.ts` | feature-flag and refund semantics product-visible |

## 13. Known residuals and security debt (tracked, not silently owned)

1. **Audience-intelligence unkeyed** — identity format fixed in §2; requires Stream A call-site
   plumbing (`triggers.ts`, `budget-resume.ts`). Until then, a recovered continuation can
   re-charge its own up-front deduction.
2. **Subscription self-grant** — `subscription.subscribe` trusts client `confirmedByWebhook`;
   manual/admin payment verification semantics are a product decision (integration owner).
3. **Premium leaflet legacy path unkeyed** — dormant claims path is the designed exact-once
   successor; activation decision is Stream C's.
4. **`publishing.publishDuePosts`** — global due-scan trigger reachable by any authenticated
   user (executes other users' due rows); recommend admin gating at integration.
5. **Creatify webhook signature** not verified (bounded: only the attacker's own jobs can be
   completed/charged).
6. **Safety-check provider failure keeps the 1-credit charge** (no refund class).
7. **Unbilled LLM surfaces** (§13 of the matrix) — product pricing decisions.
8. **Reservation reaper wiring** — `reapStaleCreditReservations` exported and tested; scheduling
   belongs to integration-owned `api/boot.ts`.

*End of contract. Changes require a Stream E contract revision commit on
`feature/r4-e-financial-reliability` plus Stream A sign-off where Stream A-owned files are
affected.*
