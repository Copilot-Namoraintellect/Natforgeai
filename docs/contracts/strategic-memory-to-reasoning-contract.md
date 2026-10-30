# STRATEGIC MEMORY → REASONING HANDOFF CONTRACT (R8-A → R8-B/C/D/E)

> **Producer:** R8-A Strategic Memory (`feature/r8-a-strategic-memory`)
> **Consumers:** R8-B market intelligence, R8-C opportunity/risk synthesis,
> R8-D strategic reasoning/recommendation, R8-E (and any later strategic
> consumer)
> **Status:** canonical downstream contract — consumers read, never redefine or
> mutate
> **Projection version:** `strategic-memory-to-reasoning/v1`
> **Source of truth:** `docs/contracts/strategic-memory-contract.md` (R8-A
> canonical) + `api/lib/strategic-memory/strategic-memory-projection.ts`
> (`STRATEGIC_MEMORY_PROJECTION_FIELD_KEYS` — asserted exact in acceptance)
> **Upstream (frozen, consumed not merged):** R7 Business Optimisation V1
> (`a2c084a1…`) via
> `docs/contracts/business-optimisation-to-strategic-intelligence-contract.md`.

---

## 1. Purpose and boundaries

R8-A owns durable, versioned strategic memory. This contract is the **only**
surface through which downstream R8 streams consume it. Downstream may read
and must never mutate: no R8-B/C/D/E call may write `strategic_memory_records`,
`strategic_memory_lifecycle_events`, or any upstream authority table, and no
consumer may mint memory identities, statuses, confidence classes or
contradiction resolutions.

**Strategic memory is durable context, not autonomous strategy.** No projected
field authorizes spend, experiments, campaigns, strategy changes, or any
execution. A downstream recommendation that would change money, experiments or
governance must be expressed as a new proposal through the governed R7
surfaces, subject to R7-F evaluation and human approval exactly like any other
client.

## 2. Consuming surface

Consumers read **only** through the tenant-scoped tRPC procedures on the
`strategicMemory` router:

| Procedure | Read model |
|---|---|
| `strategicMemory.r8Projections` | Current-state projection list (`includeNonActive: true` exposes labelled non-active memory) |
| `strategicMemory.get` | One record + lifecycle + projection (contradiction visibility included) |
| `strategicMemory.list` | Filtered rows + projections (status labelled) |
| `strategicMemory.listLifecycle` | Immutable history of one record |

The pure projection builder `buildStrategicMemoryProjection`
(`api/lib/strategic-memory/strategic-memory-projection.ts`) is the frozen
builder; consumers at integration time may rebuild projections from durable
rows but must never extend the key allowlist.

## 3. Projection field allowlist (exact, 30 keys)

| Key | Type | Semantics |
|---|---|---|
| `contractVersion` | `"strategic-memory-to-reasoning/v1"` | Frozen projection version |
| `memoryId` | `mem1:…` | Opaque canonical identity — reference verbatim, never parse or reconstruct |
| `businessId` | `number` | Owning business (server-verified) |
| `memoryType` | closed enum | `BUSINESS_FACT \| BUSINESS_ASSUMPTION \| STRATEGIC_OBJECTIVE \| STRATEGIC_DECISION \| OUTCOME_PATTERN \| LEARNING_PATTERN \| EXPERIMENT_RESULT \| OPTIMISATION_DECISION \| CONSTRAINT` |
| `subjectType` | closed enum | `BUSINESS \| CAMPAIGN \| OBJECTIVE \| DECISION \| OUTCOME \| ATTRIBUTION \| LEARNING \| EXPERIMENT \| OPTIMISATION \| GOVERNANCE \| PORTFOLIO \| POLICY` |
| `subjectId` | `string` | Opaque subject reference (e.g. `campaign:500`, `out1:…`) |
| `statementType` | `FACT \| ASSUMPTION` | The fact/assumption distinction — binding downstream |
| `factStatus` | closed enum | `CURRENT \| STALE \| SUPERSEDED \| CONTRADICTED \| EXPIRED \| INVALIDATED` |
| `statement` | closed-template render / bounded attestation object | Rendered from authoritative fields; content is never authority |
| `confidenceClass` | closed enum | `AUTHORITATIVE \| VERIFIED \| PROVISIONAL \| OBSERVED \| UNVERIFIED` (server-derived; never promotable downstream) |
| `evidenceRefs` | `string[]` | Exact upstream identities (out1:/atr1:/lrn1:/exp1:/exr1:/opt1:/ogd1:/psn1:/snapshot ids) |
| `sourceAuthority` | closed enum | `r7_outcome \| r7_attribution \| r7_learning \| r7_experimentation \| r7_budget_portfolio \| r7_governance \| business_dna \| strategy_snapshot \| operator_attestation` |
| `sourceVersion` | `string` | Frozen upstream contract version |
| `sourceIdentity` | `string` | Primary upstream identity (operator path: deterministic attestation coordinates) |
| `basis` | `{basisType, summary} \| null` | ASSUMPTION only; never null for ASSUMPTION records |
| `limitations` | `string[]` (≤8) | Preserved verbatim — including upstream disclaimers for R7-derived memory |
| `validFrom` | ISO 8601 | Validity window start |
| `validUntil` | ISO 8601 \| null | Validity window end (assumptions always set) |
| `observedAt` | ISO 8601 | When the underlying evidence was observed |
| `recordedAt` | ISO 8601 | When the memory was accepted |
| `supersedesMemoryId` | `mem1:… \| null` | Exact predecessor (history preserved) |
| `contradictsMemoryIds` | `mem1:…[]` | Records this record contradicts |
| `contradictedByMemoryIds` | `mem1:…[]` | Successors that contradict this record — contradiction stays visible |
| `contextScope` | closed shape | `{scopeType, campaignId, businessDnaSnapshotId}` — never wider than the verified business |
| `lifecycle` | `{statuses[], currentStatus, eventCount}` | Immutable smf1: fact summary |
| `causationClaimed` | `false` | Always false |
| `causationDisclaimer` | `string` | Verbatim disclaimer (§4) |
| `attributionClaimed` | `false` | Always false |
| `attributionDisclaimer` | `string` | Verbatim disclaimer (§4) |

