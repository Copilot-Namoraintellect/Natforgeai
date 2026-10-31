# R9-B Mission Planning & Decomposition — Planning Authority Inventory (B0)

> **Stream:** R9-B Mission Planning & Decomposition (`feature/r9-b-mission-planning`)
> **Programme base:** `4fc43c3b252baa81906cd409ca2ec290baa77825` (verified `git rev-parse HEAD`)
> **Date:** 2026-11-11
> **Status:** inventory complete — implementation authority confirmed

---

## 1. Frozen upstream heads (captured before any implementation)

| Authority | Branch | Frozen HEAD (full SHA) | Verdict |
|---|---|---|---|
| R9-A Mission Authority & Objectives | `origin/feature/r9-a-mission-authority` | `273ce4074b48d80923325b099a03d36fdee030bb` (accepted `273ce40`) | MISSION_AUTHORITY_READY |
| R9-F Mission Governance & Approval | `origin/feature/r9-f-mission-governance` | `1665d2f9c7fe59e825c403ce966b0ebdead3d385` (resolved exactly from `origin/feature/r9-f-mission-governance`) | MISSION_GOVERNANCE_READY |

Neither branch is merged. Both are consumed by branch reference only (frozen
contracts + durable-row shapes). R8 canonical `0036` is untouched on this
branch.

---

## 2. Concept separation (explicit)

| Concept | Owner | What it is | What it is NOT |
|---|---|---|---|
| **Mission objective** | R9-A | Bounded objective authority derived from a governed R8 candidate: objective statement/type, scope, success criteria, constraints, validity, risk ceiling | A plan, a task list, permission to do anything |
| **Mission plan** | **R9-B (this stream)** | Versioned decomposition of an eligible mission into bounded task definitions + planning assumptions + unresolved items + completeness status | The objective itself, a schedule, execution authorization |
| **Task definition** | **R9-B (this stream)** | Bounded unit of work: type, objective, inputs, outputs, required capabilities, constraints, pre/postconditions, governance characteristics, status | An execution action, a provider call, a commitment that it will run |
| **Dependency** | R9-C (scheduling) | Ordering/sequencing relation between tasks | Task authority; R9-B exposes preconditions only |
| **Schedule** | R9-C | When tasks run, ordering commitments | Not owned here; R9-B exposes a read-only scheduling projection |
| **Execution action** | R9-D/E + R9-F gate | Performing a task/step under a consumable R9-F governance verdict | Never minted by planning; planning has no `EXECUTING` vocabulary |

House rule preserved verbatim from the R9-A contract:

```
candidate != mission
mission != task
recommendation != execution authorization
```

---

## 3. Authority inventory

### 3.1 R9-A planning handoff (consumed read-only)

- Contracts: `docs/contracts/mission-authority-contract.md`,
  `docs/contracts/mission-authority-to-planning-contract.md` (frozen @ A HEAD
  `273ce40`).
- Frozen projection: `mission-authority-to-planning/v1` — **27-key exact
  allowlist**, verbatim planning/execution disclaimers,
  `governanceAuthorityScope` always `RECOMMENDATION_ONLY`,
  `planningClaimed`/`executionClaimed` always `false`.
- Planning-eligibility gate (contract §3): consumable **only** when
  `status === "ELIGIBLE_FOR_PLANNING"` **and** `freshness === "current"`
  **and** `governanceAuthorityScope === "RECOMMENDATION_ONLY"`.
- Consuming surface: `missionAuthority.getPlanningHandoff` (tRPC, authed);
  durable rows in `mission_proposals`
  (`db/migrations/0037_r9_a_mission_authority_foundation.sql` on the A branch —
  provisional artefact, NOT executed). Row carries `missionId`, `version`
  (optimistic CAS), `missionFingerprint` (immutable core anchor),
  `constraintSetFingerprint`, `scopeKey`, full constraint/scope JSON.
- **Not present on this branch** (A not merged). R9-B therefore consumes via
  a house-pattern seam: raw-SQL read of `mission_proposals` behind a guarded
  `information_schema` check; absence fails closed
  (`MISSION_AUTHORITY_UNAVAILABLE`). The seam mirrors the frozen 27-key
  projection builder exactly and never extends the allowlist. An in-memory
  port carries the identical frozen semantics for the acceptance suite.
- Rebinding rule: planning binds the mission's `version` +
  `missionFingerprint` at plan formation; a mission whose authority row later
  changes material under the same `missionId` fails closed on replay
  (`PLAN_MISSION_AUTHORITY_DRIFT`) — planning never rewrites mission
  authority.

### 3.2 R9-F governance contract (consumed by reference only)

- Contracts: `docs/contracts/mission-governance-contract.md`,
  `docs/contracts/mission-governance-to-execution-contract.md` (frozen @ F
  HEAD `1665d2f`).
- Relevant to R9-B: closed subject taxonomy includes `MISSION_PLAN` (phase
  `PLANNING`) and `TASK` (phase `EXECUTION`); closed action taxonomy includes
  `PLAN_TASKS`, `SEQUENCE_DEPENDENCIES`, `BIND_OBJECTIVES`; policy default
  `autonomousPhases = {FORMULATION, PLANNING, SCHEDULING}`.
- **Boundary:** R9-B performs **governance pre-classification only** (B7) —
  it exposes task characteristics (side-effect class, financial effect,
  external communication, provider use, irreversible mutation, data mutation,
  customer impact, campaign activation, review hints). R9-B never sets a
  decision, never sets `ALLOW`, never sets final risk, never reads/writes
  `mission_governance_decisions` or approval rows. R9-F remains the only
  authority that may turn a plan/task subject into a consumable verdict.

### 3.3 Existing workflow / task / job abstractions (do NOT reuse as authority)

