# R5-E Policy / Safety / Cost Control — E0 Governance Inventory

> **Stream:** WBS-R5 Stream E (Policy / Safety / Cost Control)
> **Branch:** `feature/r5-e-policy-safety-cost`
> **Base:** `e4493a8` (R4 X8 FULL_AUTONOMY_V1_READY)
> **Date:** 2026-06-28
> **Scope:** Inventory only. No code changes in this slice.

---

## 1. Mission boundary

R5-E owns **decision policy** for autonomous marketing actions triggered by
social/marketing intelligence. It does **not** own social ingestion (R5-A),
intent/sentiment interpretation (R5-B), engagement execution (R5-C),
opportunity detection (R5-D), or provider publishing (R4 distribution).

Required principle (programme): **no autonomous marketing action may execute
unless a server-side policy decision explicitly authorizes it.**

---

## 2. R4 authority inventory (reusable)

### 2.1 Governance / operator control plane

| Authority | Location | Reuse for R5-E |
|---|---|---|
| Admin/operator gating (`adminQuery`, OTP/2FA-verified sessions) | `api/middleware.ts` | Operator surface for policy decisions / escalation queue. |
| Admin mutation audit (`recordAdminMutationAudit`, closed vocab, fail-closed actor) | `api/lib/governance/admin-audit.ts` | Pattern for policy-management audit; actor never invented. |
| Lifecycle projection (deterministic, read-only, explicit clock) | `api/lib/governance/lifecycle-projection.ts` | Pattern: pure derivation, no second state machine, explicit clock injection. |
| Blocker/recoverability vocabulary | `deriveLifecycleBlocker` | Operator-visible blocker pattern for policy denials/escalations. |
| Forbidden-action list (no force-approve, no state setters) | `docs/GOVERNANCE_AND_OPERATOR_CONTRACT.md` §6 | R5-E must not add generic force-approve; rejections are permanent per action identity. |

### 2.2 Approval authority

| Authority | Location | Reuse for R5-E |
|---|---|---|
| Approval request store (`approval_requests`: pending/approved/rejected/edited, idempotency key, JSON context lineage) | `db/schema.ts:721` | Durable `marketing_action` approval binding for REQUIRE_APPROVAL decisions. |
| Transactional single-winner decision (`executeApprovalDecision`, guarded UPDATE + affectedRows, same-tx audit) | `api/approval-router.ts` | Approval decisions are atomic and never fabricated. |
| Stale-approval invalidation (strategy/launch lineage binding; budget-increase ↔ cost-pause binding) | `api/approval-router.ts` `validate*Lineage` | Pattern for binding approval to exact action request + policy version + context fingerprint. |
| Deterministic approval command builder (idempotency from event dedupKey, no raw provider key leakage) | `api/lib/engagement/sensitive-reply-approval.ts` | Direct template for `buildMarketingActionApprovalRequest`. |
| Sensitive-reply approval store | `api/lib/engagement/sensitive-reply-approval-store.ts` | Pattern for durable approval persistence. |

### 2.3 Cost / billing authority

| Authority | Location | Reuse for R5-E |
|---|---|---|
| Credit engine (`checkCredits`, `deductCredits`, `recordAiUsage`) | `api/lib/billing/credit-engine.ts` | Cost eligibility reads wallet/spend; charging stays in the billing engine (R5-E never charges). |
| Cost control (`enforceCostControl`: balance + daily/monthly system limits; `pauseWorkflowForCostLimit` with approval dedup) | `api/lib/billing/cost-control.ts` | Affordability pattern; budget-exhausted → not cost eligible. |
| Reservation state machine (reserved→settled|released, deterministic sha256 identity, idempotent replay, fail-closed conflicts) | `api/lib/billing/credit-reservation.ts` + `-store.ts` | Billing identity + reservation semantics for billable actions; retries preserve identity. |
| Credit wallet / spend limits (`credit_wallets.spendLimit`, daily/monthly allocations) | `db/schema.ts:1274` | Per-user spend ceiling consulted by policy. |
| Tiered rate limits (`TIER_RATE_LIMITS`, redis/in-memory windows) | `api/lib/rate-limiter.ts` | Provider/IP rate limiting pattern; policy adds per-business action caps. |
| System settings (`daily_ai_credit_limit`, `monthly_ai_credit_limit`) | `api/lib/system-settings.ts` | Server-side tunable limits pattern. |
| Exact-once financial acceptance | `api/lib/billing/exact-once-financial-acceptance.test.ts` | Billing identity/dedup acceptance precedent. |

### 2.4 Safety / content controls

