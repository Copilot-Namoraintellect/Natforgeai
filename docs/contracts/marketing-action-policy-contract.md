# MARKETING ACTION POLICY CONTRACT — WBS-R5 Stream E

> **Owner:** R5-E (Policy / Safety / Cost Control)
> **Branch:** `feature/r5-e-policy-safety-cost`
> **Status:** implemented with the E8 24-case acceptance suite (`api/policy-acceptance.test.ts`)
> **Consumers:** R5-C (autonomous engagement) initiates actions; R5-D (opportunity detection) recommends classifications. **R5-C must not redefine policy authority. R5-D may recommend an opportunity classification but may not bypass this policy when initiating any action.**

Required principle: **no autonomous marketing action may execute unless a
server-side policy decision explicitly authorizes it.**

---

## 1. Action request identity

Canonical shape: `api/lib/policy/action-request.ts` (`MarketingActionRequest`).

| Field | Type | Notes |
|---|---|---|
| `actionRequestId` | string `[A-Za-z0-9][A-Za-z0-9:_-]{0,127}` | Durable id for the logical action, supplied by the initiating system. |
| `businessId` | positive int | Owning business; ownership re-verified server-side on every call. |
| `sourceSignalId` | string ≤128 \| null | R5-A signal reference (opaque). |
| `sourceInterpretationId` | string ≤128 \| null | R5-B interpretation reference. |
| `actionType` | enum | See §2. |
| `platform` | enum | `facebook, instagram, linkedin, tiktok, twitter, whatsapp, email`. |
| `providerAccountBinding` | `{integrationId, platform, externalAccountRef?}` \| null | Required for provider-capable actions; verified server-side. |
| `campaignId`, `publicationId` | positive int \| null | Ownership-cross-checked server-side. |
| `estimatedCostClass` | enum | Caller-advisory only; the engine derives the authoritative class. |
| `requestedAt` | ISO 8601 | Explicit; never invented. |
| `contextVersion` | string ≤128 | Fingerprint of the content/context being acted on; pins approvals. |

Identity rules: the action-request fingerprint excludes `requestedAt` so a
retried logical action converges; the same `actionRequestId` with different
material identity is an `ACTION_REQUEST_IDENTITY_CONFLICT` (fail closed).
**The request carries no risk, decision, approval or billing fields — any
client-supplied such field is rejected (fail closed), never ignored.**

## 2. Supported action types

Closed vocabulary (`MARKETING_ACTION_TYPES`):

`observe_only`, `classify`, `reply_publicly`, `reply_privately`, `react`,
`escalate_to_human`, `create_opportunity_candidate`, `schedule_follow_up`,
`nurture_candidate`, `suppress_action`.

Provider-capable (require a verified binding): `reply_publicly`,
`reply_privately`, `react`, `nurture_candidate`. Billable (derived credits):
`reply_publicly` 1, `reply_privately` 1, `nurture_candidate` 5; all others 0.
No unsupported provider actions exist in this vocabulary; adding one is an
R5-E contract change.

## 3. Policy identity / versioning

`api/lib/policy/policy-model.ts` + `api/lib/policy/policy-store.ts`.

- `policyId = pol_<sha256("natforge-policy:" + businessId)[:16]>` —
  deterministic per business, stable across versions.
- `policyVersion = v<version>-<sha256(config)[:12]>` — any config change
  produces a new version string.
- Policy rows are immutable; `activatePolicyVersion` deactivates the old row
  and inserts the new one in one transaction (monotonic `version`).
- Missing policy is **fail closed** (`POLICY_MISSING` → DENY). A business
  opts in explicitly via `policy.adoptDefaultPolicy` / `policy.setPolicy`.
- The typed config (`BusinessPolicyConfig`) is the only configuration
  mechanism — no scripting. Validation enforces disjoint action lists,
  closed vocabularies, conservative caps and risk monotonicity.

## 4. Decision identity

`policyDecisionId = pdec_<sha256(v1 | actionRequestId | businessId |
policyVersion ?? "NO_POLICY" | actionType | platform | contextVersion |
sourceInterpretationId | intelligenceVersion)[:40]>`.

