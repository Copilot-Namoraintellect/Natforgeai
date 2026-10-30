# STRATEGIC MEMORY CONTRACT (WBS-R8-A)

> **Stream:** R8-A Strategic Memory
> **Branch:** `feature/r8-a-strategic-memory`
> **Status:** canonical R8-A contract — downstream (R8-B/C/D/E) consumes, never redefines
> **Contract version:** `strategic-memory/v1`
> **Upstream (frozen, consumed not merged):** R7 Business Optimisation V1
> (`integration/r7-business-optimisation`, accepted HEAD `a2c084a1…`) via
> `docs/contracts/business-optimisation-to-strategic-intelligence-contract.md`;
> R6 Lead Autonomy V1 (`8030e97a…`); Business DNA / strategy snapshot authorities
> (reference only — see `docs/recovery/r8-a-strategic-memory-inventory.md` §3).

---

## 1. Purpose and boundaries

R8-A turns durable upstream authorities — R7 outcomes, attribution, learning,
experiment results, optimisation proposals/instructions, governance decisions —
together with stable business context (Business DNA, goals/objectives, strategy
history, historical decisions), into a **versioned strategic memory**:
durable context over time, never rewritten, never silently refreshed.

**Strategic memory is durable context, not autonomous strategy.** No memory
record may authorize spend, experiments, campaigns, or strategy changes.

R8-A owns: strategic-memory identity; memory record types; the fact/assumption
distinction; evidence provenance; temporal validity; supersession;
contradiction; expiry/staleness; strategic objective/reference memory;
decision-history memory; business-context memory; R7-derived strategic evidence
memory; current-state projection; immutable history; the downstream read-only
contract.

R8-A does **not** own: market/external signal collection; strategic reasoning;
opportunity/risk classification; strategy generation; campaign execution;
budget optimisation; experiment execution; governance approval; business
outcome truth; attribution truth; learning truth; provider/payment/billing
authority. It creates **no competing authority** for Business DNA, R7 outcomes,
R7 learning or R7 governance.

## 2. Core principles (binding)

1. Strategic memory is durable context, not autonomous strategy.
2. Facts and assumptions remain distinct (`statementType`).
3. Historical records are immutable (`evidenceHash`-bound core; no update path).
4. New evidence may supersede a prior record but must not erase it
   (`supersedesMemoryId` binds the exact predecessor; history stays queryable).
5. Contradictions remain visible (`contradictsMemoryIds`; both records persist;
   the current projection surfaces the conflict).
6. Stale/expired facts never silently remain active (deterministic temporal
   state; current projection excludes non-current memory).
7. Model-generated summaries are never source authority (no model output field
   exists at the boundary; R7-derived statements are closed-template renders of
   authoritative fields only).
8. Strategic memory is reproducible from durable evidence (deterministic
   identity + source fingerprint + evidence hash; replay reproduces the row).
9. Tenant/business boundaries are absolute (identity binds `tenantUserId` +
   `businessId` inside every hash; ownership re-verified from durable rows per
   call).
10. No memory record may itself authorize spend, experiments, campaigns or
    strategy changes (no execution fields exist anywhere in the schema).

## 3. Record shape and closed vocabularies

`contractVersion = "strategic-memory/v1"` on every record and projection.

