# BUSINESS CHANGE → STRATEGIC REASONING HANDOFF CONTRACT (R8-B → R8-D/E)

> **Producer:** R8-B Business Change Intelligence (`feature/r8-b-business-change-intelligence`)
> **Consumers:** R8-D strategic reasoning, R8-E opportunity/risk intelligence (and any later strategic consumer)
> **Status:** canonical downstream contract — consumers read, never redefine or mutate
> **Projection version:** `business-change-to-reasoning/v1`
> **Source of truth:** `docs/contracts/business-change-intelligence-contract.md` (R8-B canonical) + `api/lib/business-change/business-change-projection.ts` (`BUSINESS_CHANGE_PROJECTION_FIELD_KEYS` — asserted exact in acceptance)
> **Upstream (frozen, consumed not merged):** R8-A Strategic Memory @ `23d0f22` via `docs/contracts/strategic-memory-to-reasoning-contract.md`; R8-F Strategic Governance @ `44118e3` by contract reference.

---

## 1. Purpose and boundaries

R8-B owns internal-business-change detection and change evidence. This contract
is the **only** surface through which downstream R8 streams consume it.
Downstream may read and must never mutate: no R8-D/E call may write
`business_change_events`, `business_change_lifecycle_events`, or any upstream
authority table, and no consumer may mint change identities, statuses,
significance classes or lifecycle resolutions.

**Change evidence is not recommendation authority.** No projected field
authorizes spend, experiments, campaigns, strategy changes, or any execution.
A downstream recommendation that would change money, experiments, or
governance must be expressed as a new proposal through the governed R7
surfaces (R7-F evaluation + human approval), and must additionally pass R8-F
governance before it may be voiced.

## 2. Consuming surface

Consumers read **only** through the tenant-scoped tRPC procedures on the
`businessChange` router:

| Procedure | Read model |
|---|---|
| `businessChange.r8Projections` | Active-change projection list (`includeNonActive: true` exposes labelled non-active changes) |
| `businessChange.get` | One change + lifecycle + projection (contradiction visibility included) |
| `businessChange.list` | Filtered rows + projections (status labelled) |
| `businessChange.listLifecycle` | Immutable history of one change |

The pure projection builder `buildBusinessChangeProjection`
(`api/lib/business-change/business-change-projection.ts`) is the frozen
builder; consumers at integration time may rebuild projections from durable
rows but must never extend the key allowlist.

## 3. Projection field allowlist (exact, 28 keys)

| Key | Type | Semantics |
|---|---|---|
| `contractVersion` | `"business-change-to-reasoning/v1"` | Frozen projection version |
| `changeId` | `chg1:…` | Opaque canonical identity — reference verbatim, never parse or reconstruct |
| `businessId` | `number` | Owning business (server-verified) |
| `changeDomain` | closed enum | §3.1 of the canonical contract |
| `changeType` | closed enum | Directional change type |
| `subjectType` | closed enum | §3.3 of the canonical contract |
| `subjectId` | `string` | Opaque subject reference |
| `previousStateRef` | closed shape | `{authority, memoryId, sourceIdentity, sourceVersion, statementType, stateFingerprint}` |
| `currentStateRef` | closed shape | Same shape — the compared new state |
| `evidenceRefs` | `string[]` | Exact upstream identities (out1:/atr1:/lrn1:/psn1:/ogd1:/bdna_/ssnap_/att1:…) |
| `sourceAuthority` | closed enum | New-state source |
| `sourceVersion` | `string` | Frozen upstream contract version |
| `significanceClass` | closed enum | `LOW \| MODERATE \| HIGH \| CRITICAL` (server-derived, confidence-capped) |
| `confidenceClass` | closed enum | `AUTHORITATIVE \| VERIFIED \| PROVISIONAL \| OBSERVED \| UNVERIFIED` (never promotable downstream) |
| `status` | closed enum | `DETECTED \| CONFIRMED \| PROVISIONAL \| CONTRADICTED \| SUPERSEDED \| INVALIDATED \| EXPIRED` |
| `detectedAt` | ISO 8601 | Detection time |
| `effectiveAt` | ISO 8601 | Upstream effect time |
| `recordedAt` | ISO 8601 | Acceptance time |
| `validUntil` | ISO 8601 \| null | Validity bound (if set) |
| `supersedesChangeId` | `chg1:… \| null` | Exact predecessor (correction lineage) |
| `limitations` | `string[]` (≤8) | Preserved verbatim |
| `lifecycle` | `{statuses[], currentStatus, eventCount}` | Immutable bcl1: fact summary |
| `memoryCandidate` | closed shape \| null | Labelled downstream candidate for R8-A ingest — reference-only, never authority |
| `governanceEligibilityHint` | closed enum | Advisory significance/evidence hint for R8-F-era governance (§5) |
| `causationClaimed` | `false` | Always false |
| `causationDisclaimer` | `string` | Verbatim disclaimer (§4) |

