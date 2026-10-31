# R9-F — Mission Governance & Approval Inventory (F0)

> Stream: `feature/r9-f-mission-governance` · Programme base `4fc43c3b` ·
> Frozen upstream: R8 Strategic Intelligence (`STRATEGIC_INTELLIGENCE_V1_READY`,
> HEAD `4fc43c3b252baa81906cd409ca2ec290baa77825`).
> Date: 2026-11-10. Status: governance inventory — determines reusable
> primitives before any R9-F code.

## 0. Purpose

R9-F owns **mission governance only**: whether a mission proposal, plan,
schedule, task, execution step, retry, recovery action, cancellation or
escalation may proceed (`ALLOW` / `REVIEW_REQUIRED` / `BLOCK` — never
`EXECUTE`), under phase-separated authorization, deterministic risk
classification, exact approval binding, immutable receipts, an execution
consumption gate, and retry/recovery governance. It does **not** own mission
objectives, task planning, dependency planning, scheduling, execution engine,
provider adapters, state recovery, strategic intelligence, Business DNA or
budget authority.

**Charter principle:** planning authority ≠ execution authority; mission
approval ≠ task approval; task approval ≠ provider authorization; retry
authority ≠ new-action authority; recovery authority ≠ policy override; no
agent may approve itself.

This document inventories the existing governance primitives the stream
reuses. **No competing approval/policy systems are created where existing
ones suffice, and strategic-recommendation approval is never conflated with
mission-execution authorization.**

## 1. Inventory method

Read-only inspection of: R8-F strategic governance (closest structural
predecessor), R7-F optimisation governance, the R4/R6-D approval ledger, the
R6-C OTP human-presence primitive, the canonical audit ledger, workflow /
retry / replay machinery, campaign-launch & publishing governance, provider
authorization surfaces, auth/tenant isolation middleware, and mission/task
concepts. Module headers, contract docs and schemas were read directly; no
code was executed and no schema was changed during inventory.

## 2. Reusable primitives (determination: REUSE)

### 2.1 Versioned, code-level policy registry — R8-F (`api/lib/strategic-governance/strategic-policy.ts`, pattern from R7-F)
- Immutable-per-version `Map` registry; same version + different content →
  `POLICY_VERSION_CONFLICT`; **no runtime mutation endpoint**; conservative
  default; unknown version → fail closed; monotone-autonomy validation.
- R9-F reuses the pattern verbatim for `mission-policy.ts` (phase autonomy
  ceilings, risk→disposition map, prohibited action list, validity windows).

### 2.2 Closed taxonomy + pure deterministic decision engine — R8-F (`strategic-recommendation-taxonomy.ts`, `strategic-decision-engine.ts`)
- Closed vocabulary; unknown type → durable `BLOCK`; authority only ever
  narrows (`weakest` composition); deterministic decision identity over a
  canonical hashed fragment; prompt-injection suspicion only raises risk,
  never widens authority; server-derived risk the client cannot lower.
- R9-F reuses the shape; dimensions change to **mission subject class /
  action type / declared risk signals (raise-only) / phase autonomy /
  retry semantics**.

### 2.3 Durable immutable decision store + structural executor seam — R8-F (`strategic-governance-store.ts`, `-bridge.ts`)
- Table in `@db/schema` (single source of truth); insert-only rows; unique
  `(userId, governanceDecisionId)` convergence anchor; `ER_DUP_ENTRY` →
  `idempotent_replay`; structural select/insert seam bound to Drizzle in the
  bridge and to the in-memory fake in tests; guarded `information_schema`
  degradation (table absent → fail closed).
- R9-F reuses verbatim for `mission_governance_decisions` (provisional 0037).

### 2.4 Governed approval ledger — R4/R6-D/R7-F/R8-F (`db/schema.ts: approval_requests`)
- Existing `approvalType` enum: `campaign_launch`, `budget_increase`,
  `sensitive_reply`, `high_value_proposal`, `ad_spend`, `shutdown`,
  `brand_risk`, `strategy_review`, `marketing_action` (R5-E), `sales_handoff`
  (R6-D), `optimisation_action` (R7-F), `strategic_recommendation` (R8-F).
