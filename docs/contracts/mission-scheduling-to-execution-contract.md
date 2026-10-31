# MISSION SCHEDULING → EXECUTION CONTRACT (R9-C → R9-D)

> **Owner:** R9-C Dependency & Scheduling Intelligence (producer);
> R9-D execution coordination (consumer, future stream)
> **Projection version:** `mission-scheduling-to-execution/v1`
> **Binding:** R9-X binds this port to frozen R9-D

---

## 1. Purpose and authority boundary

This is the **only** surface through which scheduling evidence reaches the
execution side. It is read-only, frozen-key and carries verbatim disclaimers.
It exposes deterministic ordering evidence; it authorizes nothing.

```
schedule != execution authorization
readiness != authorization
schedulable != executable
```

R9-D **must** call R9-F's execution consumption gate
(`assertMissionActionConsumable`) independently for every material action.
A schedule — including a `READY` schedule with `requiresApproval=false` —
never substitutes for that gate. Mission approval ≠ task approval ≠ provider
authorization (R9-F phase separation).

## 2. Frozen projection key allowlist (exact)

The projection object carries **exactly** these 20 keys — asserted exact in
acceptance; unknown keys are a contract violation:

```
contractVersion          "mission-scheduling-to-execution/v1"
scheduleId               sch1:<sha256>
missionId                mis1:<sha256>
planId                   opaque R9-B plan coordinate
planFingerprint          <sha256> accepted plan snapshot fingerprint
status                   PROPOSED|VALIDATED|READY|BLOCKED|SUPERSEDED|STALE|INVALIDATED|CANCELLED
orderedTaskIds           string[] deterministic linear order (slot-major, lexicographic within slot)
parallelGroups           string[][] scheduling-level concurrency slots
dependencyRefs           {dependencyId, predecessorTaskId, successorTaskId,
                         dependencyType, hardOrSoft, source}[]
blockingStates           {taskId, readiness, reasons[]}[]
constraints              plan-declared TIME_WINDOW / EXCLUSIVE_RESOURCE per ordered task
governanceRequirements   {requiresApproval, reasonCodes[], authorityScope,
                         consumptionGate, governanceAuthorityUnavailable}
riskClass                LOW|MEDIUM|HIGH|CRITICAL
validity                 {validFrom, validUntil}
evidence                 {graphHash, stateViewHash, readinessHash,
                         approvalEvidenceHash, capabilityEvidenceHash, scheduleFingerprint}
limitations              string[] verbatim limitation labels
scheduleClaimed          false   (constant)
executionClaimed         false   (constant)
schedulingDisclaimer     verbatim
executionDisclaimer      verbatim
```

## 3. Semantics R9-D may rely on

- `orderedTaskIds` respects every HARD ordering edge; `parallelGroups` slots
  contain no MUTUAL_EXCLUSION pair and no shared `EXCLUSIVE_RESOURCE` key.
- `blockingStates` is exhaustive for the bound inputs: any task not listed
  there was `READY_FOR_SCHEDULING` at production time.
- `status` is a scheduling lifecycle status; it never transitions to
  `EXECUTING` here and R9-D must not derive execution state from it.
- Superseded schedules remain readable for lineage; only the newest active
  schedule reflects current scheduling evidence.

## 4. Semantics R9-D must NOT rely on

- The projection is not freshness authority: re-validate `validity` and
  obtain R9-F consumption before acting.
- `parallelGroups` are scheduling hints, not execution guarantees — actual
  concurrency is execution-side authority.
- `constraints` and capability evidence are plan-declared contract material;
  scheduling cannot widen them and neither can R9-D.
- The projection never includes approval state objects, budget state,
  provider credentials or task content.

## 5. Failure posture

Absent or malformed projection ⇒ R9-D fails closed (no execution decision
may be derived from missing scheduling evidence). A `BLOCKED`, `STALE`,
`SUPERSEDED`, `INVALIDATED` or `CANCELLED` schedule ⇒ no execution ordering
may be consumed from it. `governanceAuthorityUnavailable=true` ⇒ all approval
evidence degraded to unsatisfied; re-govern before any approval-gated step.
