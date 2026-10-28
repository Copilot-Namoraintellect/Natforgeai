# ATTRIBUTION → BUSINESS LEARNING HANDOFF CONTRACT (R7-B → R7-C)

> **Producer:** R7-B (Attribution Intelligence), branch
> `feature/r7-b-attribution-intelligence`
> **Consumer:** R7-C (Business Learning / conversion feedback)
> **Status:** canonical handoff contract — downstream consumes, does not redefine
> **Implements:** `ATTRIBUTION_LEARNING_CONTRACT_VERSION = "attribution-to-learning/v1"`
> **Source of truth:** `docs/contracts/attribution-intelligence-contract.md`
> (R7-B canonical attribution contract) + `api/lib/attribution/attribution-projection.ts`
> `buildAttributionLearningProjection`
> **Upstream (frozen, consumed not merged):** R7-A Conversion Outcome
> Intelligence (`feature/r7-a-conversion-outcome-intelligence` @ `3e8aea8`) via
> `docs/contracts/conversion-outcome-to-attribution-learning-contract.md`;
> R6 Lead Autonomy V1 (`integration/r6-lead-autonomy` @ `8030e97a…`).

This contract defines the frozen projection through which R7-C consumes
durable attribution results. R7-B determines which prior journey events are
legitimately associated with a canonical R7-A outcome, what contribution
evidence exists, and how deterministic models allocate credit. **R7-B never
asserts causation.** R7-C derives business learning on its own authority from
this projection only.

**Allocated credit is association evidence, not causal proof.** Credit,
confidence, and evidence classes are R7-B-derived quantities; the presence of
credit on a touchpoint must never be read by R7-C as "this caused the
outcome".

---

## 1. Attribution identity

- `attributionId` — `"atr1:" + sha256(canonicalJson({ v: 1, tenantUserId,
  businessId, outcomeId, modelType, modelVersion, windowStart, windowEnd,
  journeyHash, totalCreditBps, confidenceClass, evidenceClass, outcomeStatus,
  policyVersion }))`, server-minted only, deterministic, tenant-anchored
  (R7-B contract §3). Stable for the life of the record.
- Downstream must treat `attributionId` as an **opaque, immutable reference**:
  no re-derivation, no parsing, no construction of new identities from its
  parts. Deduplicate and join on it verbatim.
- The tenant is bound inside the hash: identical material under a different
  tenant is a **different** attribution, never a duplicate.

## 2. Outcome and lead references

- `outcomeId` — the canonical R7-A outcome (`out1:`), opaque and verbatim.
  `outcomeStatus`/`outcomeType` are the **snapshots at attribution
  calculation time**; the current outcome state is R7-A authority and must be
  re-read through the outcome projection when freshness matters.
- `conversionId` — the canonical R6-E conversion (`cnv1:`), opaque and
  verbatim.
- `leadId` (numeric, `| null`) — the outcome-carried server-verified lead
  linkage. `null` means "no verified linkage", never "unknown person". R7-C
  must not attempt retroactive linkage or fuzzy matching (R6-A owns identity;
  the lid1 ↔ numeric mapping is score-mediated).
- Supersession: when a result is superseded, `supersedesAttributionId` on the
  newer result names the prior one. The **current** attribution per outcome +
  model + version is the latest result not superseded by a newer one.

## 3. Credit semantics

- `totalCreditBps` — integer basis points. For every non-empty eligible
  touchpoint set the total is **exactly** 100000 (100.000%); zero-credit
  results (reversed outcomes, insufficient evidence) carry `0`.
- `touchpoints[]` — the eligible set, each with `creditBps` (integer),
  `type` (closed: `CAMPAIGN | PUBLICATION | ENGAGEMENT | OPPORTUNITY |
  NURTURE_TOUCH | SALES_HANDOFF`), `sourceIdentity` (upstream durable id),
  `occurredAt`, `businessId` (null-or-equal scope), and `provenance`
  (lineage path + referencing ids + source-row hash).
- `excludedTouchpoints[]` — candidates excluded with one closed reason code
  each (audit completeness; never credit-bearing).
