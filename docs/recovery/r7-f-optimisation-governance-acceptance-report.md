# R7-F OPTIMISATION GOVERNANCE — ACCEPTANCE REPORT

> **Stream:** WBS-R7 Stream F — Business Optimisation Governance
> **Branch:** `feature/r7-f-optimisation-governance`
> **Programme base:** `8030e97adc9fe8e6bf1cc3a93a8a66da56025a46` (R6 Lead
> Autonomy V1, frozen upstream — consumed, not merged)
> **Date:** 2026-11-05

---

## IDENTITY

```
branch=feature/r7-f-optimisation-governance
HEAD=a2bd083e53deede3bcbcfbe02102ccc4c7e1bed0
remote=https://github.com/Copilot-Namoraintellect/Natforgeai.git
working_tree=clean
```

## DELIVERABLES

| Deliverable | Where | Status |
|---|---|---|
| F0 governance inventory | `docs/recovery/r7-f-optimisation-governance-inventory.md` | done |
| F1 contract | `docs/contracts/business-optimisation-governance-contract.md` | done |
| F2 action taxonomy | `optimisation-action-taxonomy.ts` (11 closed types; unknown → BLOCK) | done |
| F3 financial governance | `optimisation-financial-governance.ts` + policy financial ceilings | done |
| F4 human approval governance | `optimisation-approval.ts` (binding + `assertOptimisationActionExecutable` gate) | done |
| F5 experiment governance | `optimisation-experiment-governance.ts` | done |
| F6 portfolio/concentration | `optimisation-portfolio-governance.ts` | done |
| F7 rogue-agent posture | boundary rejection of authority fields; code-level policy; no billing/provider paths; injection only narrows | done |
| F8 operations/recovery | `optimisation-operations-projection.ts` + `optimisation-blocker-taxonomy.ts` + audit-only `recordRecovery` | done |
| F9 acceptance | `r7-f-acceptance.test.ts` (34 criteria) + 8 module suites | done |
| Downstream contract | `evaluate` + `assertOptimisationActionExecutable` + `revalidate` (contract §10) | done |

## FEATURE STATUS

```
F0=done  F1=done  F2=done  F3=done  F4=done  F5=done  F6=done  F7=done
F8=done  F9=done
```

### F9 criterion map (34/34 proven)

| # | Criterion | Proof |
|---|---|---|
| 1 | registered low-risk allowed | `STRATEGY_RECOMMENDATION` → ALLOW (acceptance) |
| 2 | unknown action blocked | `REWRITE_PRODUCTION_DB` → BLOCK, durable |
| 3 | malformed proposal blocked | null/garbage rejected; money action w/o material → BLOCK |
| 4 | wrong business blocked | unknown business → OWNERSHIP_MISMATCH fail-closed |
| 5 | cross-tenant blocked | owner mismatch → BLOCK `CROSS_TENANT_PROPOSAL` |
| 6 | stale policy blocked | gate + registry: `STALE_POLICY_VERSION` |
| 7 | stale budget state blocked | `STALE_BUDGET_STATE` |
| 8 | in-budget reallocation follows policy | recorded `REALLOCATION_WITHIN_APPROVED_TOTAL` + binding |
| 9 | total increase cannot auto-authorize | `TOTAL_BUDGET_INCREASE_REQUIRES_APPROVAL` |
| 10 | threshold-crossing requires review | cap/fraction ceilings |
| 11 | forged approval rejected | tampered binding hash |
| 12 | agent self-approval rejected | approval tenant ≠ decision tenant |
| 13 | cross-proposal replay rejected | different decision id |
| 14 | modified proposal invalidates approval | fingerprint drift |
| 15 | expired approval rejected | `EXPIRED_APPROVAL` |
| 16 | experiment above budget | `EXPERIMENT_BUDGET_EXCEEDS_LIMIT` |
| 17 | prohibited dimension | `EXPERIMENT_DIMENSION_PROHIBITED` |
| 18 | excessive concurrency | `EXPERIMENT_CONCURRENCY_LIMIT_REACHED` |
| 19 | protected trait | `PROTECTED_TRAIT_OPTIMISATION_BLOCKED` |
| 20 | concentration ceiling | `CONCENTRATION_LIMIT_EXCEEDED` |
| 21 | sudden shift / oscillation | `SUDDEN_REALLOCATION_SHIFT_LIMIT`, `REALLOCATION_OSCILLATION_DETECTED` |
| 22 | reserved/locked funds immovable | `REALLOCATION_SOURCE_LOCKED` |
| 23 | unsupported provider | `UNSUPPORTED_PROVIDER` |
| 24 | stale learning | `STALE_LEARNING` |
| 25 | prompt injection cannot alter policy | injection only raises risk; policy code-level unchanged |
| 26 | model override ignored/rejected | `CLIENT_AUTHORITY_FIELD_REJECTED` |
| 27 | agent cannot alter its risk class | authority-field rejection |
| 28 | agent cannot change approval threshold | immutable registry + no router mutation |
| 29 | agent cannot invoke payment/billing | zero billing imports; seed untouched |
| 30 | audit written for material decision | exactly one event/insert; replay silent |
| 31 | operations projection truthful | counts + blocker/recovery classes |
| 32 | recovery cannot force ALLOW | audit-only; decision row unchanged |
| 33 | no upstream R6 authority mutated | no R6 imports/writes; base files untouched |
| 34 | no production financial action | only governance + audit rows written |

