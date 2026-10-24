# R5-C AUTONOMOUS ENGAGEMENT — C0 REPOSITORY / CONTRACT INVENTORY

> **Stream:** WBS-R5 Stream C — Autonomous Engagement
> **Branch:** `feature/r5-c-autonomous-engagement` (base `e4493a8`, R4 `FULL_AUTONOMY_V1_READY`)
> **Date:** 2026-10-24
> **Status:** C0 complete — foundation for C1–C9

---

## 1. Frozen upstream contracts consumed (read from branch refs, NOT merged)

| Stream | Branch | Frozen HEAD | Contract(s) |
|---|---|---|---|
| R5-A Social Listening | `feature/r5-a-social-listening` | `c9a930e` | `docs/contracts/social-listening-to-intelligence-contract.md`, `social-signal-contract.md` |
| R5-B Intent & Sentiment | `feature/r5-b-intent-sentiment` | `b939328` | `docs/contracts/intelligence-to-engagement-opportunity-contract.md`, `social-intelligence-contract.md` |
| R5-E Policy / Safety / Cost | `feature/r5-e-policy-safety-cost` | `c936caa` | `docs/contracts/marketing-action-policy-contract.md` |
| R5-F Operations Governance | `feature/r5-f-operations-governance` | `5800626` | `docs/contracts/marketing-operations-governance-contract.md` |

Consumption rule applied: byte-identical vendoring of the frozen R5-E policy
engine (see §7) so R5-C code calls the real `assertMarketingActionExecutable`
gate — no policy rule is re-created locally. R5-A / R5-B / R5-F are consumed as
contracts + fixture shapes only (their lib code is NOT vendored; their tables
are referenced by identity strings, never by import).

## 2. Reusable R4 modules

| Capability | Authority | Reuse |
|---|---|---|
| Approval decision flow | `api/approval-router.ts` (`executeApprovalDecision`, tx-guarded, one `approval_resolved` audit) | Consumed unchanged + R5-E's additive `marketing_action` hook (vendored). R5-C adds only a resume branch in `onApprovalResolved` + boot sweep (C4). |
| Approval continuation trigger | `api/lib/workflow/triggers.ts:507 onApprovalResolved`; `api/lib/workflow/approval-continuation.ts` boot sweep | C adds `marketing_action` branch → engagement executor. |
| Credit reservations (exact-once billing) | `api/lib/billing/credit-reservation*.ts`; unique `(userId, reservationReference)` | Execution settlement uses `authorization.billingIdentity` as `reservationReference` (per E contract §10). Generation billing reuses `runAgent` keyed path (`billingIdempotencyKey`). |
| Agent runner (structured model output) | `api/lib/agents/runner.ts` `runAgent` (zod `generateObject`, provider timeout, keyed reservation settle/release) | C2 response generation runs through it with a frozen zod schema → structured output only. |
| Audit ledger | `api/lib/audit/audit-event.ts` + `audit-store.ts` (fingerprint-dedup) | One `engagement_execution` audit event type (append-only); policy/receipt evidence lives in receipt rows + sanitized metadata. |
| Durable queue / retry / replay | `api/lib/queue/*` (deterministic job ids, terminal failure, replay claims) | Engagement execution uses DB-claim authority (same pattern as `tryClaimEvent`); BullMQ not required for the acceptance path. |
| Provider adapters | `api/lib/integrations/platforms.ts`, `api/lib/integrations/adapters/` | Publication-only. See §4 gaps. |
| Inbound engagement pipeline | `api/lib/engagement/inbound.ts` (Meta webhook → `conversation*`, claim lease, exact-once) | Proven claim/lease/reconcile pattern C6 reuses. Distinct concern (inbound vs outbound) — no shared state. |
| Rate limiting | `api/lib/rate-limiter.ts` | Available for future surfaces; policy caps are the authority for action volume (E §9). |

## 3. Existing engagement execution paths

- **Inbound only.** `engagement/inbound.ts` ingests Meta webhooks (comments/messages), claims durable rows in `engagement_webhook_events`, and routes to `handleNewMessage` → `conversation*` tables + `engagement-agent.generateReply` (AI draft, DB-persisted, billing identity `engagement-reply:<dedupKey>`).
- **Human approval for sensitive replies exists but dead-ends:** `sensitive-reply-approval*.ts` builds/inserts `sensitive_reply` approvals; `onApprovalResolved` has **no branch for them** — approving resumes nothing. No outbound sender exists.
- `conversationRouter.aiReply` is DB-only (records an AI message row; never sends).

## 4. Missing external-response authority (the R5-C gap)