- **Credit is not causal proof.** R7-C must not convert credit into causal
  claims, channel ROI statements, or budget assertions. Confidence and model
  assumptions must be preserved, not flattened, in any derived learning.

## 4. Confidence / evidence semantics

- `evidenceClass` (closed): `DIRECT_LINKAGE | STRONG_ASSOCIATION |
  WEAK_ASSOCIATION | INSUFFICIENT_EVIDENCE` — derived from journey quality
  (chronology completeness, timestamp authority, lineage stability, outcome
  verification state), never from model opinion.
- `confidenceClass` (closed): `HIGH | MEDIUM | LOW | NONE` — deterministic
  mapping from the evidence class.
- `outcomeStatus` snapshot governs how much trust the value deserves:
  `VERIFIED` outcomes support full classes; `PROVISIONAL`/`OBSERVED` outcomes
  are capped at `STRONG_ASSOCIATION` and only exist when policy allowed them.
  R7-C must keep provisional-derived learning labelled as such.

## 5. Models and windows

- `modelType` + `modelVersion` — the closed model identity used (e.g.
  `FIRST_TOUCH` @ `attribution-first-touch/v1`). Each model's assumptions are
  versioned constants (documented in the R7-B contract §7); R7-C must carry
  the model version in any learning derived from credit and must not blend
  credits across model versions without labelling the blend.
- `windowStart` / `windowEnd` — the bounded attribution window (ISO 8601,
  UTC); `windowEnd` equals the outcome time. Window membership decisions are
  R7-B authority.

## 6. Lifecycle semantics

- Attribution results are immutable. Truthful change is new history: a newer
  result supersedes (`supersedesAttributionId` + an immutable supersession
  fact). R7-C must honor supersession: superseded results are historical
  evidence, never current credit.
- Reversed / cancelled / superseded outcomes never retain a misleading active
  positive attribution: synchronization mints a zero-credit successor. R7-C
  must use the **current** (non-superseded) attribution per outcome + model.

## 7. Exact-once / replay semantics

- Evaluation is insert-first against durable unique anchors
  (`atr_attribution_id_uidx`, `atr_natural_key_uidx`): duplicates, concurrent
  evaluations, and retries converge to one durable result surfaced as
  `duplicateClassification: "none" | "idempotent_replay"`.
- Replaying the same identity with different material fails closed
  (`ATTRIBUTION_REPLAY_CONFLICT`); record-hash drift on any read fails closed
  (`ATTRIBUTION_EVIDENCE_CONFLICT`). Projections are pure functions of the
  durable row, so re-reading is inherently replay-safe.
- R7-C must key idempotency on `attributionId`; there is no client idempotency
  identity.

## 8. Causation and attribution disclaimer

Every projection carries, verbatim:

```
causationClaimed: false
causationDisclaimer: "Allocated credit is association evidence, not causal
  proof. This projection does not assert that any touchpoint caused the
  business outcome."
attributionClaimed: true
```

**Association ≠ contribution ≠ allocated credit ≠ causal evidence.** R7-C
must retain and surface these disclaimers in any derived output that traces
back to an attribution, and must never present allocated credit as
incremental or causal lift (that requires R7-D experimental evidence).

## 9. Privacy restrictions

- The projection carries **no PII**: no name, email, phone, or company fields
  exist anywhere in the attribution tables or the projection.
- **No `userId` exposure**: the tenant id is internal to R7-B storage and
  never appears in the projection; downstream consumes within tenant scope
  through the tenant-scoped procedures only.
- Downstream inherits the minimization duty: do not join, enrich, or retain
  personal data onto this projection without a governance decision; honor
  R6-F privacy states (`SUPPRESSED`/`RESTRICTED`/`RETENTION_EXPIRED`) as stop
  signals for any optimisation action that touches a lead.

## 10. R7-C-consumable fields

Exact top-level allowlist from `ATTRIBUTION_LEARNING_PROJECTION_FIELD_KEYS`
(25 keys — asserted exact in acceptance):

