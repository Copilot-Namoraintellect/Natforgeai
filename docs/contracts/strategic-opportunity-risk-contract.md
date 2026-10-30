# STRATEGIC OPPORTUNITY & RISK CONTRACT (R8-E canonical)

> **Stream:** R8-E Strategic Opportunity & Risk Intelligence
> (`feature/r8-e-strategic-opportunity-risk`)
> **Status:** versioned authority — downstream reads, never redefines
> **Contract version:** `strategic-opportunity-risk/v1`
> **Engine version:** `strategic-opportunity-risk-engine/v1`
> **R9 projection version:** `strategic-intelligence-to-mission-control/v1`
> **Frozen upstream (consumed by branch ref only, never merged):**
> R8-D `00f9adf` (`strategic-reasoning-to-opportunity-risk/v1`),
> R8-F `44118e3` (`strategic-governance/v1`), R8-A `23d0f22`, R8-B `055eece`,
> R8-C `b366c5e` (evidence lineage through R8-D only).

---

## 1. Purpose and boundaries

R8-E transforms governed R8-D strategic-reasoning conclusions into **bounded,
evidence-preserving strategic opportunity and risk candidates** for downstream
R9 mission-control consideration. This stream owns:

- opportunity/risk candidate identity (`sor1:`);
- candidate kind/type classification;
- impact / urgency / time-horizon classification;
- confidence / evidence classification and deterministic prioritisation;
- support / contradiction accounting;
- candidate deduplication and overlap / portfolio interaction;
- candidate lifecycle and immutable history (`sorl1:` facts);
- governance binding (R8-F decisions bound verbatim);
- the read-only R9 mission-control handoff projection.

This stream must **not** own: R8-D reasoning authority, R8-A/B/C evidence
authorities, R8-F governance authority, mission planning, task scheduling,
strategy mutation, Business DNA mutation, budget execution, campaign
execution, experiment execution, provider/payment/billing execution.

**A candidate is strategic evidence, never an execution instruction.** No
candidate may directly launch strategy, campaign, spend, experiment or
provider actions. No `EXECUTE` semantics exist anywhere in this stream.

## 2. Core principles (binding)

1. Candidates are strategic evidence, not execution instructions.
2. OPPORTUNITY and RISK remain distinct kinds; no third ambiguous category.
3. Strategic priority must not be driven by model enthusiasm — ranking is a
   deterministic integer function of declared factors only.
4. Impact, urgency and confidence are separate dimensions.
5. Low-confidence high-impact candidates become REVIEW/MONITOR, never
   automatic top priority.
6. Contradictions remain visible (carried verbatim, penalise priority, never
   erased).
7. External signals do not become business facts merely because they support
   a candidate (lineage preserved; confidence ceilings from R8-D bind).
8. Duplicate/overlapping candidates converge (same identity) or are linked by
   relations — never silently merged, never score-inflated.
9. Ranking is deterministic and reproducible: same inputs ⇒ same classes,
   same scores, same order.
10. No candidate mutates strategy, DNA, budget, campaigns, experiments, or
    invokes providers/payments/billing.

## 3. Candidate identity (E2)

```
candidateId = "sor1:" + sha256(canonicalJson({
  v: 1,
  userId,                       // tenant anchor (house convention)
  businessId,                   // business scope
  candidateKind,                // OPPORTUNITY | RISK
  candidateType,                // closed vocabulary §5
  reasoningIds: [...].sort(),   // governing reasoning authority
  subjectKey,                   // deterministic subject/context key
  evidenceBundleFingerprint     // bound evidence fingerprint
}))
```

- **subjectKey** = sorted anchor-evidence refs of the governing reasoning
  projections, joined — deterministic, bounded (≤ 32 refs), never fuzzy.
- **evidenceBundleFingerprint** = sha256 over the sorted
  `(reasoningId, evidenceBundleId, evidenceFingerprint)` triples of the
  governing projections — binds the exact upstream evidence snapshot.
