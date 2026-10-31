# MISSION AUTHORITY & OBJECTIVES CONTRACT (R9-A)

> **Owner:** R9-A Mission Authority & Objectives (`feature/r9-a-mission-authority`)
> **Authority:** converts eligible governed R8 strategic recommendations into
> bounded mission proposals and mission objectives
> **Contract version:** `mission-authority/v1`
> **Engine version:** `mission-authority-engine/v1`
> **Downstream projection:** `mission-authority-to-planning/v1`
> **Upstream (frozen, consumed not merged):** R8-E strategic opportunity/risk
> (`strategic-intelligence-to-mission-control/v1`, frozen R8 HEAD
> `4fc43c3b`) via the canonical R8-E stores/seams; R8-F strategic governance
> (`strategic-governance/v1`) through R8-E's consumption gate only.

---

## 1. Purpose and boundaries

R9-A owns **mission identity and mission-objective authority**: whether a
governed R8 recommendation is eligible to become a mission proposal, what
business objective the mission serves, its scope, expected outcomes, success
criteria, constraints, assumptions, strategic binding, validity window, and
its lifecycle **up to planning eligibility**, plus the read-only downstream
planning projection.

**Core authority rule (preserved verbatim on every surface):**

```
candidate != mission
recommendation != execution authorization
```

R8 governance approval authorizes **recommendation consumption only**. R9-A
may create a mission proposal; it must **never** create execution
authorization. There is no `EXECUTING` status in this contract, no task
creation, no scheduling, no dependency planning, no retries, no provider
invocation, no budget movement, no approval/governance authority, no
strategy/Business-DNA mutation anywhere in this stream.

### 1.1 Explicit non-ownership

