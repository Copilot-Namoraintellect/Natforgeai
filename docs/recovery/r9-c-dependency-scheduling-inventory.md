# R9-C Dependency & Scheduling Intelligence — Authority Inventory (C0)

> **Stream:** `feature/r9-c-dependency-scheduling`
> **Programme base:** `4fc43c3b252baa81906cd409ca2ec290baa77825` (R8 frozen HEAD,
> `STRATEGIC_INTELLIGENCE_V1_READY`)
> **Frozen upstream:** R9-A Mission Authority (`273ce40`, `MISSION_AUTHORITY_READY`);
> R9-F Mission Governance (`1665d2f`, `MISSION_GOVERNANCE_READY`) — consumed
> read-only by branch ref only, **never merged**.
> **Date:** 2026-11-12
> **Verdict prerequisite:** this inventory precedes any R9-C edit.

---

## 1. Upstream authorities consumed (frozen, read-only)

| Authority | Location | Consumption mode |
|---|---|---|
| R9-A mission authority contract | `docs/contracts/mission-authority-contract.md` @ `273ce40` (`mission-authority/v1`) | Canonical upstream contract. Mission identity `mis1:<sha256>`; statuses `PROPOSED/ELIGIBLE_FOR_PLANNING/REVIEW_REQUIRED/BLOCKED/SUPERSEDED/STALE/CANCELLED/INVALIDATED` (no `EXECUTING`); `validFrom`/`validUntil`; tenant = `userId`, business scope = `businessId`; immutable `missionFingerprint`; optimistic-CAS `version` |
| R9-A mission durable rows | `mission_proposals` (provisional 0037 @ `273ce40`) | Read behind a **guarded information-schema check** (house seam pattern — R8-D `strategic-reasoning-evidence-seam` is the model). R9-C **never** writes R9-A tables, never re-derives mission status, never widens mission scope |
| R9-A planning projection contract | `docs/contracts/mission-authority-to-planning-contract.md` @ `273ce40` (`mission-authority-to-planning/v1`, 27-key allowlist, verbatim planning/execution disclaimers) | R9-B's bound input surface. R9-C treats mission validity (`validUntil`), business scope and status as **read-only scheduling constraints**, never as mutable material |
| R9-F mission governance contract | `docs/contracts/mission-governance-contract.md` @ `1665d2f` (`mission-governance/v1`) | Decisions `ALLOW/REVIEW_REQUIRED/BLOCK` (no `EXECUTE`); subject class `MISSION_SCHEDULE` / phase `SCHEDULING`; risk classes `LOW/MEDIUM/HIGH/CRITICAL`; server-derived risk, raise-only |
| R9-F execution consumption gate | `assertMissionActionConsumable` (F service @ `1665d2f`) | The ONLY downstream authority gate. R9-C surfaces `requiresApproval=true`; R9-C never creates `ALLOW`, never calls the consumption gate on behalf of a downstream consumer, never re-interprets a decision |
| R9-F governance durable rows | `mission_governance_decisions` (provisional 0037 @ `1665d2f`) | Read behind the same guarded information-schema check for approval-expiry binding in readiness. R9-C never writes governance rows |

**Explicit non-ownership:** no R9-C write path to `mission_proposals`,
`mission_lifecycle_events`, `mission_governance_decisions`, `approval_requests`
or any upstream authority table; no mission re-derivation; no governance
decision minting; no approval minting; no capability registration.

## 2. Concept distinctions (authority inventory requirement)

| Concept | Owner | What it is | What it is not |
|---|---|---|---|
| **Mission proposal** | R9-A | Bounded mission authority with validity + status | Not a task container; not a schedule |
| **Task / task plan** | R9-B (parallel stream; input port only here) | Typed task-plan material bound at R9-X | R9-C must **not** invent/freeze the task-definition contract (development boundary). R9-C defines only the **scheduling input port** it accepts |
| **Dependency edge** | **R9-C (this stream)** | Deterministic, tenant-scoped ordering constraint between two task ids of one mission+plan, typed (`REQUIRES_*`/`MUTUAL_EXCLUSION`), hard/soft | Not execution ordering truth; not a governance object; never cross-mission/plan/tenant/business |
| **Task readiness** | **R9-C** | Derived scheduling state (`READY_FOR_SCHEDULING`, `BLOCKED_*`, `STALE`, `INVALID`) from dependency state + approval state + capability evidence + time windows | Not execution authorization; schedulable ≠ executable |
| **Schedule** | **R9-C** | Deterministic ordering + parallel groups + blocking report over one plan, lifecycle `PROPOSED→VALIDATED→READY→BLOCKED/SUPERSEDED/STALE/INVALIDATED/CANCELLED` (no `EXECUTING`) | Not an execution plan; not authority to run; schedule identity is content-addressed |
| **Governance decision** | R9-F | `ALLOW/REVIEW_REQUIRED/BLOCK` over the exact bound schedule/action | R9-C surfaces `requiresApproval`; R9-C never emits `ALLOW` |
| **Execution** | R9-D (future stream) + R9-F consumption gate | Material action under separate execution governance | R9-C invokes nothing; `schedule != execution authorization` |

## 3. Existing graph / scheduling / dependency concepts (repo scan)

Grep + inspection over `api/`, `db/schema.ts`, `scripts/`:

- **No DAG / cycle-detection / topological-sort authority exists.** Matches for
  "cycle/dag/topolog" are unrelated (billing cycles, agent-runner loops, copy
  text). R9-C builds bounded deterministic graph validation from first
  principles (pure functions, no model in the path).
