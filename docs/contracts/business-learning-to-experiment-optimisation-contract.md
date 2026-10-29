# BUSINESS LEARNING → EXPERIMENT / OPTIMISATION HANDOFF CONTRACT (R7-C → R7-D/R7-E)

> **Producer:** R7-C (Business Learning Engine), branch
> `feature/r7-c-business-learning`
> **Consumers:** R7-D (Experimentation), R7-E (Budget/Portfolio Optimisation)
> **Status:** canonical handoff contract — downstream consumes, does not redefine
> **Implements:** `BUSINESS_LEARNING_TO_EXPERIMENT_CONTRACT_VERSION = "business-learning-to-experiment-optimisation/v1"`
> **Source of truth:** `docs/contracts/business-learning-contract.md`
> (R7-C canonical learning contract) + `api/lib/business-learning/business-learning-projection.ts`
> `buildExperimentOptimisationProjection`
> **Upstream (frozen, consumed not merged):** R7-A
> (`feature/r7-a-conversion-outcome-intelligence` @ `3e8aea8`) via
> `conversion-outcome/v1`; R7-B (`feature/r7-b-attribution-intelligence` @
> `6ff9eca`) via `attribution-to-learning/v1`; R6 Lead Autonomy V1
> (`8030e97a…`). Governance: R7-F (`feature/r7-f-optimisation-governance` @
> `5e4ab95`) — separate authority, consumed by downstream, never embedded here.

This contract defines the frozen, read-only projection through which R7-D
and R7-E consume durable business-learning records. R7-C turns governed
outcomes and attributed journey activity into evidence-bounded learning.
**Learning is evidence, not authority.** This projection deliberately
contains no execution permission of any kind.

**Learning does not authorize experiment execution. Learning does not
authorize budget change.** R7-D/R7-E must separately obtain R7-F governance
authority (`evaluate` + `assertOptimisationActionExecutable`) before any
material action. Learning eligibility ≠ execution permission.

---

## 1. Learning identity

- `learningId` — `"lrn1:" + sha256(canonicalJson({ v: 1, tenantUserId,
  businessId, learningType, subjectType, subjectId, outcomeTypeFamily,
  contextScope, evidenceBundleId, derivationVersion }))`, server-minted
  only, deterministic, tenant- and business-anchored (R7-C contract §3).
- Downstream must treat `learningId` as an **opaque, immutable reference**:
  no re-derivation, no parsing, no construction of new identities from its
  parts. Deduplicate and join on it verbatim.
- `evidenceBundleId` — `"evb1:" + sha256(...)` over the exact source
  authorities (outcome ids, attribution ids, source versions). Same
  authoritative evidence set → same bundle id. Downstream may use it to
  recognise records reproducible from the same evidence.

## 2. Consuming surface

R7-D/R7-E consume **only** through the tenant-scoped tRPC procedures
`businessLearning.getExperimentProjection` /
`businessLearning.listExperimentProjections` (or the pure projection builder
at integration time). No other R7-C surface is downstream-consumable, and
downstream must never read R7-C tables directly.

## 3. Projection field allowlist

Exact top-level key allowlist from
`BUSINESS_LEARNING_EXPERIMENT_PROJECTION_FIELD_KEYS` (23 keys — asserted
exact in acceptance):

| Key | Type | Semantics |
|---|---|---|
| `contractVersion` | `"business-learning-to-experiment-optimisation/v1"` | Frozen projection version |
| `learningId` | `string` | Opaque canonical identity (§1) |
| `businessId` | `number` | Owning business (server-verified) |
| `learningType` | `string` | Closed vocab (R7-C contract §2) |
| `subjectType` | `string` | Closed vocab |
| `subjectId` | `string` | Verbatim upstream subject identity |
| `outcomeTypeFamily` | `string` | Derived outcome family / `MIXED` |
| `contextScope` | `LearningContextScope` | Server-derived bounded scope (R7-C contract §6) |
| `confidenceClass` | `string` | `INSUFFICIENT_EVIDENCE \| WEAK \| MODERATE \| STRONG` |
| `evidenceClass` | `string` | `VERIFIED \| PROVISIONAL \| MIXED \| INSUFFICIENT` |
| `supportCount` | `number` | Distinct positive-support pairs |
| `contradictionCount` | `number` | Distinct opposite-direction pairs |
| `noveltyClass` | `string` | `NEW \| REINFORCING \| CONTRADICTING \| DUPLICATE \| SUPERSEDING` |
| `status` | `string` | `CANDIDATE \| SUPPORTED \| CONTRADICTED \| SUPERSEDED \| DEPRECATED \| INVALIDATED` |
| `outcomeIds` | `string[]` | Canonical out1: source references |
| `attributionIds` | `string[]` | Canonical atr1: source references |
| `limitations` | `string[]` | What must NOT be inferred (R7-C contract §15) |
| `derivedAt` | `string` | Derivation time (provenance only) |
| `validUntil` | `string \| null` | Expiry where applicable |
| `freshness` | `{ stale: boolean; provisional: boolean; contradictionUnresolved: boolean }` | Governance-eligibility metadata (§5) |
| `governanceAuthorityRequired` | `"R7-F"` | Constant — downstream MUST obtain R7-F authority before action |
| `causationClaimed` | `false` | Always false (§6) |
| `causationDisclaimer` | `string` | Verbatim disclaimer (§6) |