| Key | Type | Semantics |
|---|---|---|
| `contractVersion` | `"attribution-to-learning/v1"` | Frozen projection version |
| `attributionId` | `string` | Opaque canonical identity (§1) |
| `outcomeId` | `string` | Canonical R7-A outcome reference |
| `outcomeStatus` | `string` | Outcome state snapshot at calculation time |
| `outcomeType` | `string` | Outcome classification snapshot |
| `businessId` | `number` | Owning business (server-verified) |
| `leadId` | `number \| null` | Outcome-carried lead linkage only (§2) |
| `conversionId` | `string` | Canonical R6-E conversion reference |
| `modelType` | `string` | Closed model type (§5) |
| `modelVersion` | `string` | Closed model identity version (§5) |
| `windowStart` | `string` | Window lower bound, ISO 8601 UTC |
| `windowEnd` | `string` | Window upper bound (= outcome time) |
| `touchpoints` | `AttributionTouchpoint[]` | Eligible set with allocated credit (§3) |
| `excludedTouchpoints` | `AttributionExcludedTouchpoint[]` | Excluded candidates + closed reasons |
| `totalCreditBps` | `number` | Integer basis points; exactly 100000 or 0 |
| `confidenceClass` | `string` | Closed confidence class (§4) |
| `evidenceClass` | `string` | Closed evidence class (§4) |
| `policyVersion` | `string` | Attribution policy version |
| `sourceVersions` | `unknown` | Consumed contract versions |
| `supersedesAttributionId` | `string \| null` | Supersession lineage (§6) |
| `journeyHash` | `string` | Eligible-set fingerprint |
| `calculatedAt` | `string` | Calculation time (provenance only) |
| `causationClaimed` | `false` | Always false (§8) |
| `causationDisclaimer` | `string` | Verbatim disclaimer (§8) |
| `attributionClaimed` | `true` | Always true (§8) |

## 11. Fields R7-C must derive itself

R7-C owns, and this projection deliberately does not provide:

- Causal lift, incrementality, or any causal score
- Learning weights, model feedback parameters, or strategy promotion
- Budget/portfolio optimisation signals
- Aggregated revenue, ROI, or net-value computations (derive from outcome
  authority + attribution credit on R7-C's own authority, honouring
  supersession and provisional caps)

Deriving these from credit alone would restate the causation this contract
forbids (§8).

## 12. Fields downstream must not mutate

**All of them.** Every projected field (§10) and every durable row behind it
(`attribution_results`, `attribution_lifecycle_events`) is read-only for R7-C.
Corrections or derived state live in **R7-owned tables** keyed by
`attributionId` references (no FKs). R7-C must not rewrite attribution
authority, must not back-fill or alter touchpoint sets, and must not "fix"
credit, classes, or windows on R7-B rows — calculated history is immutable.

## 13. Schema dependencies

- `attribution_results`, `attribution_lifecycle_events` — stream-local
  provisional migration `0035_r7_b_attribution_foundation` (**artefact only,
  NOT executed**; journal idx 35 + snapshot generated offline; no database
  touched). See `docs/recovery/r7-b-unexecuted-migrations.md`. R7-X owns final
  R7 convergence (including collision resolution with R7-A's provisional
  `0035`); downstream must not execute or renumber migrations itself.
- **No FK constraints** couple these tables to anything (house convention:
  opaque references, predicate-enforced ownership). R7-C tables must likewise
  reference `attributionId` opaquely.

## 14. Security invariants

1. R7-C must consume attributions only through the tenant-scoped procedures
   (`attribution.get` / `attribution.list`) and must revalidate tenant scope on
   every query — never expose or join `userId` across tenants.
2. R7-C must honor supersession: only current (non-superseded) results count
   as active credit.
3. R7-C must not promote provisional/observed-derived credit to verified
   authority and must keep such learning labelled.
4. R7-C must not infer causation from credit and must retain/surface the
   disclaimers in any derived output.
5. R7-C must not mutate projected fields or durable rows.
6. R7-C must not demand PII: none exists in this projection.

---

**R7-C: consume attributions through this contract. Allocated credit is
association evidence, not causal proof. Do not redefine attribution
authority.**