Deliberately absent (consumers must not expect or reconstruct): causal claims,
ROI forecasts, strategy-mutation authority, budget authority, execution flags,
model reasoning, raw upstream evidence text, client/agent authority fields.

### 3.1 Memory candidate shape (closed, reference-only)

```
{ candidateType: "strategic_memory_ingest_candidate",
  suggestedMemoryType: string,     // closed R8-A memory type
  suggestedSubjectType: string,    // closed R8-A subject type
  suggestedSubjectId: string,
  statementSummary: string ≤280,   // bounded render of the change — content, never authority
  basis: {basisType, summary}      // bounded
}
```

The candidate is **advisory material only**. R8-A remains the memory authority:
a candidate may be proposed to R8-A's governed ingest/record paths at R8-X
integration, but this projection never mints memory and consumers must not
treat the candidate as recorded memory.

## 4. Causation disclaimer (verbatim on every projection)

```
causationClaimed: false
causationDisclaimer: "Business change evidence records that an internal state
  comparison detected a change between two authoritative states. It does not
  assert that any marketing activity, attribution credit or optimisation
  caused the change, and it is not a recommendation to act."
```

**Detection ≠ causation ≠ recommendation.** A detected change is an observed
before/after pair with provenance; why it changed is R8-D reasoning under R8-F
governance.

## 5. Governance eligibility hint (advisory)

`governanceEligibilityHint` is a deterministic, advisory mapping from
(significanceClass, confidenceClass):

| significance | confidence (capped) | hint |
|---|---|---|
| LOW | any | `CONTEXT_ONLY` |
| MODERATE | any | `REVIEW_ORIENTED` |
| HIGH | ≤ PROVISIONAL | `REVIEW_ORIENTED` |
| HIGH | ≥ VERIFIED | `ELIGIBLE_FOR_GOVERNED_REASONING` |
| CRITICAL | AUTHORITATIVE | `ELIGIBLE_FOR_GOVERNED_REASONING` |

The hint **narrows nothing and authorizes nothing** — it only tells the
consumer which evidence posture applies before the consumer runs its own R8-F
governance evaluation. R8-F (`strategic-intelligence-governance-contract.md`)
remains the sole authority over whether any recommendation may be voiced;
stale/review-bound evidence can never justify an autonomous recommendation.

## 6. Current-state semantics downstream must honour

- `r8Projections` returns **only active changes** (`DETECTED`, `CONFIRMED`,
  `PROVISIONAL`) as active. Non-active records (`CONTRADICTED`, `SUPERSEDED`,
  `INVALIDATED`, `EXPIRED`) appear only with `includeNonActive: true`, always
  with status labelled — never silently active.
- A `SUPERSEDED` change's successor is bound by `supersedesChangeId`; both
  remain queryable forever.
- A `CONTRADICTED` change and its contradicting successor remain visible;
  downstream must surface the conflict, never pick a winner silently.
- `EXPIRED`/`INVALIDATED` changes are history, not active context.
- `PROVISIONAL` changes (operator-attested) are provisional by construction:
  they may inform reasoning but can never anchor autonomous conclusions.

## 7. Tenant, scope and freshness discipline

- Every read is tenant-scoped (`userId`-predicated) and business-scoped; the
  session anchors all reads. Cross-tenant/cross-business evidence never
  resolves.
- Re-validate at consumption time: `contractVersion`, `changeId` pattern
  (`chg1:` + 64 hex), `status`, `validUntil`, and the frozen `sourceVersion`
  for the record's `sourceAuthority`.
- The previous-state ref binds the R8-A memory identity: consumers honour
  R8-A current-state semantics (a change whose `previousStateRef.memoryId`
  is no longer CURRENT in R8-A must be treated as historical context, not
  live comparison truth).

## 8. Mutability and audit

- All projected fields are read-only. Corrections or derived state live in
  consumer-owned tables keyed by `changeId` references (no FKs, house
  convention).
- The canonical `audit_events` ledger records every durable R8-B effect
  (`business_change_detected`, `business_change_lifecycle`); consumers must
  not duplicate or shadow that authority.

## 9. Security invariants

1. Consumers must consume only through the tenant-scoped procedures and
   revalidate tenant scope on every query.
2. Consumers must not present change evidence as causal proof (§4) or as a
   recommendation.
3. Consumers must not promote `confidenceClass`, raise `significanceClass`,
   or "resolve" contradictions — no such path exists and none may be built.
4. Consumers must not mutate projected fields or durable rows (§8).
5. A model-generated summary is never source authority; consumers may
   summarize change evidence but the change records themselves never change.
6. Change material referencing protected traits was rejected at the boundary;
   consumers inherit the minimization duty.

---

**R8-D/E: consume business change through this contract. Change evidence
notices; it never decides.**