These are legacy execution-side machinery. R9-B task definitions are a new,
bounded planning vocabulary; none of the below mints or constrains plan/task
identity.

| Area | Location | Notes for planning |
|---|---|---|
| Autonomous workflow engine | `api/lib/workflow/engine.ts`, `workflow-operation.ts` | Legacy campaign workflow state machine + operation log with correlation ids |
| Workflow triggers / next-cycle | `api/lib/workflow/triggers.ts`, `next-cycle-*.ts` | Schedule-driven campaign continuation |
| Post-live lifecycle | `api/lib/workflow/post-live-lifecycle-*.ts` | Post-publication monitoring/scheduling loops |
| Publishing runner | `api/lib/workflow/publishing-runner.ts` | Provider publication execution |
| Approval continuations | `api/lib/workflow/approval-continuation.ts`, `strategy-approval.ts`, `launch-approval.ts` | Human approval gates in legacy flows |
| Budget autonomy | `api/lib/workflow/budget-*.ts`, `cost-pause.ts` | Legacy budget guardrails |
| Queue / workers | `api/lib/queue/bullmq.ts`, `content-generation-worker.ts`, `publishing-worker.ts` | BullMQ job execution |
| Retry systems | `api/lib/queue/terminal-failure.ts`, `terminal-replay*.ts`, `bullmq-terminal-failure.test.ts` | Terminal-failure/replay reconciliation |
| Jobs | `api/lib/jobs/content-generation-job.ts`, `credit-renewal.ts` | Job trackers |
| Agent router | `api/agent-router.ts` | Legacy agent action routing |

### 3.4 Campaign workflow definitions / state machines

- `api/campaign-router.ts`: campaign lifecycle `draft → active → paused →
  completed` (+ deletion). Legacy CRM-adjacent state, not mission planning
  state. R9-B task vocabulary may reference campaign configuration as a
  bounded task *objective* only; activation remains an execution/governance
  concern.
- `docs/publishing-workflow-system-documentation.md`,
  `docs/publishing-workflow-executive-summary.md`: publishing workflow
  documentation (execution-side).

### 3.5 Provider jobs / execution actions / task & job identities

- Provider execution lives in `api/lib/queue/*-worker.ts`,
  `api/lib/integrations/`, `api/lib/publish/`, `api/lib/media/`,
  `api/lib/video/`. R9-B never invokes these; a provider-dependent task is a
  **definition** whose feasibility is classified `CONDITIONALLY_SUPPORTED`
  and whose execution still requires provider availability + R9-F
  authorization.
- No existing global task-identity authority exists. R9-B mints `pln1:` /
  `tsk1:` / `mpl1:` deterministic identities (see contract).

### 3.6 Audit infrastructure

- `api/lib/audit/audit-event.ts`: canonical `AuditEvent` envelope +
  `AUDIT_EVENT_TYPES` taxonomy + `createAuditEvent` (pure). Additive
  code-level types used by prior streams (pattern: one event type per durable
  effect, ids/hashes/bounded labels in metadata only).
- `api/lib/audit/audit-store.ts`: `persistAuditEvent(executor, event)` with
  duplicate classification (`none` / `idempotent_replay`).
- R9-B adds `mission_plan_created`, `mission_plan_lifecycle` (additive,
  code-level, no migration).

### 3.7 Schema / migration state

- Canonical schema source of truth: `db/schema.ts` (drizzle `mysqlTable`
  style; see `strategicOpportunityRiskCandidates` for the reference pattern:
  deterministic-id varchar(69), JSON columns, fingerprint varchar(64),
  optimistic `version`, unique convergence anchors + indexes).
- Migrations on this branch run `0000…0036` (`0036_r8_strategic_intelligence_
  foundation` = R8 canonical, frozen). No `0037` exists here.
- R9-B adds its tables to `db/schema.ts` and a **stream-local provisional**
  artefact `0037_r9_b_mission_planning_foundation.sql` — **NOT executed**
  (`MIGRATION_EXECUTION = FALSE`); R9-X owns canonical 0037 convergence
  (siblings A and F each hold their own provisional 0037 artefacts).
- Sibling provisional 0037 artefacts inspected for convergence hygiene:
  `0037_r9_a_mission_authority_foundation.sql` (`mission_proposals`,
  `mission_lifecycle_events`), `0037_r9_f_mission_governance_foundation.sql`
  (`mission_governance_decisions` + `approval_requests.approvalType +=
  "mission_action"`).

### 3.8 Middleware / router registration

- `api/middleware.ts`: `authedQuery` (session + verified OTP gate) is the
  correct base for all R9-B procedures; `adminQuery` not required.
- `api/router.ts`: `appRouter` registry — R9-B adds `missionPlanning`.
- Test conventions: `api/r5-test-support.ts` `createFakeDb` (in-memory
  drizzle-like executor with transaction snapshot), `buildCtx`; acceptance
  suites `vi.mock("./queries/connection")` and drive services directly with
  fake executors + in-memory frozen-semantics ports.

---

## 4. Inventory conclusions

1. **Planning authority is greenfield on this branch** — no existing module
   owns mission plans or task definitions; no collision with legacy workflow
   machinery, which remains execution-side and untouched.
2. **R9-A consumption is seam-based** (raw-SQL + information-schema guard +
   in-memory frozen-semantics port), exactly the R8-E house pattern; R9-A
   code is not merged and not duplicated.
3. **R9-F is reference-only** for B7 pre-classification; no R9-F table is
   read or written.
4. **Boundaries hold by construction:** no `EXECUTING` plan status, no
   provider invocation, no budget/CRM/DNA/strategy write paths, no approval
   authority, tenant-anchored session `userId` on every read/write.
