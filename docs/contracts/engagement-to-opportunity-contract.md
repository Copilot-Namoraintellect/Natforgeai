# ENGAGEMENT → OPPORTUNITY / DOWNSTREAM CONTRACT (WBS-R5 Stream C)

> **Stream:** WBS-R5 Stream C — Autonomous Engagement
> **Branch:** `feature/r5-c-autonomous-engagement`
> **Status:** ACCEPTED — 29-proof C9 acceptance suite (`api/r5-c-acceptance.test.ts`)
> **Audience:** R5-D (opportunity detection), R5-X (integration), R6 (future consumers), operators
> **Rule:** downstream streams consume engagement evidence; they must NOT
> redefine engagement execution authority, re-derive engagement identities,
> or mutate engagement records. R5-C owns engagement planning + execution.
> **Frozen upstream consumed (not merged):** R5-A `c9a930e`, R5-B `b939328`,
> R5-E `c936caa` (vendored byte-identical — see §17), R5-F `5800626`.

---

## 1. Engagement action identity

- `actionRequestId = "eng_" + sha256(... )[:40]` over the canonical tuple
  `{contractVersion, businessId, signalId, signalVersion, interpretationId,
  actionType, provider, integrationId, externalTarget, responseContextVersion}`
  (`api/lib/engagement/action-request.ts`).
- Server-minted only; deterministic per logical action; any material change
  to the bound inputs mints a NEW identity (and therefore a fresh R5-E
  decision scope). Retries converge to the same id.
- Engagement action types constructed by C (subset of the frozen R5-E
  vocabulary, never redefined): `reply_publicly`, `escalate_to_human`,
  `suppress_action`. `react` / `reply_privately` are NOT constructible (no
  repository transport — §16); other vocabulary entries remain policy-owned.

## 2. Response-generation identity

- `responseContentId = "egen_" + sha256(actionRequestId|interpretationId|
  responseContextVersion)[:40]`; integer `version` (currently always 1).
- `responseContextVersion = sha256(interpretationId|signalContentHash|
  providerEvidenceHash|businessDnaSnapshotId|null|platform)` — binds
  approvals to the exact interpretation/evidence/brand context.
- Generation billing identity: `engen:<responseContentId>:v<version>`
  (exact-once through the governed agent-run reservation path).
- Accepted content is immutable (unique `(responseContentId, version)`,
  content-hash verified on replay; conflicting replay fails closed
  `RESPONSE_CONTENT_IDENTITY_CONFLICT`).

## 3. Policy decision binding

- One `actionRequestId` + one `policyVersion` → one `policyDecisionId`
  (`pdec_…`, R5-E owned). C consumes decisions read-only via
  `getDecisionById` / durable rows and re-asserts
  `assertMarketingActionExecutable` at execution time with the CURRENT
  active policy version and the durable approval row.
- The gate verdict is the only execution authority. DENY / ESCALATE /
  NO_ACTION never execute; REQUIRE_APPROVAL executes only under the exact
  bound approval; stale policy (`STALE_POLICY_VERSION`), changed context
  (`CONTEXT_VERSION_MISMATCH`) and expired bindings (`EXPIRED_DECISION`)
  fail closed. C adds no local policy interpretation.

## 4. Approval binding

- `marketing_action` approvals (R5-E/E-owned approval flow, consumed
  unchanged): one row per decision (`ma1:<sha256(contractVersion:decisionId)>`),
  binding `{policyDecisionId, actionRequestId, businessId, policyVersion,
  contextVersion, riskClass, estimatedCostClass, billingIdentity, expiresAt}`
  in `approval_requests.context.marketingActionBinding`.
- Authorisation is fail-closed on missing/stale/mismatched/expired bindings
  (R5-E validates inside the decision transaction; C re-validates at
  execution). Edited approvals are never valid. Rejection permanently
  blocks the action identity (`ACTION_REJECTED_BY_HUMAN`, permanent).
- C-owned continuation: `resumeEngagementContinuationForApproval`
  (api/lib/engagement/continuation.ts) + the `onApprovalResolved`
  `marketing_action` branch + boot sweep. Approval resumes the action
  automatically — no developer command.

