# R9-A Mission Authority & Objectives — Authority Inventory (A0)

> **Stream:** `feature/r9-a-mission-authority`
> **Programme base:** `4fc43c3b252baa81906cd409ca2ec290baa77825` (R8 frozen HEAD,
> `STRATEGIC_INTELLIGENCE_V1_READY`)
> **Date:** 2026-11-10
> **Verdict prerequisite:** this inventory precedes any R9-A edit.

---

## 1. Upstream authority consumed (frozen, read-only)

| Authority | Location | Consumption mode |
|---|---|---|
| R8→R9 handoff contract | `docs/contracts/strategic-intelligence-to-mission-control-contract.md` | Canonical downstream contract; 37-key `strategic-intelligence-to-mission-control/v1` projection; verbatim disclaimers; hard rules §6 (read-only, no silent winners, ceilings bind, staleness demotes, supersession chains preserved) |
| R8-E candidate store / projection builder | `api/lib/strategic-opportunity-risk/` (`-store`, `-projection`, `-governance-seam`, `-reasoning-seam`) | Consumed through canonical imports + production raw-SQL read port behind a guarded information-schema check (house seam pattern). R9-A **never** writes R8 tables, never re-derives R8 classification, never re-interprets governance |
| R8-F consumption gate | `assertCandidateConsumable` (`strategic-opportunity-risk-governance-seam.ts`) | The ONLY eligibility path; verdict scope `RECOMMENDATION_ONLY`; BLOCK terminal; REVIEW_REQUIRED requires F5-binding-hash-valid approval |
| R8-F engine binding | `api/lib/strategic-governance/strategic-governance-engine-binding.ts` (`bindCanonicalStrategicGovernanceEngine`) | Registered once at boot by R8-X; R9-A resolves the same registered engine through R8-E's registry — no second governance engine |

**Explicit non-ownership (contract §1/§6):** no R9 write path to
`strategic_opportunity_risk_candidates|relations|lifecycle_events` or any
upstream authority table; no candidate minting; no governance
re-interpretation; R8 recommendations are never strengthened.

## 2. Concept distinctions (authority inventory requirement)

| Concept | Owner | What it is | What it is not |
|---|---|---|---|
| **Strategic recommendation** | R8-E (+R8-F governance) | Ranked, evidence-preserving OPPORTUNITY/RISK candidate; governed, freshness-current; `RECOMMENDATION_ONLY` authority | Not a mission; not execution authorization (projection `missionClaimed:false`, `executionClaimed:false`) |
| **Mission proposal** | **R9-A (this stream)** | Bounded formulation over ONE governed candidate: mission identity, objective, scope, expected outcome, success criteria, constraints, assumptions, validity window, R8 lineage binding | Not execution authorization; not governance approval; not a task container |
| **Mission objective** | **R9-A** | Deterministic objective identity (`obj1:`) + closed objective type + bounded statement traceable to the source candidate | Not a new strategic objective (cannot be invented by model or client); never broader than the source candidate |
| **Task** | R9-B (planning; future stream) | Downstream decomposition of an eligible mission | R9-A never creates tasks, dependencies or schedules |
| **Execution** | R9-C/D (future streams) + R7-F/R8-F governance | Material action under separate execution governance | No `EXECUTING` status exists in the R9-A vocabulary; R9-A invokes nothing |

## 3. Existing mission/job/workflow/task concepts

Grep over `api/` + `db/schema.ts`:

