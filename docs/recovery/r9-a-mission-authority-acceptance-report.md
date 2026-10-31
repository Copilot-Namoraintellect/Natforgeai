# R9-A Mission Authority & Objectives — Acceptance Report

> **Stream:** `feature/r9-a-mission-authority`
> **Programme base:** `4fc43c3b252baa81906cd409ca2ec290baa77825` (R8 frozen HEAD,
> `STRATEGIC_INTELLIGENCE_V1_READY`)
> **Date:** 2026-11-10
> **Verdict:** `MISSION_AUTHORITY_READY`

---

## 1. What was built

The authoritative Mission Authority & Objectives capability for R9 Mission
Control (docs/contracts/mission-authority-contract.md,
`mission-authority/v1`):

- `api/lib/mission-authority/` — contract, identity, formation, lifecycle,
  R8 candidate seam, store, planning projection, service.
- `api/mission-authority-router.ts` — tRPC `missionAuthority` router
  (`propose`, `get`, `list`, `revalidate`, `cancel`, `listLifecycle`,
  `getPlanningHandoff`); registered in `api/router.ts`.
- `db/schema.ts` — `missionProposals` + `missionLifecycleEvents`.
- `db/migrations/0037_r9_a_mission_authority_foundation.sql` — stream-local
  provisional artefact only. **MIGRATION_EXECUTION=False** (not executed, not
  in the drizzle journal/snapshot; canonical R8 0036 untouched; R9-X owns
  canonical 0037 convergence).
- Additive audit labels `mission_proposed` / `mission_lifecycle` (exact list
  in `audit-event.test.ts` updated in lockstep).
- Contracts: `docs/contracts/mission-authority-contract.md`,
  `docs/contracts/mission-authority-to-planning-contract.md`
  (`mission-authority-to-planning/v1`, 27-key exact allowlist).
- Inventory: `docs/recovery/r9-a-mission-authority-inventory.md`.

## 2. Core authority rule — preserved

```
candidate != mission
recommendation != execution authorization
```

- R8 governance approval authorizes **recommendation consumption only**; the
  consumption gate verdict scope (`RECOMMENDATION_ONLY`) is re-asserted at
  the seam and bound verbatim into every mission record and projection.
- R9-A creates mission proposals. It creates **no** execution authorization:
  no `EXECUTING` status exists in the vocabulary, transition map, or any
  input surface; no task/schedule/provider/billing path exists.

## 3. A9 connected acceptance — minimum proof set

Executed over the REAL integrated stack (R8-A memory → R8-B change → R8-C
signals → R8-D reasoning → R8-F real frozen governance engine → R8-E
candidates → R9-A real router/service/store) with an in-memory fake DB
enforcing the durable unique anchors. `api/mission-authority-acceptance.test.ts`
— **28/28 passed**.

| # | Proof | Test |
|---|---|---|
| 1 | Governed R8 candidate creates a mission proposal | A1 |
| 2 | Ungoverned candidate cannot | A2 |
| 3 | Blocked candidate cannot | A3 |
| 4 | Expired candidate cannot silently create a mission | A4 |
| 5 | Mission identity deterministic | A5 |
| 6 | Duplicate request converges (zero extra events) | A5+A6, A20 replay |
| 7 | Conflicting replay fails closed | A7 |
| 8 | Cross-tenant candidate rejected | A8 |
| 9 | Cross-business candidate rejected | A9 |
| 10 | Mission preserves exact R8 lineage | A10 |
| 11 | Mission preserves constraints | A11 |
| 12 | Mission cannot broaden source scope | A12 |
| 13 | Model cannot invent objective authority | A13 |
| 14 | Model cannot remove constraint | A14 |
| 15 | Model cannot increase budget | A15 |
| 16 | Model cannot lower risk / promote priority | A16 |
| 17 | Mission proposal != execution authorization | A17 |
| 18 | Status cannot become EXECUTING in A | A18 |
| 19 | Stale source causes revalidation | A19 |
| 20 | Supersession preserves history | A20 |
| 21 | Downstream projection read-only, eligibility-gated | A21 |
| 22 | Business DNA not mutated | A22 |
| 23 | Strategy not mutated | A23 |
| 24 | Provider/billing/CRM not invoked | A24 |
| 25 | No production action (additive mission-only audit) | A25 |