- **`api/lib/workflow/engine.ts`** — a 17-state publishing lifecycle state
  machine (`business_onboarding … completed`) with `workflowOperationId`
  audit anchoring. It is a fixed linear+branch transition map, **not** a
  dependency graph; it owns campaign publishing lifecycle, not mission task
  scheduling. Not consumed; naming kept distinct (`workflow_*` vs
  `mission_schedule_*`).
- **`api/lib/queue/`** — BullMQ content-generation/publishing workers with
  terminal-replay reconciliation. Execution transport, no scheduling
  semantics, no ordering authority. Not consumed.
- **`api/lib/jobs/`** — content-generation job + credit renewal. Job tracking
  only. Not consumed.
- **Cron / scheduler infrastructure** — `api/boot.ts` starts interval-based
  reconciliation (`post-live-lifecycle-pass`, replay reconciliation). Time
  trigger only; no dependency awareness. Not consumed.
- **`schedules` table / `schedule-router.ts`** — the content-calendar
  publishing schedule (month-view posts). Unrelated domain ("schedule" name
  collision only); not consumed.
- **`automations`** — trigger/action workflow definitions (stored, externally
  executed). Not a DAG; not consumed.
- **Retries / recovery** — workflow `budget-resume`, `cost-pause`,
  queue terminal-replay. Recovery authority is explicitly **not owned** here
  (charter: no retry/recovery authority).
- **Resource locks / concurrency primitives** — no advisory-lock or mutex
  authority exists. Closest: `api/lib/billing/credit-reservation-engine.ts`
  (ledger reservation, budget concurrency) — R7/R4 authority, not consumed.
  R9-C models *scheduling-level* contention grouping only (§6 below); it
  never grants capability and never locks money.
- **State transitions / CAS** — house convention: status columns are
  optimistic-CAS guarded (`version`), lifecycle facts are append-only
  (`*1:` identities). Reused directly for schedule lifecycle (C8).

## 4. Reusable deterministic primitives (adopted)

| Primitive | Source | Use in R9-C |
|---|---|---|
| `canonicalJson` / `sha256Hex` | `api/lib/conversion/conversion-contract.ts` | Identity + fingerprint determinism (`dep1:`, `sch1:`, `msl1:`, graph hash, schedule hash) |
| Guarded information-schema seam | R8-D `strategic-reasoning-evidence-seam.ts` | Read R9-A `mission_proposals` + R9-F `mission_governance_decisions` behind a table-probe; absent ⇒ fail-closed (`MISSION_SCHEDULING_AUTHORITY_UNAVAILABLE`) |
| Insert-first exact-once store | R8-B `business-change-store.ts` | `idempotent_replay` / `corroborating_replay` / conflicting-replay-fails-closed convergence for edges, schedules, lifecycle facts |
| Immutable-core `evidenceHash` | R8-B store integrity assertion | Dependency rows and schedule rows are hash-bound; drift fails closed (`SCHEDULING_TAMPER`) |
| CAS lifecycle transitions | R8-B `transitionChangeStatus` | Schedule status transitions with `version` guard |
| Frozen projection builder | R8-A/R8-B `-projection.ts` | `mission-scheduling-to-execution/v1` downstream projection with exact key allowlist + verbatim disclaimers |
| Audit ledger | `api/lib/audit/audit-event.ts` | Additive `mission_dependency_recorded`, `mission_schedule_committed`, `mission_schedule_lifecycle` event types (same additive pattern R9-A used) |
| Closed-vocab + zod strictObject boundary | All R8 contracts | Client-authority rejection at the router boundary |
| In-memory fake DB harness | `api/*-acceptance.test.ts` | Connected acceptance over real service/store/seam code, no real DB |

## 5. What does NOT exist (and will not be invented)

- No task-definition contract (R9-B owns it; R9-C ships only the typed input
  port `mission-task-plan/v1`, C1).
- No execution engine, no provider invocation, no retry/recovery, no budget
  movement, no capability registry.
- No cross-mission / cross-plan / cross-tenant / cross-business dependency
  surface — every edge is scoped to `(userId, missionId, planId)` and
  validated against the mission's authoritative tenant+business.
- No `EXECUTING` schedule status, no schedule-driven state mutation of any
  upstream table, no "run" endpoint.

## 6. Contention representation boundary (C6)

Repository evidence supports scheduling-level contention grouping over task
`requiredCapabilities` and plan-declared `resourceKeys` only:

- same provider/account capability ⇒ serialized group (capability is a
  scheduling constraint, never granted);
- same declared mutable resource key (e.g. `campaign:<id>` from R7-B's
  canonical touchpoint family, or plan-declared resource keys) ⇒ serialized;
- same declared budget-authority key ⇒ serialized;
- same exclusive workflow resource key ⇒ serialized.

Where the plan declares no resource keys, no contention is inferred — R9-C
does not invent resources not represented in the repository (charter C6).

## 7. Schema / migration posture

- R9-C ships one stream-local provisional artefact
  `0037_r9_c_dependency_scheduling_foundation.sql` (tables:
  `mission_dependency_edges`, `mission_schedules`,
  `mission_schedule_lifecycle_events`), **artefact only, NOT executed**;
  `MIGRATION_EXECUTION=False`.
- Canonical `db/schema.ts` gains the three table definitions (code-level
  source of truth, no journal/snapshot mutation).
- Canonical R8 `0036` is untouched; R9-A's and R9-F's provisional `0037`s are
  left alone — **R9-X owns canonical 0037 convergence**; no sibling merge.

## 8. Verdict

Inventory complete. R9-C proceeds with: typed input port (C1), dependency
contract + graph (C2/C3), readiness (C4), deterministic scheduling (C5),
bounded contention (C6), time windows (C7), lifecycle + schema (C8),
governance boundary (C9), downstream execution contract (C10), connected
acceptance + rogue-agent security (C11 + security suite).