**One action request + one policy version → one stable decision identity.**
Retries and concurrent evaluations converge through the durable unique
`decisionScopeKey = <actionRequestId>|<policyVersion ?? "NO_POLICY">`;
a replay with conflicting material fails closed
(`DECISION_IDENTITY_CONFLICT`). A policy change produces a new decision id.

## 5. Decision vocabulary

Closed, exhaustive (`POLICY_DECISIONS`):

| Decision | Meaning |
|---|---|
| `ALLOW_AUTONOMOUS` | May execute without a human, within expiry, while the policy version is current. |
| `REQUIRE_APPROVAL` | Executes only after an explicit human approval bound to this exact decision. |
| `DENY` | Must not execute. Non-billable. |
| `ESCALATE` | Immediate human handling; creates operator-visible state; never machine-executable. |
| `NO_ACTION` | Durable suppression (`suppress_action`); non-billable. |

Autonomy rank: `ALLOW_AUTONOMOUS > REQUIRE_APPROVAL > ESCALATE > DENY`.

## 6. Risk tiers

`low < medium < high < critical` (`api/lib/policy/risk-classification.ts`).
Derived deterministically from authoritative intelligence features only —
never client-supplied:

- LOW: praise, routine engagement, basic factual questions.
- MEDIUM: product/service objections, nuanced questions, moderate complaints,
  uncertain intent, unknown classes (conservative), negative sentiment floor.
- HIGH: severe complaints, legal/compliance, privacy issues, payment
  disputes/refunds, personal-sensitive, urgent sentiment floor, personal-data
  floor, injection-suspected floor.
- CRITICAL: safety concerns, reputational crisis (immediate human handling).

Confidence below `minAutonomousConfidence` bumps one tier. **Invariant:
higher risk can only reduce autonomy** — enforced by monotone floor
composition (classification) and by policy validation
(`POLICY_RISK_MONOTONICITY_VIOLATION` on any widening mapping; critical may
only map to ESCALATE/DENY).

## 7. Reason codes

Closed vocabulary (`POLICY_REASON_CODES`, 40 codes): policy/mapping codes
(`ACTION_ALLOWED_BY_POLICY`, `ACTION_PROHIBITED_BY_POLICY`,
`ACTION_REQUIRES_APPROVAL_BY_POLICY`, `ACTION_DEFAULTED_TO_APPROVAL`,
`ACTION_DEFAULTED_TO_DENY`), fail-closed codes (`POLICY_MISSING`,
`UNKNOWN_ACTION_TYPE`, `ACTION_REQUEST_IDENTITY_CONFLICT`,
`INTELLIGENCE_BINDING_MISMATCH`, `OWNERSHIP_MISMATCH`), risk codes
(`APPROVAL_REQUIRED_BY_RISK`, `ESCALATED_BY_RISK`, `CRITICAL_RISK_ESCALATION`,
`CONFIDENCE_BELOW_AUTONOMY_MIN`, `INJECTION_SUSPECTED`), channel codes
(`CHANNEL_PROHIBITED_BY_POLICY`, `CHANNEL_NOT_IN_ALLOWED_LIST`,
`OUTSIDE_BUSINESS_HOURS`), cost codes (`BUDGET_INSUFFICIENT_BALANCE`,
`BUDGET_DAILY_SYSTEM_LIMIT`, `BUDGET_MONTHLY_SYSTEM_LIMIT`,
`BUDGET_WALLET_SPEND_LIMIT`, `BUDGET_AUTONOMOUS_DAILY_CAP`,
`COST_CLASS_EXCEEDS_POLICY_CAP`, `COST_CLASS_DECLARATION_MISMATCH`),
volume/rate codes (`QUOTA_DAILY_ACTION_CAP`, `QUOTA_CHANNEL_DAILY_CAP`,
`RATE_LIMIT_PROVIDER`), provider codes (`PROVIDER_BINDING_MISMATCH`,
`PROVIDER_CAPABILITY_UNAVAILABLE`), execution codes
(`SUPPRESSION_REQUESTED`, `NON_BILLABLE_ACTION`,
`ESCALATION_REQUIRES_OPERATOR`, `EXPIRED_DECISION`, `APPROVAL_NOT_FOUND`,
`APPROVAL_PENDING`, `ACTION_REJECTED_BY_HUMAN`, `STALE_POLICY_VERSION`,
`CONTEXT_VERSION_MISMATCH`, `APPROVAL_BINDING_MISMATCH`). Every code has an
operator-readable explanation in `POLICY_REASON_EXPLANATIONS`.

