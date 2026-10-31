# MISSION EXECUTION → STATE & RECOVERY CONTRACT (R9-D → R9-E)

> **Producer:** R9-D Execution Coordination (`feature/r9-d-execution-coordination`)
> **Consumer:** R9-E Mission State & Recovery (future stream, read-only)
> **Status:** canonical downstream contract — R9-E reads, never redefines
> **Projection version:** `mission-execution-to-state-recovery/v1`
> **Source of truth:** `docs/contracts/mission-execution-coordination-contract.md`

---

## 1. Purpose and boundaries

This is the **only** surface through which execution state reaches the
recovery/observability side. It is read-only, frozen-key, carries verbatim
disclaimers, and exposes what happened during execution — never why a
mission existed, never authorization to change anything.

```
dispatch != success
observation != recovery authority
retry candidate != retry authorization
```

R9-D emits retry/recovery **candidate state** only. Retry authorization
remains R9-F authority; recovery orchestration remains R9-E authority. R9-E
may observe and may recover; it may **never** rewrite execution history:
no R9-D table is mutable through this projection, and no consumer may mint,
edit or delete execution actions, attempts or lifecycle facts.

## 2. Frozen projection key allowlist (exact)

The projection object carries **exactly** these keys — asserted exact in
acceptance; unknown keys are a contract violation:

```
contractVersion            "mission-execution-to-state-recovery/v1"
executionActionId          exa1:<sha256>
attemptId                  exr1:<sha256> | null
missionId                  mis1:<sha256>
planId                     opaque R9-B plan coordinate
scheduleId                 sch1:<sha256>
taskId                     opaque R9-B task coordinate
actionType                 EXECUTE_TASK | EXECUTE_STEP | RETRY_STEP
adapterType                CAMPAIGN | CONTENT | SOCIAL | CRM | NOTIFICATION |
                           ANALYTICS | INTERNAL_WORKFLOW
attemptNumber              int ≥ 1 | null
dispatchState              NEVER_ATTEMPTED | DISPATCH_PREPARED | DISPATCHED |
                           ACKNOWLEDGED | SUCCEEDED | FAILED | UNCERTAIN |
                           CANCELLED
resultStatus               SUCCEEDED | FAILED_RETRYABLE | FAILED_FINAL |
                           PENDING_EXTERNAL | UNCERTAIN | null
failureClass               NONE | ADAPTER_REJECTED | PROVIDER_ERROR | TIMEOUT |
                           CONNECTION_LOSS | AMBIGUOUS_CALLBACK | VALIDATION |
                           INTERNAL
uncertaintyClass           NONE | TIMEOUT | CALLBACK_AMBIGUOUS |
                           PARTIAL_CONFIRMATION | PROVIDER_STATE_UNKNOWN
externalReference          string | null
authorizationFingerprint   <sha256>
idempotencyKey             idem1:<sha256>
startedAt                  ISO-8601 UTC | null
completedAt                ISO-8601 UTC | null
retryCandidate             { required: boolean, reason: string | null }
limitations                string[] verbatim limitation labels
executionDisclaimer        verbatim
observabilityDisclaimer    verbatim
```

## 3. Semantics R9-E may rely on

- One projection per `(executionActionId, attemptId)` — the latest attempt of
  an action carries the current observable state; superseded attempts remain
  queryable via the action's attempt list (immutable history).
- `resultStatus` is conservatively classified (R9-D §7): `UNCERTAIN` and
  `PENDING_EXTERNAL` are **never** success signals.
- `retryCandidate.required=true` means a retry/recovery review may be
  warranted — it grants no authority; a retry needs fresh R9-F consumption.
- Rows are append-only; history is never edited. `resultHash` /
  `dispatchFingerprint` integrity is enforced by R9-D (`EXECUTION_TAMPER`).

## 4. Semantics R9-E must NOT rely on

- The projection is not authorization: it contains no approval state, no
  policy content, no governance receipts.
- The projection is not causation or outcome truth (R7 authorities own
  outcome truth).
- The projection never includes secrets, credentials, provider tokens,
  action parameters or raw provider payloads — only hashes, closed labels
  and bounded references.

## 5. Failure posture

Absent or malformed projection source rows ⇒ R9-E fails closed (no recovery
decision may be derived from missing execution evidence). R9-D remains the
sole writer of execution tables; R9-X binds this port at integration.

## 6. Verbatim disclaimers

```
executionDisclaimer:
  "Execution state is observable evidence only — never recovery authority.
   dispatch != success; uncertainty != success. Retry requires fresh R9-F
   governance consumption; recovery orchestration is R9-E authority. This
   projection authorizes nothing and mutates nothing."

observabilityDisclaimer:
  "association != causation. This projection carries no outcome truth, no
   approval state, no secrets and no action parameters. History is
   append-only; consumers must never rewrite execution records."
```
