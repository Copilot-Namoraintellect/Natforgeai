# Autonomous runtime resilience contract

Version: `runtime-resilience/v1`. Frozen programme base:
`799f6b4cb351ebe969f97da606324605fdf2a07b`.

Process recovery != authority recovery. Worker restart != permission to
re-execute. Queue delivery != execution authorization. Lease acquisition !=
business authority. Retry != automatic permission. Missing acknowledgement !=
success.

The implementation is a server-only composition module in
`api/lib/runtime-resilience/runtime-service.ts`. It exports no HTTP router,
model tool, shell, SQL interpreter, credential resolver or governance writer.
`createRuntimeController` is a trusted composition root; deployments must never
expose it or accept its binding/dependencies from a queue, client or model.
No production startup entry point activates this module in this stream.

## C1-C4: envelope, identity, liveness and durable claim

A trusted binding fixes tenant, business, release, R9-D dependencies and a
server-owned parameter loader. Controllers enqueue only existing R9-D
`DISPATCH_PREPARED` actions. Queue/worker input consists solely of a strict
`{jobId}` object. All action coordinates and parameter fingerprints are loaded
from durable R9-D rows. Worker registration is a trusted server operation,
not an authentication endpoint: deployed worker identity/authentication and
least-privilege DB credentials must be bound by R10-X before production.

Workers have per-start random registration nonces hashed into `wrk1:` instance
identities. Logical worker roles may have multiple replicas. Jobs (`job1:`)
bind tenant/business, mission/plan/schedule/task, type, authority reference,
failed attempt and parameter fingerprint. Immutable fingerprints include
runtime/release versions. Leases (`lea1:`) bind job, instance, epoch and
acquisition timestamp. Neither identity nor a hash grants business authority.

MySQL unique indexes converge insert-first jobs. Claim uses a single guarded
UPDATE of the job version/state; exactly one affected row proves a winner.
Rereading another winner's row is never sufficient. Lease-row insertion
follows the durable job claim: a crash between them leaves the job fenced;
no external effect precedes successful claim persistence. Reclaims require an
expired lease and increment the epoch. Completion and the dispatch barrier
require the current version, lease and unexpired deadline. Workers must send
heartbeats frequently (default late 15s, stale 60s, dead 300s). Invalid or
future heartbeats fail closed. Stale workers must register a new instance.
The fixed 60s job lease is not renewed; long work can be reconciled under a
new lease but cannot be automatically dispatched again after the barrier.

## C5-C6: crash and restart truth table

| Crash point                                | Durable truth                            | Next action                                                            |
| ------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------- |
| Before R9-D intent                         | No action                                | Refuse job dispatch                                                    |
| After intent, before runtime barrier       | One R9-D intent, no dispatch evidence    | Reload exact action/material; R9-D revalidates A/B/C/F before dispatch |
| After barrier, before R9-D call            | `DISPATCHING` marker                     | Conservative UNCERTAIN; no automatic replay                            |
| During dispatch                            | Marker and possibly R9-D attempt         | Read authoritative receipt; otherwise UNCERTAIN                        |
| Provider ack before local ack              | Marker, absent receipt                   | UNCERTAIN; governed reconciliation only                                |
| Result persisted before runtime completion | Immutable R9-D receipt                   | Copy receipt classification, never redispatch                          |
| During recovery                            | Existing barrier/receipt remains durable | Repeat read/reconciliation, never inherit process authority            |

The runtime writes `DISPATCHING` before entering R9-D. It is deliberately
conservative: a crash just before R9-D can strand work that never dispatched.
Availability is recovered through R9-E/F review, not by erasing the barrier.
R9-D owns intent, adapter dispatch, exact parameter hashing, fresh governance
consumption, callback polling and outcome evidence. The runtime does not
change those authorities. Errors after the barrier yield UNCERTAIN, never
success or an implicit retry. Runtime COMPLETED means envelope processing
finished; its result can remain UNCERTAIN/PENDING_EXTERNAL. It never means
mission success. Later callback truth remains authoritative in R9-D/R9-E;
a runtime result is a snapshot, not an alternative outcome ledger.

## C7: retry boundary

Runtime cannot authorize or manufacture a retry. R9-D must first prepare a new
RETRY_STEP with fresh exact R9-F authority. Enqueue additionally requires the
exact latest failed/uncertain `failedAttemptRef`. Runtime binds this into job
identity and rechecks original tenant/business, mission/plan/schedule/task,
adapter/capability and original parameter hash before dispatch. The new
governance decision must differ from the failed action's. Parameters reload
from server material on every run. Provider/account selection is absent from
the runtime API; server-controlled R9-D adapter binding remains unchanged.
No queue-level automatic retry can bypass the durable dispatch barrier.

## C8-C11: dead letters, stuck work, draining, releases

Dead letters preserve job/authority/attempt, failure and uncertainty, timestamp,
bounded diagnostic and evidence hash. Evidence is inserted before job state
changes; storage failure leaves the original job visible. Dead-lettering
never edits R9-D results or R9-E mission state. Diagnostics are bounded acyclic
JSON, depth <= 6 and serialized length <= 1024, with secret-shaped keys and
recognizable credential tokens rejected. Free text is inert data.

Stuck detection only proposes REVALIDATE, REQUEST_HUMAN_REVIEW or ESCALATE.
Expired leases, stale/missing owners, provider pending, missing callbacks and
unchanged state never trigger replay. A drain flag synchronously blocks new
local claim calls; durable DRAINING prevents subsequent claims by this
instance. Already-entered async claims may finish fencing a job but must
recheck worker eligibility before dispatch. In-flight dispatches finish with
conservative truth; stop returns `drained:false` until active runs finish.
Hard process death relies on lease expiry and the durable barrier. Signal
binding and heartbeat scheduling remain deployment composition work.

Both job runtime version and release must match the bound worker release.
Workers with unknown contracts fail closed. Rolling release adoption requires
an explicit certified binding; no caller can widen the supported set.

## C12-C14: observation, security, acceptance

See `runtime-to-observability-contract.md`. Observation conveys no runtime
mutation capability. The worker closure exposes only identity, heartbeat,
claim, run, drain and stop. It accepts no outcome, approval, provider/account,
secret path, shell, SQL, policy, monitoring or backup operation. A process with
arbitrary module execution or unrestricted DB credentials is outside this
API boundary; production credentials and process isolation remain required.

Connected tests execute the real runtime store/service and R9-D/F services
against a deterministic Drizzle predicate/unique-index harness. Real MySQL
concurrent-writer testing and production process-supervisor/queue binding
remain R10-X pre-production gates. Migration 0038 is an unexecuted provisional
artifact; canonical R9 0037 is unchanged. No OneGrid, deployment or live
provider execution is authorized by this contract.
