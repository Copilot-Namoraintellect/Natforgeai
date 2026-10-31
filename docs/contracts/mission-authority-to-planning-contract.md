# MISSION AUTHORITY → PLANNING CONTRACT (R9-A → R9-B/C)

> **Producer:** R9-A Mission Authority & Objectives
> (`feature/r9-a-mission-authority`)
> **Consumer:** R9 Mission Control planning/execution streams (future, read-only)
> **Status:** canonical downstream contract — planning reads, never redefines
> or mutates
> **Projection version:** `mission-authority-to-planning/v1`
> **Source of truth:** `docs/contracts/mission-authority-contract.md` (R9-A
> canonical) + `api/lib/mission-authority/mission-authority-projection.ts`
> (`MISSION_PLANNING_PROJECTION_FIELD_KEYS` — asserted exact in acceptance)

---

## 1. Purpose and boundaries

R9-A owns mission proposals and mission-objective authority. This contract is
the **only** surface through which planning (task decomposition, dependency
analysis, scheduling) and downstream execution coordination consume missions.
Downstream may read and must never mutate: no planning call may write
`mission_proposals`, `mission_lifecycle_events`, or any upstream authority
table, and no consumer may mint mission identities, objectives, constraints,
classifications, statuses, validity windows or lifecycle facts.

**mission != task. mission proposal != execution authorization.**

A mission proposal is bounded formulation authority over one governed R8
recommendation. Nothing in this projection pre-approves, pre-arms or bypasses
planning's own governance gates; execution authorization remains a downstream
decision under separate governance.

## 2. Consuming surface

Planning reads **only** through the tenant-scoped tRPC procedure on the
`missionAuthority` router:

| Procedure | Read model |
|---|---|
| `missionAuthority.getPlanningHandoff` | Frozen projection for ONE mission (`missionId` input). No listing authority: planning discovers mission ids through its own authorised channels; this stream does not rank or recommend missions. |

The pure projection builder `buildMissionPlanningProjection`
(`api/lib/mission-authority/mission-authority-projection.ts`) is the frozen
builder; consumers may rebuild projections from durable rows but must never
extend the key allowlist.

## 3. Planning-eligibility gate

A projection is planning-consumable **only** when `status ===
"ELIGIBLE_FOR_PLANNING"` **and** `freshness === "current"` **and**
`governanceAuthorityScope === "RECOMMENDATION_ONLY"`. Every projection also
carries `planningClaimed: false` / `executionClaimed: false` and verbatim
disclaimers (§5); consumers must not infer eligibility from any other field.

## 4. Projection field allowlist (exact, 27 keys)

| Key | Type | Semantics |
|---|---|---|
| `contractVersion` | `"mission-authority-to-planning/v1"` | Frozen projection version |
| `missionId` | `mis1:…` | Opaque canonical identity — reference verbatim |
| `objectiveId` | `obj1:…` | Mission objective identity |
| `businessId` | `number` | Owning business (server-verified) |
| `missionType` | closed enum (8) | from the mission record |
| `objectiveType` | closed enum (8) | from the mission record |
| `objectiveStatement` | string | bounded formulation wording |
| `expectedOutcome` | string | bounded expected outcome |
| `successCriteria` | array | preserved verbatim (immutable inputs) |
| `constraints` | array | preserved verbatim — the full derived + client constraint set |
| `assumptions` | array | preserved verbatim |
| `scope` | object | `{subjectType, businessScope, channelScope, campaignScope, geography}` — derived, never broader than source |
| `priorityContext` | closed enum (5) | carried verbatim from source candidate |
| `strategicRisk` | closed enum (4) | carried verbatim from bound R8-F decision — never lowered |
| `validity` | object | `{validFrom, validUntil}` — mission validity window |
| `status` | closed enum (8) | mission lifecycle status (no EXECUTING) |
| `freshness` | `current\|stale` | computed at read — never stored |
| `r8Lineage` | object | `{sourceCandidateId, sourceReasoningIds, governanceDecisionId, governanceDecision, policyVersion, limitations}` — preserved verbatim |
| `governanceAuthorityScope` | `"RECOMMENDATION_ONLY"` | always; never execution |
| `governanceRequirements` | string[] | derived governance obligations (e.g. human review before material action) |
| `supersedesMissionId` | `mis1:\|null` | exact predecessor |
| `planningClaimed` | `false` | always false |
| `planningDisclaimer` | string | verbatim (§5) |
| `executionClaimed` | `false` | always false |
| `executionDisclaimer` | string | verbatim (§5) |

## 5. Verbatim disclaimers (on every projection)

```
planningClaimed: false
planningDisclaimer: "A mission proposal is bounded mission authority, not a
  plan. Task decomposition, dependency analysis, scheduling and sequencing
  remain downstream planning authority under separate governance."
executionClaimed: false
executionDisclaimer: "A mission proposal is never an execution authorization:
  no task, campaign, budget, Business DNA, experiment, provider, payment or
  billing state may be mutated from this projection. mission != task;
  recommendation != execution authorization."
```

## 6. Hard rules for planning

1. **Read-only.** No planning write path to any R9-A or upstream table.
2. **Authority is immutable.** Planning may decompose within the mission
   scope; it may never rewrite mission authority (objective, constraints,
   risk ceilings, validity, lineage). Deviations require governed
   supersession by R9-A (new `mis1:` identity) — never in-place edits.
3. **Ceilings bind.** `strategicRisk`, `priorityContext`, confidence and
   impact ceilings travel verbatim; no consumer may promote or lower them.
4. **Staleness demotes.** `freshness: "stale"` projections (or non-eligible
   statuses) must not anchor planning; mission revalidation is an R9-A
   authority.
5. **Supersession chains preserved.** Both a superseded mission and its
   successor remain queryable forever via `supersedesMissionId`.
6. **mission != task; recommendation != execution authorization.**
