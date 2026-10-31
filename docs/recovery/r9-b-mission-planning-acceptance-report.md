# R9-B Mission Planning & Decomposition — Acceptance Report

> **Stream:** R9-B Mission Planning & Decomposition (`feature/r9-b-mission-planning`)
> **Programme base:** `4fc43c3b252baa81906cd409ca2ec290baa77825`
> **Date:** 2026-11-11
> **Verdict:** see §8.

---

## 1. Frozen upstream authorities (recorded before implementation)

| Authority | Frozen HEAD (full SHA) | Source |
|---|---|---|
| R9-A Mission Authority & Objectives | `273ce4074b48d80923325b099a03d36fdee030bb` | `origin/feature/r9-a-mission-authority` (accepted `273ce40` — verified match) |
| R9-F Mission Governance & Approval | `1665d2f9c7fe59e825c403ce966b0ebdead3d385` | resolved exactly from `origin/feature/r9-f-mission-governance` |

Neither branch merged; both consumed by branch reference only. R8 canonical
`0036` untouched. No sibling R9 stream merged.

## 2. Deliverables

| Item | Location |
|---|---|
| Planning authority inventory (B0) | `docs/recovery/r9-b-mission-planning-inventory.md` |
| Canonical contract (B1) | `docs/contracts/mission-planning-contract.md` (`mission-planning/v1`) |
| Scheduling handoff contract (B9) | `docs/contracts/mission-planning-to-scheduling-contract.md` (`mission-planning-to-scheduling/v1`) |
| Implementation | `api/lib/mission-planning/` (contract, identity, templates, mission seam, store, service, projection) + `api/mission-planning-router.ts` |
| Connected acceptance (B10) | `api/mission-planning-acceptance.test.ts` — 39 cases |
| Rogue-agent security | `api/mission-planning-security.test.ts` — 17 cases |
| Provisional migration (artefact only, NOT executed) | `db/migrations/0037_r9_b_mission_planning_foundation.sql`; canonical tables in `db/schema.ts` |
| Audit | additive `mission_plan_created`, `mission_plan_lifecycle` |

## 3. Architecture (summary)

- **Upstream consumption:** R9-A is read **only** through
  `mission-planning-mission-seam.ts` — the frozen 27-key
  `mission-authority-to-planning/v1` projection mirrored over raw
  `mission_proposals` rows (guarded `information_schema` check; absence fails
  closed `MISSION_AUTHORITY_UNAVAILABLE`), plus an in-memory port with
  identical frozen semantics for the suite. The seam never writes upstream
  tables and never extends the projection allowlist.
- **Eligibility gate (R9-A contract §3):** `ELIGIBLE_FOR_PLANNING` +
  `freshness: current` + `RECOMMENDATION_ONLY` — anything else fails closed
  `MISSION_NOT_ELIGIBLE`.
- **Identity (B2):** `pln1:` binds tenant + business + mission + R9-A
  `missionFingerprint` + planVersion + plan scope key + task-set fingerprint +
  constraint-set fingerprint. `tsk1:` binds tenant + business + mission + plan
  + task type + server-derived canonical objective + input/output fingerprints
  + constraint fingerprint. Task wording never controls identity (advisory
  rewording is never hashed). Same basis converges; conflicting replay fails
  closed `PLAN_REPLAY_CONFLICT`; mission material drift under one identity
  fails closed `PLAN_MISSION_AUTHORITY_DRIFT`.
- **Decomposition (B3):** deterministic rule table over the 8 closed mission
  types + constraint-driven additions (HUMAN_REVIEW_REQUIRED ⇒ REQUEST_APPROVAL
  before first side-effecting task; MEASURABLE_OUTCOME_REQUIRED ⇒ MONITOR+
  REPORT; BUDGET_CEILING ⇒ RECONCILE; PROHIBITED_ACTION ⇒ excluded + recorded
  unresolved).
