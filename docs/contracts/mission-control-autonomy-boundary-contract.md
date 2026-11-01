# MISSION CONTROL AUTONOMY BOUNDARY CONTRACT (R9-X)

> **Owner:** R9-X Mission Control Integration (`integration/r9-mission-control`)
> **Status:** architectural policy boundary — R9-X ships **no** autonomy
> activation, no pricing, no packaging. This document defines what each
> autonomy level may mean *when a future operator explicitly enables it*,
> and the constraints that hold at **every** level without exception.
> **Scope:** the R9 Mission Control surface (A/B/C/D/E/F) plus its frozen
> upstreams. It does not modify any stream contract.
> **Verdict context:** `MISSION_CONTROL_V1_READY` is earned at the
> governance/architecture level implemented in R9-X (sandbox adapters,
> `LIVE_EXECUTION=False`, R9-F gates on every material action). Autonomy
> *levels* are a forward policy vocabulary, not a shipped runtime mode.

---

## 1. Purpose

Mission Control coordinates governed missions end-to-end. "Autonomy" describes
**how much of that coordination a runtime agent may perform without a human in
the loop on each individual step** — never *whether* the governance chain can
be skipped. This contract fixes four autonomy levels and the invariants that
hold at all of them, so that product, operations and engineering share one
unambiguous definition of what "Level N" permits.

**This is a policy boundary only.** It introduces:

- no new endpoints, no new approvals surface, no new execution verbs;
- no billing, packaging, tiering or entitlement logic;
- no runtime flag that silently widens authority.

An autonomy level is a **configuration of which already-governed steps may run
without per-step human confirmation**, bounded by the same R9-F governance
authority that constrains every level. Raising a level never removes a gate;
it only changes *how often the human confirmation checkpoint fires* for
actions R9-F already classifies as allowable in principle.

---

## 2. Universal invariants (hold at EVERY level, including Level 4)

No autonomy level — present or future — may violate any of the following.
They are structural to R9-X and are not configurable per level.

1. **Tenant & business isolation.** Every authority is anchored to the
   authenticated session `userId` and verified `businessId`. Cross-tenant and
   cross-business reads, bindings and consumptions fail closed.
2. **R9-F is the single governance authority.** Every material action
   (mission lifecycle subjects, execution steps, retries, recoveries,
   escalations) passes the exact R9-F gate — decision receipt + approval
   binding revalidation — immediately before its side-effect boundary. There
   is no second engine, no local ALLOW, no cached override.
3. **Recommendation ≠ authorization; plan ≠ execution; schedule ≠ execution.**
   No status, projection, schedule or plan ever pre-authorizes execution.
   Dispatch always re-derives the exact envelope hash and re-runs the gate.
4. **Capability & adapter closure.** Executable capabilities come only from
   the closed B→D translation vocabulary; adapter selection is
   server-controlled from the closed registry. Unknown or UNSUPPORTED
   capabilities fail closed (`CAPABILITY_INVALID`). A model/agent string can
   never name a module, URL, shell, SQL or credential.
5. **Budget & financial guardrails.** R9-F's financial policy is raise-only:
   no autonomous total-spend increase, locked/reserved funds immutable,
   provider allow-list, monetary values in integer minor units.
6. **Independent human approval where required.** Where R9-F returns
   `REVIEW_REQUIRED`, a fresh, exact-bound approval via the out-of-band OTP
   primitive is mandatory; a tenant JWT alone can never authorize
   (no self-approval), and human rejection permanently blocks the decision
   identity.
7. **Result integrity.** No inferred success: `UNCERTAIN` is explicit and
   never becomes success; retries are never self-authorized and cannot widen
   scope; recovery proposals are advisory and re-bound to the latest
   authoritative attempt.
8. **Audit & immutability.** Execution history, lifecycle facts and decision
   receipts are immutable; exactly one audit event per durable effect;
   conflicting replay fails closed with zero side effects.
9. **Data minimization.** Only parameter fingerprints persist — never raw
   payloads, secrets or PII in any R9 projection or receipt.
10. **No live execution in R9-X.** Adapters are sandbox fakes;
    `LIVE_EXECUTION=False`; no migration executes; no provider, billing,
    CRM or deployment side effect exists anywhere in the stream.

---

## 3. The four autonomy levels

### LEVEL 1 — Decision Support

The system observes, derives and recommends; a human performs every material
act.

- **Permitted without per-step confirmation:** reads, projections,
  evaluations, readiness derivation, recovery-candidate *proposal* (advisory),
  R8→R9 candidate consumption as a governed recommendation.