- Binding discipline (`strategic-approval.ts` / `optimisation-approval.ts`):
  approval binds exact decision + policy version + material fingerprint via
  `approvalBindingHash`; expiry; human rejection permanently blocks the
  identity; a single downstream consumption gate is the only authority
  converter.
- **R9-F reuses the ledger** with a provisional enum extension
  `mission_action` (0037 artefact; R9-X owns convergence). Binding hash binds
  tenant + business + mission/plan/task refs + action params fingerprint +
  risk class + policy version + expiry.

### 2.5 Independent human-presence proof — R6-C / R8-F (`api/lib/qualification/qualification-review-authority.ts`, `api/lib/strategic-governance/strategic-review-authority.ts`, `api/lib/auth/otp.ts`)
- Email OTP challenge: out-of-band, single-use, 10-minute TTL,
  attempt-limited, purpose `review_authorization`. A tenant JWT alone can
  never resolve a review — runtime agents hold the tenant JWT and are
  indistinguishable from the human at the session layer.
- R9-F reuses the **same governed OTP primitive** for mission-governance
  review resolution (`mission-review-authority.ts`, gateway seam; production
  wires the OTP gateway). This is the structural answer to *agent
  self-approval* (F4/F8): an autonomous agent cannot observe the emailed
  code.

### 2.6 Canonical audit ledger — WBS7A/B (`api/lib/audit/`)
- Immutable envelope; closed `AUDIT_EVENT_TYPES`; deterministic fingerprint;
  metadata hygiene; one event per durable effect, convergence emits zero.
- R9-F adds two code-level additive types: `mission_governance_decision`,
  `mission_governance_recovery`. Evaluation persists decision + audit in one
  transaction.

### 2.7 Business authority / tenant scoping — R8-F bridge
- Business ownership verified by **both** id and owning user; unknown /
  cross-tenant business is indistinguishable from absent →
  `OWNERSHIP_MISMATCH` fail closed. R9-F reuses verbatim.

### 2.8 Risk taxonomy
- R5-E tiers `low < medium < high < critical`; R8-F `LOW/MEDIUM/HIGH/CRITICAL`
  with raise-only declarations and server-derived floors.
- R9-F reuses the four-class scale; risk dimensions are mission-specific
  (financial impact, external side effects, customer impact, irreversible
  effects, provider calls, data mutation, campaign activation, budget
  consumption, regulatory implication, scope breadth), with semantic floors
  from the action type that declarations can only raise, never lower.

### 2.9 Blocker taxonomy + read-only operations projection — R7-F / R8-F
- Projection derives status from immutable rows (staleness/expiry computed,
  never stored); no `forceAllow/forceApprove/override*` anywhere.
- R9-F reuses the shape for the mission-governance operations projection.

### 2.10 tRPC router + middleware conventions (`api/middleware.ts`, `api/router.ts`)
- `authedQuery` (tenant session), `z.strictObject` inputs rejecting every
  client-supplied authority field; error→tRPC-code mapping (fail closed).
- R9-F router `missionGovernance` (`api/mission-governance-router.ts`)
  registers in `appRouter` alongside the R8 routers.

### 2.11 Test harness (`api/r5-test-support.ts` `createFakeDb`)
- Table-name-keyed in-memory Drizzle-SQL evaluator; raw authority modules
  are never mocked. R9-F acceptance + security suites reuse it.

### 2.12 Workflow / retry / replay machinery (`api/lib/workflow/`)
- `workflow-operation.ts`, `queue_replay_requests` replay keys, approval
  continuation, cost pause/resume — the existing **campaign-execution**
  retry/continuation machinery.
- **Determination: reference, do not reuse.** R9-F does not build on these
  handles: mission retry/recovery governance is decided here as policy
  (idempotent-retry vs new-side-effect, fresh-review requirements), while
  the mechanical retry/replay execution remains downstream R9 concern.
  No workflow module is imported by the R9-F module tree.