| Never owned | Owning authority |
|---|---|
| Strategic-intelligence truth (candidates, reasoning, memory, signals) | R8-A…R8-F |
| Mission governance/approval (R9's own gates) | R9 governance (future stream) |
| Task decomposition, dependency planning, scheduling | R9-B planning |
| Execution coordination, retries, provider execution | R9-C/D execution |
| Budget execution / billing settlement | R4 billing authority |
| Strategy mutation / Business DNA mutation | Operator / strategy authority |

## 2. Mission proposal record

| Field | Type | Semantics |
|---|---|---|
| `missionId` | `mis1:<sha256>` | Deterministic identity (§3) |
| `objectiveId` | `obj1:<sha256>` | Deterministic objective identity (§3) |
| `tenantId` | number | Session-anchored tenant (`ctx.user.id`); **never client-supplied** |
| `businessId` | number | Owning business; server-verified ownership every call |
| `sourceCandidateId` | `sor1:<sha256>` | Exactly one governed R8-E candidate; reference verbatim |
| `sourceReasoningIds` | `rsn1:[]` | Governing R8-D conclusions carried verbatim from the candidate |
| `missionType` | closed enum (8) | Deterministic derivation from source candidate type (§5) |
| `objectiveType` | closed enum (8) | Deterministic derivation from source candidate type (§5) |
| `objectiveStatement` | string ≤ 500 | Bounded objective wording; client-authored or model-drafted (§4) |
| `objectiveWordingDraft` | string ≤ 500 \| null | Advisory model draft when supplied (inert bounded text) |
| `modelAssistanceFlagged` | boolean | Injection-pattern suspicion label on advisory wording (never blocks by itself; preserved verbatim) |
| `expectedOutcome` | string ≤ 500 | Bounded statement of the outcome the mission expects |
| `successCriteria` | array ≤ 8 | `{criterionType (closed 4), statement ≤ 280, metricRef ≤ 120 \| null}`; client-supplied inputs, preserved verbatim |
| `constraints` | array | Immutable mission-authority inputs (§6); derived set + client additions; never removed except governed supersession |
| `assumptions` | array ≤ 8 | `{statement ≤ 280}`; client-declared, preserved verbatim |
| `scope` | object | `{subjectType (closed 6), businessScope, channelScope: null, campaignScope: null, geography: null}` — deterministically derived (§4.3); never broader than the source candidate |
| `priorityContext` | closed enum (5) | Carried **verbatim** from the source candidate `priorityClass` |
| `strategicRisk` | closed enum (4) | Carried **verbatim** from the bound R8-F decision `strategicRiskClass` — never lowered |
| `governanceReference` | object | `{governanceDecisionId, governanceDecision, policyVersion, approvalRequirement, authorityScope: "RECOMMENDATION_ONLY"}` — bound verbatim |
| `validFrom` | ISO-8601 UTC | Formation time (injected-clock deterministic) |
| `validUntil` | ISO-8601 UTC | `min(sourceCandidate.validUntil, validFrom + 30d)` when candidate window present, else `validFrom + 30d` (§7) |
| `status` | closed enum (8) | Mission lifecycle (§8) — **no EXECUTING** |
| `supersedesMissionId` | `mis1:` \| null | Exact predecessor on governed supersession |
| `lineageHash` | `<sha256>` | Binds the verbatim R8 lineage (candidate identity, reasoning ids, governance reference, candidate fingerprint, projection version) |
| `missionFingerprint` | `<sha256>` | Immutable mission core fingerprint (replay-conflict anchor, §3) |
| `sourceProjection` | object | Verbatim 37-key `strategic-intelligence-to-mission-control/v1` projection bound at formation |
| `sourceVersions` | object | Frozen upstream contract versions bound at formation |
| `createdAt` / `updatedAt` | ISO-8601 | Persistence timestamps |
| `version` | int | Optimistic CAS for lifecycle transitions |

## 3. Deterministic identity (A2)

```
missionId = "mis1:" + sha256(canonicalJson({
  v: 1,
  tenantUserId,          // session anchor
  businessId,
  sourceCandidateId,     // governed R8 candidate (reference only)
  missionType,
  objectiveScope,        // canonical scope key (§4.3)
  constraintSetFingerprint
}))

objectiveId = "obj1:" + sha256(canonicalJson({
  v: 1, tenantUserId, businessId, sourceCandidateId,
  objectiveType, objectiveScope, objectiveStatement
}))

misl1 lifecycle fact identity = "misl1:" + sha256(canonicalJson({
  v: 1, missionId, lifecycleType, targetStatus, successorMissionId,
  occurredAt, reasonCode
}))
```

Same tenant + business + source governed candidate + mission type + objective
scope + constraint set ⇒ same `missionId`. Durable convergence anchor:
unique `(userId, missionId)`; retried/raced identical formation converges
(`idempotent_replay`, zero extra events). A formation arriving under the same
anchor with a different `missionFingerprint` fails closed
(`MISSION_REPLAY_CONFLICT`).

**No client-generated authority.** No model-created source candidate. The
client supplies reference ids and bounded inputs only; identity, types,
scope, risk, confidence ceilings, validity and lineage are server-derived.

**Eligibility rejection set (fail closed):** unknown R8 candidate ·
ungoverned candidate · wrong tenant · wrong business · stale candidate ·
invalid approval state · expired recommendation · tampered evidence or
projection · governance authority unavailable · client-authority field.

## 4. Objective formation (A3)

### 4.1 Authority sources

An objective may be formed **only** from: (a) a governed R8 strategic
opportunity/risk candidate (the sole source anchor), (b) an explicit
client-declared objective statement / expected outcome / success criteria /
assumptions (tenant inputs, bounded and preserved verbatim), (c) accepted
constraints (derived set + client additions), (d) the approved strategic
context carried by the candidate projection (reasoning/memory/change/signal
lineage refs, limitations, risk/confidence ceilings).

### 4.2 Model assistance — wording only

`modelAssistance.draftWording` (≤ 500 chars) may **reword the objective
statement** and nothing else. It can never: select `missionType` /
`objectiveType`, alter scope, add/remove/tighten/loosen constraints, set or
raise budget ceilings, change `strategicRisk`, `priorityContext`,
`confidenceClass`, validity, lineage, governance material or status. Advisory
wording is inert bounded printable text; injection-pattern suspicion is
recorded (`modelAssistanceFlagged`) and the wording travels labelled as
advisory. A model draft is never required for authority — deterministic
formation is complete without it.

### 4.3 Scope derivation (never broader than the source)

`scope.subjectType` is derived deterministically from the source candidate
type (§5 derivation table). `businessScope` is exactly the owning business.
`channelScope`, `campaignScope`, `geography` are `null` — the projection
carries no channel/campaign/geography authority, so none may be invented.
Mission scope is therefore structurally incapable of exceeding the source
candidate; any client- or model-supplied scope material is rejected
(`CLIENT_AUTHORITY_FIELD_FORBIDDEN`).

## 5. Closed vocabularies and derivation tables

### 5.1 Mission types (8)

`OPPORTUNITY_PURSUIT`, `RISK_RESPONSE`, `MARKET_EXPANSION`,
`POSITIONING_ACTION`, `CAPABILITY_ACTION`, `CHANNEL_SHIFT`,
`PORTFOLIO_REBALANCE`, `DEFENSIVE_RESPONSE`.

### 5.2 Objective types (8)

`GROWTH`, `RISK_REDUCTION`, `MARKET_EXPANSION`, `POSITIONING`,
`CAPABILITY_BUILD`, `CHANNEL_OPTIMISATION`, `PORTFOLIO_HEALTH`,
`RESILIENCE`.

### 5.3 Candidate-type derivation table (deterministic, rule-first)

| Candidate type (R8-E) | Mission type | Objective type | Scope subjectType |
|---|---|---|---|
| MARKET_EXPANSION | MARKET_EXPANSION | MARKET_EXPANSION | MARKET |
| DEMAND_GROWTH | OPPORTUNITY_PURSUIT | GROWTH | MARKET |
| POSITIONING_CHANGE | POSITIONING_ACTION | POSITIONING | MARKET |
| COMPETITIVE_RESPONSE | DEFENSIVE_RESPONSE | RESILIENCE | MARKET |
| PRODUCT_MARKETING | OPPORTUNITY_PURSUIT | GROWTH | PRODUCT_SET |
| CHANNEL_SHIFT | CHANNEL_SHIFT | CHANNEL_OPTIMISATION | CHANNEL |
| CAPABILITY_INVESTMENT | CAPABILITY_ACTION | CAPABILITY_BUILD | CAPABILITY |
| RESOURCE_REALLOCATION | PORTFOLIO_REBALANCE | PORTFOLIO_HEALTH | PORTFOLIO |
| REGULATORY_RESPONSE | DEFENSIVE_RESPONSE | RESILIENCE | BUSINESS |
| TECHNOLOGY_ADOPTION | CAPABILITY_ACTION | CAPABILITY_BUILD | CAPABILITY |
| REPUTATION_RESPONSE | DEFENSIVE_RESPONSE | RESILIENCE | BUSINESS |
| MARKET_DECLINE | RISK_RESPONSE | RISK_REDUCTION | MARKET |
| CAPABILITY_RISK | RISK_RESPONSE | RISK_REDUCTION | CAPABILITY |
| PORTFOLIO_RISK | PORTFOLIO_REBALANCE | PORTFOLIO_HEALTH | PORTFOLIO |
| STRATEGIC_MISALIGNMENT | RISK_RESPONSE | RISK_REDUCTION | BUSINESS |

Unknown candidate types fail closed (`SOURCE_PROJECTION_MALFORMED`).

### 5.4 Success criterion types (4)

`MEASURABLE_THRESHOLD`, `QUALITATIVE_REVIEW`, `GOVERNANCE_GATE`,
`TIME_BOUND_DELIVERABLE`.

### 5.5 Constraint types (13)

`MEASURABLE_OUTCOME_REQUIRED`, `ALLOWED_CHANNELS`, `ALLOWED_BUSINESS_UNIT`,
`TIME_HORIZON_LIMIT`, `BUDGET_CEILING`, `PROHIBITED_ACTION`,
`DEPENDENCY_REQUIRED`, `HUMAN_REVIEW_REQUIRED`, `RECOMMENDATION_ONLY`,
`RISK_CEILING`, `CONFIDENCE_CEILING`, `SCOPE_BOUND`, `VALIDITY_WINDOW`.

### 5.6 Scope subject types (6)

`BUSINESS`, `MARKET`, `PRODUCT_SET`, `CHANNEL`, `PORTFOLIO`, `CAPABILITY`.

### 5.7 Priority context (5)

Carried verbatim from the source candidate: `MONITOR`, `LOW`, `MEDIUM`,
`HIGH`, `CRITICAL_REVIEW`.

### 5.8 Strategic risk (4)

Carried verbatim from the bound R8-F decision: `LOW`, `MEDIUM`, `HIGH`,
`CRITICAL` — **never lowered** by anyone downstream of the decision.

## 6. Success criteria and constraints (A4)

**Derived constraint set** (always present, server-derived, immutable):

| Constraint | Content |
|---|---|
| `RECOMMENDATION_ONLY` | "Source R8 approval authorizes recommendation consumption only; it is never execution authorization." |
| `RISK_CEILING` | `strategicRiskClass` carried verbatim — mission risk may never exceed the source |
| `CONFIDENCE_CEILING` | candidate `confidenceClass` carried verbatim — never promote |
| `SCOPE_BOUND` | scope limited to §4.3 derivation |
| `VALIDITY_WINDOW` | `validFrom`/`validUntil` (§7) |

**Client additions** (optional, ≤ 8 total incl. derived): bounded entries of
the closed constraint types (e.g. `ALLOWED_CHANNELS` with a bounded string
list, `BUDGET_CEILING` with optional integer minor-unit amount + closed
3-letter currency, `PROHIBITED_ACTION`, `DEPENDENCY_REQUIRED`,
`HUMAN_REVIEW_REQUIRED`, `ALLOWED_BUSINESS_UNIT`). Client additions can only
**add or tighten**; they can never remove, loosen or contradict a derived
constraint (duplicate-type additions to a derived type are rejected
`INVALID_CONSTRAINT`).

**Success criteria** (1–8 client-supplied): `{criterionType, statement ≤
280, metricRef ≤ 120 | null}`. **Assumptions** (0–8): `{statement ≤ 280}`.

Constraints are immutable mission-authority inputs; the only mutation path
is governed supersession (`supersede` mints a NEW mission proposal with
`supersedesMissionId`; the predecessor is preserved forever with append-only
history).

## 7. Mission validity window

`validFrom` = formation timestamp. `validUntil` = `min(candidate.validUntil,
validFrom + 30 days)` when the candidate carries a validity window, else
`validFrom + 30 days`. Expiry never silently extends. A mission whose window
has lapsed reads `freshness: "stale"` and `revalidate` transitions it to
`STALE` — planning must not consume stale missions; re-formation requires a
fresh, currently-governed R8 candidate.

## 8. Mission lifecycle (A5)

Statuses (closed, exact): `PROPOSED`, `ELIGIBLE_FOR_PLANNING`,
`REVIEW_REQUIRED`, `BLOCKED`, `SUPERSEDED`, `STALE`, `CANCELLED`,
`INVALIDATED`.

```
                propose (consumable candidate required)
                        │
                        ▼
                    PROPOSED ───────────────┐
                        │                    │ cancel (operator, bounded reason)
        revalidate      │                    ▼
   ┌────────────────────┤                CANCELLED
   ▼                    │                    ▲
ELIGIBLE_FOR_PLANNING    │                    │
   │  ▲  ▲               │              (from any non-terminal)
   ▼  │  │               ▼
REVIEW_REQUIRED ◄── governance REVIEW_REQUIRED / approval pending
   │                    │
   ▼                    ▼
BLOCKED ◄── governance BLOCK / source BLOCKED       (terminal)
STALE ◄──── validity expired / source stale          (revalidate to recover only via fresh source)
SUPERSEDED ◄─ supersede (successor mission minted)   (terminal, history preserved)
INVALIDATED ◄ source contradicted/invalidated/tamper (terminal)
```

- `PROPOSED` → `ELIGIBLE_FOR_PLANNING` when revalidation confirms the source
  candidate is still governed, current and consumable.
- `REVIEW_REQUIRED` reflects the bound governance state requiring/awaiting
  human review (approval pending or REVIEW_REQUIRED decision); it is a
  formation-lifecycle label, **not** an R9-A governance decision.
- `BLOCKED` reflects governance BLOCK — terminal.
- All transitions are append-only `misl1:` facts + one audit event each;
  convergence paths emit zero events; CAS version drift fails closed
  (`LIFECYCLE_CONFLICT`).
- **No `EXECUTING` status exists.** Execution belongs to downstream streams
  under separate governance.

## 9. R8 handoff binding (A6)

Formation consumes the frozen R8 surface read-only and revalidates, on every
formation and revalidation:

1. candidate identity resolves for this tenant + business (cross-tenant and
   cross-business are indistinguishable from unknown — both fail closed);
2. the durable candidate row rebuilds the verbatim 37-key projection via
   R8-E's frozen builder and validates it exactly (any extra/missing key,
   wrong version or non-verbatim disclaimer ⇒ `SOURCE_PROJECTION_MALFORMED`);
