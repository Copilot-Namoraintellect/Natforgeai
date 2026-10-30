# STRATEGIC INTELLIGENCE → MISSION CONTROL CONTRACT (R8-E → R9)

> **Producer:** R8-E Strategic Opportunity & Risk Intelligence
> (`feature/r8-e-strategic-opportunity-risk`)
> **Consumer:** R9 Mission Control (future stream, read-only)
> **Status:** canonical downstream contract — R9 reads, never redefines or
> mutates
> **Projection version:** `strategic-intelligence-to-mission-control/v1`
> **Source of truth:** `docs/contracts/strategic-opportunity-risk-contract.md`
> (R8-E canonical) +
> `api/lib/strategic-opportunity-risk/strategic-opportunity-risk-projection.ts`
> (`STRATEGIC_MISSION_CONTROL_PROJECTION_FIELD_KEYS` — asserted exact in
> acceptance)
> **Upstream (frozen, consumed not merged):** R8-D (`00f9adf`) via
> `strategic-reasoning-to-opportunity-risk/v1`; R8-F (`44118e3`) via
> `strategic-governance/v1`.

---

## 1. Purpose and boundaries

R8-E owns strategic opportunity/risk candidates. This contract is the **only**
surface through which R9 consumes them. Downstream may read and must never
mutate: no R9 call may write `strategic_opportunity_risk_candidates`,
`strategic_opportunity_risk_relations`,
`strategic_opportunity_risk_lifecycle_events`, or any upstream authority
table, and no consumer may mint candidate identities, classifications,
priorities, statuses, governance bindings or lifecycle facts.

**Candidate ≠ mission. Recommendation ≠ execution authorization.** A
candidate is ranked strategic evidence for mission-control consideration. R9
owns objective planning, dependency analysis, task planning and execution
coordination under separate governance; nothing in this projection pre-arms,
pre-approves or bypasses R9's own gates.

**R8 governance approval authorizes recommendation consumption only. It does
not authorize R9 execution.** An `ALLOW_RECOMMENDATION` decision or a valid
bound human approval on a `REVIEW_REQUIRED` decision (§3) is, at most,
authority for R9 to *consume the candidate as a governed recommendation*. It
is never authority to plan against it autonomously, and never authority to
execute anything: mission formulation, objective definition, dependency
planning, task planning, sequencing and execution coordination remain R9
authority under R9's own governance.

## 2. Consuming surface

R9 reads **only** through the tenant-scoped tRPC procedure on the
`strategicOpportunityRisk` router:

| Procedure | Read model |
|---|---|
| `strategicOpportunityRisk.getMissionControlHandoff` | Governed, freshness-current candidate projections for a business, ranked deterministically (priorityScore desc, candidateId tie-break). `includeNonGoverned: true` additionally exposes non-governed candidates, always status-labelled. |

The pure projection builder `buildMissionControlProjection`
(`api/lib/strategic-opportunity-risk/strategic-opportunity-risk-projection.ts`)
is the frozen builder; consumers may rebuild projections from durable rows
but must never extend the key allowlist.

## 3. Governance eligibility (what may appear as a governed recommendation)

A candidate appears as a governed handoff item only when the frozen R8-F
consumption gate passes (`assertCandidateConsumable`):

- decision `ALLOW_RECOMMENDATION`, current policy version, unexpired; **or**
- decision `REVIEW_REQUIRED` with a valid bound human approval (F5 binding
  hash verified against the stored decision — forged/expired/edited
  approvals fail closed).

`BLOCK` is terminal and never appears as a governed recommendation.
Candidates failing the gate appear only with `includeNonGoverned: true`,
status-labelled, and carry no consumption meaning.

## 4. Projection field allowlist (exact, 37 keys)