## 5. Provider operation identity

- `providerOperationIdentity = "eop_" + sha256(provider|providerAccountRef|
  externalTarget|contentHash)[:40]`. Stable per logical provider operation
  and content-bound: a changed response produces a new identity, so a stale
  approval can never ride a swapped payload.
- Unique on `engagement_executions` and `engagement_receipts` — the
  reconciliation/dedupe anchor for ambiguous outcomes and crash windows.

## 6. Engagement receipt identity

- `engagementReceiptId = "erec_" + sha256(executionId|providerOperationIdentity)[:40]`.
- One receipt per execution (unique `executionId`) and per provider
  operation (unique `providerOperationIdentity`). Immutable once accepted;
  no update path exists.

## 7. Action / status vocabulary (closed)

Action types (C-constructed): `reply_publicly` · `escalate_to_human` ·
`suppress_action`.

Execution statuses (closed): `pending_claim` · `executing` ·
`pending_retry` · `succeeded` · `failed_retryable` · `failed_terminal` ·
`ambiguous` · `blocked` · `never_execute` · `internal_only`.

Reconciliation states (closed): `none` · `needed` · `in_progress` · `resolved`.

Failure classes (closed): `transient` · `permanent` · `ambiguous` ·
`governance` · `unsupported`.

Receipt statuses (closed): `succeeded`.

## 8. Retry / reconciliation semantics

- Claim lease 5 min (`ENGAGEMENT_CLAIM_LEASE_MS`); single-writer via
  conditional UPDATEs (two sequential atomic guarded updates: claimable
  statuses, then expired `executing` lease).
- Transient provider failures: deterministic backoff `attempt × 60s`,
  max 3 attempts, hold released between attempts (no double settle).
- Ambiguous outcomes: NEVER blind resend. Execution → `ambiguous` +
  `reconciliationState: needed`; the reconciler probes the provider by
  operation identity: `confirmed_success` → durable receipt (settlement is
  deterministically keyed — exactly one charge); `confirmed_absent` → full
  gated re-attempt; `unknown` → stays ambiguous for a later pass.
- Crash windows: disposition resolver (`resolveExecutionDisposition`) is a
  pure function of durable rows + clock — replay after receipt →
  `idempotent_replay`; crashed claim (expired lease, no receipt) →
  reconcile-before-resend; policy/approval staleness re-checked on every
  attempt.
- Boot sweeps: `runEngagementContinuationSweep` (dangling approved/rejected
  continuations) + `runEngagementReconciliationSweep` (ambiguous / due
  retries / expired leases), both fire-and-forget in `api/boot.ts`.

## 9. Immutable fields

`engagement_receipts`: ALL fields immutable after acceptance.
`engagement_response_contents`: ALL fields immutable after acceptance.
`engagement_executions`: identity fields (`executionId`,
`actionRequestId`, `signalId`, `signalVersion`, `interpretationId`,
`policyDecisionId`, `responseContentId`, `responseContentVersion`,
`provider`, `platform`, `actionType`, `integrationId`, `externalTarget`,
`businessId`, `userId`) are set at insert; working fields (`status`,
`attempt`, claims, `reconciliationState`, `failureClass`,
`providerOperationIdentity`, `billingReservationId`, `lastError`) transition
only through the execution engine's guarded paths.

## 10. Billing semantics

- Policy billing identity `bill_…` (R5-E) authorises the execution
  reservation: `credit_reservations.reservationReference = billingIdentity`
  (unique per user → double charge impossible). Settle only on confirmed
  external success (deterministic settle key
  `<billingIdentity>:settle`); release on transient/permanent failure and
  ambiguous outcomes (deterministic release key).
- Generation billing: `engen:<responseContentId>:v<version>` through the
  governed agent-runner keyed path — exact-once; replayed decisions reuse
  accepted content (no second model call, no second hold).
- Non-billable: DENY, ESCALATE, NO_ACTION, unsupported, blocked, rejected,
  expired/stale — these never reach the provider and carry
  `billingIdentity: null`. Approval-waiting actions hold no charge.

