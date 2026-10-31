# R9-X Duplicate Authority / Bypass Audit (X6)

**Date:** 2026-11-12
**Integration branch:** `integration/r9-mission-control`
**Method:** semantic + lexical search over the integrated tree (`api/`,
`db/schema.ts`, `src/`), write-path ownership analysis, raw-SQL write scan,
procedure-surface enumeration. Search covered the mandated verb list
*and* semantics (not just exact names).

---

## 1. Verbs / semantics scan (integrated tree, non-test code)

Every hit for `forceAllow`, `forceApprove`, `skipGovernance`,
`bypassGovernance`, `executeWithoutApproval`, `setReady`, `setSucceeded`,
`markSuccess`, `overrideRisk`, `setRisk`, `setPriority`, `forceRetry`,
`forceRecovery`, `overrideSchedule`, `executeMission`, `runMission`,
`dispatchNow` (and R7/R8 analogues) lands in exactly one of:

1. **Client-authority rejection blocklists** (closed field sets rejected at
   the boundary): `mission-authority-contract`, `mission-planning-contract`,
   `mission-scheduling-contract` (via plan-port schema strictness),
   `mission-state-recovery-contract`, `mission-governance-contract`,
   `mission-decision-engine`, `execution-coordination-contract`,
   plus the frozen R7/R8 analogues (`optimisation-decision-engine`,
   `budget-portfolio/governance-seam`, `market-signal-contract`).
2. **Comments asserting absence** (e.g. `mission-blocker-taxonomy.ts`,
   `mission-governance-service.ts`, `mission-operations-projection.ts`).

**No executable bypass procedure, force-verb handler, hidden write path or
override surface exists anywhere in the integrated Mission Control tree.**

## 2. Write-path ownership (insert/update table partition)

| Stream | Tables written (insert) | Tables updated (CAS lifecycle) |
|--------|------------------------|--------------------------------|
| R9-A | mission_proposals, mission_lifecycle_events | mission_proposals (status/version CAS) |
| R9-B | mission_plans, mission_plan_tasks, mission_plan_lifecycle_events | mission_plans, mission_plan_tasks |
| R9-C | mission_task_plan_snapshots, mission_dependency_edges, mission_schedules, mission_schedule_lifecycle_events | mission_schedules |
| R9-D | execution_actions, execution_attempts, execution_lifecycle_events | execution_actions, execution_attempts |
| R9-E | mission_state_records, mission_task_states, mission_recovery_candidates, mission_operational_timeline_events | mission_recovery_candidates |
| R9-F | mission_governance_decisions | — (insert-only receipts) |

No cross-stream writes. Raw-SQL write scan (`INSERT INTO` / `UPDATE <protected>`
/ `DELETE FROM` / `DROP` / `ALTER`) across all six stream libs: **zero hits** —
seams are read-only behind guarded information-schema checks.

## 3. Capability checks (each must have exactly ONE authority)

| # | Capability | Finding |
|---|-----------|---------|
| 1 | creating mission authority | ONE — `missionAuthority.propose` (A); source eligibility only via `resolveGovernedCandidate` (R8 read-only + R8-E gate) |
| 2 | rewriting mission objective | NONE — no update path touches objective material; C11.27/SEC-21 assert |
| 3 | broadening mission scope | NONE — scope derived at formation; client additions can only tighten |
| 4 | defining hidden task | NONE — tasks minted only by R9-B templates; C port derivation is server-side (X4 BIND) |
| 5 | removing dependency | NONE — edges immutable, insert-only; no delete procedure (SEC-1) |
| 6 | fabricating readiness | NONE — readiness is a pure function of graph + governance reads + capability contract |
| 7 | creating schedule authority | ONE — `missionScheduling.produceSchedule` (C), deterministic content-addressed |
| 8 | bypassing R9-F | NONE — D re-runs the exact consumption gate pre-dispatch; E re-runs it pre-recovery-consumption |
| 9 | fabricating ALLOW | NONE — decisions insert-only receipts; risk raise-only; no override input |
| 10 | self-approving | NONE — OTP-bound single-use mailbox challenge; tenant JWT alone cannot resolve |
| 11 | dispatching without exact authorization | NONE — `assertMissionActionConsumable` is the only gate; failure ⇒ NO DISPATCH |
| 12 | selecting arbitrary adapter | NONE — closed registry, capability-driven server-side selection |
| 13 | bypassing idempotency | NONE — durable unique anchors; conflicting replay fails closed (C11.20, SEC-9, D/E analogues) |
| 14 | rewriting execution history | NONE — attempts insert-only; lifecycle append-only |
| 15 | fabricating SUCCESS | NONE — results classified conservatively; UNCERTAIN never auto-success |
| 16 | hiding UNCERTAIN | NONE — uncertainty classes are closed and surfaced (E derivation) |
| 17 | authorizing retry | ONE — R9-F `RETRY` subject class; D never self-authorizes |
| 18 | authorizing recovery | ONE — R9-F gate re-run at E consumption; AUTHORIZED performs nothing in E |
| 19 | altering budget | NONE — no budget table write in any R9 stream |
| 20 | mutating Business DNA / strategy | NONE — zero writes to businesses/strategy tables (raw-SQL scan) |

## 4. Peripheral surfaces checked

- **Router convergence:** 6 routers, 56 procedures, all `authedQuery`; zero
  public procedures; no duplicate registrations; no provisional/legacy mission
  routers remain.
- **Pre-existing `execute`/`dispatch` procedures** in `engagement-router`
  (R5-C) and `nurture-router` (R6-D) are *their own frozen stream authorities*
  with their own governance — they are not Mission Control paths, hold no
  mission-table write access, and cannot mint mission/schedule/execution
  authority.
- **Frontend:** `src/lib/mission-control.ts` is a UI status string helper; no
  direct mission write API calls exist in `src/`.

## 5. Required result

```
ONE mission authority   = R9-A  ✓
ONE planning authority  = R9-B  ✓
ONE dependency/scheduling authority = R9-C ✓
ONE execution coordination authority = R9-D ✓
ONE state/recovery authority = R9-E ✓
ONE governance authority = R9-F ✓
PRIVILEGE_ESCALATION_FOUND = False
```
**X6=ACCEPTED.**
