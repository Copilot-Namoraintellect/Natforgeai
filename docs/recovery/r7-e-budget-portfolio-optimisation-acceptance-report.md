# R7-E BUDGET & PORTFOLIO OPTIMISATION — FINAL ACCEPTANCE REPORT

> **Stream:** WBS-R7 Stream E — Budget & Portfolio Optimisation
> **Date:** 2026-11-10
> **Branch:** `feature/r7-e-budget-portfolio-optimisation`

---

## IDENTITY

```
branch=feature/r7-e-budget-portfolio-optimisation
HEAD=f51f3d0 (verification slice; this report commits as the next slice)
remote=origin https://github.com/Copilot-Namoraintellect/Natforgeai.git
working_tree=clean at report time (uncommitted: this report only)
base=8030e97adc9fe8e6bf1cc3a93a8a66da56025a46 (exact programme base — unmodified)
```

Commit slices (each: inspect → test → diff-check → atomic commit → push):

| Slice | Commit | Content |
|---|---|---|
| E0+E1 | `1b82e47` | authority/portfolio inventory + optimisation contract |
| E2–E8 | `5c827ee` | snapshot, evidence model, solver, stability, governance seam, service, store, bridge, router, schema + provisional 0035, E8 contract + doc, unexecuted-migrations doc |
| E9 | `640e861` | connected acceptance harness (40 criteria) + unit tests |
| SEC | `22de60a` | rogue-agent security acceptance (16 adversarial tests) + decision tamper-evidence |

## UPSTREAM

```
r7_a_head=3e8aea8   (consumed via branch refs only — contracts + projection shapes; NOT merged)
r7_b_head=6ff9eca   (consumed via branch refs only — contract + projection shapes; NOT merged)
r7_c_head=53b2ff4   (consumed via branch refs only — contract + projection shapes; NOT merged)
r7_f_head=5e4ab95   (consumed via branch refs only — governance contract, proposal/decision/fingerprint
                     shapes, default policy; frozen seam in api/lib/budget-portfolio/governance-seam.ts)
contract_compatibility=FULL — R7-E consumes A/B/C projections read-only through frozen shapes
  (evidence-model.ts parses only the published projection subsets; businessId re-verified per row),
  and binds to R7-F through the frozen governance port (validated decision shape, published
  id/fingerprint formulas, default-policy test double for acceptance; production port fails closed
  until R7-X binds the canonical engine).
```

Sibling R7 branches were never merged, checked out, or renumbered. `integration/r7-business-optimisation` untouched.

## E0 — AUTHORITY / PORTFOLIO INVENTORY

`docs/recovery/r7-e-budget-portfolio-inventory.md` — DONE.
Exact existing financial authority identified: R4 owns settling (`campaigns.budget` whole-USD field,
`credit_reservations` state machine, `api/lib/billing/*` engines, frozen billing-key registry);
R7-F's bridge derivation documents the placeholder budget authority that R7-E's snapshot makes
deterministic (`approvedTotal = committed campaign envelope` baseline; no autonomous headroom; a
server-resolved approved-total override supports reserved-funds semantics). No competing budget
truth created: the snapshot derives from canonical rows; R4 remains the only settling authority.

## E1 — OPTIMISATION CONTRACT

`docs/contracts/budget-portfolio-optimisation-contract.md` — DONE. All required fields specified
(optimisationId `opt1:`, businessId, portfolioSnapshotId `psn1:`, budgetPeriod, currentTotalBudgetMinor,
currentAllocations[], proposedAllocations[], deltaAllocations[], evidenceRefs[], learningRefs[],
attributionRefs[], outcomeRefs[], objective, algorithmVersion, constraintVersion, confidenceClass,
reasonCodes (closed, ≤8), governanceDecisionId, approvalRequired, status (closed lifecycle),
createdAt, validUntil). Integer minor units; no floating-point money anywhere.

## E2 — PORTFOLIO SNAPSHOT — DONE

Deterministic `psn1:` identity over server-assembled state (no wall-clock in the identity). Client may
supply only `{businessId}`; totals/allocations/funds are server-derived and re-validated at the
provider boundary (cross-tenant indistinguishable-from-absent). Stale snapshots fail closed
(`SNAPSHOT_STALE`, policy horizon) before any material action. Proven by AC1–AC4, AC18, AC20/21.

## E3 — EVIDENCE / PERFORMANCE MODEL — DONE

Deterministic integer weights (frozen `EVIDENCE_WEIGHTS`): VERIFIED(4) > PROVISIONAL(2) > OBSERVED(1);
attribution confidence HIGH=4/MEDIUM=2/LOW=1/NONE=0 × evidence class DIRECT=4/STRONG=3/WEAK=1/
INSUFFICIENT=0; learning STRONG=3/MODERATE=2/WEAK=1; recency buckets (7d/30d/90d); contradicted
learning blocks its subject; single-event cap 4000 bps of total mass; R7-B credit in 100000-bps
semantics. No model opinion assigns financial weight; attribution credit is association, never
causation (disclaimers carried on the E8 projection). Proven by AC8–AC11, AC19 + unit tests.