Deliberately absent (downstream must derive or own itself): causal lift,
incrementality, experiment design, treatment assignment, budget deltas,
portfolio weights, ROI. Deriving these from learning fields alone would
restate the causation this contract forbids.

## 4. Status semantics downstream must honour

- Only `SUPPORTED` learning is meaningful promotion material; `CANDIDATE`
  is provisional support, `CONTRADICTED`/`SUPERSEDED`/`DEPRECATED`/
  `INVALIDATED` records are history, never current evidence.
- Supersession: the current record per
  `(learningType, subjectType, subjectId)` is the latest non-superseded,
  non-deprecated record. Downstream must join on `learningId` and re-read
  rather than cache across lifecycle changes.
- Contradictions remain visible: a subject whose current record is
  `CONTRADICTED` carries unresolved contradiction
  (`freshness.contradictionUnresolved = true`) and must not be promoted as
  settled knowledge.

## 5. Governance-eligibility metadata (not governance)

`freshness` is **metadata for R7-F policies to consider**, computed
deterministically by R7-C:

- `stale` — `validUntil` passed, or the record's `derivedAt` is older than
  the learning freshness horizon (policy constant; snapshot at projection).
- `provisional` — `evidenceClass ∈ { PROVISIONAL, MIXED }`.
- `contradictionUnresolved` — current status `CONTRADICTED`, or
  `contradictionCount > 0` on a current record.

This metadata narrows nothing and widens nothing. R7-F alone decides
whether any action may proceed; R7-C never calls R7-F and never embeds a
governance engine.

## 6. Causation disclaimer (verbatim on every projection)

```
causationClaimed: false
causationDisclaimer: "Learning records are association evidence derived from
  governed outcomes and attributed journey activity. This projection does not
  assert that any subject caused any business outcome."
```

**Association ≠ contribution ≠ allocated credit ≠ causal evidence.** Any
R7-D/R7-E output that traces back to a learning record must retain and
surface this disclaimer. Causal claims require R7-D experimental evidence
under R7-F governance — never learning records alone.

## 7. Mutability

**All projected fields are read-only for R7-D/R7-E.** R7-C durable rows are
immutable (append-only lifecycle). Downstream must not rewrite learning
authority, must not "fix" classes, counts or scopes, and must not delete
inconvenient learning. Corrections or derived state live in R7-D/R7-E-owned
tables keyed by `learningId` references (no FKs, house convention).

## 8. Privacy

- The projection carries **no PII**: no name, email, phone, or company
  fields exist anywhere in the learning tables or the projection.
- **No `userId` exposure**: the tenant id is internal to R7-C storage and
  never appears in the projection; downstream consumes within tenant scope
  through the tenant-scoped procedures only.
- Downstream inherits the minimization duty and must honour R6-F privacy
  states (`SUPPRESSED`/`RESTRICTED`/`RETENTION_EXPIRED`) as stop signals for
  any optimisation action that touches a lead (R6→R7 handoff §8).

## 9. Exact-once / replay semantics

- Derivation is insert-first against durable unique anchors
  (`blr_learning_id_uidx`, `blr_natural_key_uidx`): replays and concurrent
  derivations converge to one durable row surfaced as
  `duplicateClassification: "none" | "idempotent_replay"`.
- Projections are pure functions of the durable row + its lifecycle facts,
  so re-reading is inherently replay-safe. Downstream must key idempotency
  on `learningId`; there is no client idempotency identity.

## 10. Security invariants

1. Downstream must consume learning only through the tenant-scoped
   procedures and must revalidate tenant scope on every query.
2. Downstream must not present learning as causal proof (§6).
3. Downstream must not promote provisional-derived learning as verified.
4. Downstream must not mutate projected fields or durable rows (§7).
5. Downstream must obtain R7-F governance authority before any material
   action; R7-C learning projections are never sufficient authority.

---

**R7-D / R7-E: consume learning through this contract. Learning is
evidence, not authority. Learning does not authorize experiment execution
or budget change. Do not redefine learning authority.**