- Same authoritative basis ⇒ same `candidateId` ⇒ durable convergence;
  conflicting replay under the same identity fails closed
  (`CANDIDATE_REPLAY_CONFLICT`). No fuzzy candidate merging exists.

Rejected at the boundary (fail closed): cross-business reasoning
(`REASONING_SCOPE_MISMATCH`), cross-tenant evidence (indistinguishable from
unknown → `UNKNOWN_REASONING_REFERENCE`), unknown reasoning, stale reasoning
(`STALE_REASONING`), unsupported projection contract versions
(`REASONING_CONTRACT_VERSION_UNSUPPORTED`), tampered evidence fingerprints
(`CANDIDATE_REPLAY_CONFLICT`). Clients can never supply candidate authority
fields (§9).

## 4. Candidate record (durable shape)

| Field | Type | Notes |
|---|---|---|
| `candidateId` | `sor1:<64hex>` | deterministic identity |
| `userId` | number | tenant anchor |
| `businessId` | number | scope, ownership re-verified per call |
| `candidateKind` | `OPPORTUNITY\|RISK` | closed |
| `candidateType` | closed enum (§5) | deterministic derivation; model proposals advisory only |
| `reasoningIds` | `rsn1:[]` | governing conclusions, sorted |
| `memoryRefs` | `mem1:[]` | lineage through R8-D, verbatim |
| `changeRefs` | `chg1:[]` | lineage through R8-D, verbatim |
| `signalRefs` | `xsig1:[]` | lineage through R8-D, verbatim |
| `supportingEvidence` | `[{ref, evidenceClass, role}]` | preserved verbatim from R8-D |
| `contradictingEvidence` | `[{ref, evidenceClass}]` | preserved verbatim — conflict stays visible |
| `impactClass` | closed enum (§5) | deterministic integer score (§6) |
| `urgencyClass` | closed enum (§5) | deterministic integer score (§6) |
| `timeHorizon` | closed enum (§5) | derived from urgency + validity |
| `confidenceClass` | closed enum (§5) | carried verbatim from R8-D — never raised |
| `evidenceQualityScore` | integer 0–100 | deterministic (§6) |
| `priorityScore` | integer | deterministic fixed-point (§6) |
| `priorityClass` | closed enum (§5) | deterministic mapping + caps (§6) |
| `strategicRiskClass` | closed enum (§5) | carried verbatim from bound R8-F decision |
| `governanceDecisionId` | `sgd1:\|null` | bound R8-F decision |
| `governanceDecision` | `ALLOW_RECOMMENDATION\|REVIEW_REQUIRED\|BLOCK\|null` | verbatim |
| `policyVersion` | string\|null | frozen R8-F policy artefact |
| `approvalStatus` | `none\|pending\|approved\|rejected` | derived read-only view of the governed ledger |
| `status` | closed enum (§5) | lifecycle (§8) |
| `portfolioRelation` | closed enum (§5) | NEW/REINFORCING/OVERLAPPING/CONFLICTING/SUPERSEDING |
| `relationCandidateIds` | `sor1:[]` | linked candidates (lineage, never score input) |
| `subjectKey` | string | deterministic subject/context |
| `evidenceBundleFingerprint` | 64-hex | tamper-evident evidence binding |
| `candidateFingerprint` | 64-hex | over the immutable material core |
| `derivationOutcome` | `CANDIDATE_CREATED\|MONITOR_ONLY\|NO_CANDIDATE` | derivation verdict |
| `limitations` | string[] (≤8) | preserved verbatim from R8-D + derivation notes |
| `validUntil` | ISO-8601\|null | candidate validity window |
| `supersedesCandidateId` | `sor1:\|null` | exact predecessor |
| `governanceRecord` | json\|null | validated R8-F decision payload (opaque) |
| `sourceVersions` | json | bound upstream contract versions |
| `createdAt` | ISO-8601 | persistence timestamp |

## 5. Closed vocabularies

**candidateKind:** `OPPORTUNITY`, `RISK` (no third category).