| Field | Type | Rule |
|---|---|---|
| `memoryId` | `mem1:` + sha256-64 | Server-minted only (§4). |
| `userId` / `businessId` | bigint | Session tenant + server-verified business ownership. |
| `memoryType` | closed enum (§3.1) | Server-derived (R7 ingest) or client-proposed + server-validated (operator path). |
| `subjectType` | closed enum (§3.2) | Server-normalized. |
| `subjectId` | bounded string ≤191 | Opaque upstream reference (e.g. `campaign:500`, `out1:…`); verbatim. |
| `statementType` | `FACT \| ASSUMPTION` | §5 — the fact/assumption distinction. |
| `factStatus` | closed enum (§3.3) | Denormalized current lifecycle status; CAS-guarded transitions only. |
| `statement` | JSON closed-template render / bounded attestation object | Derived: rendered from authoritative upstream fields via closed templates. Operator: `{ text }` bounded ≤1024 chars, stored verbatim as untrusted content. |
| `evidenceRefs` | `string[]` (each ≤191, closed pattern §3.5) | Exact upstream identities; every ref re-resolved server-side at ingest (§6). |
| `sourceAuthority` | closed enum (§3.4) | §6 provenance. |
| `sourceVersion` | bounded string ≤48 | Frozen upstream contract version per source (§6). |
| `sourceIdentity` | bounded string ≤191 | The primary upstream identity this memory derives from (operator path: deterministic attestation coordinates). |
| `sourceFingerprint` | sha256-64 | Hash of the exact upstream material consumed; drift = tampering (§6). |
| `confidenceClass` | closed enum (§3.6) | Server-derived deterministic mapping (§5.3); never client-supplied. |
| `basis` | JSON \| null | ASSUMPTION: required non-empty (§5.2). FACT: null. |
| `limitations` | `string[]` ≤8 × ≤191 | Preserved verbatim into every projection. |
| `validFrom` | ISO 8601 ≤32 | Required. |
| `validUntil` | ISO 8601 ≤32 \| null | ASSUMPTION: required (expiry/review semantics). FACT: optional. |
| `observedAt` | ISO 8601 ≤32 | When the underlying fact/evidence was observed. |
| `recordedAt` | ISO 8601 ≤32 | When the memory row was accepted. |
| `supersedesMemoryId` | `mem1:…` \| null | Exact predecessor binding (§7). |
| `contradictsMemoryIds` | `mem1:…[]` | Exact contradiction bindings (§7). |
| `contextScope` | JSON closed shape (§3.7) | Server-derived bounded scope; never client-widened. |
| `evidenceHash` | sha256-64 | Immutable-core hash (§4.3). |
| `version` | int | Optimistic-CAS guard for status transitions. |
| `createdAt` | timestamp | DB default. |

### 3.1 Memory types (closed — adapted, not mechanically adopted)

`BUSINESS_FACT`, `BUSINESS_ASSUMPTION`, `STRATEGIC_OBJECTIVE`,
`STRATEGIC_DECISION`, `OUTCOME_PATTERN`, `LEARNING_PATTERN`, `EXPERIMENT_RESULT`,
`OPTIMISATION_DECISION`, `CONSTRAINT`.

Not adopted (no repository-native support; owning streams are named instead):
`RISK_POSTURE` and `CAPABILITY_STATE` — opportunity/risk conclusions belong to
R8-B/C; capability/provider truth belongs to upstream authorities. A later
stream may propose additions only via a new contract version.

### 3.2 Subject types (closed)

`BUSINESS`, `CAMPAIGN`, `OBJECTIVE`, `DECISION`, `OUTCOME`, `ATTRIBUTION`,
`LEARNING`, `EXPERIMENT`, `OPTIMISATION`, `GOVERNANCE`, `PORTFOLIO`, `POLICY`.

### 3.3 Memory lifecycle statuses (closed)

`CURRENT`, `STALE`, `SUPERSEDED`, `CONTRADICTED`, `EXPIRED`, `INVALIDATED`.

Deterministic state (§8). Status is a denormalized, CAS-guarded projection of
the append-only lifecycle facts; it is never client-writable.

### 3.4 Source authorities (closed)

| Source | May mint | Notes |
|---|---|---|
| `r7_outcome` | OUTCOME_PATTERN, BUSINESS_FACT* | R7-A `conversion-outcome/v1`; VERIFIED-class only for FACT (*see §5.1). |
| `r7_attribution` | OUTCOME_PATTERN (association-only) | R7-B `attribution-to-learning/v1`; `causationClaimed:false` travels verbatim. |
| `r7_learning` | LEARNING_PATTERN | R7-C learning projections; confidence/contradiction/novelty preserved. |
| `r7_experimentation` | EXPERIMENT_RESULT | R7-D result handoff; design-assumption limitations preserved. |
| `r7_budget_portfolio` | OPTIMISATION_DECISION | R7-E strategy handoff / proposal / instruction; governance block + disclaimers preserved. |
| `r7_governance` | OPTIMISATION_DECISION, CONSTRAINT | R7-F decisions; immutable; expiry computed. |
| `business_dna` | BUSINESS_FACT, CONSTRAINT | Governed derivation from hash-verified DNA snapshots only. |
| `strategy_snapshot` | STRATEGIC_DECISION, CONSTRAINT | Strategy-history derivation from hash-verified snapshots only. |
| `operator_attestation` | BUSINESS_ASSUMPTION, STRATEGIC_OBJECTIVE, STRATEGIC_DECISION, CONSTRAINT | Authenticated human input (§5.2). **Never** FACT. |

### 3.5 Evidence reference patterns (closed)

Each `evidenceRefs[]` entry matches one of (per source authority):
`out1:[a-f0-9]{64}`, `atr1:…`, `lrn1:…`, `evb1:…`, `exp1:…`, `exr1:…`,
`opt1:…`, `ins1:…`, `ogd1:…`, `psn1:…`, `bdna_[a-z0-9]{1,64}`
(business DNA snapshot ids), `ssnap_[a-z0-9]{1,64}` (strategy snapshot ids),
`campaign:[0-9]+`. Identity prefixes mirror the frozen upstream families; no
other shape is accepted.