## E4 — BOUNDED OPTIMISATION — DONE

Deterministic bounded solver: Σ proposed ≤ approved total; pure reallocations conserve money exactly
(Σ delta = 0); BigInt integer internals; largest-remainder rounding with stable key tie-break (no
money creation); min/max allocation, per-cycle shift cap (20% + $500 absolute), concentration
ceiling (50%), locked/reserved/disabled/unsupported preservation, minimum-evidence threshold,
no negative allocation. Proven by AC5–AC7, AC12–AC17 + rounding-torture security test.

## E5 — ANTI-OSCILLATION / STABILITY — DONE

Cooldown per allocation key (24h), hysteresis band (1% of current), repeated-reversal hold (7d
window), gross-change threshold ($0.50); a triggered control holds the whole cycle to NO_CHANGE with
an explainable reason code; history is the auditable proposal/instruction ledger. Proven by AC24,
AC25 + unit tests.

## E6 — GOVERNANCE / APPROVAL BINDING — DONE

Every material proposal is evaluated by R7-F through the frozen seam before execution eligibility.
Revalidation before authorisation: fresh snapshot freshness, current policy version, approval
binding (hash + fingerprint + expiry + tenant), decision evaluation-fingerprint re-verification,
proposal-fingerprint re-derivation. `ALLOW` is executable only within the exact governed proposal;
`REVIEW_REQUIRED` requires a human approval row; `BLOCK` never executes. No R7-E path modifies a
governance decision; no client/agent can mark a proposal allowed; self-approval is rejected.
Proven by AC26–AC31 + security tests (tampered decision, forged approval, expiry, cross-tenant).

## E7 — PROPOSAL / EXECUTION BOUNDARY — DONE

R7-E creates proposals and read-only authorised instructions (`ins1:`) only. No billing, payment,
provider, CRM, campaign or strategy execution exists in the stream (static-scanned in tests).
Production governance port fails closed (`GOVERNANCE_UNAVAILABLE`) until R7-X binds canonical R7-F —
on this branch no proposal can become execution-eligible in production wiring. Proven by AC35,
AC39, AC40.

## E8 — DOWNSTREAM STRATEGY HANDOFF — DONE

`docs/contracts/business-optimisation-to-strategy-contract.md` + frozen 23-key read-only projection
(`budgetPortfolio.getStrategyHandoff`) exposing optimisation id, business, budget period, current vs
proposed allocation, evidence, confidence, constraints, governance decision, approval status,
validity, algorithm/version, reason codes + verbatim causation/attribution disclaimers. R7-E never
mutates strategy. Proven by AC36.

## E9 — CONNECTED ACCEPTANCE — DONE (40/40)

`api/r7-e-acceptance.test.ts` — 38 connected tests covering all 40 required criteria:

1 ✅ valid snapshot · 2 ✅ wrong-business rejected · 3 ✅ cross-tenant rejected · 4 ✅ client-fabricated
budget rejected · 5 ✅ locked funds preserved · 6 ✅ reserved preserved · 7 ✅ unsupported provider
excluded · 8 ✅ verified > provisional · 9 ✅ weak attribution reduces strength · 10 ✅ contradicted
learning blocks · 11 ✅ single event can't run away · 12 ✅ Σ proposed ≤ approved · 13 ✅ no money
created by rounding · 14 ✅ no negative allocation · 15 ✅ per-cycle cap · 16 ✅ concentration
ceiling · 17 ✅ minimum allocation floor (mechanism; whole-dollar budgets bind floors at $1) ·
18 ✅ stale snapshot rejected · 19 ✅ stale evidence rejected · 20 ✅ duplicate converges ·
21 ✅ concurrent converges · 22 ✅ conflicting replay fails closed · 23 ✅ deterministic identical
evidence · 24 ✅ noisy change → NO_CHANGE · 25 ✅ reversal hold · 26 ✅ BLOCK prevents ·
27 ✅ REVIEW_REQUIRES approval · 28 ✅ forged approval rejected · 29 ✅ modified proposal invalidates
approval · 30 ✅ agent can't raise total · 31 ✅ client can't mark ALLOW · 32 ✅ model can't select
allocations · 33 ✅ injection can't alter budget · 34 ✅ upstream read-only · 35 ✅ no
payment/billing/provider execution · 36 ✅ strategy projection read-only · 37 ✅ audit written ·
38 ✅ no upstream mutation · 39 ✅ no production action · 40 ✅ rogue agent contained.

## TESTING

