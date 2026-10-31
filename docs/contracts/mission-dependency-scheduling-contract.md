# MISSION DEPENDENCY & SCHEDULING CONTRACT (R9-C)

> **Owner:** R9-C Dependency & Scheduling Intelligence (`feature/r9-c-dependency-scheduling`)
> **Authority:** converts governed mission-plan structure into validated dependency
> graphs, task readiness and deterministic schedules
> **Contract version:** `mission-dependency-scheduling/v1`
> **Engine version:** `mission-scheduling-engine/v1`
> **Input port:** `mission-task-plan/v1` (typed R9-B task-plan port — R9-X binds it)
> **State port:** `mission-scheduling-state/v1`
> **Downstream projection:** `mission-scheduling-to-execution/v1`
> **Upstream (frozen, consumed not merged):** R9-A mission authority
> (`mission-authority/v1`, frozen HEAD `273ce40`); R9-F mission governance
> (`mission-governance/v1`, frozen HEAD `1665d2f`)

---

## 1. Purpose and boundaries

R9-C owns **dependency structure and scheduling semantics** for governed
mission work: which tasks depend on which, which may run in parallel, which
are blocked, what must be satisfied first, what sequencing is safe, what
resource/capability contention exists, what timing constraints apply, what
the earliest safe deterministic schedule is, and **when no schedule may be
produced at all**.

**Core authority rules (preserved verbatim on every surface):**

```
schedule != execution authorization
readiness != authorization
schedulable != executable
candidate schedule != approved schedule change
```

R9-C produces ordering evidence. It must **never** produce execution
authorization. There is no `EXECUTING` status in this contract, no provider
invocation, no budget movement, no approval minting, no capability minting,
no retry/recovery authority, no mission-completion truth, no upstream
(R9-A/R9-F) table write anywhere in this stream.

### 1.1 Explicit non-ownership

| Never owned | Owning authority |
|---|---|
| Mission objective / mission validity / mission status | R9-A |
| Task definition / task-plan semantics | R9-B (bound via the `mission-task-plan/v1` input port at R9-X) |
| Governance decisions / approvals / the consumption gate | R9-F |
| Execution coordination, retries, recovery, provider calls | R9-D (+ R9-F gates) |
| Budget execution / billing settlement | R4 billing authority |

**Development boundary (R9-B in parallel):** R9-C does not invent or freeze
the task-definition contract. It defines only the typed, versioned
**scheduling input port** (§2) that future frozen R9-B must satisfy.

## 2. Scheduling input port (C1)

```ts
missionTaskPlanPortSchema = z.strictObject({
  portVersion: z.literal("mission-task-plan/v1"),
  missionId: /mis1:[a-f0-9]{64}/,        // existing R9-A mission
  planId:    opaque bounded id,           // R9-B-owned plan coordinate
  supportedCapabilities: string[] ≤ 32,   // environment contract (never widened)
  tasks: [1..200] of z.strictObject({
    taskId:   opaque bounded id,
    taskType: string ≤ 64,                // opaque B-owned label
    preconditions:  string[] ≤ 8,          // bounded refs
    postconditions: string[] ≤ 8,
    requiredCapabilities: string[] ≤ 8,
    constraints: [TIME_WINDOW {notBefore?, notAfter?} | EXCLUSIVE_RESOURCE {resourceKey}] ≤ 8,
    governanceCharacteristics: {
      requiresApproval: boolean,           // B-declared material
      irreversible: boolean,
      financialExposure: boolean,
      sideEffectClass: NONE|OBSERVATION|INTERNAL_MUTATION|EXTERNAL_SIDE_EFFECT|FINANCIAL|IRREVERSIBLE,
      declaredRiskClass: LOW|MEDIUM|HIGH|CRITICAL?  // raise-only material
    },
    validity: { validFrom, validUntil } | null
  })
})
```

The port is **not permission to invent missing plan data**: unknown
`portVersion`, malformed documents, duplicate task ids, inverted validity
windows and unknown missions all fail closed (`PLAN_PORT_VERSION_UNSUPPORTED`,
`PLAN_PORT_MALFORMED`, `UNKNOWN_MISSION`). Accepted documents are stored
**verbatim** as scheduling material (`mission_task_plan_snapshots`); R9-C
schedules around them and never rewrites them.