## 11. Risk / policy lineage

Every receipt carries the full lineage: `businessId`, `signalId`,
`interpretationId`, `actionRequestId`, `policyDecisionId`,
`approvalRequestId?`, `responseContentId/version`, `provider`,
`integrationId`, `externalTarget`, `providerOperationIdentity`,
`executedAt`. Risk class and reason codes live on the immutable R5-E
decision (consumed read-only). C derives policy intelligence only through
`deriveAuthoritativeIntelligence` (closed intent mapping, conservative
sentiment mapping, deterministic injection-marker scan on interpretation
evidence/explanation) — never reclassifies risk locally.

## 12. Fields R5-D may consume

`engagementReceiptId`, `executionId`, `actionRequestId`, `businessId`,
`signalId`, `signalVersion`, `interpretationId`, `policyDecisionId`,
`approvalRequestId?`, `actionType` (via execution), `platform`, `provider`,
`externalTarget`, `providerExternalReceipt`, `executedAt`, `status`,
`reconciliationState`, plus execution `failureClass`/`lastError` for
diagnosis. Gate: act only on `status = succeeded` receipts (or durable
`internal_only` routings for suppression analytics); treat
`recommendedHandling`/opportunity indicators from R5-B as the opportunity
hints — receipts are the engagement-effect evidence, NOT opportunity
scores. R5-D must not re-derive execution authority from receipt presence
alone for any new action — a new action requires a new governed R5-E
request.

## 13. Fields R6 may consume later

Everything in §12 plus: `responseContentId`/`responseContentVersion` +
content hash (for approved-content audit), `providerOperationIdentity`
(provider-side correlation), per-attempt telemetry
(`attempt`, `maxRetries`, `nextRetryAt`, timestamps), billing identities
(`billingIdentity` on decisions, `billingReservationId` on executions),
and ops-evidence projections (§C8 module) for capacity/conformance
reporting.

## 14. Fields downstream must not mutate

ALL receipt and response-content fields (immutable). Execution identity +
lineage fields (§9). Approval rows and policy decisions (R5-E-owned).
`social_signals` / `social_interpretations` (R5-A/B-owned, read-only
everywhere in C). Downstream metadata belongs in downstream-owned tables
keyed by `engagementReceiptId` / `actionRequestId`.

## 15. Sensitive-data restrictions

- Receipts, execution rows, audit events and approval/policy rows carry
  NO provider tokens/secrets, NO raw social content, NO reply text — only
  opaque ids, hashes, bounded external references (verified by C9.26).
- Provider tokens are decrypted only inside the execution boundary
  (`loadAccessToken`) and never logged or persisted downstream.
- `contentText` enters generation solely as delimited, length-capped
  untrusted quoted evidence (≤600 chars); nothing beyond the justified
  excerpt is retained. PII minimisation follows the frozen A/B contracts.
- Audit metadata passes the canonical sanitizer (token-like keys stripped);
  exactly one fingerprint-deduplicated `engagement_receipt` /
  `engagement_execution` audit event per material outcome.

## 16. Provider capability semantics

- The C capability matrix (`ENGAGEMENT_PROVIDER_CAPABILITIES`) is
  transport-grounded. The ONLY supported provider-capable action is
  `reply_publicly` on `facebook` and `instagram` (governed Meta comment
  reply seam with real Graph transport, env-gated OFF by default via
  `ENGAGEMENT_PROVIDER_TRANSPORT_ENABLED`; provider fakes in all tests).
- `reply_publicly` on linkedin/twitter/tiktok, `react` (all), and
  `reply_privately` (all) are UNSUPPORTED → `UNSUPPORTED_PROVIDER_CAPABILITY`,
  fail closed, no external attempt, non-billable. We do not pretend
  unsupported APIs exist.
- Divergence note: R5-E's policy capability map is a conservative
  policy-side pre-check listing more platforms; C's boundary is the final
  execution gate. Policy `ALLOW` means "may proceed if all
  provider/execution conditions hold" — the C boundary is one of those
  conditions.