- **Capability registry (B6):** closed, code-level, frozen. SUPPORTED /
  CONDITIONALLY_SUPPORTED / UNRESOLVED / UNSUPPORTED derived per task; unknown
  capabilities never fabricated; infeasible work becomes `unresolvedItems`,
  never executable tasks. Provider-dependent tasks carry
  `REQUIRES_PROVIDER_AVAILABILITY` and explicitly do **not** imply provider
  authorization (R9-F remains the gate).
- **Governance pre-classification (B7):** sideEffectClass / governanceClass /
  executionClass / declarative characteristics are **proposal material only**;
  no decision, no ALLOW, no risk class is ever set. R9-F referenced by
  contract only (`mission-governance/v1`).
- **Lifecycle (B8):** DRAFT / VALIDATED / READY_FOR_SCHEDULING /
  REVIEW_REQUIRED / BLOCKED / SUPERSEDED / STALE / CANCELLED / INVALIDATED —
  **no EXECUTING**. Revision mints planVersion N+1 with `supersedesPlanId`
  lineage; history is append-only (`mpl1:` facts + one audit event each;
  convergence emits zero).
- **Model boundary (B4):** closed vocabulary only; every proposal re-derived
  server-side; ordering advisory; wording inert + injection-flagged; no tool
  names, shell/SQL, providers, budget or authority material accepted.
- **Scheduling projection (B9):** frozen 24-key read-only
  `mission-planning-to-scheduling/v1` with verbatim disclaimers and an
  eligibility gate (READY_FOR_SCHEDULING + current). Scheduling may order;
  never rewrites task authority.

## 4. B10 connected acceptance — 30/30 proven (39 cases incl. regressions)

| # | Requirement | Case |
|---|---|---|
| 1 | valid mission → bounded plan | T1 |
| 2 | ungoverned mission rejected | T2 |
| 3 | stale mission rejected | T3 |
| 4 | deterministic plan identity | T4 |
| 5 | deterministic task identity | T5 |
| 6 | duplicate request converges | T6 |
| 7 | conflicting replay fails closed | T7 |
| 8 | objective preserved exactly | T8 |
| 9 | constraints preserved | T9 |
| 10 | plan cannot widen scope | T10 |
| 11 | task cannot widen scope | T11 |
| 12 | unsupported task type unresolved/rejected | T12 |
| 13 | unsupported capability not fabricated | T13 |
| 14 | provider task ≠ provider authorization | T14 |
| 15 | model cannot invent task authority | T15 |
| 16 | model cannot invent provider | T16 |
| 17 | model cannot increase budget | T17 |
| 18 | model cannot remove review | T18 |
| 19 | shell remains inert | T19 |
| 20 | SQL remains inert | T20 |
| 21 | injection cannot create executable task | T21 |
| 22 | client cannot mark executable | T22 |
| 23 | client cannot set ALLOW | T23 |
| 24 | status cannot become EXECUTING | T24 |
| 25 | revision supersedes, history intact | T25 |
| 26 | cross-tenant rejected | T26 |
| 27 | cross-business rejected | T27 |
| 28 | projection read-only + frozen | T28 |
| 29 | no provider invoked | T29 |
| 30 | no production action | T30 |

Plus: CAS conflict, mission-demote read staleness, plan validity ≤ mission
window, cancel, constraint-driven decomposition, prohibited-action exclusion,
unknown mission type, authority drift on lifecycle, tenant-scoped reads.

## 5. Rogue-agent security verdicts