## 8. Approval requirements

- `REQUIRE_APPROVAL` carries an `approvalBinding` (decision id, policy
  version, context version, risk, cost class, billing identity, expiry) and
  produces one durable `approval_requests` row
  (`approvalType = "marketing_action"`, deterministic idempotency key
  `ma1:<sha256(contractVersion:decisionId)>` — one row per decision).
- Authorizing the approval (inside the existing transactional decision
  flow) is fail-closed on: missing decision, policy version drift
  (`STALE_POLICY_VERSION`), changed context (`CONTEXT_VERSION_MISMATCH`),
  expired binding. Edited approvals are never valid for marketing actions.
- Rejection permanently blocks the action identity
  (`ACTION_REJECTED_BY_HUMAN`, `permanent: true`); the only path forward is
  a new governed action request.
- `ESCALATE` creates the same durable row in `escalation` mode as the
  operator work queue; resolving it records the human outcome but never
  authorizes machine execution.

## 9. Budget / quota semantics

- Volume caps count **distinct governed action decisions** with an
  executable disposition (`ALLOW_AUTONOMOUS | REQUIRE_APPROVAL`) per UTC day
  / per channel, from the durable decision ledger (retries converge → cannot
  inflate caps).
- Autonomous spend cap sums derived credit estimates of `ALLOW_AUTONOMOUS`
  decisions per UTC day.
- Evaluation is never metered; a denied/suppressed/escalated action is
  non-billable (`billingIdentity: null`, `estimatedCredits: 0`).
- Approval-waiting actions carry no charge; the billing identity is consumed
  only at execution settlement time by the R4 billing authority.

## 10. Billing identity requirements

`billingIdentity = bill_<sha256(scope | actionRequestId | businessId |
actionType | platform | derivedCostClass)[:40]>` — deterministic, stable
across retries, null for non-billable actions, present only on executable
dispositions. One logical billable action → exactly one billing identity; the
downstream settlement MUST use it as the reservation reference (R4
`credit_reservations` unique `(userId, reservationReference)`) so double
charges are impossible. R5-E never deducts, settles or refunds.

## 11. Rate / volume limits

- Policy caps: `volume.maxActionsPerDay`, `volume.maxActionsPerChannelPerDay`
  (UTC day, from the decision ledger), `spend.maxAutonomousCreditsPerDay`,
  `spend.maxActionCredits`.
- Provider rate state (`RATE_LIMIT_PROVIDER`) is injected; in this stream it
  resolves to not-limited (no live provider invocations) and is the
  documented hook for the future provider-rate authority. Policy caps are
  fully enforced regardless.

## 12. Provider capability semantics

`resolveProviderCapabilitySnapshot` verifies, server-side, from durable
rows: binding exists, owner matches, business matches (or null), platform
matches, status `connected` → `bindingVerified`. A conservative fixed map
decides `capabilityAvailable` per (actionType, platform). Any failure denies
with `PROVIDER_BINDING_MISMATCH` / `PROVIDER_CAPABILITY_UNAVAILABLE`.

## 13. Expiry / staleness rules

- `ALLOW_AUTONOMOUS` and approval bindings expire
  `executionTtlMinutes` (default 15) after evaluation.
- Execution requires the active policy version to equal the decision's
  policy version (`STALE_POLICY_VERSION` otherwise) — for both autonomous
  and approval-authorized actions.
- Changed content context invalidates authorizations
  (`CONTEXT_VERSION_MISMATCH`).

## 14. Replay / idempotency

- Decision insert is the convergence anchor (unique scope key); replay →
  `idempotent_replay` with the identical durable row returned.
- Approval rows dedupe on the deterministic idempotency key.
- Audit events dedupe on the canonical fingerprint.
- Replayed requests with conflicting material fail closed
  (`DECISION_IDENTITY_CONFLICT`).

## 15. Audit requirements

Every accepted decision records exactly one canonical `policy_decision`
audit event (`audit_events`, fingerprint-deduplicated). Metadata: decision,
policy version, reason codes, risk class, gate outcomes, thresholds, billing
identity, opaque evidence references, evaluation fingerprint. Failures are
loud and retry-safe (R4 service-delegated pattern). Explainability:
`policy.explainDecision` answers why-allowed/denied/approval/escalated from
recorded facts — **no model chain-of-thought is persisted anywhere**.