1. **No outbound reply/comment/reaction sender** for Facebook / Instagram / LinkedIn / Twitter anywhere in R4. Only `sendWhatsAppMessage` (unused, unbound) and one-way `publishTo*` post functions exist.
2. **No provider capability matrix** — adapters are hardcoded publication-only; capability per (action, platform) is greenfield (C5).
3. **No governed response-generation authority** bound to interpretation + policy (C2).
4. **No exact-once outbound execution / receipt durability** (C6/C7).
5. **No policy gate consumption** — nothing calls `assertMarketingActionExecutable` (E froze after C's base; vendored, see §7).
6. `social_integrations` has **no unique key** for the engagement target (lookup by `pageId` only); R5-C re-verifies ownership from the durable row instead of trusting any client binding.

## 5. Provider capability findings (repository-grounded)

| Action × Platform | R4 seam | R5-C verdict |
|---|---|---|
| `reply_publicly` × facebook / instagram | none (C builds governed comment-reply seam, fake-backed) | **supported via C seam** |
| `reply_publicly` × linkedin / twitter / tiktok | none | **unsupported → fail closed** |
| `reply_privately` × any | `sendWhatsAppMessage` exists but no whatsapp engagement binding/24h-window authority | **unsupported → fail closed** |
| `react` × any | none | **unsupported → fail closed** |
| `escalate_to_human` / `no_action` | n/a (non-provider) | supported (durable routing only, no external effect) |

Divergence note: R5-E's policy capability map is a conservative fixed pre-check
(`reply_publicly` listed for li/tw/tt). R5-C's execution boundary is the final,
transport-grounded check: policy `ALLOW` means "may proceed if all
provider/execution conditions hold" (E contract §5) — C's boundary is one of
those conditions. Unsupported pairs never reach a provider call.

## 6. Schema needs (→ migration `0030_engagement_execution_foundation`, artefact only, NOT executed)

Next free number per frozen A/B/E contracts ("next migration is `0030_*`;
never renumber 0029"). Three minimal tables (C7 receipt fields + C6 execution
claims + C2 immutable response content):

- `engagement_response_contents` — responseContentId/version unique, contentHash, businessId, userId, actionRequestId, interpretationId, platform, bounded content, model/tokens, billingIdentity, status, createdAt. Immutable.
- `engagement_executions` — executionId, actionRequestId (unique), businessId, userId, signalId, interpretationId, policyDecisionId, approvalRequestId?, responseContentId/version, provider, integrationId, externalTarget, status, attempt, providerOperationIdentity (unique), claim lease columns, reconciliationState, error, timestamps.
- `engagement_receipts` — engagementReceiptId, executionId (unique), providerOperationIdentity (unique), + full mission C7 field set (businessId, signalId, interpretationId, actionRequestId, policyDecisionId, approvalId, responseContentId/version, provider, integrationId, externalTarget, providerExternalReceipt, executedAt, status, reconciliationState, createdAt). Immutable once accepted.

No enum extensions needed (response generation reuses `agentType "engagement"`).
R5-X collision note: A/B/E each hold a provisional `0029_*`; C holds `0030_*`.
X owns final sequencing; C executed nothing.

## 7. Frozen R5-E consumption (vendored byte-identical from `c936caa`)

R5-C must not re-create policy rules, and C9 must exercise the real policy
engine deterministically. Sanctioned mechanism: **byte-identical vendor** of the
frozen E surface (no git merge; identities preserved exactly; git treats
identical adds as clean no-op at X integration when E merges first).

| Vendored path | Source @ c936caa |
|---|---|
| `api/lib/policy/*.ts` (11 modules: action-request, policy-types, decision-engine, marketing-action-approval, policy-model, policy-store, policy-decision-store, risk-classification, cost-governance, policy-authority-resolver, policy-audit) | identical |
| `api/policy-router.ts` | identical |
| `db/schema.ts` (businessPolicies + policyDecisions + `approval_requests.approvalType` += `marketing_action`) | identical |
| `api/lib/audit/audit-event.ts` (`policy_decision` event type) | identical |
| `api/approval-router.ts` (additive `marketing_action` fail-closed hook) | identical |
| `api/router.ts` (`policy` registration) | identical |

NOT vendored: E's migration artefact (`0029_sad_donald_blake.sql`, E-owned),
E's test suite (E-owned). C's acceptance builds its own harness over the real
engine.

## 8. Overlap-risk files (for R5-X)

| File | Streams | Handling |
|---|---|---|
| `db/schema.ts` | A, B, E, C | C appends three tables after vendored E block; union merge. |
| `db/migrations/` + `meta/_journal.json` | A, B, E(0029), C(0030) | X renumbers; C chained idx 29←0028 snapshot. |
| `api/router.ts` | E, C | C adds `engagement` registration below `policy`. |
| `api/approval-router.ts` | E, C | C consumes vendored E version unchanged. |
| `api/lib/workflow/triggers.ts` | A (owner), C | C adds one `marketing_action` branch in `onApprovalResolved` (additive). |
| `api/boot.ts` | A, D, F, C | C adds engagement continuation sweep beside existing sweep. |
| `api/lib/audit/audit-event.ts` | E, F, C | C appends `engagement_execution` + `engagement_receipt` types. |

## 9. Security risks identified up front

- Prompt injection via social text → mitigation: social text enters the model prompt only as delimited untrusted quoted evidence; output is zod-bounded; policy independently floors risk (`INJECTION_SUSPECTED`); no model output can alter action/policy/provider identity (identities are server-derived before generation).
- Forged signal/interpretation/binding ids → server-side ownership re-verification against durable rows before execution; cross-business fails closed.
- Duplicate/concurrent execution → DB unique keys (`actionRequestId` on executions, `providerOperationIdentity` on receipts) + claim lease; no in-memory dedupe.
- Crash windows → disposition resolver before provider call (receipt exists → replay; expired claim + no receipt → reconcile via provider probe; never blind resend on ambiguous).
- Stale authority → `assertMarketingActionExecutable` re-run at execution time with current policy version + approval binding (E gate).
- Secrets → receipts/audit/metadata carry opaque ids + bounded references only; sanitizer strips token-like keys; provider tokens never leave the integration store.
- PII → content bounded (platform max), receipts carry hashes/ids, no raw social text in receipts or audit.

## 10. Test infrastructure plan

- `vitest` (node env, no global setup). Fake drizzle DB pattern: table-name via `Symbol.for("drizzle:Name")`, `queryChunks` walking, `ER_DUP_ENTRY` on unique keys (same as E8/B acceptance harnesses).
- Provider gateway = deps-injected seam; tests install a scripted fake (success / transient / ambiguous / timeout / ownership drift).
- Model runner mocked at `runAgent` for generation proofs; real zod schema enforcement retained.
- Targeted: C-owned suites. Regressions: approval-router, audit, triggers, policy (vendored, run as-is), inbound, governance suites. Full `npm test`, `npm run check`, `npm run build`.