Deliberately absent (downstream must derive or own): causal lift, incrementality,
ROI forecasts, strategy mutation authority, budget authority, execution flags,
model reasoning, raw upstream evidence text.

## 4. Causation and attribution disclaimer (verbatim on every projection)

```
causationClaimed: false
causationDisclaimer: "Strategic memory is durable context, not causal proof.
  This projection does not assert that any marketing activity, attribution
  credit or optimisation caused any business outcome."
attributionClaimed: false
attributionDisclaimer: "Attribution-derived memory is association evidence, not
  causal proof. Credit allocation, causal scores and channel weights remain
  R7-B derivations on their own authority."
```

**Association ≠ contribution ≠ allocated credit ≠ causal evidence.** Outcome-
pattern memory derived from R7-B attribution is *association*; only R7-D
experiment memory carries scoped causal evidence — and only within its recorded
design assumptions (its `limitations` say so verbatim).

## 5. Current-state semantics downstream must honour

- `r8Projections` returns **only `CURRENT` memory** as active. Non-active
  records (`STALE`, `SUPERSEDED`, `CONTRADICTED`, `EXPIRED`, `INVALIDATED`)
  appear only with `includeNonActive: true`, and always with their status
  labelled — never silently active.
- A `SUPERSEDED` record's successor is bound by `supersedesMemoryId`; both
  remain queryable forever.
- A `CONTRADICTED` record and its contradicting successor remain visible via
  `contradictsMemoryIds` / `contradictedByMemoryIds`; downstream must surface
  the conflict, never pick a winner silently.
- `EXPIRED`/`INVALIDATED` records are history, not context.
- ASSUMPTION records always carry `basis`, `limitations` and `validUntil`;
  treat their statements as provisional by construction.

## 6. Tenant, scope and freshness discipline

- Every read is tenant-scoped (`userId`-predicated) and business-scoped; the
  session anchors all reads. Cross-tenant/cross-business evidence never
  resolves.
- Re-validate at consumption time: `contractVersion`, `memoryId` pattern
  (`mem1:` + 64 hex), `factStatus`, `validFrom/validUntil`, and the frozen
  `sourceVersion` for the record's `sourceAuthority`.
- `contextScope` bounds generalisation: memory scoped `CAMPAIGN` must not be
  generalised to the whole business without new evidence.

## 7. Mutability and audit

- All projected fields are read-only. Corrections or derived state live in
  consumer-owned tables keyed by `memoryId` references (no FKs, house
  convention).
- The canonical `audit_events` ledger records every durable R8-A effect
  (`strategic_memory_recorded`, `strategic_memory_lifecycle`); consumers must
  not duplicate or shadow that authority.

## 8. Security invariants

1. Consumers must consume only through the tenant-scoped procedures and
   revalidate tenant scope on every query.
2. Consumers must not present memory as causal proof (§4).
3. Consumers must not promote ASSUMPTION → FACT, raise `confidenceClass`, or
   "resolve" contradictions — no such path exists and none may be built.
4. Consumers must not mutate projected fields or durable rows (§7).
5. A model-generated summary is never source authority; consumers may summarize
   memory but the memory records themselves never change.
6. Memory whose `limitations`/statement reference protected traits was
   rejected at ingest; consumers inherit the minimization duty.

---

**R8-B/C/D/E: consume strategic memory through this contract. Memory
remembers; it never decides.**