## 16. Fields R5-C may consume

- From the decision: `policyDecisionId`, `decision`, `reasonCodes`,
  `riskClass`, `approvalRequired`, `approvalBinding`, `expiresAt`,
  `billingIdentity`, `estimatedCredits`, `costEligible`, `rateEligible`,
  `providerEligible`, `thresholds`, `actionRequestId`, `platform`,
  `campaignId`.
- `assertMarketingActionExecutable` (E6) is the **mandatory** pre-action
  gate; its `authorization` is the only execution authority.
- `policy.evaluateActionRequest` to obtain decisions; `policy.getDecision` /
  `explainDecision` for status.

## 17. Fields R5-D may consume

- `decision`, `riskClass`, `reasonCodes`, `sourceSignalId`,
  `sourceInterpretationId`, `actionRequestId` (read-only, for opportunity
  classification and for initiating a *new* governed action request).
- R5-D MUST NOT mutate any decision field, derive parallel risk authority,
  or initiate actions outside `policy.evaluateActionRequest`.

## 18. Fields downstream must not mutate

`policyDecisionId`, `policyVersion`, `decision`, `reasonCodes`, `riskClass`,
`approvalBinding`, `billingIdentity`, `evaluationFingerprint`,
`evaluatedAt`, `thresholds`. Decisions are immutable durable records; new
authority requires a new action request (new id or new policy version).

## 19. Sensitive-data restrictions

Decisions, audit metadata and approval bindings persist **no** raw social
content, message text, tokens, provider keys, PII or credentials — only
opaque references and fingerprints. The canonical WBS7A sanitizer strips
sensitive metadata keys as defence in depth (verified by acceptance case 24).
Social/intelligence content is inert data in the decision path: injection
suspicion can only raise risk, never widen authority (case 19).

## 20. Schema dependencies

- New tables `business_policies`, `policy_decisions` (migration
  `db/migrations/0029_sad_donald_blake.sql`, **created, not executed** — see
  `docs/recovery/r5-e-unexecuted-migrations.md`).
- `approval_requests.approvalType` gains `marketing_action` (same migration).
- Reads/writes elsewhere: existing `businesses`, `campaigns`,
  `publishing_queue`, `social_integrations`, `credit_wallets`, `ai_usage`,
  `credit_reservations`, `audit_events` (read-only or insert-only through
  existing authorities).

## 21. Overlap-risk files

| File | Risk | Handling |
|---|---|---|
| `api/approval-router.ts` | Shared approval decision flow | Additive fail-closed `marketing_action` hook only (no existing behaviour changed). |
| `api/lib/audit/audit-event.ts` | Shared event taxonomy | One additive enum value `policy_decision`. |
| `api/router.ts` | Router registry | One additive registration. |
| `db/schema.ts` | Shared schema | Two new tables + one enum extension (migration 0029). |
| `api/lib/engagement/*` | R5-C territory | Not modified; distinct approval type. |
| `api/policy-router.ts` | Owned by R5-E | New file. |

## 22. Security invariants

1. All decisions are made server-side; the client can only request
   evaluation (strict schema; authority fields rejected).
2. Fail closed: missing policy, unknown action, missing/unverified provider
   capability, ownership mismatch, stale policy, expired binding.
3. Risk can only reduce autonomy (monotone classification + policy
   validation).
4. Budget/quota/rate gates run inside every evaluation; no execution path
   skips them; denied/suppressed/escalated actions are non-billable.
5. Approval binds exactly one decision + policy version + context;
   rejection permanently blocks the action identity.
6. Retries/concurrent evaluations converge to one durable decision; no
   duplicate decisions, approvals, audits or charges.
7. Cross-tenant access fails closed (owner-scoped reads, re-verified
   ownership on every reference).
8. Every decision is auditable and explainable without chain-of-thought.
9. No hidden bypass: no force-approve, no client-settable decision/risk/
   approval/billing fields, no scripting.
10. Prompt-injection content can never alter policy; it can only raise risk.
11. No live provider, billing or production actions occur in this stream.
