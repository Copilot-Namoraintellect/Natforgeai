# Production provider adapter contract

Version: `provider-resilience/v1`. Frozen upstream:
`mission-execution-coordination/v1` at
`799f6b4cb351ebe969f97da606324605fdf2a07b`.

Provider response != business truth without validation.
Timeout != failure. Timeout != success. HTTP 200 != necessarily business success.
Provider health != provider-switch authority.
Fallback != authorization to widen scope.
Credential availability != permission. Integration adapter != governance authority.

## Declaration and server composition

Every adapter implements `ProductionProviderAdapterContract` and declares
providerId, adapterVersion, capabilities, supportedActionTypes,
idempotencySupport, callbackSupport, reconciliationSupport, rateLimitModel,
timeoutModel, credentialBindingType, accountBindingType, healthCapabilities,
and bounded numeric timeout/rate/backoff/circuit policies.

The registry validates closed vocabularies, copies the declaration, and freezes
its nested values. Model strings cannot extend it. The service currently accepts
only explicit sandbox adapters; application boot, routers, existing transports,
and workers do not register a live adapter or expose provider execution.

A future production composition must supply a durable repository and a fresh
server authority resolver. There is no default authorization grant. The resolver
must read the current R9 action and attempt, current R9 upstream readiness,
governance decision, approval ledger and policy; select an explicitly authorized
provider binding; and supply its consumption deadline. Binding registration is
trusted server administration, not a model/client mutation. The fixed callback
key resolver permits only verification for the exact tenant, business, provider,
account, capability, action, and credential fingerprint. It accepts no arbitrary
environment key, secret name, file path or URL. No dispatch credential is needed
by sandbox adapters.

## Exact execution and identity

Dispatch inputs are strict binding/action/attempt references and bounded JSON
parameters. Arbitrary authority, provider, account, URL, tool, shell, SQL and
credential selector keys are rejected at every parameter depth. Plain text
content remains inert data. References supplied as client input are not a grant
of authority; service envelopes contain no client-selected input references.

R9 canonical action parameters are recomputed with schedule, task, task type,
action, adapter, capability and parameters before comparing the R9 authorized
hash. The service checks tenant, business, capability, action, attempt ownership,
server-selected binding, uncompleted attempt, expiry, current R9-F gate and policy.
R9 subject classes are EXECUTION_STEP or RETRY, as frozen.

`pbd1:` hashes tenant/business/provider/account/capability/action.
`prq1:` hashes the binding/action/attempt/exact payload hash.
The native provider key, where declared, is the request ID.
A durable unique tenant/action/attempt anchor prevents binding or account changes
from creating a second dispatch. A claim commits before transport. Duplicate
dispatches return the existing receipt, including unresolved claims after a
crash. They never resend. With no native provider key this is at-most-one local
transport invocation per attempt, not a claim of distributed exactly-once effects.
A new attempt requires fresh upstream authority and must not bypass an unresolved
earlier effect. The provider layer never creates an attempt or retries itself.
The tenant transaction rejects a different attempt for the same action while
any earlier provider receipt is DISPATCHED, PENDING or UNCERTAIN, including
receipts for another provider. Cross-action recovery lineage must additionally
be checked by the upstream authority resolver before granting a new action.

## Classification and timeouts

The closed results are SUCCEEDED, FAILED_RETRYABLE, FAILED_FINAL, PENDING,
UNCERTAIN, RATE_LIMITED, AUTHENTICATION_FAILED. Only a validated adapter's explicit
business result can claim success; a receipt/HTTP status alone cannot. Success
requires a bounded provider reference. Timeout, reset, DNS/connection failure,
truncation, malformed and unknown outcomes remain UNCERTAIN.

The outer deadline bounds connect + read time. Adapters receive separate phase
deadlines and must enforce them in their certified transport. Expiry cannot
prove that a provider did nothing: late transport settlement cannot trigger
another call or overwrite a callback-confirmed terminal outcome.

Only closed labels, hashes and bounded identifiers enter receipts/persistence.
Arbitrary adapter detail, failure text and transport exception messages are not
logged or returned. Adapter certification must also prevent credentials from
being used as identifiers. Models never receive credentials.

## Callbacks and convergence

Only signed_webhook declarations may ingest callbacks. HMAC-SHA256 covers provider,
account, event, timestamp and the canonical bounded payload; compare is constant
time. Freshness is five minutes in either direction. Payloads bind the exact
request and execution attempt. The durable request supplies tenant/business and
binding coordinates. Wrong account, tenant, business, attempt, stale, forged and
unknown-reference callbacks fail closed. Rejected material never reserves a valid
event's replay anchor.

Validated identical events converge. Conflicting material for the same event, or
a contradictory later event, is recorded as CONFLICT_QUARANTINED with its own
hash identity. It never overwrites a terminal outcome. The migration natural key
includes the payload hash so both sides of a conflict can be retained. Callback
transitions and probe accounting share the tenant transaction.
Signed callback material is copied before any asynchronous authority/store
lookup, preventing caller mutation after signature verification.

## Reconciliation, pacing and degraded mode

Reconciliation calls only the bound adapter with the immutable stored request.
CONFIRMED_SUCCEEDED requires the exact requestId and a provider reference;
CONFIRMED_FAILED requires the exact requestId and explicit failure evidence.
STILL_PENDING also requires the exact requestId and remains PENDING;
missing, mismatched or unknown evidence remains
UNCERTAIN. Calls are deadline-bounded. Evidence records converge independently
of observation time. Contradictory terminal evidence is retained with a conflict
result while the prior terminal outcome remains unchanged. No provider evidence
is fabricated. An evidence hash is a fingerprint, not proof of external truth.

Durable request-window limits cover provider, account and account/action within
the tenant's budget. Token-bucket declarations use a stricter persisted
burst/window envelope. The pure token-bucket helper supports deterministic refill.
Provider retry-after hints are bounded and visible and block subsequent dispatch.
Global shared-provider quotas must be divided conservatively among tenants by
the future certified composition; per-tenant quotas are not a global capacity
claim.

Bounded exponential backoff with deterministic jitter is advisory and never
permission to retry. Circuit state is tenant/provider/account/action scoped:
CLOSED, OPEN, HALF_OPEN. Failures within a bounded window open it. Open circuits
stop dispatch. Half-open slots are reserved under the durable tenant lock;
only the configured number can run. Consecutive probe successes close the
circuit; probe failure reopens it. Health, backoff, queues and degraded posture
never select an alternative account/provider, widen parameters or grant authority.
Degraded modes pause, remain pending, queue advisory work, request operator
attention or require reauthorization. No background retry queue is activated.
Probe accounting uses the persisted dispatch origin: an ordinary in-flight
straggler cannot settle or free a half-open probe slot. Reopening retains other
outstanding probe reservations; a neutral probe breaks consecutive successes.

## Persistence and activation boundary

The MySQL repository serializes each tenant's claims, callbacks, evidence,
rate scopes and circuits using a dedicated circuit-table lock row within a
transaction. Claims commit before external I/O. Updates use versioned CAS.
R9 tables are read-only and absent authority fails closed. The five R10 tables
are isolated in the provisional 0038 migration, which is an artifact only.

This work supplies sandbox-connected acceptance and the dormant durable
repository. It does not execute a migration or certify real-MySQL locking,
transport phase behavior, provider webhook formats or real credentials.
Those remain R10-X/pre-production activation gates. No existing integration is
automatically certified or enabled.