## TESTING

```
targeted=112/112 green (8 files: contract, taxonomy, policy, financial,
  experiment, portfolio, decision-engine, approval, r7-f-acceptance)
affected_regressions=R5 policy+governance+ops (green), approval ledger
  (green), learning promotion (green), audit (green after taxonomy update),
  billing (green except 1 env-gated assertion)
full_suite=6519 passed, 4 failed, 66 skipped, 14 todo (6603 total)
typescript=tsc -b clean (exit 0)
build=npm run build clean (vite + esbuild + deployment verification)
diff_check=git diff --check clean (exit 0)
```

**Full-suite failures — all pre-existing/environmental, none caused by R7-F:**

1. `credit-engine.test.ts` / `creative-generation-claim.test.ts`
   "reports the configured database name" — require `DATABASE_URL`; this
   fresh worktree ships without `.env` and has no local MySQL (R6 deferred
   real-MySQL execution to pre-production; DB-gated tests skip).
2. `lead-qualification-schema.test.ts` exact-once anchor string match —
   **verified failing on the frozen base `8030e97`** (broken R6-C test).
3. `src/pages/Campaigns.test.tsx` — Firebase init requires
   `VITE_FIREBASE_API_KEY`; absent in this worktree.

R7-F changed none of the failing files; its own suite and every directly
affected regression are green.

## SCHEMA

```
schema_changed=true (db/schema.ts: +optimisation_governance_decisions table,
  +approval_requests.approvalType "optimisation_action")
provisional_migration=0035_r7_f_optimisation_governance
  (+meta/0035_snapshot.json, journal idx 35; drizzle-kit generate reports
  "No schema changes" — snapshot parity verified)
migration_execution=False
```

## SECURITY

```
SECURITY_VERDICT=PASS
OPTIMISATION_GOVERNANCE_VERDICT=PASS
FINANCIAL_GOVERNANCE_VERDICT=PASS
TENANT_ISOLATION_VERDICT=PASS
APPROVAL_INTEGRITY_VERDICT=PASS
AGENT_ISOLATION_VERDICT=PASS
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS
TOOL_LEAST_PRIVILEGE_VERDICT=PASS
CROSS_AGENT_TRUST_VERDICT=PASS
SELF_MODIFICATION_GUARD_VERDICT=PASS
SECRET_ISOLATION_VERDICT=PASS
PRIVILEGE_ESCALATION_FOUND=False
ROGUE_AGENT_BLAST_RADIUS=proposal-only: a compromised optimiser can propose
  but can never widen its own authority — policy, ceilings, thresholds and
  approvals are server-side; the worst it can obtain is a BLOCK or a fresh
  REVIEW_REQUIRED bound to exact material it cannot alter post-approval
UNRESOLVED_AGENT_SECURITY_DEBT=none for this stream; programme-level note:
  OTP-bound independent human proof is not wired into optimisation approvals
  in V1 (approval-row discipline reused; R6-C OTP primitive is the later
  integration point if policy demands it)
```

READY condition check: no autonomous agent can expand its own financial or
policy authority — policy is a code-level immutable registry, financial
ceilings arrive only in the server-resolved policy/snapshot, total-spend
increases route to humans by default, and every client/model-supplied
authority field fails closed at the boundary. READY is not forbidden.

## FINAL VERDICT

```
OPTIMISATION_GOVERNANCE_READY
```

Boundaries honoured: no deploy, no migration execution, no production
contact, no live payment/billing/provider invocation; no sibling R7 branch
merged; frozen upstream base consumed read-only.
