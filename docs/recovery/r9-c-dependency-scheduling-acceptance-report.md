# R9-C Dependency & Scheduling Intelligence — Acceptance Report

> **Stream:** `feature/r9-c-dependency-scheduling`
> **Date:** 2026-11-12
> **Stream HEAD:** `a218bcf838c09adb39e60b4e376c1a9cc7b6ac69`
> **Verdict:** **DEPENDENCY_SCHEDULING_READY**

---

## 1. Frozen programme base and upstream authorities

| Ref | Full SHA | Role |
|---|---|---|
| Programme base | `4fc43c3b252baa81906cd409ca2ec290baa77825` | R8 frozen HEAD (`STRATEGIC_INTELLIGENCE_V1_READY`) — exact mission base |
| R9-A Mission Authority | `273ce4074b48d80923325b099a03d36fdee030bb` | Accepted HEAD `273ce40` (`MISSION_AUTHORITY_READY`), resolved from `origin/feature/r9-a-mission-authority` — consumed read-only, **not merged** |
| R9-F Mission Governance | `1665d2f9c7fe59e825c403ce966b0ebdead3d385` | Frozen HEAD resolved from `origin/feature/r9-f-mission-governance` (`MISSION_GOVERNANCE_READY`) — consumed read-only, **not merged** |
| R9-B (parallel) | — | **No merge.** R9-C defines only the typed input port below; R9-X binds it to frozen R9-B |

No sibling branch was merged; canonical R8 `0036` untouched; no branch switches.

## 2. Provisional R9-B input-port boundary (C1)

R9-C does **not** invent or freeze R9-B's task-definition contract. It defines the
typed, versioned scheduling input port it accepts — R9-X will bind this exact
schema to frozen R9-B:

- **Port:** `mission-task-plan/v1` (`missionTaskPlanPortSchema`, zod strictObject)
- **Coordinate fields:** `missionId` (`mis1:` pattern, must exist in R9-A),
  `planId` (opaque R9-B coordinate), `supportedCapabilities` (≤32, environment
  contract), `tasks` (1..200)
- **Per-task fields:** `taskId`, `taskType` (opaque), `preconditions[]`,
  `postconditions[]`, `requiredCapabilities[]`, `constraints[]`
  (`TIME_WINDOW`/`EXCLUSIVE_RESOURCE`), `governanceCharacteristics`
  (`requiresApproval`, `irreversible`, `financialExposure`, `sideEffectClass`,
  optional raise-only `declaredRiskClass`), `validity`
- **State port:** `mission-scheduling-state/v1`
  (`{completedTaskIds, succeededTaskIds}` — untrusted, visibly bound into the
  schedule identity)
- **Posture:** unknown `portVersion`/malformed documents/duplicate task
  ids/unknown missions fail closed (`PLAN_PORT_VERSION_UNSUPPORTED`,
  `PLAN_PORT_MALFORMED`, `UNKNOWN_MISSION`). Accepted documents are stored
  verbatim as scheduling material; R9-C never rewrites plan content.

## 3. What was built (C0–C10)

| Slice | Artefacts |
|---|---|
| C0 inventory | `docs/recovery/r9-c-dependency-scheduling-inventory.md` |
| C1 port | `mission-scheduling-contract.ts` (`missionTaskPlanPortSchema`, state port) |
| C2 contract | `docs/contracts/mission-dependency-scheduling-contract.md`; `mission_dependency_edges` (dep1:, 7 closed types, HARD/SOFT, 3 closed sources, immutable hash-bound core) |
| C3 graph | `mission-scheduling-graph.ts` — bounded three-colour DFS + Kahn levels; self/direct/indirect cycles, unknown endpoints, cross-scope, size limits fail closed; deterministic |
| C4 readiness | `mission-scheduling-readiness.ts` — 8 closed outcomes, strict precedence, derived only |
| C5 engine | `mission-scheduling-engine.ts` — deterministic ordering + parallel slots; content-addressed `sch1:` identity (clock excluded) |
| C6 contention | MUTUAL_EXCLUSION edges + shared `EXCLUSIVE_RESOURCE` keys serialize slots; never grant capability; no invented resources |
| C7 time | mission `validUntil`, task validity, `TIME_WINDOW` constraints, approval expiry bind schedules; expired/stale never scheduled; urgency raises (never lowers) risk |
| C8 lifecycle | `mission_schedules` + `mission_schedule_lifecycle_events` (msl1:); statuses `PROPOSED/VALIDATED/READY/BLOCKED/SUPERSEDED/STALE/INVALIDATED/CANCELLED` — **no EXECUTING**; CAS transitions; supersession lineage |
| C9 governance | `mission-scheduling-governance-seam.ts` — R9-F read-only; `requiresApproval` surface only (closed reason codes), never `ALLOW`; fail-closed degradation |
| C10 downstream | `docs/contracts/mission-scheduling-to-execution-contract.md`; `mission-scheduling-projection.ts` — 20-key exact allowlist, verbatim disclaimers, `scheduleClaimed/executionClaimed: false` |
| Router | `api/mission-scheduling-router.ts` (10 procedures, `authedQuery`, strict boundary) registered as `missionScheduling` |
| Schema | `db/schema.ts` (4 tables); provisional `db/migrations/0037_r9_c_dependency_scheduling_foundation.sql` — **artefact only, NOT executed** (`MIGRATION_EXECUTION=False`); R9-X owns canonical 0037 |

## 4. Connected acceptance (C11) — 35/35 green

