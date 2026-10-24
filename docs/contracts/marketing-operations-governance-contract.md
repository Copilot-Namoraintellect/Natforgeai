# MARKETING OPERATIONS GOVERNANCE CONTRACT — WBS-R5 Stream F

> **Status:** canonical operator/governance contract for R5 (supersedes none;
> extends `docs/GOVERNANCE_AND_OPERATOR_CONTRACT.md` from R4-F)
> **Branch:** `feature/r5-f-operations-governance`
> **Common base:** `e4493a8` (R4 `FULL_AUTONOMY_V1_READY`)
> **Date:** 2026-10-24
> **Audience:** R5-X integration, R5-A/B/C/D/E stream owners, operators
> **Rule:** this contract is the single integration reference for R5
> operational visibility, health classification, blocker taxonomy and
> governed recovery. Streams must not bypass it or duplicate its state.

---

## 1. Projection identity

The canonical R5 operational read model is
`projectR5BusinessOperations({ businessId, now?, executor? })`
(`api/lib/governance/r5-operations-projection.ts`).

- **One projection only.** There is no second lifecycle state machine; the
  projection derives everything from durable authorities and owns **no**
  mutable operational state.
- **Read-only.** It never writes, transitions, retries, acknowledges or
  "heals" what it observes.
- **Deterministic.** Explicit-clock pure derivation
  (`deriveR5Blockers` / `deriveR5OperationalState` are pure functions over
  normalized `R5OperationsEvidence`).
- **Actor-agnostic.** The lib never receives client ownership. Visibility is
  the caller's decision (admin operator surface reads any business).
- **Secret-free.** Only allow-listed columns are selected.
- Business scope is the projection key: campaigns, queue items, approvals,
  terminal failures, reservations and usage are folded up to the owning
  `businesses` row via `campaigns.businessId` / `users.id`.

## 2. Operational states

`R5_OPERATIONAL_HEALTH` (closed vocabulary):

| State | Meaning |
|---|---|
| `HEALTHY` | No open blockers; work is flowing or nothing is expected. |
| `DEGRADED` | No open blocker, but a recent (≤24h) failure trace exists; recovery already happened or the trace is informational. |
| `BLOCKED_OPERATOR` | Open blocker(s) requiring a human operator/approver (incl. governance approvals). |
| `BLOCKED_CONFIGURATION` | Open blocker(s) requiring a configuration/billing/plan decision (provider capability, model config, budget, quota). |
| `AUTO_RECOVERING` | Open blocker(s) are all AUTO_RECOVER class (rate limit, transient queue/redis/model); bounded retry is in progress. |
| `UNSUPPORTED` | No R5 capability evidence for the business (nothing integrated); never guessed. |
| `FAIL_CLOSED` | Security rejection, ownership mismatch, malformed-payload integrity failure, or unreadable authority. |

Precedence (worst wins): `FAIL_CLOSED` > `BLOCKED_OPERATOR` >
`BLOCKED_CONFIGURATION` > `AUTO_RECOVERING` > `DEGRADED` > `HEALTHY`;
`UNSUPPORTED` applies only when zero capability evidence exists.
`interpretation` (R5-B) and `opportunity` (R5-D) areas report
`{ supported: false }` until those streams land.

## 3. Blocker taxonomy

`R5_BLOCKER_CLASSES` (closed, 15 — `api/lib/governance/r5-blocker-taxonomy.ts`):

`PROVIDER_AUTH_EXPIRED`, `PROVIDER_SCOPE_MISSING`, `RATE_LIMITED`,
`QUEUE_UNAVAILABLE`, `REDIS_UNAVAILABLE`, `MODEL_TIMEOUT`,
`MODEL_CONFIGURATION_MISSING`, `POLICY_REQUIRES_APPROVAL`,
`BUDGET_EXHAUSTED`, `QUOTA_EXHAUSTED`, `STALE_OPERATION`,
`UNSUPPORTED_PROVIDER_CAPABILITY`, `OWNERSHIP_MISMATCH`,
`MALFORMED_EXTERNAL_PAYLOAD`, `SECURITY_REJECTION`.

Classification rules are normative and pure
(`R5_BLOCKER_CLASS_POLICY`). Security/ownership classes are only produced
from explicit evidence (A-owned `lastFailureClass: FAIL_CLOSED` +
decisive failure code, or mapped security codes) — never inferred from
absence of data. Unknown failure codes map to `null` (area default), never
to a security class.

## 4. Recovery classifications

