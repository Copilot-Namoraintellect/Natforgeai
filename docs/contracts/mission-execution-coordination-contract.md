# MISSION EXECUTION COORDINATION CONTRACT (R9-D)

> **Owner:** R9-D Execution Coordination (`feature/r9-d-execution-coordination`)
> **Authority:** coordinates execution of governed mission actions — dispatch
> intent, execution-attempt identity, adapter dispatch boundary, idempotency,
> conservative result classification and read-only downstream execution state.
> **Contract version:** `mission-execution-coordination/v1`
> **Engine version:** `mission-execution-engine/v1`
> **Downstream projection:** `mission-execution-to-state-recovery/v1`
> (see `docs/contracts/mission-execution-to-state-recovery-contract.md`)
> **Upstream (frozen, consumed read-only, never merged):** R9-A mission
> authority (`mission-authority/v1` @ `273ce40`), R9-B mission planning
> (`mission-planning/v1` @ `a358f53`), R9-C dependency & scheduling
> (`mission-dependency-scheduling/v1` @ `1c5837f` +
> `mission-scheduling-to-execution/v1` projection semantics), R9-F mission
> governance (`mission-governance/v1` @ `1665d2f` +
> `mission-governance-to-execution/v1` gate semantics).

---

## 1. Purpose and authority boundary

R9-D answers one question: **may this exact scheduled task's exact bound
action be dispatched to this adapter, now, and what happened when it was?**
Everything else — mission truth (R9-A), task truth (R9-B), ordering evidence
(R9-C), authorization (R9-F), retry governance (R9-F), recovery (R9-E) — is
owned elsewhere and consumed read-only.

**Core authority rules (preserved verbatim on every surface):**

```
schedule != execution authorization
task definition != execution authorization
mission approval != task execution authorization
readiness != authorization
consumption != performance
dispatch != success
uncertainty != success
retry != new authority
```

R9-D must never: decide strategic truth, mission objectives, planning,
scheduling or governance; mint approvals, decisions, risk classes or retry
authority; alter approved action parameters; select arbitrary
modules/tools/URLs/shell/SQL; move budget; settle billing; mutate Business
DNA, strategy, mission, plan, schedule or governance rows; expose provider
credentials.

## 2. Execution action envelope (D1)

Every candidate execution is a deterministic **execution action**. Fields
(closed set; server-derived — clients name references only):

| Field | Type | Semantics |
|---|---|---|
| `executionActionId` | `exa1:<sha256>` | Deterministic identity (§3) |
| `tenantId` | number | Session anchor (`ctx.user.id`); never client-supplied |
| `businessId` | number | Server-resolved owning business; re-verified every call |
| `missionId` | `mis1:<sha256>` | R9-A mission reference, verbatim |
| `planId` | `pln1:` / opaque plan coordinate | R9-B plan reference, verbatim |
| `scheduleId` | `sch1:<sha256>` | R9-C schedule reference, verbatim |
| `taskId` | `tsk1:` / opaque task coordinate | R9-B task reference, verbatim |
| `taskType` | string ≤ 64 | From the R9-B task row (server-read), verbatim |
| `actionType` | closed enum | `EXECUTE_TASK` \| `EXECUTE_STEP` \| `RETRY_STEP` (R9-F closed action taxonomy subset) |
| `actionParametersHash` | `<sha256>` | Governance fingerprint of the canonical action parameters (scheduleId + taskId + taskType + actionType + adapterType + capability + bounded parameters); raw parameters never persist |
| `inputRefs` | string[] ≤ 16 | Bounded reference strings (server-validated identities only) |
| `governanceDecisionId` | `mgd1:<sha256>` | The exact R9-F decision referenced for consumption |
| `approvalReference` | number \| null | Bound `approval_requests.id` for REVIEW_REQUIRED decisions; null for ALLOW |
| `authorizationFingerprint` | `<sha256>` | Fingerprint of the consumed authorization (§3) |
| `idempotencyKey` | `idem1:<sha256>` | Deterministic (§3); never client-generated |
| `adapterType` | closed enum | Server-selected adapter class (§5) |
| `capability` | closed enum | Server-resolved capability key (§5) |
| `validFrom` / `validUntil` | ISO-8601 UTC | Consumption validity window (governance expiry ∩ schedule validity) |
| `dispatchState` | closed enum | `NEVER_ATTEMPTED` → `DISPATCH_PREPARED` → `DISPATCHED` → `ACKNOWLEDGED` → `SUCCEEDED` \| `FAILED` \| `UNCERTAIN`; `CANCELLED` terminal |

## 3. Deterministic identity (D2)