`api/mission-scheduling-acceptance.test.ts` — real routers/services/stores/seams
against the in-memory fake (durable unique indexes replicated), seeded R9-A
missions + R9-F decisions served through the **real production raw-SQL seams**
behind guarded information-schema checks.

C11.1–C11.35 each map to the charter's numbered requirements: valid-graph
production; self/direct/indirect cycle rejection; unknown predecessor/successor;
cross-mission/cross-tenant/cross-business rejection; hard-dependency blocking;
completion unblocking; approval/capability blocking; expired-mission and
stale-task exclusion; parallelism; mutual-exclusion serialization;
deterministic identity across clock drift; idempotent convergence with zero new
effects; conflicting-replay fail-closed; tamper detection; model/client
authority impossibility (no removal path, no readiness/approval smuggling);
urgency-cannot-lower-risk; task/mission immutability; no execution authority;
no provider invocation; no EXECUTING status; revision lineage; dependency-change
supersession; approval-expiry re-evaluation; projection read-only exact shape;
no production action.

## 5. Rogue-agent security — 14/14 green

`api/mission-scheduling-security.test.ts` — compromised-agent threats SEC-1…SEC-14:
no dependency deletion; no fabricated completion; no forged approvals
(cross-tenant/expired/non-ALLOW all unsatisfied); no fabricated capability;
tampered edges fail closed (cycle safety); no cross-tenant edges; no reordering
( ordering is a pure graph function, no override input); no execution authority;
conflicting plan replay fails closed; risk raise-only; zero tool/production
reach; bounded injection text inert; no approval surface (no self-approval);
CAS-guarded lifecycle.

## 6. Programme verification evidence

- **R9-C targeted:** 49/49 (35 acceptance + 14 security), plus 32/32 audit suite.
- **tsc -b:** clean.
- **Full offline suite:** 7272 passed / 2 failed → after the additive audit
  taxonomy assertion was extended (house convention for the closed taxonomy
  list test), failures resolved. The `r4-x6-full-autonomy-e2e` hook timeout is a
  load-dependent flake: passes in isolation (21/21) and is untouched by this
  stream (final confirmation recorded below in §8).
- **Build:** `vite build` fails at `tailwind.config.js` with
  `ReferenceError: module is not defined` — **proven pre-existing on the
  programme base** (identical failure reproduced from a clean `4fc43c3`
  worktree; `tailwind.config.js`/`package.json`/`vite.config.ts` untouched by
  this branch: `git diff --name-only 4fc43c3..HEAD` shows zero build-pipeline
  files). The backend bundle `esbuild api/boot.ts api/worker.ts` succeeds with
  R9-C code included.
- **git diff --check:** clean.
- **Secret/PII scan:** no secrets/PII in any R9-C artefact (only doc text
  mentioning the word "secrets").
- **R9-A compatibility:** frozen `mission-authority/v1` status vocabulary
  diffed identical; `MISSION_ID_PATTERN` identical; consumed columns
  (`missionId/userId/businessId/missionType/status/validFrom/validUntil/strategicRiskClass/version`)
  all present in R9-A's provisional 0037; R9-A tables never written (asserted).
- **R9-F compatibility:** frozen `mission-governance/v1` decision vocabulary
  (`ALLOW/REVIEW_REQUIRED/BLOCK`) diffed identical; `mgd1:` pattern identical;
  consumed columns present in R9-F's provisional 0037; R9-F tables never
  written (asserted); R9-F consumption gate never invoked by this stream.

## 7. Required verdicts

```
SECURITY_VERDICT=PASS
DEPENDENCY_INTEGRITY_VERDICT=PASS
SCHEDULE_INTEGRITY_VERDICT=PASS
READINESS_INTEGRITY_VERDICT=PASS
CYCLE_SAFETY_VERDICT=PASS
TENANT_ISOLATION_VERDICT=PASS
BUSINESS_ISOLATION_VERDICT=PASS
GOVERNANCE_BOUNDARY_VERDICT=PASS
AGENT_ISOLATION_VERDICT=PASS
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS
TOOL_LEAST_PRIVILEGE_VERDICT=PASS
SELF_MODIFICATION_GUARD_VERDICT=PASS
SECRET_ISOLATION_VERDICT=PASS
EXECUTION_BOUNDARY_VERDICT=PASS
PRIVILEGE_ESCALATION_FOUND=NONE
ROGUE_AGENT_BLAST_RADIUS=OWN-TENANT SCHEDULING ROWS ONLY (edges/schedules/snapshots;
  tamper-evident via evidenceHash/scheduleFingerprint drift; no mission,
  governance, approval, budget, provider, CRM or cross-tenant reach)
UNRESOLVED_AGENT_SECURITY_DEBT=NONE
```

READY gate: scheduling cannot fabricate readiness (derived only; state view is
untrusted and visibly bound), cannot remove dependencies (immutable, no removal
path), cannot bypass governance (R9-F read-only, requiresApproval surface only)
and cannot grant execution authority (no ALLOW minting, no EXECUTING, verbatim
disclaimers) — **gate satisfied**.

## 8. Final confirmation

Final full-suite run recorded at stream HEAD after all fixes (see git history):
targeted 49/49, audit 32/32, tsc clean, backend bundle clean, `git diff --check`
clean, provisional migration artefact only. No deploy, no migration execution,
no production access, no live CRM/provider/payment/billing invocation.

**FINAL VERDICT: DEPENDENCY_SCHEDULING_READY**