`R5_RECOVERY_CLASSES` (closed): `AUTO_RECOVER`, `OPERATOR_ACTION`,
`FAIL_CLOSED`, `GOVERNANCE_APPROVAL`.

| Blocker classes | Recovery class |
|---|---|
| `RATE_LIMITED`, `QUEUE_UNAVAILABLE`, `REDIS_UNAVAILABLE`, `MODEL_TIMEOUT` | `AUTO_RECOVER` (system-retryable) |
| `PROVIDER_AUTH_EXPIRED`, `PROVIDER_SCOPE_MISSING`, `MODEL_CONFIGURATION_MISSING`, `UNSUPPORTED_PROVIDER_CAPABILITY`, `STALE_OPERATION` | `OPERATOR_ACTION` |
| `POLICY_REQUIRES_APPROVAL`, `BUDGET_EXHAUSTED`, `QUOTA_EXHAUSTED` | `GOVERNANCE_APPROVAL` |
| `OWNERSHIP_MISMATCH`, `MALFORMED_EXTERNAL_PAYLOAD`, `SECURITY_REJECTION` | `FAIL_CLOSED` |

**Invariant:** automatic recovery is never invented for conditions that
embed a human decision (credentials, consent, money, approval, ownership,
security). `systemRetryAllowed === true` only for AUTO_RECOVER classes.

## 5. Health semantics

- Health rolls up from open blockers by worst `healthImpact`
  (`none < auto < configuration < operator < fail_closed`).
- Blocker → healthImpact: auto classes → `auto`; capability/model/budget/
  quota → `configuration`; credential/scope/approval/stale → `operator`;
  security/ownership/malformed → `fail_closed`.
- `DEGRADED` additionally requires a recent failure trace with no open
  blocker; otherwise `HEALTHY`.
- `safeNextAction` (closed vocabulary `R5_SAFE_NEXT_ACTIONS`) is the action
  of the highest-precedence blocker that has one; AUTO_RECOVER blockers map
  to `none` (the system is already handling them).

## 6. Operator access requirements

- The operator surface is **admin-scoped**: every procedure requires an
  authenticated, OTP/2FA-verified admin session (`adminQuery`).
- No separate operator role; no impersonation; actor = `ctx.user.id`.
- Operator reads may cross businesses (operator visibility by design);
  user surfaces remain strictly owner-scoped and are unchanged by F.
- All mutations re-derive ownership from durable rows — never client input.
- Errors are bounded (no raw exception internals, no provider payloads).

## 7. Allowed recovery actions

Exposed as narrow, evidence-backed adapters that **delegate to existing
governed authorities** and add binding validation, staleness rejection and
audit. Nothing here invents new authority:

| Action | Delegates to | Convergence |
|---|---|---|
| `operations.retryOperation` — `publishing_queue_item` | existing terminal replay D1 authority (durable failure anchors the replay) | deterministic `replayKey` uniqueness + active-claim mutex |
| `operations.retryOperation` — `terminal_failure` | existing terminal replay D1 authority | deterministic `replayKey` uniqueness + active-claim mutex |
| `operations.retryOperation` — `next_cycle_instruction` | `retryFailedNextCycleInstruction` + `dispatchNextCycleInstruction` | CAS on exact instructionId |

Every action: server-authorized; binds to the exact operation + owning
business; validates current state before acting; rejects stale requests
(`expectedStatus` mismatch); idempotent (state-based convergence); preserves
billing/provider/policy identity; writes exactly one canonical admin audit
event (tx-atomic where a transaction exists; loud retry-safe failure
otherwise); fail closed when authority cannot be proven.

## 8. Forbidden recovery actions

No endpoint — under any name — may provide: force allow, force approve,
force policy pass, force bill, force publish, force ownership change,
arbitrary lifecycle-state setters, generic force-complete, approval
fabrication, or client-supplied lifecycle state / recovery identity. The F8
acceptance suite asserts no such procedure exists on the operations router.

## 9. Audit requirements

- Every privileged R5-F mutation records exactly one canonical
  `admin_mutation` event via `recordAdminMutationAudit`
  (`api/lib/governance/admin-audit.ts`) into the fingerprint-unique
  `audit_events` ledger.
- Closed vocabulary extensions (F6): `ADMIN_AUDIT_ACTIONS` gains
  `admin.r5_operation_retry` (+ `admin.r5_operation_retry_failed` outcome
  via `outcome:"failed"`); `ADMIN_AUDIT_TARGET_TYPES` gains `r5_operation`.
- Actor is always the authenticated admin id — never invented; audit fails
  closed on invalid actor/action/target.