```
actionParametersHash    = sha256(canonicalJson({ v: 1, params: {
                          scheduleId, taskId, taskType, actionType, adapterType,
                          capability, parameters }}))
                          — identical to R9-F's actionParamsFingerprint binding;
                          the raw bounded parameters never persist

authorizationFingerprint = sha256(canonicalJson({
  v: 1, governanceDecisionId, policyVersion, approvalRequestId|null,
  missionRiskClass, expiresAt }))

executionActionId = "exa1:" + sha256(canonicalJson({
  v: 1, tenantUserId, businessId, missionId, planId, scheduleId, taskId,
  actionType, actionParametersHash, authorizationFingerprint, adapterType }))

idempotencyKey = "idem1:" + sha256(canonicalJson({
  v: 1, tenantUserId, executionActionId }))

dispatchFingerprint = sha256(canonicalJson({
  v: 1, executionActionId, adapterType, capability, attemptNumber,
  actionParametersHash, idempotencyKey }))

attemptId = "exr1:" + sha256(canonicalJson({
  v: 1, executionActionId, attemptNumber, dispatchFingerprint }))

resultHash = sha256(canonicalJson({
  v: 1, attemptId, resultStatus, failureClass, uncertaintyClass,
  externalReference|null, classifiedResult }))   // classifiedResult is the
                                                 // redacted classification
                                                 // material, never raw
                                                 // provider payloads

lifecycleEventId = "exl1:" + sha256(canonicalJson({
  v: 1, executionActionId, lifecycleType, fromState, toState, reasonCode,
  attemptId|null, occurredAt }))
```

- The execution action binds **tenant + business + mission + plan + schedule
  + task + action type + exact parameters + governance authorization
  fingerprint**. Any change to any component mints a new `executionActionId`
  and, because R9-F binds the exact action parameters, invalidates the old
  approval (a modified action after approval is a new action).
- **No model-generated identity authority. No client-generated idempotency
  authority.** Durable convergence anchors: unique `(userId,
  executionActionId)` and `(userId, idempotencyKey)`; identical replay
  converges (`idempotent_replay`, zero extra events); conflicting material
  under the same anchor fails closed (`EXECUTION_REPLAY_CONFLICT`).
- The governance-bound canonical action parameters are
  `canonicalJson({ v:1, scheduleId, taskId, taskType, actionType, adapterType,
  capability, parameters })` — R9-F's `actionParamsFingerprint` binds exactly
  this object; R9-D recomputes it at consumption and the R9-F gate fails
  closed on any drift.

## 4. Upstream consumption gate (D3)

Before any dispatch intent is created, every seam is revalidated
server-side. Failure at any seam ⇒ **NO DISPATCH**.

- **R9-A:** mission row exists for this tenant; `status ∈
  {PROPOSED, ELIGIBLE_FOR_PLANNING, REVIEW_REQUIRED}` (current — never
  SUPERSEDED/STALE/CANCELLED/INVALIDATED/BLOCKED); `businessId` matches;
  `validFrom ≤ now < validUntil`.
- **R9-B:** plan row exists for `(missionId, planId)`, plan currency window
  covers `now`, plan not superseded/invalidated; task row exists, belongs to
  the exact mission + plan, task not withdrawn; capability classification
  present; task constraints preserved verbatim against the R9-C schedule's
  projected constraints.
- **R9-C:** schedule row exists for this tenant; `status = READY` (PROPOSED /
  VALIDATED not yet executable; BLOCKED / SUPERSEDED / STALE / INVALIDATED /
  CANCELLED rejected as not current); `taskId ∈ orderedTaskIds`; `taskId` not
  blocked in `blockingStates`; task-level `TIME_WINDOW` constraints honour
  `now`; schedule validity window covers `now`; for every HARD ordering
  dependency into `taskId` of type `REQUIRES_COMPLETION` / `REQUIRES_SUCCESS`,
  a `SUCCEEDED` execution attempt exists in this stream's ledger for the
  predecessor task (scheduling evidence is re-checked against real execution
  state — absence of success fails closed).
- **R9-F:** the referenced durable decision row exists for this tenant;
  `assertMissionActionConsumable` (frozen gate, `mission-governance-to-execution/v1`)
  returns `consumable: true` for the exact expected action **now** — exact
  subject/action/refs/parameters fingerprint, current policy version,
  unexpired, bound approval valid where required. `consumable: false` is a
  hard stop; the deny reason is surfaced verbatim and never overridden.

Absent upstream tables (unexecuted provisional migrations, frozen branches
not merged) fail closed: `EXECUTION_AUTHORITY_UNAVAILABLE`. R9-D never
fabricates schedule readiness, approvals or governance receipts.

## 5. Adapter boundary (D5)

- **Closed registry.** Adapter classes (closed): `CAMPAIGN`, `CONTENT`,
  `SOCIAL`, `CRM`, `NOTIFICATION`, `ANALYTICS`, `INTERNAL_WORKFLOW`.
  Capability keys (closed): `campaign.activate`, `content.dispatch`,
  `social.publish`, `crm.record`, `notification.send`, `analytics.record`,
  `workflow.run` — each capability maps to exactly one adapter class; the
  mapping is code-level and versioned.
- Adapter selection is **server-controlled**: the resolved capability comes
  from the R9-B task's `requiredCapabilities` intersected with the plan's
  `supportedCapabilities` (both server-read). Exactly one adapter may satisfy
  the requirement set; otherwise fail closed (`ADAPTER_UNAVAILABLE` /
  `CAPABILITY_UNAVAILABLE`). Unknown adapter classes are rejected
  (`UNKNOWN_ADAPTER`).
