# Runtime to observability contract

Version: `runtime-to-observability/v1`. Producer: R10-C. Consumer: R10-E.

This projection is read-only observability evidence. Observability never
holds runtime authority: it cannot claim, complete, dead-letter, retry, drain
or mutate runtime rows, and cannot mark execution outcomes. Missing heartbeat,
lapsed lease and absent callback are never proof of success or failure;
ambiguous work remains uncertain until governed reconciliation.

`buildRuntimeObservabilityProjection` is a pure projection;
`controller.observe()` loads a durable snapshot for a trusted internal
consumer. It is not a public router. Authorization belongs to the hosting
server; callers cannot supply tenant/business filters. Jobs and dead letters
are scoped to the controller's tenant/business. Worker health is internal
fleet metadata and must not be exposed to ordinary tenant users.

The frozen top-level field set is enforced by
`assertRuntimeObservabilityShape`:

| Field             | Read-only meaning                                                                 |
| ----------------- | --------------------------------------------------------------------------------- |
| projectionVersion | Exact contract version                                                            |
| generatedAt       | Server snapshot timestamp                                                         |
| disclaimers       | Mandatory absence of authority and uncertainty statements; bounded snapshot scope |
| workers           | Instance/role/service/state, heartbeat timestamp/age, liveness, runtime/release   |
| queueDepth        | Counts by PENDING, LEASED, COMPLETED, DEAD_LETTERED, CANCELLED                    |
| jobAge            | Oldest pending and leased job ages in milliseconds                                |
| leaseAge          | Active/expired lease counts and oldest active acquisition age                     |
| deadLetterCount   | Total and counts by reason                                                        |
| crashLoops        | Multiple role starts within default 10 minute window; advisory suspicion          |
| versionDrift      | Runtime contract mismatch count and instance IDs                                  |
| stuckWork         | Job identity, stuck classification, advisory recovery proposal                    |
| retryBacklog      | Pending queue count and failed/uncertain/pending-external candidates              |

`observe()` reads up to 500 recent fleet workers, 500 recent tenant jobs
filtered to the business, and 500 business dead letters. It explicitly marks
these as snapshot counts, never global queue totals. A production aggregate
reader must replace this bounded read for large fleets. Lease age uses durable
acquisition time, not expiry; missing timestamps yield null. Crash-loop
findings can include legitimate scale-out and do not authorize any response.
`retryBacklog.pending` describes pending work, not approved retries.

No payload parameters, raw diagnostics, credential references, provider
accounts, approvals, governance policy, tokens or mutation handles appear in
the projection. R10-E can alert/page and propose governed investigation only.
Execution receipts/callback truth continue to come from R9-D/R9-E, never from
runtime health or missing heartbeats.