**candidateType (15):** `MARKET_EXPANSION`, `DEMAND_GROWTH`,
`POSITIONING_CHANGE`, `COMPETITIVE_RESPONSE`, `PRODUCT_MARKETING`,
`CHANNEL_SHIFT`, `CAPABILITY_INVESTMENT`, `RESOURCE_REALLOCATION`,
`REGULATORY_RESPONSE`, `TECHNOLOGY_ADOPTION`, `REPUTATION_RESPONSE`,
`MARKET_DECLINE`, `CAPABILITY_RISK`, `PORTFOLIO_RISK`,
`STRATEGIC_MISALIGNMENT`.

**impactClass:** `MINOR`, `MODERATE`, `MAJOR`, `SEVERE`.
**urgencyClass:** `LOW`, `MODERATE`, `HIGH`, `IMMEDIATE`.
**timeHorizon:** `IMMEDIATE`, `NEAR_TERM`, `MEDIUM_TERM`, `LONG_TERM`.
**confidenceClass:** `INSUFFICIENT`, `LOW`, `MODERATE`, `HIGH`.
**priorityClass:** `MONITOR`, `LOW`, `MEDIUM`, `HIGH`, `CRITICAL_REVIEW`.
**strategicRiskClass:** `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`.
**status:** `CANDIDATE`, `MONITOR`, `REVIEW_REQUIRED`,
`GOVERNED_RECOMMENDATION`, `BLOCKED`, `SUPERSEDED`, `CONTRADICTED`, `STALE`,
`RESOLVED`, `INVALIDATED`.
**portfolioRelation:** `NEW`, `REINFORCING`, `OVERLAPPING`, `CONFLICTING`,
`SUPERSEDING`.
**derivationOutcome:** `CANDIDATE_CREATED`, `MONITOR_ONLY`, `NO_CANDIDATE`.

## 6. Deterministic classification (E3–E5)

### 6.1 Derivation (rule-first, no model in the path)

Deterministic `(hypothesisType, implicationType, strategicRiskClass,
contradictingCount)` rules, e.g.:

| R8-D hypothesis | kind / type |
|---|---|
| `GROWTH_SIGNAL`, `DEMAND_CHANGE` | OPPORTUNITY / `DEMAND_GROWTH` |
| `MARKET_SHIFT` | OPPORTUNITY / `MARKET_EXPANSION` |
| `DECLINE_SIGNAL` | RISK / `MARKET_DECLINE` |
| `COMPETITIVE_PRESSURE` | risk ≥ HIGH or contradicted → RISK / `COMPETITIVE_RESPONSE`; else OPPORTUNITY / `COMPETITIVE_RESPONSE` |
| `BUSINESS_CAPABILITY_GAP` | RISK / `CAPABILITY_RISK` |
| `STRATEGIC_ALIGNMENT`, `POSITIONING_SIGNAL` | OPPORTUNITY / `POSITIONING_CHANGE` |
| `RESOURCE_MISMATCH` | implication `REVIEW_RESOURCE_PRIORITY` → OPPORTUNITY / `RESOURCE_REALLOCATION`; else RISK / `PORTFOLIO_RISK` |
| `REGULATORY_IMPLICATION` | RISK / `REGULATORY_RESPONSE` |
| `TECHNOLOGY_IMPLICATION` | OPPORTUNITY / `TECHNOLOGY_ADOPTION` |
| `NO_ACTIONABLE_CONCLUSION` | `NO_CANDIDATE` |

`NO_CANDIDATE` also for: non-active or stale reasoning, implication
`NO_ACTION`, `INSUFFICIENT` confidence with no material risk, zero usable
evidence. Not every conclusion becomes a candidate — `MONITOR`/`NO_ACTION`
cases remain possible. Model assistance may propose `candidateTypes` from the
bounded space only; a proposal that disagrees with the deterministic rule is
ignored (never authority — model cannot pick kind, type, or verdict).

### 6.2 Impact score (integer, 0–100)