- Binding authority: `resolveEngagementBinding` re-verifies owner,
  business, platform and `connected` status from the durable
  `social_integrations` row on every execution; drift/revocation/cross-
  business → fail closed.

## 17. Schema / migration dependencies

- C-owned migration artefact: `db/migrations/0030_engagement_execution_foundation.sql`
  (tables `engagement_response_contents`, `engagement_executions`,
  `engagement_receipts`). **Created, NOT executed.** Execution = FALSE.
- Journal: entry idx 29, tag `0030_engagement_execution_foundation`,
  snapshot `0029_snapshot.json` chains from 0028 (verified parity with
  `db/schema.ts`).
- Collision documented for R5-X: A (`0029_social_listening_foundation`),
  B (`0029_add_social_interpretations`) and E (`0029_sad_donald_blake`)
  hold provisional 0029s on their branches; C holds `0030_*`. C's
  `db/schema.ts` ALSO carries E's `business_policies`/`policy_decisions`
  and the `approval_requests.marketing_action` enum (vendored byte-identical
  from `c936caa` so the real engine runs on this branch); the corresponding
  DDL is deliberately NOT in C's 0030 SQL. R5-X owns final renumbering and
  must not execute any provisional migration until convergence.
- Reads against `social_signals` / `social_interpretations` use the
  name-based seam (`api/lib/engagement/source-loader.ts`) so this branch
  compiles pre-integration; at integration the drizzle-backed loader works
  unchanged.

## 18. Overlap-risk files

| File | Streams | Note for R5-X |
|---|---|---|
| `db/schema.ts` | A, B, E, C | C appends three tables after the vendored E block; union merge. |
| `db/migrations/` + `meta/_journal.json` | A, B, E(0029), C(0030) | X renumbers; C's snapshot chains 0028. |
| `api/router.ts` | E, C | C adds `engagement` below `policy`. |
| `api/approval-router.ts` | E (owner), C | C consumes vendored E version unchanged. |
| `api/lib/workflow/triggers.ts` | A (owner), C | C adds one `marketing_action` branch in `onApprovalResolved` before the campaign-scoped early return. |
| `api/boot.ts` | A, D, F, C | C adds two fire-and-forget sweeps beside the R4 sweep. |
| `api/lib/audit/audit-event.ts` | E, F, C | C appends `engagement_execution` + `engagement_receipt`. |
| `api/lib/env.ts` | D, C | C adds `engagementProviderTransportEnabled` (default OFF). |

## 19. Security invariants

1. No autonomous engagement executes without a valid R5-E policy
   authority (`assertMarketingActionExecutable` at execution time).
2. Client cannot self-authorise: the tRPC surface accepts only identities +
   action type + platform + binding id; risk/policy/approval/billing fields
   do not exist on it (E's contract also rejects smuggled fields).
3. Server-derived identities only (action request, response content,
   operation identity, receipt id) — deterministic, content-bound.
4. Strict tenant/business isolation: ownership re-verified from durable
   rows on plan, on every execution (binding) and on every router call;
   cross-business signals/interpretations/bindings fail closed.
5. Interpretation must match signal identity/version; policy decision must
   match the exact action request + policy version + context version.
6. Exact-once external effects: DB unique keys + claim lease; ambiguous
   outcomes are probed, never blindly resent; replay after receipt is a
   no-op.
7. Social text is untrusted input end-to-end: delimited/capped in
   generation, injection suspicion only raises risk (E floors), and no
   model output can alter action/policy/provider identity (identities are
   bound outside the model; structured output only + deterministic
   post-validation).
8. Approval-required decisions cannot execute early; stale approval/
   policy/context fail closed; rejection is permanent; duplicate callbacks
   converge.
9. Unsupported capabilities fail closed; unknown providers fail closed;
   provider/account ownership is authoritative.
10. No secrets/tokens/raw social content in receipts, audit, logs, or
    responses; billing identities are the only chargeable keys; denied/
    escalated/suppressed paths are non-billable.