- Mutation + audit are atomic inside one transaction where the delegated
  authority runs in a transaction; otherwise the audit failure propagates
  loudly (no silent skip).
- Never logged: secrets, tokens, raw credentials, raw provider payloads,
  hidden model reasoning, unbounded PII. Metadata is allow-listed plus the
  WBS7A key sanitizer.

## 10. Staleness semantics

- Business staleness: `lastSuccessAt` older than
  `R5_STALENESS_THRESHOLDS.businessActivityMs` (7d) ⇒ `isStale: true`
  (warning indicator, not a blocker).
- Listening staleness: A-owned binding `status: "stale"` (or a blocked
  binding without fresh success) ⇒ `STALE_OPERATION` blocker.
- Recovery staleness: an operator retry carrying `expectedStatus` is
  rejected when the durable row has moved on (`STALE` conflict); concurrent
  retries converge through conditional state guards + the replay mutex.

## 11. Downstream state fields consumed from A/B/C/D/E

| Stream | Fields consumed (read-only) |
|---|---|
| R5-A | `social_listening_states.{integrationId,provider,platform,providerAccountId,mechanism,status,cursorUpdatedAt,lastSuccessAt,lastFailureAt,lastFailureClass,lastFailureCode,lastFailureReason,acceptedCount,duplicateCount,rejectedCount}`; `social_signals` 24h rollup `{integrationId,count,MAX(observedAt)}` — via `api/lib/governance/r5-stream-evidence.ts` |
| R5-B | none yet; area reports `supported:false` |
| R5-C | R4 engagement authorities today: `publishing_queue`, `campaigns.workflowState`, `creative_generation_claims` |
| R5-D | none yet; area reports `supported:false` |
| R5-E | policy backlog proxied from `approval_requests` (pending rows) + `publishing_queue.safety_blocked`; billing/quota from `credit_wallets`, `credit_reservations`, `user_usage`, `subscription_tiers` |

## 12. Fields F must not own or mutate

F must not own or write: signal rows/normalization (A), interpretation
results (B), engagement execution (C), opportunity classification (D),
policy decisions or billing logic (E), campaign lifecycle state (R4-A
engine), queue terminal/replay state (queue modules), approval decisions
(approval router), wallet/reservation rows (billing engine). F adds **no**
tables and **no** mutable state of its own.

## 13. Sensitive-data restrictions

- Never selected/logged: `accessTokenEncrypted`, `refreshTokenEncrypted`,
  `pageAccessTokenEncrypted`, any token/secret/credential material,
  connection strings, webhook secrets, password hashes, banking details.
- `social_signals.contentText` (provider payload) is never projected;
  listening evidence is counts/freshness/class only.
- `providerAccountId` is surfaced as binding identity only (A already
  stores it; F treats it as opaque identifier).
- Error responses carry bounded mapped messages only.

## 14. Schema dependencies

None added by F. The projection reads existing R4 tables and A's tables via
the guarded information-schema check (absence ⇒ `available:false`, never an
error). A's migration `0029` remains A-owned and unexecuted; F created no
migrations and executes none.

## 15. Overlap-risk files

| File | Note |
|---|---|
| `api/health-router.ts` | F adds an admin R5 readiness procedure |
| `api/router.ts` | F registers the `operations` router |
| `api/lib/governance/admin-audit.ts` | F extends closed vocabularies additively |
| `api/admin-router.ts` | unchanged by F (operator reads live on `operations`) |
| `api/lib/governance/lifecycle-projection.ts` | consumed unchanged |
| `db/schema.ts` | not modified by F |
| `api/lib/social-listening/*` (A-branch) | A-owned; F reads via the evidence bridge only |

## 16. Security invariants

1. Fail closed by default; least privilege; admin+verified-session only.
2. No client-supplied lifecycle state or recovery identity.
3. Tenant isolation preserved: recovery binds to the durable owner of the
   referenced operation; forged businessId/operationId pairs are rejected.
4. Stale operator actions rejected; replayed/duplicate actions converge
   safely; concurrent actions serialize on durable guards.
5. Operator actions cannot bypass policy, billing, approval, tenant or
   provider rules — they only invoke existing governed authorities.
6. Policy denials and terminal states cannot be force-overridden; no
   procedure exists to do so (asserted).
7. Every privileged mutation audited; audit failure cannot leave an
   unaudited successful mutation.
8. Projections carry no secrets, tokens, raw payloads or credential fields
   (asserted by tests).
9. AUTO_RECOVER remains non-human: the system retries; operators are only
   shown that retry is in progress.
