# Strategic Governance → Reasoning / Opportunity / R9 Contract (WBS-R8-F downstream)

> Downstream handoff contract for the R8-F strategic-intelligence governance
> authority. Canonical governance contract:
> `docs/contracts/strategic-intelligence-governance-contract.md`.
> Branch `feature/r8-f-strategic-governance`.

## 1. Parties and roles

- **R8-F (this stream)** owns strategic-intelligence governance: the decision
  vocabulary, evidence/source-trust derivation, confidence bounds, strategic
  risk, review thresholds, immutable decision records, the operations
  projection, narrow recovery, and the R9 handoff semantics.
- **R8-D / R8-E (sibling streams)** consume governance semantics to voice
  strategic reasoning output and opportunity/risk responses. They **must not**
  become governance authorities: they propose material; they never decide.
- **R9 (mission control / strategy execution planning)** may consume approved
  recommendation metadata, but must still act through its own execution and
  mission-control authority. Governance approval is never execution approval.

## 2. What downstream streams may consume

| Surface | Consumer use |
|---|---|
| `strategicGovernance.evaluate` | R8-D/E submit a governed recommendation proposal; receive the immutable decision. |
| `strategicGovernance.get` / `listDecisions` | Read back immutable decisions (tenant-scoped). |
| `strategicGovernance.revalidate` | **Mandatory** immediately before any material effect — re-evaluate a stored decision against current policy + evidence authority with fresh proposal material. |
| `assertStrategicRecommendationConsumable` | The single fail-closed gate converting a decision (+ approval where required) into consumption eligibility. |
| `getOperationsProjection` | Read-only operational truth (status, blockers, approval state, staleness). |

## 3. Hard rules for consumers

1. **Propose, never decide.** R8-D/E supply proposal material only. Any
   decision/risk/confidence/trust/approval field they supply is rejected at
   the boundary (`CLIENT_AUTHORITY_FIELD_REJECTED`).
2. **Revalidate before effect.** A stored decision can go stale (policy
   version change, evidence change, expiry). Consumers MUST call `revalidate`
   immediately before acting and MUST persist a new governed decision when
   anything material changed.
3. **Consumption ≠ execution.** `assertStrategicRecommendationConsumable`
   returns `authorityScope: "RECOMMENDATION_ONLY"`. Even a consumable,
   human-approved recommendation grants zero ability to launch campaigns,
   mutate strategy, move budget, alter Business DNA, or invoke
   provider/payment/billing — those require R9+ separate governed authority.
4. **BLOCK is terminal.** A blocked recommendation identity is never
   consumable; human rejection permanently blocks the identity. The only path
   forward is a NEW governed proposal.
5. **No upstream writes.** Downstream streams never write R8-F tables; the
   ledger of record is the immutable decision row + audit events.

## 4. R9 handoff semantics

R9 may read approved recommendation metadata (decision id, recommendation
type, derived confidence/risk/trust classes, policy version, approval
reference, expiry) to inform mission-control planning. This metadata is
**read-only strategic evidence**: it is never an instruction, never a
pre-approval, and never bypasses R9's own governance, budgeting, or execution
gates. If R9 acts on a recommendation, R9 owns the action and its governance;
R8-F's role ended at voicing the governed recommendation.

## 5. Failure-closed interop

If the R8-F evidence authority is unavailable (e.g. pre-R8-X evidence-store
binding), evaluation fails closed (`EVIDENCE_AUTHORITY_UNAVAILABLE`) — no
strategic claim is voiced on guessed evidence. If the approval ledger or OTP
gateway is unavailable, review resolution fails closed. Absence of authority
never widens autonomy downstream.

## 6. Versioning

Governance contract `strategic-governance/v1`; engine
`strategic-governance-engine/v1`; approval binding
`strategic-governance/approval@v1`. Consumers bind these versions; bumps
invalidate prior derived identities deliberately.