**Execution-state port** (`mission-scheduling-state/v1`): `{ completedTaskIds,
succeededTaskIds }` — untrusted scheduling material, validated as a subset of
plan tasks (`succeeded ⊆ completed`), visibly bound into the schedule
identity. It is never execution truth and never mints completion.

## 3. Dependency edge record (C2)

| Field | Type | Semantics |
|---|---|---|
| `dependencyId` | `dep1:<sha256>` | Deterministic identity (§4); MUTUAL_EXCLUSION pairs normalised to canonical endpoint order |
| `tenantId` | number | Session anchor (`ctx.user.id`); never client-supplied |
| `businessId` | number | Server-derived from the R9-A mission |
| `missionId` / `planId` | `mis1:` / opaque | Single mission+plan scope; cross-scope references fail closed |
| `predecessorTaskId` / `successorTaskId` | opaque | Both must exist in the registered plan |
| `dependencyType` | closed enum (7) | `REQUIRES_COMPLETION`, `REQUIRES_SUCCESS`, `REQUIRES_OUTPUT`, `REQUIRES_APPROVAL`, `REQUIRES_CAPABILITY`, `REQUIRES_TIME_WINDOW`, `MUTUAL_EXCLUSION` |
| `reason` | string ≤ 280 \| null | Bounded declaration text |
| `hardOrSoft` | `HARD` \| `SOFT` | HARD ordering edges shape the DAG; SOFT edges are recorded evidence only |
| `source` | closed enum (3) | `PLAN_DERIVED`, `OPERATOR_DECLARED`, `SCHEDULING_DERIVED` |
| `createdAt` | timestamp | Persistence time |

Edge rows are **immutable**; `evidenceHash` binds the immutable core and
drift fails closed (`SCHEDULING_TAMPER`). Exact-once anchors: unique
`(tenant, dependencyId)` and natural `(tenant, missionId, planId,
predecessor, successor, type)`.

## 4. Deterministic identity (C3/C5)

```
dependencyId = "dep1:" + sha256({v:1, tenantUserId, businessId, missionId, planId,
  predecessorTaskId, successorTaskId (canonical order for MUTUAL_EXCLUSION),
  dependencyType, hardOrSoft, source, reason})

scheduleId = "sch1:" + sha256({v:1, tenantUserId, businessId, missionId, planId,
  planFingerprint, graphHash, stateViewHash, approvalEvidenceHash,
  capabilityEvidenceHash, orderedTaskIds, parallelGroups, blockingStates,
  readinessHash, validUntil})
```

The injected clock **never** participates in identity. Same authoritative
inputs ⇒ same `sch1:` and same ordering. Replayed identical production
converges (`idempotent_replay`, zero new durable effects, zero lifecycle
facts, zero audit events). Durable unique anchors make retries/converge
deterministic; conflicting replay of the same anchor fails closed
(`SCHEDULING_REPLAY_CONFLICT`).

## 5. Graph validation (C3) — cycles fail closed

Every edge is validated against the **full plan graph** before acceptance.
Rejections (all fail closed): self-cycle (`SELF_DEPENDENCY`), direct or
indirect cycle (`SCHEDULING_CYCLE` with a deterministic witness path),
unknown predecessor/successor (`UNKNOWN_*_TASK`), cross-mission
(`CROSS_MISSION_DEPENDENCY`), cross-plan (`CROSS_PLAN_DEPENDENCY`),
cross-tenant (`CROSS_TENANT_DEPENDENCY`), cross-business
(`CROSS_BUSINESS_DEPENDENCY`), malformed edge, and plan-size limits
(`SCHEDULING_GRAPH_TOO_LARGE`, 200 tasks / 1000 edges / hard traversal-step
budget). Traversal is iterative three-colour DFS over lexicographically
sorted adjacency with Kahn levelisation — **no model or agent can override
cycle detection**; the graph module is pure and rule-only.

## 6. Readiness (C4) — derived, never supplied

Derived deterministically from the validated graph, the accepted plan, the
execution-state view, R9-F approval evidence, plan capability contract and
mission/task validity. Closed outcomes (precedence order):
`INVALID` > `STALE` > `BLOCKED_DEPENDENCY` > `BLOCKED_APPROVAL` >
`BLOCKED_CAPABILITY` > `BLOCKED_TIME_WINDOW` > `BLOCKED_CONSTRAINT` >
`READY_FOR_SCHEDULING`.