- Models/clients may **never** provide module names, URLs, shell commands,
  SQL, executable code or tool names. The adapter interface receives a
  secret-scrubbed dispatch payload only.
- **Development mode (D6):** only fake/in-memory sandbox adapters are bound.
  `LIVE_EXECUTION=False`. No live provider, CRM, payment/billing or campaign
  activation call occurs anywhere in this stream. The governed dispatch
  boundary is architected for later production binding at R9-X/R10.

## 6. Dispatch intent + idempotency (D4)

- Insert-first immutable dispatch intent (the execution action row) is
  created **before** any side-effect boundary, audited
  (`execution_action_prepared`), and only then may dispatch proceed.
- Dispatch-state transitions are optimistic-CAS guarded; illegal transitions
  fail closed (`INVALID_DISPATCH_STATE`).
- The same authorized action replayed (same tenant, same idempotency key)
  converges to the existing row. A conflicting action under the same anchor
  fails closed (`EXECUTION_REPLAY_CONFLICT`). Duplicate worker consumption,
  repeated HTTP requests, duplicate scheduler triggers and callback replays
  all converge through the same durable anchors (structural exact-once; real
  MySQL concurrency remains the R10/pre-production gate).

## 7. Result classification (D7)

External/fake-adapter results are classified **conservatively**; provider
payloads are untrusted external data.

| `resultStatus` | Meaning |
|---|---|
| `SUCCEEDED` | Adapter returned an unambiguous success with a validated reference |
| `FAILED_RETRYABLE` | Explicit, classified failure where a bounded retry may be conceivable (retry still needs fresh R9-F authority) |
| `FAILED_FINAL` | Explicit final failure |
| `PENDING_EXTERNAL` | Acknowledged but outcome externally pending (awaiting callback) |
| `UNCERTAIN` | Timeout, connection loss, ambiguous/partial callback — **never** mapped to success |

`failureClass` (closed): `NONE`, `ADAPTER_REJECTED`, `PROVIDER_ERROR`,
`TIMEOUT`, `CONNECTION_LOSS`, `AMBIGUOUS_CALLBACK`, `VALIDATION`, `INTERNAL`.
`uncertaintyClass` (closed): `NONE`, `TIMEOUT`, `CALLBACK_AMBIGUOUS`,
`PARTIAL_CONFIRMATION`, `PROVIDER_STATE_UNKNOWN`.

External references are validated before binding: a callback whose reference
does not match the attempt's issued reference is rejected
(`EXTERNAL_REFERENCE_MISMATCH`); duplicate callbacks converge
(`idempotent_replay`). Absence of failure news is never fabricated into
success.

## 8. Retry boundary (D8)

- R9-D **never** self-authorizes a retry. FAILED_RETRYABLE / UNCERTAIN /
  PENDING_EXTERNAL results emit a **retry/recovery candidate** (read-only
  lifecycle fact + projection state) only.
- A retry attempt requires a **fresh, exact R9-F authority** (a consumable
  decision binding `subjectClass ∈ {RETRY, EXECUTION_STEP, TASK}` with the
  retry's own parameters / retry context). The gate re-validates the exact
  binding; forged, expired or cross-subject authority fails closed.
- A governed retry reuses the exact original action scope: identical
  `missionId/planId/scheduleId/taskId/actionType/parameters/adapterType`.
  Any change to parameters, provider/adapter, scope or spend is a different
  action and fails closed (`RETRY_SCOPE_BROADENED` / gate denial).

## 9. Security / secret isolation (D10)

- Secrets are never included in task payloads, model prompts, logs, audit
  metadata, projections or mission planning records; never returned to
  clients.
- Action material containing secret-shaped keys (`apiKey`, `apiKeyV2`,
  `secret`, `secretKey`, `token`, `accessToken`, `refreshToken`, `password`,
  `authorization`, `clientSecret`, `privateKey`, `credential`, `session`) is
  rejected at the boundary (`SECRET_MATERIAL_REJECTED`).
- Adapter credentials, where future live adapters need them, resolve
  server-side at the adapter boundary — never selected by, or exposed to,
  models, clients or execution agents. A compromised execution agent can
  dispatch only the exact governed action to the server-selected adapter;
  it cannot select credentials, providers, accounts, tools or code.

## 10. Audit + immutability

- One canonical audit event per durable effect: `execution_action_prepared`,
  `execution_attempt_recorded`, `execution_attempt_lifecycle`. Convergence
  emits zero events.
- Execution action rows and attempt rows are immutable; hash drift fails
  closed (`EXECUTION_TAMPER`). Lifecycle is append-only `exl1:` facts.
- R9-D writes only its own tables + the canonical audit ledger. It never
  writes R9-A/B/C/F tables or any legacy execution surface.

## 11. Versioning

`mission-execution-coordination/v1`. Identity patterns, closed vocabularies,
error taxonomy and the envelope field set are frozen per contract version;
R9-D bumps the version only with a new governed contract revision accepted
upstream. Downstream R9-E consumes execution state exclusively through
`mission-execution-to-state-recovery/v1`.