```
targeted            = api/lib/budget-portfolio/budget-portfolio.test.ts (30/30 PASS),
                      api/r7-e-acceptance.test.ts (38/38 PASS — all 40 E9 criteria),
                      api/r7-e-security-acceptance.test.ts (16/16 PASS),
                      api/r7-e-contract-compatibility.test.ts (8/8 PASS)
affected_regressions= base comparison (detached worktree @ 8030e97, same 13 failing files):
                      4 failures PRE-EXISTING/environmental, identical on base (lead-qualification
                      schema anchors, credit-engine + creative-claim DATABASE_URL env guards,
                      Campaigns.tsx firebase init); all other full-suite failures are parallel-load
                      10s timeouts — every such file passes isolated on this branch (r4-c-downstream
                      15/15 solo; publishing-router/strategy-readiness/creative-lineage/r4-a5-restart/
                      wbs13-wiring 44/44 together; creative-agent-format-lineage 10/10 solo) and none
                      imports any R7-E module. One genuine regression found during the run (audit
                      taxonomy exact-array assertion) was fixed and re-verified 20/20.
full_suite          = npx vitest run — 410 files: 6498 passed / 5 failed / 66 skipped / 14 todo.
                      The 5 failures are exactly the pre-existing/environmental set above (4 identical
                      on the programme base + 1 load-flake green in isolation). ZERO R7-E-related
                      failures.
typescript          = npx tsc -b — PASS (TSC_EXIT=0, no diagnostics)
build               = npm run build — PASS (vite build + api/boot.ts + api/worker.ts bundles +
                      deployment verification, "✅ Deployment verification passed")
diff_check          = git diff --check — PASS (clean)
secret_scan         = git grep high-entropy secret patterns over all R7-E files — PASS (no matches)
concurrency/replay  = AC20/AC21/AC22 + governance replay (idempotent_replay; conflict fails closed)
anti_oscillation    = AC24/AC25 + solver/stability unit tests
rogue_agent         = 16/16 PASS (see SECURITY)
```

## SCHEMA

```
schema_changed        = YES (additive: budget_portfolio_snapshots / _proposals / _allocation_instructions)
provisional_migration = 0035_r7_e_budget_portfolio_optimisation (+ meta snapshot + journal idx 35)
0034 / sibling 0035s  = untouched
migration_execution   = False (artefact only; no db:push/db:migrate; no environment contact)
collision documented  = docs/recovery/r7-e-unexecuted-migrations.md
```

## SECURITY

```
SECURITY_VERDICT                       = PASS
OPTIMISATION_INTEGRITY_VERDICT         = PASS (deterministic, time-independent, content-hash
                                           guarded; conflicting replay fails closed)
FINANCIAL_INTEGRITY_VERDICT            = PASS (integer minor units; Σ delta = 0 exactly; rounding
                                           torture green; total increase impossible without human
                                           approval; locked/reserved immutable)
PORTFOLIO_INTEGRITY_VERDICT            = PASS (concentration/shift caps; disabled/locked/unsupported
                                           preserved; stale/contradicted evidence cannot accelerate)
TENANT_ISOLATION_VERDICT               = PASS (tenant-anchored identities, predicates and reads;
                                           cross-tenant evidence/snapshot/proposal rejected)
GOVERNANCE_BINDING_VERDICT             = PASS (BLOCK/REVIEW honoured; forged/expired/edited approvals
                                           rejected; modified proposals invalidate binding; tampered
                                           decisions fail shape/fingerprint re-verification; no
                                           self-approval; no client-authority fields)
AGENT_ISOLATION_VERDICT                = PASS (no shell/SQL/process/secret access; no env reads;
                                           deterministic identities — no Math.random)
PROMPT_INJECTION_RESISTANCE_VERDICT    = PASS (injection suspicion only narrows authority; hostile
                                           strings never enter money paths; invariants hold)
TOOL_LEAST_PRIVILEGE_VERDICT           = PASS (no exec/fs/fetch/billing/provider imports in stream)
CROSS_AGENT_TRUST_VERDICT              = PASS (approvals are external ledger rows bound by hash;
                                           proposal material can never mint its own approval)
SELF_MODIFICATION_GUARD_VERDICT        = PASS (constraints + frozen policy are immutable artefacts;
                                           no runtime mutation endpoint exists)
SECRET_ISOLATION_VERDICT               = PASS (no process.env / secret reads; deps injected)
PRIVILEGE_ESCALATION_FOUND             = NONE
ROGUE_AGENT_BLAST_RADIUS               = BOUNDED — a compromised optimisation agent can only emit
                                           governance-gated reallocation proposals within the approved
                                           envelope; it cannot raise the total, unlock locked/reserved
                                           funds, fabricate evidence authority, alter attribution or
                                           learning, change any governance result, self-approve,
                                           execute any payment/billing/provider effect, or touch
                                           strategy. Worst case: a bounded, explainable, reversible
                                           proposal awaiting human approval (default policy: every
                                           material move is REVIEW_REQUIRED).
UNRESOLVED_AGENT_SECURITY_DEBT         = Governance evaluation on this branch uses the faithful
                                           default-policy TEST DOUBLE (frozen seam) — canonical R7-F
                                           engine binds at R7-X (same consumed-not-merged discipline
                                           as all R7 streams). Real-MySQL concurrency is deferred to
                                           R10/pre-production per programme convention (deterministic
                                           in-memory concurrency green).
```

READY gate: no model/agent/client can increase total authorized spend, move locked funds, bypass
governance, fabricate evidence, or directly execute financial effects — all proven above.

## FINAL VERDICT

```
BUDGET_PORTFOLIO_OPTIMISATION_READY
```