### 3.6 Confidence classes (closed)

`AUTHORITATIVE`, `VERIFIED`, `PROVISIONAL`, `OBSERVED`, `UNVERIFIED`.
Server-derived only, by the deterministic mapping in §5.3. Monotonic downward
under re-evaluation; no path promotes confidence.

### 3.7 Context scope (closed shape, server-derived)

```
{ scopeType: "BUSINESS" | "CAMPAIGN" | "OBJECTIVE" | "PORTFOLIO",
  campaignId: number | null,
  businessDnaSnapshotId: string | null }
```

`scopeType=CAMPAIGN` requires an owned `campaignId`. No client-supplied scope
may widen beyond the server-verified business; cross-context
overgeneralisation fails closed (§9).

### 3.8 Protected traits (closed rejection set)

`race, ethnicity, religion, belief, health, genetic, biometric, political
opinion, trade_union_membership, sexual_orientation, precise_geolocation`.
Memory whose statement, basis, limitations or contextScope references a
protected trait is rejected (`STRATEGIC_MEMORY_PROTECTED_TRAIT_REJECTED`)
under the default policy. No v1 lawful-authority exception path exists; any
future exception requires a governed policy version, not client input.

## 4. Identity and evidence binding (A2)

### 4.1 Memory identity

```
memoryKey = sha256(canonicalJson({
  v: 1,
  tenantUserId, businessId,
  sourceAuthority, sourceIdentity,
  memoryType,
  contextScope            // canonical server-derived shape
}))
memoryId  = "mem1:" + memoryKey
```

Same business + source authority + source identity + semantic memory type +
context scope ⇒ same memory identity. Retries/concurrent ingests converge on
one durable row (`duplicateClassification: "none" | "idempotent_replay"`).
Re-ingest of the same natural identity with a **different** source fingerprint
or evidence hash is conflicting replay and fails closed
(`STRATEGIC_MEMORY_IDENTITY_CONFLICT`).

### 4.2 No fuzzy matching; no client-selected authoritative ids

Clients reference upstream ids only. The server loads the durable upstream row
(R7 seam / DNA store / snapshot store), re-verifies ownership and integrity,
and derives everything else. Unknown source identities, cross-business or
cross-tenant evidence, stale unsupported contract versions, and tampered
source fingerprints all fail closed (§6.3).

### 4.3 Immutable core

`evidenceHash = sha256(canonicalJson({v:1, userId, businessId, memoryType,
subjectType, subjectId, statementType, statement, evidenceRefs (verbatim,
order-normalized), sourceAuthority, sourceVersion, sourceIdentity,
confidenceClass, basis, limitations, validFrom, validUntil, observedAt,
supersedesMemoryId, contradictsMemoryIds (verbatim), contextScope}))` —
`recordedAt` (server acceptance time) is deliberately excluded so a later
re-ingest of the same upstream record converges as an idempotent replay
rather than conflicting on clock drift; the row itself remains immutable.

Drift between a retained row and a recomputed hash is tampering and fails
closed on every read (`STRATEGIC_MEMORY_EVIDENCE_CONFLICT`).

## 5. Fact vs assumption (A3)

### 5.1 FACT

`statementType=FACT` requires **authoritative evidence**: the source authority
must be one of `r7_outcome, r7_attribution, r7_learning, r7_experimentation,
r7_budget_portfolio, r7_governance, business_dna, strategy_snapshot`, the
bound upstream rows must pass their own integrity assertions, and the derived
confidence must be at least `OBSERVED` (R7-A `OBSERVED`/`UNVERIFIED_EXTERNAL`
lands `OBSERVED`; user attestation cannot mint FACT — `operator_attestation`
FACT proposals are rejected). Model-generated text can never create FACT; the
boundary exposes no model-output field.

### 5.2 ASSUMPTION

`statementType=ASSUMPTION` requires, server-enforced:
- `basis`: non-empty bounded JSON (`{ basisType: closed enum
  ("OPERATOR_JUDGMENT","MARKET_SIGNAL","PENDING_VERIFICATION","PRIOR_EXPERIENCE"),
  summary: string ≤280 }`);
- `confidenceClass ∈ {PROVISIONAL, OBSERVED, UNVERIFIED}` (never
  AUTHORITATIVE/VERIFIED);