- `REQUIRES_COMPLETION` satisfied by completion; `REQUIRES_SUCCESS` by
  success; `REQUIRES_OUTPUT` by success plus a declared postcondition;
  `REQUIRES_APPROVAL` by a current R9-F `ALLOW` on the exact bound task;
  `REQUIRES_CAPABILITY` by the plan capability contract; time-window edges
  by the successor window.
- Readiness is **relative to the bound state view and evidence** and is
  labelled as such downstream; a client can no more mark a task ready or an
  approval satisfied than it can mint an R9-F decision.

## 7. Scheduling (C5–C7)

- **Ordering** = deterministic Kahn levels over HARD ordering edges; within a
  level, ready tasks are packed greedily (lexicographic order) into parallel
  slots. Identical inputs always yield the same ordering, the same parallel
  groups and the same identity.
- **Contention (C6)**: tasks connected by a MUTUAL_EXCLUSION edge or sharing
  an `EXCLUSIVE_RESOURCE` key never share a slot — contention may serialize,
  it may **never** grant capability. No resource is invented beyond what the
  plan declares and the repository represents.
- **Time (C7)**: mission `validUntil`, task validity, task `TIME_WINDOW`
  constraints and approval expiry bind every schedule. Expired missions and
  stale tasks are **not scheduled**; expired authority is never scheduled as
  current. Scheduling urgency never weakens governance and never lowers risk.
- **Risk**: deterministic, server-derived, **raise-only** (side-effect
  classes, declared risk material raise; urgency near window close may raise
  one class). Nothing lowers it.

## 8. Schedule lifecycle (C8)

`PROPOSED → VALIDATED → READY | BLOCKED`, plus `SUPERSEDED`, `STALE`,
`INVALIDATED`, `CANCELLED`. **No `EXECUTING` exists.** Status transitions are
optimistic-CAS guarded (`version`); every transition mints an append-only
`msl1:` lifecycle fact; history is never edited. Changed inputs (new edges,
changed execution state, changed approval evidence/expiry, changed plan
revision) mint a **superseding** schedule bound by `supersedesScheduleId`;
lineage is preserved.

## 9. Governance boundary (C9)

Scheduling consumes R9-F **read-only**. It may set `requiresApproval=true`
(with closed reason codes: `REQUIRES_APPROVAL_MATERIAL`,
`APPROVAL_EVIDENCE_MISSING`, `SIDE_EFFECT_REVIEW`, `RISK_REVIEW`,
`SEQUENCE_CHANGED`) but **never creates `ALLOW`** and never invokes
`assertMissionActionConsumable` on a consumer's behalf. Schedule changes that
alter side-effect sequence, provider order, financial exposure, irreversible
actions or an approved action fingerprint surface `SEQUENCE_CHANGED` for
re-governance. When the governance authority is unavailable, approval
evidence degrades to unsatisfied (fail-closed) and the limitation is carried
verbatim on the projection.

## 10. When no schedule is produced

Scheduling refuses (no durable schedule) for: dependency cycles, unknown
missions/plans/tasks, cross-scope references, unschedulable mission status,
expired mission validity, malformed ports/state, or unavailable mission
authority (`MISSION_SCHEDULING_AUTHORITY_UNAVAILABLE`). A produced schedule
may legitimately be `BLOCKED` — that is evidence of blocking state, not a
failure to schedule.

## 11. Downstream

The read-only `mission-scheduling-to-execution/v1` projection
(`docs/contracts/mission-scheduling-to-execution-contract.md`) carries
ordering, parallel groups, dependency refs, blocking states, governance
requirements, validity, evidence hashes and verbatim disclaimers. R9-D must
call R9-F's consumption gate independently for every material action.

## 12. Audit

Additive canonical events on the shared ledger: `mission_dependency_recorded`
(one per inserted edge), `mission_schedule_committed` (one per inserted
schedule), `mission_schedule_lifecycle` (one per inserted msl1 fact).
Convergence/replay paths emit zero events. Metadata carries ids, closed
labels and hashes only — never task content, secrets or PII.

## 13. Schema

`mission_task_plan_snapshots`, `mission_dependency_edges`,
`mission_schedules`, `mission_schedule_lifecycle_events` — stream-local
provisional migration `0037_r9_c_dependency_scheduling_foundation`
(**artefact only, NOT executed**; canonical `0036` untouched; R9-X owns
canonical 0037 convergence). `MIGRATION_EXECUTION=False`.