| Verdict | Result |
|---|---|
| SECURITY_VERDICT | PASS |
| MISSION_PLANNING_INTEGRITY_VERDICT | PASS |
| TASK_AUTHORITY_INTEGRITY_VERDICT | PASS |
| MISSION_SCOPE_INTEGRITY_VERDICT | PASS |
| CONSTRAINT_INTEGRITY_VERDICT | PASS |
| CAPABILITY_VALIDATION_VERDICT | PASS |
| TENANT_ISOLATION_VERDICT | PASS |
| BUSINESS_ISOLATION_VERDICT | PASS |
| GOVERNANCE_BOUNDARY_VERDICT | PASS (no decision/ALLOW/risk vocabulary; R9-F untouched) |
| PROMPT_INJECTION_RESISTANCE_VERDICT | PASS (inert bounded text; flagged; zero authority effect) |
| AGENT_ISOLATION_VERDICT | PASS |
| TOOL_LEAST_PRIVILEGE_VERDICT | PASS (no queue/publish/provider/secrets imports in stream) |
| SELF_MODIFICATION_GUARD_VERDICT | PASS (frozen registries; no mutation endpoints) |
| SECRET_ISOLATION_VERDICT | PASS |
| EXECUTION_BOUNDARY_VERDICT | PASS (no EXECUTING; no execution surface) |
| PRIVILEGE_ESCALATION_FOUND | NONE |
| ROGUE_AGENT_BLAST_RADIUS | Planning rows of the authenticated tenant only; no upstream, governance, provider, budget, permission or secret reach |
| UNRESOLVED_AGENT_SECURITY_DEBT | Real-MySQL concurrency execution is deferred to R10 / pre-production acceptance (schema anchors structurally verified; deterministic concurrency green in-suite) — house-standard deferral |

READY gate: planning cannot create execution authority, fabricate capability,
or broaden mission scope — confirmed by the 17 adversarial cases.

## 6. Test evidence

- `api/mission-planning-acceptance.test.ts`: **39/39 passed**
- `api/mission-planning-security.test.ts`: **17/17 passed**
- `tsc -b`: **clean (exit 0)**
- R9-A compatibility: seam mirrors `mission-authority-to-planning/v1`
  (27-key allowlist + verbatim disclaimers asserted exact over planted raw
  durable rows); eligibility gate consumed exactly per R9-A contract §3.
- R9-F contract compatibility: B7 characteristics vocabulary consumed as
  material-only; R9-F tables/read models untouched; no decision surface.
- Full offline suite: see §7.

## 7. Full-suite / build / hygiene

| Check | Result |
|---|---|
| R9-B acceptance suite | **39/39 passed** |
| R9-B rogue-agent security suite | **17/17 passed** |
| `tsc -b` | **clean (exit 0)** |
| `npm run build` (vite + esbuild bundle + deployment verification) | **clean (exit 0)** |
| `git diff --check` | **clean** |
| Secret / PII scan over all R9-B files | **clean** (only negative-assertion regexes in tests) |
| Full offline suite — confirmation run | **7279 passed / 68 skipped / 14 todo (7363 total)**; 2 failed |
| Full-suite failure analysis | `src/pages/Campaigns.test.tsx` fails identically on the programme base (`4fc43c3b`) — pre-existing Firebase env-config failure, unrelated to R9-B. The second failure is a 10 s timeout that migrates between unrelated files across runs (run 1: `approval-router` + `campaign-router`; run 2: `publishing-router` + `content-generation-job`) — every flagged file passes in isolation on both base and this branch; machine-load flakiness under the 7 363-test suite, not a regression. |
| R8 handoff / workflow / auth / audit regressions | all green within the full suite (R8-X harness + security, workflow engine, local-auth, audit-ledger suites pass) |

## 8. Final verdict

**MISSION_PLANNING_READY**

R9-B owns mission-plan identity, plan versioning and task-definition
authority. It turns eligible governed R9-A missions into explicit, bounded,
dependency-aware plans; preserves mission objective and constraints
verbatim; classifies feasibility against a closed capability registry
without fabricating support; pre-classifies governance characteristics as
material only; exposes a frozen read-only `mission-planning-to-scheduling/v1`
projection; and contains **no execution surface of any kind** — no
scheduling, no provider invocation, no budget movement, no governance
decision, no `EXECUTING` state. Rogue-agent acceptance confirms a
compromised planning agent cannot widen scope, fabricate capability,
invent authority, or reach secrets, providers, permissions or upstream
tables.

Deferred (house-standard): real-MySQL concurrency execution is promoted to
R10 / pre-production acceptance; R9-X owns canonical `0037` convergence with
sibling streams A and F. No deployment performed; no migration executed; no
production system touched.