Plus boundary integrity B1–B5 (authority-field smuggling, ownership, budget
ceilings, bounded cancellation).

## 4. Rogue-agent security

`api/mission-authority-security.test.ts` — **14/14 passed** (14 scenarios:
fabricated sources, forged approval bindings, governance unavailability,
cross-tenant/business rows, full model-takeover wording draft, wording-
independent identity, authority smuggle fields, injected client text, bounds
enforcement, no self-approval, no provider/billing/tool invocation, EXECUTING
impossibility, supersession guards, replay drift).

Required verdicts:

```
SECURITY_VERDICT=PASS
MISSION_AUTHORITY_INTEGRITY_VERDICT=PASS
OBJECTIVE_INTEGRITY_VERDICT=PASS
SCOPE_INTEGRITY_VERDICT=PASS
CONSTRAINT_INTEGRITY_VERDICT=PASS
TENANT_ISOLATION_VERDICT=PASS
BUSINESS_ISOLATION_VERDICT=PASS
R8_HANDOFF_INTEGRITY_VERDICT=PASS
AGENT_ISOLATION_VERDICT=PASS
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS
TOOL_LEAST_PRIVILEGE_VERDICT=PASS
SELF_MODIFICATION_GUARD_VERDICT=PASS
SECRET_ISOLATION_VERDICT=PASS
EXECUTION_BOUNDARY_VERDICT=PASS
PRIVILEGE_ESCALATION_FOUND=NONE
ROGUE_AGENT_BLAST_RADIUS=NONE (wording-only advisory influence; zero authority, zero execution, zero upstream mutation)
UNRESOLVED_AGENT_SECURITY_DEBT=NONE
```

READY condition check: no model/client/agent path can fabricate mission
authority, widen scope, remove constraints, or gain execution authority —
proven by S1–S14 and A12–A18.

## 5. Regression + hygiene runs

- R9-A targeted: `mission-authority-acceptance` 28/28, `mission-authority-security` 14/14.
- R8 handoff compatibility + strategic opportunity/risk + governance/audit
  regressions: R8 suites re-run below.
- `tsc -b`: clean.
- `npm run build`: PASS (see §6 run log).
- `git diff --check`: clean.
- Secret/PII scan of the diff: no secrets, no raw PII; audit metadata carries
  ids/closed classes/hashes only (asserted in A25).

Full-suite result (offline, no DB/providers) — `npx vitest run`, 443 files:

```
Test Files  1 failed | 441 passed | 1 skipped (443)
Tests       7267 passed | 68 skipped | 14 todo (7349)
```

The single failing file is `src/pages/Campaigns.test.tsx`: it imports
`src/lib/firebase.ts`, whose `getAuth(app)` runs at module load and throws
without `VITE_FIREBASE_API_KEY` in the environment. Proven environmental and
pre-existing — the file fails identically on the untouched base and passes
3/3 when a dummy `VITE_FIREBASE_API_KEY` is present (same single failure
recorded at R8-X: "single failure proven pre-existing/unrelated"). R9-A
touches no `src/` file; not a regression.

## 6. Execution discipline

- No branch switches; no sibling R9 merges; frozen R8 authority untouched
  (R8 modules consumed read-only; zero writes to any R8 table).
- `MIGRATION_EXECUTION=False` — provisional artefact only.
- No deploy, no production access, no live provider/payment/billing/CRM calls.

## 7. Deferred

- Real-MySQL concurrency execution remains the R10 / pre-production gate
  (schema anchors structurally verified; deterministic concurrency green via
  CAS + durable unique anchors, mirroring the R6/R7/R8 deferral).
- R9 mission governance/approval, task planning (R9-B) and execution (R9-C/D)
  are downstream streams; the planning contract (`mission-authority-to-planning/v1`)
  is the sole handoff surface.

---

**FINAL VERDICT: MISSION_AUTHORITY_READY**
