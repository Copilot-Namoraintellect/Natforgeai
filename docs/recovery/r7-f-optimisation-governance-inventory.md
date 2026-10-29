# R7-F OPTIMISATION GOVERNANCE — GOVERNANCE INVENTORY (F0)

> **Stream:** WBS-R7 Stream F — Business Optimisation Governance
> **Branch:** `feature/r7-f-optimisation-governance` (base `8030e97`)
> **Date:** 2026-11-05
> **Purpose:** identify reusable governed authority before building anything.
> Rule applied throughout: **extend an existing governed primitive; never
> build a competing policy engine.**

---

## 1. Verdict

The repository already contains a complete, battle-tested governance stack
spanning R4 (financial reliability), R5 (marketing policy/safety/cost) and R6
(lead autonomy). R7-F builds **one new governed kernel**
(`api/lib/optimisation-governance/`) that mirrors the proven pure-engine +
durable-store + approval-ledger + audit-ledger shape, and **reuses** the
approval ledger, the audit ledger and the R4 billing/cost authorities as-is.
No existing authority is mutated, shadowed or forked.

What R7-F deliberately does **not** reuse: the R5-E marketing-action decision
vocabulary and the R6 qualification engine internals. Those are different
domains (social engagement actions; lead qualification) with frozen contracts.
R7-F copies their *architecture*, not their *authority*.

---

## 2. Inventory by programme

### 2.1 R4 — Financial reliability (`api/lib/billing/`, `api/approval-router.ts`)

| Primitive | Location | Reusable for R7-F |
|---|---|---|
| Credit wallet / ledger | `credit-engine.ts`, `cost-control.ts`, `cost-tracker.ts`, `middleware.ts` | **Read-only reference.** R7-F never charges; the billing authority remains the only settling authority. Governance consumes a server-resolved *budget authority snapshot*, never mutates wallets. |
| Credit reservation engine | `credit-reservation-engine.ts`, `credit-reservation-store.ts`, `stale-reservation-reaper.ts` | Model for reserved/locked funds semantics. F3/F6 treat reservation-held amounts as immovable; the reaper's staleness concept informs `staleBudgetState` blocking. |
| Approval ledger (origin) | `approval_requests` (`db/schema.ts:722`), `api/approval-router.ts` | **Reused directly.** Durable rows with `approvalType`, `riskLevel`, `status`, unique `idempotencyKey`, JSON `context` binding. R6-D already extended the enum with `sales_handoff`; R7-F extends it with `optimisation_action` (provisional migration, unexecuted). |
| Existing approval types | `campaign_launch`, `budget_increase`, `ad_spend`, `shutdown`, `strategy_review`, ... | Prove the pattern "high-impact financial action ⇒ human approval row". F4 follows it exactly, adding fingerprint-bound context. |
| Learning promotion (WBS15.6) | `api/lib/learning/promotion/` (`promotion-contract.ts`, `promotion-service.ts`, `promotion-decision.ts`, `promotion-envelope.ts`) | **Closest in-repo analog to R7-F proposals.** Proposal → fingerprint-bound `approval_requests` row → Approval Centre decision flow seals an approved envelope. R7-F mirrors this binding discipline (exact proposal coordinates + policy version + evidence snapshot + expiry) and generalises it beyond learning promotions. |
| Business DNA governance | `api/lib/business-dna-governance.ts`, `business-dna-store.ts` | Readiness-gate + immutable snapshot pattern. Informs R7-F evidence-hash/version binding on decisions. |

### 2.2 R5 — Marketing policy / safety / cost (`api/lib/policy/`, R5-F ops)

| Primitive | Location | Reusable for R7-F |
|---|---|---|
| Action request contract | `policy/action-request.ts` | Template for `OptimisationProposal`: closed vocabularies, deterministic fingerprint, **rejection of client-supplied authority fields** (`riskClass`, `decision`, `approved`, `policyVersion`, …). F7 hardening copied verbatim in spirit. |
| Policy model | `policy/policy-model.ts` | Template for the R7-F policy object: closed validated data shape, conservative fail-closed default, content hash, version string `v<n>-<hash12>`. R7-F uses a code-level versioned registry (like R6-C `qualification-policy.ts`) — no runtime mutation endpoint exists. |
| Decision engine | `policy/decision-engine.ts` | Template for the pure evaluation core: fail-closed pre-checks, deterministic decision identity, reason-code accumulation, approval binding, expiry. |
| Cost governance | `policy/cost-governance.ts` | Template for financial eligibility evaluation: decides eligibility, never charges; injected authority snapshots; deterministic billing identity. F3 lifts this "evaluate, never settle" rule. |
| Marketing-action approval | `policy/marketing-action-approval.ts` | Template for F4: binding pinned to decision + policy version + context fingerprint; `assertMarketingActionExecutable` gate; rejection permanently blocks the action identity. |
| Blocker taxonomy | `api/lib/governance/r5-blocker-taxonomy.ts` | Template for F8: recovery classes (`AUTO_RECOVER / OPERATOR_ACTION / FAIL_CLOSED / GOVERNANCE_APPROVAL`), health impacts, normative rule "automatic recovery is never invented for human-decision conditions". |
| Operations projection | `api/lib/governance/r5-operations-projection.ts`, `r5-operations-summary.ts` | Template for F8 read-only projection. |
| Policy store + decisions store | `policy/policy-store.ts`, `policy-decision-store.ts`, `db/schema.ts` (`business_policies`, `policy_decisions`) | Schema conventions for the new `optimisation_governance_decisions` table: deterministic id, `decisionScopeKey` unique convergence anchor, insert-only, threshold snapshots. |
| Audit ledger | `api/lib/audit/audit-event.ts`, `audit-store.ts` (`audit_events`, `db/schema.ts:1596`) | **Reused directly.** Canonical envelope, `eventFingerprint` unique, exact-once persistence, structural executor seam. R7-F emits exactly one audit event per inserted decision and per material governance event. |