```
riskWeight    = strategicRiskClass rank {LOW:0,MEDIUM:1,HIGH:2,CRITICAL:3} × 20   (null risk → 0)
supportWeight = min(anchor supporting count, 4) × 5
objectiveW.   = STRATEGIC_OBJECTIVE memory anchor present ? 10 : 0
breadthW.     = ≥2 evidence classes present ? 10 : 5
impactScore   = min(100, riskWeight + supportWeight + objectiveWeight + breadthWeight)
impactClass   = <25 MINOR | <50 MODERATE | <75 MAJOR | ≥75 SEVERE
```

### 6.3 Urgency score (integer, 0–100)

```
validityW.   = validUntil <24h:40 | <7d:30 | <30d:20 | else:10 | null:10
recencyW.    = newest observedAt <7d:30 | <30d:20 | <90d:10 | else:5
implicationW.= REVIEW_MARKET_RESPONSE/REVIEW_POSITIONING:20 | other REVIEW_*:15
             | INVESTIGATE/VALIDATE_ASSUMPTION:10 | MONITOR:5 | NO_ACTION:0
freshnessW.  = freshness current ? 10 : 0
urgencyScore = validityW + recencyW + implicationW + freshnessW
urgencyClass = <25 LOW | <50 MODERATE | <75 HIGH | ≥75 IMMEDIATE
```

### 6.4 Time horizon (from urgency + validity)

`IMMEDIATE` if urgencyClass `IMMEDIATE` or valid within 7 d; `NEAR_TERM` if
`HIGH` or within 30 d; `MEDIUM_TERM` if `MODERATE` or within 90 d; else
`LONG_TERM`.

### 6.5 Confidence and evidence quality

`confidenceClass` is carried **verbatim** from R8-D (ceiling-binding).
Evidence quality is deterministic:

```
quality = confidenceRank{INSUFFICIENT:0,LOW:1,MODERATE:2,HIGH:3} × 20
        − min(30, 10 × contradictingCount)
        − min(10, 5 × missingEvidenceCount)
clamped to [0, 100]
```

No path — model, client or agent — may raise confidence, impact, or urgency.

### 6.6 Priority (integer fixed-point + caps)

```
priorityScore = impactRank{MINOR:0..SEVERE:3}     × 30
              + urgencyRank{LOW:0..IMMEDIATE:3}    × 20
              + confidenceRank                     × 25
              + (objective anchor ? 10 : 0)
              + (supporting anchors ≥ 3 ? 5 : 0)
              − min(45, 15 × contradictingCount)
              − min(30, 5  × uncertaintyClassCount)
              − (missingEvidence non-empty ? 10 : 0)
```

Caps (binding, checked in order):
1. `confidenceClass = INSUFFICIENT` → priorityClass `MONITOR`.
2. `confidenceClass = LOW` → priorityClass at most `MEDIUM`.
3. confidence ≤ LOW **and** impactClass ≥ MAJOR → priorityClass `MONITOR`
   (high impact + weak confidence becomes review/monitor, never autonomous
   top priority).
4. `CRITICAL_REVIEW` additionally requires confidence ≥ MODERATE and
   impactClass ≥ MAJOR.

Uncapped mapping: `<50 MONITOR | <90 LOW | <130 MEDIUM | <170 HIGH | ≥170
CRITICAL_REVIEW`. Contradiction lowers priority (factor 6) — it never raises
it.

## 7. Governance binding (E7) — R8-F is mandatory

Every candidate is submitted to R8-F as **proposal material only**:
`proposalId = candidateId`, `recommendationType` from the deterministic
implication→recommendation mapping, `evidenceRefs` = mem/chg/xsig refs,
`claimedConfidence` = scale-mapped candidate confidence, `declaredImpact` =
structured `{impactClass, urgencyClass, timeHorizon, priorityClass}` (no
floats). Client-supplied decision/risk/approval fields are rejected at the
boundary.

Bound verbatim: candidate ID, reasoning IDs, evidence fingerprint, impact,
urgency, confidence, strategic risk, priority, policy version, and the full
validated decision payload. Status resolution:

| R8-F decision | candidate status |
|---|---|
| `ALLOW_RECOMMENDATION` | priorityClass `MONITOR` → `MONITOR`; else `GOVERNED_RECOMMENDATION` |
| `REVIEW_REQUIRED` | `REVIEW_REQUIRED` (human approval must bind the exact candidate) |
| `BLOCK` | `BLOCKED` (terminal — can never become a governed R9 recommendation) |

- `ALLOW_RECOMMENDATION` → eligible for R9 handoff as **recommendation
  evidence only**.
- `REVIEW_REQUIRED` → requires a valid human approval on the shared ledger
  (`approvalType = strategic_recommendation`, F5 binding hash over decision +
  policy version + proposal fingerprint + evidence fingerprint). Forged,
  stale, cross-decision or edited approvals fail closed
  (`APPROVAL_BINDING_MISMATCH`). Self-approval is impossible (no approval
  write path in this stream).
- R8-F unavailable → fail closed (`GOVERNANCE_AUTHORITY_UNAVAILABLE`): no
  candidate is voiced on guessed governance.
- **No direct EXECUTE semantics.** Consumption scope is `RECOMMENDATION_ONLY`.

## 8. Lifecycle (E9)

Append-only `sorl1:` facts; current state is derived, history is never
edited. Re-evaluation triggers: reasoning superseded/contradicted/staled,
strategic memory changed, business change reverted, external signal
contradicted/staled, confidence change, governance change, validity expiry.
Material change ⇒ NEW superseding candidate (`supersedesCandidateId`),
preserving immutable history. Relations (`REINFORCING`/`OVERLAPPING`/
`CONFLICTING`/`SUPERSEDING`) are recomputed deterministically and preserve
source reasoning references; they never modify priority scores.

## 9. Client-authority rejection (fail closed)

`z.strictObject` router inputs; clients supply `{businessId, reasoningIds}`
and filters only. Rejected fields include: `decision`, `governanceDecision`,
`governanceDecisionId`, `priorityClass`, `priorityScore`, `impactClass`,
`urgencyClass`, `timeHorizon`, `confidenceClass`, `evidenceQualityScore`,
`strategicRiskClass`, `riskClass`, `status`, `approvalStatus`, `approved`,
`executable`, `candidateFingerprint`, `evidenceBundleFingerprint`,
`policyVersion`, `forceAllow`, `forceApprove`, `raiseConfidence`,
`raiseImpact`, `raiseUrgency`, `lowerRisk`, `suppressContradiction`,
`hideContradiction`, `overrideDecision`, `overridePolicy`.

## 10. Error taxonomy (fail closed)

`OWNERSHIP_MISMATCH`, `UNKNOWN_REASONING_REFERENCE`,
`REASONING_SCOPE_MISMATCH`, `STALE_REASONING`,
`REASONING_CONTRACT_VERSION_UNSUPPORTED`, `REASONING_PROJECTION_MALFORMED`,
`ZERO_USABLE_REASONING`, `GOVERNANCE_AUTHORITY_UNAVAILABLE`,
`GOVERNANCE_DECISION_MALFORMED`, `APPROVAL_BINDING_MISMATCH`,
`CANDIDATE_NOT_FOUND`, `CANDIDATE_REPLAY_CONFLICT`, `LIFECYCLE_CONFLICT`,
`CLIENT_AUTHORITY_FIELD_FORBIDDEN`, `EVIDENCE_FINGERPRINT_MISMATCH`.

## 11. Security invariants (rogue-agent rules)

A compromised opportunity/risk agent must not be able to: fabricate
reasoning or evidence; raise impact/urgency/confidence; hide contradiction;
inflate priority; lower strategic risk; self-approve; fabricate governance
ALLOW; mutate strategy/DNA/budget; launch campaigns/experiments; execute
shell/SQL/tools; access secrets; expand permissions. There is no policy
mutation endpoint, no approval write path, no execution call of any kind in
this stream.