| Authority | Location | Reuse for R5-E |
|---|---|---|
| AI content safety check (`checkContentSafety`, brand tone/industry context, billing-aware) | `api/lib/safety/checker.ts` | R5-E does **not** call this for policy decisions (non-deterministic + provider cost); policy risk classification is deterministic from authoritative intelligence features. Safety checker remains downstream. |
| Publishing queue safety gate (`safetyStatus`, `safety_blocked`) | `db/schema.ts:830` | Precedent: safety is a first-class gate, not metadata. |
| Sensitive-reply escalation (sentiment→risk derivation, escalate-to-human flow) | `api/lib/engagement/` | Risk derivation precedent; R5-E generalizes to a governed risk-tier model. |

### 2.5 Audit / explainability

| Authority | Location | Reuse for R5-E |
|---|---|---|
| Canonical audit envelope (`createAuditEvent`: closed vocab, explicit occurredAt, sanitized metadata, deterministic fingerprint) | `api/lib/audit/audit-event.ts` | `policy_decision` audit events; reason codes + thresholds in sanitized metadata. |
| Durable dedup store (`persistAuditEvent`, fingerprint-unique ledger) | `api/lib/audit/audit-store.ts` | Decision audit persistence. |
| Audit ledger schema (`audit_events`, searchable correlation columns) | `db/schema.ts:1588` | Policy decisions joinable by campaign/business/approval id. |

### 2.6 Tenant isolation / authN-Z

| Authority | Location | Reuse for R5-E |
|---|---|---|
| JWT session + user lookup (`createContext`) | `api/context.ts` | Server-side identity for policy API. |
| Owner-scoped mutations (`and(eq(id), eq(userId))` inline on every user mutation) | throughout routers | Strict business/user isolation for policy reads/writes. |
| Fail-closed authorization regressions | `api/governance-acceptance.test.ts` | Fake-DB adversarial harness pattern (vi.mock connection, in-memory drizzle). |

---

## 3. Existing engagement-related logic (overlap risk)

| Area | Files | Overlap risk / boundary |
|---|---|---|
| Inbound webhook pipeline (ingestion, dedup, claim, escalation flag) | `api/lib/engagement/inbound.ts`, `engagementWebhookEvents` | R5-A/R5-C territory. R5-E consumes *authoritative intelligence references* only; never re-ingests. |
| Conversation threads/messages | `conversationThreads`, `conversationMessages` (`db/schema.ts:1089`) | R5-C owns replies. R5-E decisions reference threads, never mutate. |
| Social engagement events / interest signals | `socialEngagementEvents`, `campaignInterestSignals` | R5-A/R5-B raw material. R5-E must not derive its own interpretation. |
| Sensitive-reply approvals | `api/lib/engagement/sensitive-reply-approval*.ts` | Distinct approval type (`sensitive_reply` vs `marketing_action`); shared approval infrastructure, separate lineage validators. |
| Approval router decision flow | `api/approval-router.ts` | R5-E adds a `marketing_action` binding validator hook. Overlap-risk file — keep the hook additive and fail-closed. |
| Publishing / distribution | `api/publishing-router.ts`, `api/lib/publish/*` | R4 authority. R5-E never publishes. |
| Learning / next-cycle | `api/learning-router.ts`, `learningRecords` | Adjacent governance; no direct overlap. |

---

## 4. Missing policy concepts (to build in R5-E)

1. **Canonical marketing action request** — no typed action-request identity exists anywhere in R4.
2. **Versioned business policy authority** — no per-business policy configuration store; only global system settings exist.
3. **Policy decision engine** — no centralized allow/approve/deny/escalate evaluation; R4 gates are per-feature (publishing, workflow, billing).
4. **Governed risk tiers** — risk levels exist only as approval `riskLevel` (low/medium/high) and safety check output; no tier semantics tied to autonomy reduction.
5. **Cost eligibility vs charging** — R4 checks affordability inside features; no policy-level `costEligible` decision separating *eligibility* from *settlement*.
6. **Approval bound to action+policy version** — existing bindings are strategy/launch/budget-specific; no generic action-identity binding.
7. **Action volume caps** — tier rate limits exist per endpoint class; no per-business daily/per-channel action caps for autonomous actions.
8. **Provider capability gating for engagement actions** — `socialIntegrations` tracks connected status but no capability model per action type.
9. **Policy decision audit + explainability** — no "why was this allowed/denied" durable record.
10. **Prompt-injection resistance in decision path** — no explicit rule that social content is data, never instructions.

---

## 5. Action classes (E1 proposal, from mission + repo authority)