- **Requires a human per material act:** every mission lifecycle transition,
  every task execution, every retry, every recovery consumption.
- **R9-F posture:** formulation/planning/scheduling subjects may still
  `ALLOW` autonomously (their risk floor is low); every execution/lifecycle
  subject floors at `REVIEW_REQUIRED` and waits for a human.

### LEVEL 2 — Orchestrated Intelligence

The system chains governed steps end-to-end, pausing only at R9-F
`REVIEW_REQUIRED` checkpoints.

- **Permitted without per-step confirmation:** the full connected chain —
  mission proposal → plan → schedule → governed execution → derived state —
  where each action is either `ALLOW`-ed by R9-F or bound to an existing,
  current human approval.
- **Requires a human:** every `REVIEW_REQUIRED` decision (executed by the
  approval centre with the OTP challenge), plus any recovery whose fresh
  review R9-F demands (`RECOVERY_REQUIRES_FRESH_REVIEW`).
- **Human checkpoints:** all execution-phase actions under the default policy.

### LEVEL 3 — Governed Autonomy

The system may consume *pre-authorized, bounded* authority for a defined class
of low-risk actions within a validity window, pausing at policy ceilings.

- **Permitted without per-step confirmation:** actions R9-F `ALLOW`s outright
  under an operator-adopted, versioned policy that keeps execution-phase risk
  floors explicit — i.e. autonomy extends only to action classes the adopted
  policy genuinely floors at `ALLOW` (e.g. internal-workflow steps with no
  external side effect). R9-F remains authoritative: if the adopted policy
  ever floors a class at `REVIEW_REQUIRED`, the human checkpoint returns.
- **Requires a human:** any action outside the adopted `ALLOW` class; any
  action hitting an approval ceiling, a risk raise, a retry/recovery, or any
  financial guardrail.
- **Hard limits:** concurrency caps, per-window spend caps, and an explicit
  audit trail remain on; the operator can drop to Level 1/2 instantly (kill
  switch).

### LEVEL 4 — Advanced Autonomous Operations

The broadest *bounded* autonomy the architecture can express — **not unlimited
authority**. Level 4 widens the *set of R9-F-`ALLOW`-able action classes* an
operator may pre-authorize and extends trusted run windows; it **never**
removes any invariant in §2.

- **Permitted without per-step confirmation:** the connected chain plus
  auto-consumed retries and recoveries **only where** (a) the operator has
  adopted a versioned policy that floors those exact classes at `ALLOW`,
  (b) each action revalidates the exact R9-F gate and binding at dispatch,
  and (c) all §2 guardrails (budget, capability, scope, rate, concentration)
  hold. Uncertainty still stops the line: `UNCERTAIN`/stale/drifted material
  escalates to a human rather than proceeding.
- **Never permitted at Level 4 (or any level):** self-approval; skipping the
  R9-F gate; broadening action scope on retry/recovery; exceeding approved
  budget; executing an UNSUPPORTED/unknown capability; minting approvals,
  decisions or state; cross-tenant/cross-business action; disabling audit or
  immutability.
- **Oversight:** real-time operational timeline (`mot1:`), health
  classification, advisory recovery, and operator kill switches remain live
  and cannot be disabled by the runtime agent.

---

## 4. What changes between levels — and what never changes

| Dimension | L1 | L2 | L3 | L4 |
|---|---|---|---|---|
| Human per material act | always | at R9-F `REVIEW_REQUIRED` | at policy ceilings | at ceilings & uncertainty |
| R9-F gate per action | yes | yes | yes | yes |
| §2 invariants | all | all | all | all |
| Execution boundary | R9-D sandbox only | sandbox only | sandbox only | sandbox only (until R10 enables live, still gated) |

**What never changes across levels:** the §2 universal invariants. Raising the
level changes the *frequency of human checkpoints*, never the *presence of the
governance chain*. Any action that would violate §2 at Level 1 violates it at
Level 4.

---

## 5. Relationship to the acceptance verdict

R9-X's `MISSION_CONTROL_V1_READY` verdict is earned with autonomy operationally
at **Level 2 posture by default policy** (execution floors at
`REVIEW_REQUIRED`; only formulation/planning/scheduling `ALLOW` autonomously)
and with **no live execution anywhere**. Levels 3–4 are *policy vocabulary
reserved for future operator adoption* behind a versioned R9-F policy change
plus explicit human approval of that policy — they are not enabled by R9-X and
require no code to "support" beyond the invariants already proven by the X7/X8
acceptance suites.