### 2.3 R6 — Lead autonomy (`api/lib/qualification/`, `lead-identity/`, `scoring/`, `nurture/`, `conversion/`, governance)

| Primitive | Location | Reusable for R7-F |
|---|---|---|
| Service/store/executor seam | `qualification/qualification-service.ts`, `qualification-store.ts`, `qualification-bridge.ts` | Template for R7-F store: structural `select/insert/update` executor, local predicate descriptors translated to Drizzle by the bridge, in-memory fake in tests, guarded `information_schema` availability probe that fails closed when tables are absent (mandatory while the migration is unexecuted). |
| Code-level policy registry | `qualification/qualification-policy.ts` | **Reused as the policy mechanism for R7-F** (§3 below): versioned, immutable per version, no runtime mutation, conservative default, `UNKNOWN_POLICY_VERSION` fails closed. |
| Independent human review (OTP) | `qualification/qualification-review-authority.ts` | Evidence that out-of-band human proof exists. F4 requires human approval for threshold-crossing financial actions; R7-F *could* bind OTP for high-impact approvals in a later slice — for V1 the existing approval-row + context-binding discipline is reused unchanged; no new OTP consumer is introduced. |
| Sales-handoff approvals | `nurture/` + `approvalType = "sales_handoff"` | Precedent for extending `approval_requests.approvalType` via a stream migration (R6-D's accepted enum extension lives in canonical 0034). R7-F adds `optimisation_action` the same way, provisionally. |
| Lead governance recovery | `lead-governance-router.ts`, `lead-governance-router-recovery.test.ts`, `governance/lead-blocker-taxonomy.ts` | Template for F8 narrow recovery: recovery constrained to exact known-safe transitions, audited, no `forceAllow`/`setApproved` style escape hatches. |
| Conversion monetary truth | `conversion/` (`conversion_events.amount`, signed minor units) | Confirms repository monetary convention: **integer minor units**. R7-F financial impact uses integer minor units end-to-end. |

### 2.4 Cross-cutting

| Area | Finding |
|---|---|
| Money representation | Integer minor units (cents), signed where reversible — R6-E convention adopted. |
| Deterministic identity | `<prefix>1:<sha256>` over canonicalised coordinates — adopted (`ogd1:` decisions). |
| Immutability | Decision tables are insert-only; corrections are new decisions. |
| Exact-once | Unique convergence anchors + duplicate-key convergence to `idempotent_replay`. |
| Tenant isolation | `userId` predicates every query; identity hashes embed the tenant; cross-tenant reads are indistinguishable from absent. |
| Audit | One canonical event per material mutation; fingerprint-deduped; occurredAt preserved verbatim. |
| Testing | Vitest; pure-module unit tests + service tests over in-memory executor fakes; no live DB required for acceptance. |

---

## 3. Reuse decisions (what R7-F builds vs extends)

**Extended (no new engine):**
1. `approval_requests` ledger — new `approvalType = "optimisation_action"` (provisional enum extension, unexecuted; canonicalised later by R7-X).
2. `audit_events` ledger — used exactly as-is.
3. Code-level versioned policy registry pattern (R6-C mechanism) for the optimisation policy — no per-business policy mutation endpoint; policy versions are code artefacts.
4. R4 billing/cost authorities — read-only reference; R7-F never settles.

**Newly built (R7-F owned, in `api/lib/optimisation-governance/`):**
- `optimisation-governance-contract.ts` — closed vocabularies, proposal/decision identity, error taxonomy, zod input schemas.
- `optimisation-action-taxonomy.ts` — F2 closed optimisation action types.
- `optimisation-policy.ts` — versioned policy registry (financial ceilings, experiment constraints, portfolio limits, risk mapping).
- `optimisation-financial-governance.ts` — F3 financial classification + guardrails.
- `optimisation-experiment-governance.ts` — F5 experiment constraint checks.
- `optimisation-portfolio-governance.ts` — F6 concentration/shift/oscillation/locked-fund checks.
- `optimisation-decision-engine.ts` — pure governance evaluation (target flow core).
- `optimisation-approval.ts` — F4 approval binding + execution-eligibility gate.
- `optimisation-governance-store.ts` / `-bridge.ts` / `-service.ts` — durable persistence, production executor binding, orchestration.
- `optimisation-blocker-taxonomy.ts` / `optimisation-operations-projection.ts` — F8 blocker taxonomy + read-only projection + narrow audited recovery.
- `api/optimisation-governance-router.ts` — authed tRPC surface.

**Explicitly NOT owned (per mission):** attribution, learning, experiment
result computation, treatment assignment, budget optimisation algorithm,
strategy generation, campaign creation, conversion authority, lead authority,
payment execution, billing, provider execution. Governance authorizes or
prohibits; it never becomes the optimisation engine.

---

## 4. Gaps / non-goals surfaced for R7-X

- `approval_requests.approvalType` enum extension and the new decisions table
  converge at R7-X (same pattern as R6's `0034` collision; R7-X owns final
  sequencing — see `docs/recovery/r7-f-unexecuted-migrations.md` when created).
- Real-MySQL concurrency execution remains deferred to pre-production
  acceptance (R6-X precedent): schema anchors are structurally verified;
  deterministic in-memory concurrency is green.
- No OTP binding for optimisation approvals in V1 (approval-row discipline
  reused). If policy later demands independent human proof for financial
  approvals, the R6-C OTP primitive is the integration point.