| Action type | Billable | Notes |
|---|---|---|
| `observe_only` | no | Recording/monitoring only. |
| `classify` | no | Internal interpretation bookkeeping (R5-B derived). |
| `reply_publicly` | yes (low) | Public comment/reply. Highest abuse/injection risk → conservative autonomy. |
| `reply_privately` | yes (low) | DM/message reply. Privacy-sensitive escalation class. |
| `react` | no | Lightweight engagement (like/emoji). |
| `escalate_to_human` | no | Creates operator-visible state; never billable. |
| `create_opportunity_candidate` | no | Hands off to R5-D candidate pipeline (no lead creation here). |
| `schedule_follow_up` | no | Deferred action scheduling. |
| `nurture_candidate` | yes (standard) | Sequence-style nurturing; bounded volume. |
| `suppress_action` | no | Explicit no-op suppression with durable decision. |

No unsupported provider actions are included merely for completeness
(e.g. no ad-spend, no publishing — those remain R4/distribution authority).

---

## 6. Cost boundaries

- R5-E **evaluates** cost eligibility (balance, daily/monthly system limits,
  spend limit, per-period autonomous spend cap, reservation state).
- R5-E **never** deducts, settles, refunds, or re-prices. Charging remains in
  `credit-engine`/`cost-control` under R4 authority.
- Billing identity: one logical billable action → one deterministic billing
  identity derived from the action request identity; retries reuse it.
- Denied/suppressed/escalated actions are non-billable by construction
  (`costEligible=false` and `estimatedCostClass=none` settlement path).

---

## 7. Security gaps closed by this stream

| Gap | Control |
|---|---|
| Any future autonomous engagement could self-authorize | Server-side decision engine; client can request evaluation but never set decision/risk/approval. |
| Missing/unknown policy could default to allow | Fail closed: DENY with `POLICY_MISSING` / `UNKNOWN_ACTION_TYPE`. |
| Risk could be client-supplied | Risk derived only from authoritative intelligence features (server-resolved); forged risk input rejected. |
| Approval could be replayed across policy versions | Approval binding includes policy version + context fingerprint; stale binding fails closed. |
| Social prompt injection could drive actions | Intelligence content treated as inert data; injection-suspect content raises risk floor and can never widen autonomy. |
| Cross-tenant policy reuse | Policy and decisions keyed by businessId; ownership re-verified server-side on every reference. |
| Duplicate/concurrent evaluation divergence | Deterministic decision identity per (actionRequestId, policyVersion); durable unique insert; replay converges. |
| Budget/quota bypass | Eligibility evaluated inside the same decision; no execution path exists that skips it. |
| Sensitive data in audit | Reason codes + references only; raw social text, tokens, PII never persisted in decision/audit records. |

---

## 8. Schema implications

Minimal additions (migration artefacts created, **not executed**):

1. `business_policies` — versioned typed policy configuration per business
   (content-addressed `policyVersion`, immutable rows, active pointer).
2. `policy_decisions` — durable, immutable policy decisions (deterministic
   `policyDecisionId`, unique per action request + policy version).
3. `approval_requests.approvalType` enum gains `marketing_action`.

Journal parity: next canonical number is `0029` (29 entries, idx 0–28 in
`db/migrations/meta/_journal.json`).

---

## 9. Slice plan (E1–E8)

| Slice | Deliverable |
|---|---|
| E1 | `api/lib/policy/action-request.ts` — canonical action contract |
| E2 | `api/lib/policy/policy-model.ts` — versioned typed policy + conservative defaults |
| E3 | `api/lib/policy/decision-engine.ts` — deterministic evaluation core |
| E4 | `api/lib/policy/risk-classification.ts` — LOW/MEDIUM/HIGH/CRITICAL tiers |
| E5 | `api/lib/policy/cost-governance.ts` — cost/quota/rate eligibility |
| E6 | `api/lib/policy/marketing-action-approval.ts` + approval-router hook |
| Schema | `db/schema.ts` tables + `0029` migration artefact (unexecuted) |
| E7 | decision store + audit events + explainability |
| E8 | `api/policy-acceptance.test.ts` — 24-case deterministic acceptance |
| Handoff | `docs/contracts/marketing-action-policy-contract.md` |

---

## 10. Verdict

Existing R4 authority (approval atomicity, reservation identity, audit
sanitization, fail-closed governance, fake-DB test harness) is directly
reusable. The missing concepts are policy-specific and additive. No overlap
requires modifying another stream's behaviour except one additive,
fail-closed hook in `api/approval-router.ts`.