### 2.13 Campaign execution governance & provider authorization (`api/lib/policy/`, `api/lib/workflow/publishing-runner.ts`, launch-approval)
- R5-E marketing-action policy (`ALLOW_AUTONOMOUS/REQUIRE_APPROVAL/DENY/…`)
  governs social engagement actions; campaign-launch approvals live in the
  shared ledger.
- **Determination: reference, do not reuse.** Mission governance is a
  distinct authority plane (phase-separated mission subjects); R9-F never
  mutates R5/R7/R8 policy or decisions, and never treats any of their
  approvals as mission-execution authorization.

## 3. Explicit non-goals / non-reuse determinations

- **No new approval system.** The ledger (2.4) + OTP primitive (2.5) suffice;
  R9-F adds only the binding vocabulary and the consumable gate.
- **No new policy store.** Code-level registry (2.1) suffices; deliberately
  no policy mutation endpoint (an agent must never modify its own thresholds).
- **No EXECUTE outcome anywhere.** Decisions are `ALLOW` /
  `REVIEW_REQUIRED` / `BLOCK`; even a consumable ALLOW is
  `authorityScope: "MISSION_ACTION"` — bounded to the exact bound subject,
  never a blanket mission authorization.
- **No conflation with strategic recommendation approval.** R8-F's
  `ALLOW_RECOMMENDATION` / bound approvals are advisory recommendation
  consumption only (`RECOMMENDATION_ONLY`); they are never inputs to the R9-F
  engine and never authorize mission formulation, tasks or execution
  (charter; R8→R9 contract §3: *approval for mission formulation must not
  authorize task execution*).
- **No execution surface of any kind.** No campaign/strategy/budget/DNA/
  provider/billing/workflow imports in the R9-F module tree (verified by the
  security suite's static blast-radius test).
- **Mission/objective/task stores are not created here.** Mission planning,
  objectives, dependencies, schedules and execution belong to sibling R9
  streams; R9-F binds them as opaque, pattern-checked references
  (`missionRef`/`planRef`/`taskRef`) and governs the decision surface only.
  R9-X owns canonical mission-store binding.

## 4. Collision & sequencing notes

- **Migration numbering:** R8-X canonical `0036_r8_strategic_intelligence_foundation`
  is the highest journal entry. R9-F uses **provisional
  `0037_r9_f_mission_governance_foundation`** (stream-local artefact, **NOT
  executed**). R9-X owns convergence; if a sibling R9 stream claims 0037
  first, R9-X renumbers. R8's 0036 is never modified.
- **Enum extension:** `approval_requests.approvalType += "mission_action"` is
  additive only (same accepted-but-unexecuted pattern as R7-F/R8-F
  extensions). Audit event types are code-level additive.
- **Router namespace:** `missionGovernance` (no collision with existing
  namespaces).
- **Id prefixes:** `mgd1:` (mission governance decision), `mgov1` approval
  idempotency prefix — no collision with `sgd1:`/`sgov1`, `ogd1:`/`ogov1`.

## 5. Determination summary

| Primitive | Source | Determination |
|---|---|---|
| Policy registry pattern | R8-F / R7-F | REUSE |
| Decision engine shape (pure, deterministic, narrowing) | R8-F | REUSE |
| Store + structural seam + bridge | R8-F | REUSE |
| Approval ledger + enum extension | R4/R6-D/R7-F/R8-F | REUSE |
| OTP human-presence proof | R6-C / R8-F | REUSE |
| Audit ledger | WBS7A/B | REUSE (+2 event types) |
| Business/tenant authority | R8-F bridge | REUSE |
| Risk scale LOW→CRITICAL | R5-E / R8-F | REUSE (mission dimensions) |
| Ops projection shape | R7-F / R8-F | REUSE |
| tRPC + middleware conventions | existing | REUSE |
| In-memory fake db test harness | R5-F | REUSE |
| Workflow retry/replay machinery | `api/lib/workflow` | REFERENCE ONLY |
| Campaign-launch / marketing-action policy | R5-E / R4 | REFERENCE ONLY |
| Strategic recommendation approvals | R8-F | NEVER conflated — separate authority plane |

**Inventory verdict:** all required primitives exist and are reusable without
modification; R9-F introduces one new authority plane (mission governance)
that composes them. No competing system is created.