- `limitations`: non-empty;
- `validUntil` set (expiry/review semantics — an assumption without an expiry
  is rejected: `STRATEGIC_MEMORY_ASSUMPTION_REQUIRES_EXPIRY`).

A client cannot promote ASSUMPTION → FACT: no boundary field accepts such a
transition; promotion is only possible by re-ingesting authoritative upstream
evidence, which mints a **new** FACT record (that may supersede the
assumption).

### 5.3 Deterministic confidence mapping (server-derived only)

| Upstream material | confidenceClass |
|---|---|
| R7-A VERIFIED_* authority classes | VERIFIED |
| R7-A USER_ATTESTED | PROVISIONAL |
| R7-A UNVERIFIED_EXTERNAL / OBSERVED | OBSERVED |
| R7-B DIRECT_LINKAGE | VERIFIED |
| R7-B STRONG_ASSOCIATION | PROVISIONAL |
| R7-B WEAK_ASSOCIATION | OBSERVED |
| R7-B INSUFFICIENT_EVIDENCE | UNVERIFIED |
| R7-C HIGH confidence | VERIFIED |
| R7-C MEDIUM | PROVISIONAL |
| R7-C LOW | OBSERVED |
| R7-C NONE | UNVERIFIED |
| R7-D result confidence (STRONG→VERIFIED, MODERATE→PROVISIONAL, WEAK→OBSERVED, INSUFFICIENT→UNVERIFIED) | mapped |
| R7-E STRATEGIC/MODERATE/WEAK/INSUFFICIENT | mapped likewise |
| R7-F decision (verbatim authority) | VERIFIED for the decision fact itself |
| DNA snapshot / strategy snapshot (hash-verified) | AUTHORITATIVE |
| operator_attestation | PROVISIONAL ceiling (UNVERIFIED if basis is PENDING_VERIFICATION) |

## 6. Source provenance and the R7 ingestion seam (A6)

### 6.1 Frozen versions

`r7_outcome → conversion-outcome/v1`; `r7_attribution → attribution-to-learning/v1`;
`r7_learning → business-learning-to-experiment-optimisation/v1` (learning
projection surface); `r7_experimentation → experimentation-result-handoff/v1`;
`r7_budget_portfolio → business-optimisation-to-strategy/v1`;
`r7_governance → optimisation-governance/v1`. Any other version fails closed
(`STRATEGIC_MEMORY_SOURCE_VERSION_UNSUPPORTED`).

### 6.2 Consumption discipline

R7-derived memory is built exclusively from the frozen projection surfaces
listed in `docs/contracts/business-optimisation-to-strategic-intelligence-contract.md`,
via the R7 stores' own read + integrity-assertion + projection-builder paths
behind guarded information-schema existence checks (house seam pattern). When
an upstream table is absent the seam fail-closed degrades to "no evidence" —
memory is never fabricated. R8-A never writes any R7 (or R6/Business DNA)
table.

### 6.3 Rejection rules (fail closed, at ingest)

- `STRATEGIC_MEMORY_SOURCE_UNKNOWN` — source identity does not resolve in the
  tenant scope.
- `STRATEGIC_MEMORY_CROSS_BUSINESS_EVIDENCE` — resolved row belongs to a
  different business.
- `STRATEGIC_MEMORY_CROSS_TENANT_EVIDENCE` — resolved row belongs to a
  different tenant.
- `STRATEGIC_MEMORY_SOURCE_VERSION_UNSUPPORTED` — stale/unknown contract
  version.
- `STRATEGIC_MEMORY_SOURCE_FINGERPRINT_CONFLICT` — recomputed upstream
  fingerprint disagrees with the ingest material (tamper/injection).
- `STRATEGIC_MEMORY_AUTHORITY_PROVENANCE_MISSING` — no durable provenance row.

### 6.4 Truth preservation

