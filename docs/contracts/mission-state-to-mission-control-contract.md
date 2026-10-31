# MISSION STATE → MISSION CONTROL CONTRACT (R9-E → R9-X)

> **Producer:** R9-E Mission State, Recovery & Observability
> (`feature/r9-e-mission-state-recovery`)
> **Consumer:** R9-X / future mission-control integration (read-only)
> **Status:** canonical downstream contract — R9-X reads, never redefines
> **Projection version:** `mission-state-to-mission-control/v1`
> **Source of truth:** `docs/contracts/mission-state-recovery-contract.md`

---

## 1. Purpose and boundaries

This is the **only** surface through which R9-E operational state reaches
mission-control consumers. It is read-only, frozen-key, carries verbatim
disclaimers, and exposes what the mission's operational state is — never
what the mission should be, never authorization to change anything.

```
observability != authority
recovery proposal != recovery authorization
authorized recovery != execution
```

R9-E derives state and proposes recovery; R9-F authorizes; R9-D executes.
This projection authorizes nothing, mutates nothing, and no consumer may
derive authority from it. Mission objective (R9-A), task definition (R9-B),
schedule authority (R9-C), execution history (R9-D) and governance (R9-F)
remain the sole authorities for their planes.

## 2. Frozen projection key allowlist (exact)

The projection object carries **exactly** these keys — asserted exact in
acceptance; unknown keys are a contract violation:

```
contractVersion            "mission-state-to-mission-control/v1"
missionId                  mis1:<sha256>
planId                     opaque R9-B plan coordinate
scheduleId                 sch1:<sha256>
businessId                 number
missionStatus              verbatim R9-A mission status
healthClass                HEALTHY | DEGRADED | BLOCKED | AT_RISK | FAILED |
                           UNCERTAIN | COMPLETED
taskSummary                { total, byStatus, requiredTotal,
                             requiredSucceeded, driftTaskCount? }
taskStates[]               { taskId, status, failureClass, uncertaintyClass,
                             retryEligibility, recoveryRequired,
                             blockingReasons[], uncertainties[],
                             latestAttemptId, lastUpdatedAt }
latestExecutionRefs[]      exa1:<sha256> refs (newest first, ≤100)
blockingReasons[]          closed labels (≤8)
uncertainties[]            closed labels (≤8)
recoveryCandidates[]       { recoveryCandidateId, taskId, recoveryType,
                             status, failureClass, uncertaintyClass,
                             latestAttemptId, advisoryOnly: true }
governanceStatus           NONE | PROPOSED | REVIEW_REQUIRED | AUTHORIZED |
                           BLOCKED
latestAuthoritativeRefs    { missionFingerprint, planFingerprint,
                             scheduleFingerprint, missionStateId }
observedAt                 ISO-8601 UTC
derivedFromVersion         <sha256> (stateDerivationHash)
validUntil                 ISO-8601 UTC
limitations                string[] verbatim limitation labels
disclaimer                 verbatim
historyDisclaimer          verbatim
```

## 3. Semantics R9-X may rely on

- Task `status` ∈ `PENDING | READY | DISPATCHED | PENDING_EXTERNAL |
  SUCCEEDED | FAILED_RETRYABLE | FAILED_FINAL | UNCERTAIN | BLOCKED |
  STALE | CANCELLED` — derived by the rule-ordered contract §6.2; no
  inferred success anywhere (`SUCCEEDED` requires an authoritative R9-D
  success attempt).
- `healthClass = COMPLETED` only when every required task (current
  schedule ∩ current plan) is SUCCEEDED, no uncertainty is open, no
  blocking reason exists, and mission/plan/schedule authorities are
  current. Optional/drift work can never falsely complete or block.
- `retryEligibility` is proposal material only — never retry authority.
- `recoveryCandidates[].advisoryOnly` is always `true`; candidate status
  reflects the R9-E lifecycle (`PROPOSED | REVIEW_REQUIRED | AUTHORIZED |
  IN_PROGRESS | RESOLVED | FAILED | SUPERSEDED | STALE | CANCELLED |
  INVALIDATED`), where AUTHORIZED/IN_PROGRESS mean R9-F authorization was
  consumed read-only and any execution handoff was emitted to R9-D.
- When no persisted observation exists, the projection is derived
  read-only from the authoritative world for a single response (marked by
  the current `observedAt`/`derivedFromVersion`); it is never persisted by
  the read.

## 4. Semantics R9-X must NOT rely on

- The projection is not authority: it contains no approval state, no
  policy content, no governance receipts, no execution authorization.
- The projection is not execution history: R9-D remains the sole writer
  and owner of execution records; consumers must never rewrite them.
- The projection is not causation or outcome truth (R7 authorities own
  outcome truth).
- The projection never includes secrets, credentials, provider tokens,
  action parameters or raw provider payloads — only hashes, closed labels
  and bounded references.

## 5. Failure posture

Absent upstream authority (unexecuted provisional migrations, frozen
branches not merged) fails closed: the read surfaces
`MISSION_STATE_AUTHORITY_UNAVAILABLE` (never fabricated state). Malformed
upstream execution rows throw rather than derive from corrupted evidence.

## 6. Verbatim disclaimers

```
disclaimer:
  "observability != authority. This projection is derived operational state —
   never mission objective, never execution authorization, never governance.
   recovery proposal != recovery authorization; authorized recovery !=
   execution."

historyDisclaimer:
  "execution history is immutable input. Uncertainty != success; failure is
   never silently converted to success. Consumers must never rewrite
   upstream authority records."
```