- **No `mission_*` tables exist.** The only "mission" surface today is
  `strategicOpportunityRisk.getMissionControlHandoff` and
  `STRATEGIC_MISSION_CONTROL_PROJECTION_*` (R8-E's read-only handoff naming).
- `workflow_*` infrastructure (`workflowOperationId` on audit events,
  workflow stores) belongs to the publishing/execution harness — R9-A does
  **not** touch it; `workflowOperationId: null` on all R9-A audit events.
- `agent-router.ts` "mission" references are agent-task naming in the creative
  harness — unrelated authority; not consumed.
- No dependency/scheduler/task-decomposition authority exists upstream of R9.

## 4. Business objectives / strategy snapshots / Business DNA

- `business_dna_snapshots` and `strategy_snapshots` are R8-A/R8-B upstream
  evidence sources. R9-A does **not** read or mutate them: mission objectives
  are bound to the R8-E candidate projection only (which already carries the
  distilled memory/change/signal lineage refs). This keeps R9-A's upstream
  surface to exactly one frozen contract.
- No standalone `business_objectives` authority table exists; strategic
  objectives live as R8-A `STRATEGIC_OBJECTIVE` memory records, consumed by
  R9-A **only** as `mem1:` lineage refs through the R8-D→R8-E chain.
- **Non-mutation guarantee:** R9-A writes only its own tables
  (`mission_proposals`, `mission_lifecycle_events`) + additive audit events.
  Business DNA / strategy snapshot / campaign / budget tables are never
  written (asserted in acceptance: Business DNA not mutated, strategy not
  mutated).

## 5. Approval / governance infrastructure

- Shared approval ledger: `approval_requests` with
  `approvalType = "strategic_recommendation"` and F5 binding-hash records
  (`strategicGovernanceBinding` in `context`). R9-A reads approvals **only**
  through R8-E's read port / consumption gate to re-validate the source
  candidate. R9-A never writes approvals and never mints governance
  decisions.
- Mission-level governance/approval (R9's own gates) is explicitly **out of
  scope** for R9-A: the A5 `REVIEW_REQUIRED`/`BLOCKED` statuses are
  *formation-lifecycle* reflections of the bound R8 governance state, not
  R9-A governance decisions. No approval-type extension is introduced.

## 6. Audit infrastructure

- Canonical ledger `audit_events` via `createAuditEvent` /
  `persistAuditEvent` (`api/lib/audit/`). `eventType` is a **closed
  vocabulary** — R9-A extends it additively with two labels:
  `mission_proposed` (one per inserted proposal; convergence emits zero) and
  `mission_lifecycle` (one per inserted `misl1:` fact; convergence emits
  zero). Metadata carries ids/closed classes/hashes only — never statement
  text.
- `audit-event.test.ts` asserts the exact event-type list; updated in lockstep.

## 7. Schema / migration state

- Canonical R8 schema is in `db/schema.ts` (tables
  `strategic_opportunity_risk_candidates`, `_relations`,
  `_lifecycle_events` at `db/schema.ts:4334-4450`); migration artefact
  `0036_r8_strategic_intelligence_foundation.sql` is **provisional, NOT
  executed**. R9-A does not modify 0036 or the canonical 0036 snapshot/journal.
- R9-A adds its tables to `@db/schema` (single source of truth, house
  convention) **and** creates the stream-local provisional artefact
  `db/migrations/0037_r9_a_mission_authority_foundation.sql`
  (**artefact only, NOT executed; not added to the migration journal —
  R9-X owns canonical 0037 convergence**). `MIGRATION_EXECUTION=False`.
- New tables: `mission_proposals` (mission + objective identity/material,
  immutable core, CAS `version`) and `mission_lifecycle_events` (append-only
  `misl1:` facts). Durable convergence anchors:
  unique `missionId`, unique `(userId, missionId)`.

## 8. tRPC / middleware surface

- Routers registered in `api/router.ts` (R8-E at line 119). R9-A adds
  `missionAuthority` router via `createRouter` + `authedQuery` (tenant JWT
  only; no admin surface; no public procedures).
- Input discipline: `z.strictObject` everywhere; clients supply business
  scope + candidate reference id + bounded formation inputs (objective
  statement, success criteria, assumptions, optional budget-ceiling
  reference, optional model wording draft) — never status, fingerprints,
  risk, governance, approval, identity or projection material
  (`CLIENT_AUTHORITY_FIELD_FORBIDDEN`).

## 9. Test infrastructure

- `api/r5-test-support.ts` `createFakeDb` (drizzle-shaped in-memory fake,
  transaction rollback via structured snapshot) + `buildCtx`.
- R8-X harness pattern (`api/r8-x-harness.test.ts`): fake enforces durable
  unique anchors per table (`UNIQUE_CHECKS`), raw-SQL `information_schema`
  probes return seeded table names, production seams interpret raw rows.
  R9-A acceptance reuses this pattern to drive the REAL R8 stack
  (memory→change→signal→reasoning→opportunity) into governed candidates and
  then the REAL R9-A router — no real DB, no providers, no billing.

## 10. Security boundary summary (drives A7)

R9-A treats the mission-formulation agent and all client input as untrusted.
Deterministic formation: identity, objective type, scope, risk/confidence
ceilings, validity and lineage are server-derived from the governed R8
candidate. Model assistance may supply **wording drafts only** (inert,
bounded, injection-labelled, never authority). Fail closed on: unknown /
ungoverned / cross-tenant / cross-business / stale / expired / blocked /
tampered candidates, governance unavailability, replay conflicts, lifecycle
CAS drift, and every client-authority field.

---

**Inventory verdict:** authority boundaries confirmed; R9-A may proceed to
contract authoring (A1). No overlap with sibling R9 streams (none exist on
this branch); no frozen-R8 modification required.