R8-A never reclassifies R7 evidence into stronger truth than its source
supports: attribution stays *association* (`causationClaimed:false` verbatim in
the record's limitations-derived statement and in every projection);
provisional outcomes stay provisional; learning contradictions/novelty and
experiment design-assumption limitations are preserved verbatim; optimisation
memory carries its governance block, `validUntil` and both disclaimers.

## 7. Supersession and contradiction (A5)

- Supersession: the successor row binds `supersedesMemoryId`; the predecessor
  is CAS-transitioned to `SUPERSEDED` and one immutable lifecycle fact
  (`smf1:`) is minted on it. Predecessor rows are never deleted or edited.
- Contradiction: the newer row binds `contradictsMemoryIds`; every referenced
  record is CAS-transitioned to `CONTRADICTED` with a lifecycle fact. Both
  records remain visible; the current projection exposes the conflict
  (successor listed alongside contradicted predecessors).
- Bindings are scope-checked: predecessor/contradicted ids must exist in the
  same tenant + business, else fail closed
  (`STRATEGIC_MEMORY_LINEAGE_SCOPE_CONFLICT`).
- New evidence supporting an old memory (same natural identity, same
  fingerprint) converges idempotently; supporting *fresh* upstream material
  mints lifecycle `REAFFIRMATION` facts, never edits.
- Changed business objective / changed policy/constraint / changed
  optimisation result = a new record superseding (or contradicting) the old —
  history preserved.

## 8. Temporal model and current-state projection (A4)

Deterministic status (recomputed identically at read; CAS-guarded when
materialized):

1. A `SUPERSESSION` lifecycle fact (or bound successor) ⇒ `SUPERSEDED`.
2. An unresolved `CONTRADICTION` fact ⇒ `CONTRADICTED`.
3. An `INVALIDATION` fact (upstream evidence reversed/cancelled/superseded/
   contradicted — re-evaluation, §8.1) ⇒ `INVALIDATED`.
4. `validUntil` < now ⇒ `EXPIRED`.
5. A `STALENESS` fact (source refresh observed without replacement) ⇒ `STALE`.
6. Otherwise ⇒ `CURRENT`.

The **current projection** (`getCurrentState` / `r8Projections`,
`strategic-memory-to-reasoning/v1`) returns only `CURRENT` memory as active;
`STALE`/`SUPERSEDED`/`CONTRADICTED`/`EXPIRED`/`INVALIDATED` records remain
queryable via `get`/`list`/`listLifecycle` and appear in projections only when
explicitly requested (with their status labelled — never silently active).

### 8.1 Dependency re-evaluation

Memory binds upstream evidence by `evidenceRefs`. On ingest of upstream
material whose lifecycle invalidates prior evidence (R7-A reversal/cancellation,
R7-B supersession/zero-credit retirement, R7-C contradiction, R7-D result
supersession, R7-F expiry), R8-A mints `INVALIDATION` lifecycle facts on
dependent non-terminal memory and CAS-guards their status to `INVALIDATED`
(or `STALE` where the source merely went quiet). Re-affirming evidence mints
`REAFFIRMATION` facts. One fact per dependent record per re-evaluation;
replays converge.

## 9. Security, tenant and agent boundaries (A7)

- Session `userId` anchors everything; business/lineage/evidence ownership is
  re-verified from durable rows on every call. Cross-tenant/cross-business
  reads return nothing (fail closed).
- Client-authority smuggling fails closed (`STRATEGIC_MEMORY_CLIENT_AUTHORITY_FIELD_FORBIDDEN`):
  `memoryId, factStatus, confidenceClass, evidenceHash, sourceFingerprint,
  userId, id, version` and any `*Claimed/*Disclaimer/verified*` field are
  server-side only.
- No client force-state, no arbitrary confidence promotion, no contradiction
  deletion, no cross-business memory stitching, no `validFrom/validUntil`
  backdating beyond the bounded clock-skew window (§boundary checks, ±5 min
  future skew like R7-A).
- Prompt-injected source text is untrusted: operator statements are bounded
  verbatim content, never authority; ingestion of upstream evidence uses only
  server-loaded rows (never client-supplied payloads).
- A runtime model/agent can never: create FACT without source evidence;
  rewrite history; suppress contradiction; promote confidence; alter
  provenance; fabricate upstream R7 evidence; alter Business DNA; execute
  shell/SQL/tools; access secrets; change its own permissions. The R8-A
  surface contains no such operations.
- **Non-execution invariant:** no R8-A code path writes campaigns, budgets,
  experiments, approvals, payments, providers, CRM, or any R7 table. There is
  no execution authority here.

## 10. Audit

Canonical `audit_events` ledger only (no shadow ledger): one
`strategic_memory_recorded` event per inserted memory row and one
`strategic_memory_lifecycle` event per inserted lifecycle fact; convergence /
replay paths emit zero. Metadata carries ids / closed labels / hashes only.

## 11. Schema and migration

Tables `strategic_memory_records` and `strategic_memory_lifecycle_events`
(stream-local provisional migration `0036_r8_a_strategic_memory_foundation`,
artefact only — **NOT executed**; R8-X owns canonical sequencing;
`docs/recovery/r8-a-unexecuted-migrations.md`). R7's `0035` migration is
untouched.

## 12. Downstream contract

Read-only projection for R8-B/C/D/E:
`docs/contracts/strategic-memory-to-reasoning-contract.md`
(`strategic-memory-to-reasoning/v1`). Downstream may read, never mutate.