3. R8-F consumption gate (`assertCandidateConsumable`) passes with
   `authorityScope RECOMMENDATION_ONLY` — governance decision identity,
   decision, policy version, approval state and freshness verified; BLOCK is
   terminal; forged/expired/edited approvals fail closed;
4. candidate freshness is `current`, approval state valid, limitations and
   lineage preserved verbatim into the mission record.

No R8 projection is ever mutated; no R8 recommendation is ever strengthened
(confidence, priority, impact, urgency and risk ceilings are copied or
carried, never promoted).

## 10. Security / agent boundary (A7)

Assume a compromised mission-formulation agent. By construction it cannot:
fabricate a source recommendation (identity is client-reference-only; the
server resolves durable rows); widen mission scope (derived); remove
constraints (derived set immutable; model input is wording-only); increase
budget (no model path to amounts; client ceilings preserved verbatim and can
only be re-declared on supersession, which mints new identity); lower
strategic risk (carried verbatim); claim execution authority (no status/task/
execution vocabulary); mutate Business DNA or strategy (no write path);
approve itself (no approval authority); invoke providers; execute tools;
access secrets; or expand permissions (session `userId` anchors every read
and write; `z.strictObject` rejects every authority field at the boundary).

## 11. Downstream planning contract

Read-only planning projection: `mission-authority-to-planning/v1`
(`docs/contracts/mission-authority-to-planning-contract.md`). Planning may
decompose; planning may **never** rewrite mission authority.

---

**R8 reminder (verbatim):** *plan missions on your own authority. These
candidates inform; they never instruct.*