| Key | Type | Semantics |
|---|---|---|
| `contractVersion` | `"strategic-intelligence-to-mission-control/v1"` | Frozen projection version |
| `candidateId` | `sor1:…` | Opaque canonical identity — reference verbatim |
| `candidateKind` | `OPPORTUNITY\|RISK` | closed |
| `candidateType` | closed enum (15) | contract §5 |
| `businessId` | `number` | Owning business (server-verified) |
| `reasoningIds` | `rsn1:[]` | Governing R8-D conclusions |
| `memoryRefs` / `changeRefs` / `signalRefs` | `mem1:/chg1:/xsig1:[]` | Evidence lineage through R8-D, verbatim |
| `impactClass` | `MINOR\|MODERATE\|MAJOR\|SEVERE` | deterministic integer derivation |
| `urgencyClass` | `LOW\|MODERATE\|HIGH\|IMMEDIATE` | deterministic integer derivation |
| `timeHorizon` | `IMMEDIATE\|NEAR_TERM\|MEDIUM_TERM\|LONG_TERM` | deterministic derivation |
| `confidenceClass` | `INSUFFICIENT\|LOW\|MODERATE\|HIGH` | carried from R8-D; ceiling-binding |
| `evidenceQualityScore` | integer 0–100 | deterministic |
| `priorityScore` / `priorityClass` | integer / `MONITOR…CRITICAL_REVIEW` | deterministic ranking (caps binding) |
| `strategicRiskClass` | `LOW\|MEDIUM\|HIGH\|CRITICAL` | carried verbatim from the bound R8-F decision |
| `governanceDecisionId` | `sgd1:…\|null` | Bound R8-F decision |
| `governanceDecision` | `ALLOW_RECOMMENDATION\|REVIEW_REQUIRED\|BLOCK\|null` | verbatim |
| `policyVersion` | string\|null | frozen R8-F policy artefact |
| `approvalStatus` | `none\|pending\|approved\|rejected` | derived read-only ledger view |
| `status` | closed enum | candidate lifecycle status |
| `portfolioRelation` | `NEW\|REINFORCING\|OVERLAPPING\|CONFLICTING\|SUPERSEDING` | lineage only, never a score input |
| `relationCandidateIds` | `sor1:[]` | linked candidates |
| `limitations` | string[] (≤8) | preserved verbatim |
| `validUntil` | ISO-8601\|null | candidate validity window |
| `freshness` | `current\|stale` | computed at read — never stored |
| `supersedesCandidateId` | `sor1:\|null` | exact predecessor |
| `causationClaimed` | `false` | always false |
| `causationDisclaimer` | string | verbatim (§5) |
| `attributionClaimed` | `false` | always false |
| `attributionDisclaimer` | string | verbatim (§5) |
| `executionClaimed` | `false` | always false |
| `executionDisclaimer` | string | verbatim (§5) |
| `missionClaimed` | `false` | always false |
| `missionDisclaimer` | string | verbatim (§5) |
| `createdAt` | ISO-8601 | persistence timestamp |

## 5. Verbatim disclaimers (on every projection)

```
causationClaimed: false
causationDisclaimer: "A strategic candidate is evidence-preserving synthesis,
  not causal proof. This projection does not assert that any marketing
  activity, attribution credit, optimisation, market event or source claim
  caused any business outcome."
attributionClaimed: false
attributionDisclaimer: "Attribution-derived evidence is association evidence,
  not causal proof. Credit allocation and channel weights remain R7-B
  derivations on their own authority."
executionClaimed: false
executionDisclaimer: "A strategic candidate is never an execution
  authorization: no strategy, campaign, budget, Business DNA, experiment,
  provider, payment or billing state may be mutated from this projection."
missionClaimed: false
missionDisclaimer: "A strategic candidate is ranked evidence for
  mission-control consideration, not a mission. Objective planning,
  dependency analysis, task planning and execution coordination remain R9
  authority under separate governance. candidate != mission; recommendation
  != execution authorization."
```

## 6. Hard rules for R9

1. **Read-only.** No R9 write path to any R8 table; no candidate minting, no
   status changes, no governance re-interpretation.
2. **No silent winners.** `CONFLICTING` relations stay visible; R9 must
   surface both sides of a strategic conflict.
3. **Ceilings bind.** A `LOW`-confidence candidate is never "moderately
   confident" because a downstream model prefers it; no consumer may promote
   confidence, priority, impact or urgency, nor lower strategic risk.
4. **Staleness demotes.** `freshness: "stale"` candidates are historical
   context and must not anchor new missions without R8-E re-evaluation.
5. **Supersession chains preserved.** Both a superseded candidate and its
   successor remain queryable forever via `supersedesCandidateId`.
6. **Association ≠ corroboration ≠ truth ≠ causal evidence ≠ execution
   authority ≠ mission authority.**

---

**R9: plan missions on your own authority. These candidates inform; they
never instruct.**

---

## X10 acceptance stamp (R8-X integration)

Verified connected at R8-X against the integrated system
(`api/r8-x-harness.test.ts`):

- R8 creates no missions, schedules no missions, executes no strategy,
  allocates no spend, mutates no Business DNA/objectives, launches no
  campaigns, activates no experiments, invokes no CRM/provider/payment/billing
  (T46–T56).
- `candidate != mission` and `recommendation != execution authorization`
  travel verbatim on every projection payload (T34–T35).
- Ungoverned candidates never reach the handoff (T29, T55); `BLOCK` is
  terminal (T16/T29); `REVIEW_REQUIRED` requires an exact bound human
  approval (T30–T32).
- The 37-key allowlist is enforced exactly (T33); no execution or mission
  fields exist in the projection vocabulary.
