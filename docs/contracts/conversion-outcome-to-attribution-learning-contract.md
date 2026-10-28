# CONVERSION OUTCOME → ATTRIBUTION / LEARNING HANDOFF CONTRACT (R7-A → R7-B/R7-C)

> **Producer:** R7-A (Conversion Outcome Intelligence), branch
> `feature/r7-a-conversion-outcome-intelligence`
> **Consumers:** R7-B (Attribution), R7-C (Learning / conversion feedback)
> **Status:** canonical handoff contract — downstream consumes, does not redefine
> **Implements:** `OUTCOME_PROJECTION_CONTRACT_VERSION = "conversion-outcome/v1"`
> **Source of truth:** `docs/contracts/conversion-outcome-intelligence-contract.md`
> (R7-A canonical outcome contract) + `api/lib/outcome/outcome-projection.ts`
> `buildOutcomeProjection`
> **Upstream (frozen, consumed not merged):** R6 Lead Autonomy V1
> (`integration/r6-lead-autonomy` @ `8030e97a…`) — R6-E conversion contract and
> the R6→R7 handoff contract.

This contract defines the frozen projection through which R7-B (attribution) and
R7-C (learning) consume durable business-outcome records. R7-A records what
business outcome a governed conversion produced, with what value, supported by
what evidence, and in what lifecycle state. **R7-A never asserts causation or
attribution.** R7-B derives credit allocation and causal models, and R7-C derives
conversion learning, each on its own authority, from this projection only.

**Outcome evidence does not imply attribution or causation.** The presence of a
`conversionId`, `leadId`, or any other reference on an outcome is observational
lineage. Credit allocation, attribution confidence, causal scores, and channel
weights are R7-B-derived quantities that this projection deliberately does not
contain.

---

## 1. Outcome identity

- `outcomeId` — `"out1:" + sha256(canonicalJson({ v: 1, tenantUserId,
  businessId, conversionId, evidenceSource, evidenceIdentity }))`,
  server-minted only, deterministic, tenant- and business-anchored
  (R7-A contract §3). Stable for the life of the record.
- Downstream must treat `outcomeId` as an **opaque, immutable reference**: no
  re-derivation, no parsing, no construction of new identities from its parts.
  Deduplicate and join on it verbatim.
- The tenant and business are bound inside the hash: identical upstream evidence
  under a different tenant or business is a **different** outcome, never a
  duplicate.

## 2. Conversion and lead references

- `conversionId` — the canonical R6-E conversion (`cnv1:`), opaque and verbatim
  (R6-E contract §3). Join outcomes to conversions on it verbatim; never
  reconstruct either identity.
- `leadId` (numeric, `| null`) — the server-verified lead binding carried by the
  canonical conversion and re-verified at outcome intake (same tenant; business
  null-or-equal). `null` means "no verified linkage", not "unknown person".
- `leadIdentityVersion` (`string | null`) — opaque R6-A reference stored verbatim;
  it carries no trust or authority of its own.
- Downstream must not attempt retroactive linkage, fuzzy matching, or identity
  re-resolution (R6-A owns identity; the lid1 ↔ numeric mapping is score-mediated
  and validated at R6-C/R6-D).

## 3. Classification and status semantics

- `outcomeType` — closed set of 12 (R7-A contract §2). Reversal types
  (`REFUND`/`REVERSAL`/`CANCELLATION`) are separate outcome rows bound by
  `reversesOutcomeId`; `RENEWAL` rows may carry `renewsOutcomeId`; `SUPERSEDED`
  rows are replaced by a corrected outcome bound by `supersedesOutcomeId` on the
  replacement.
- `outcomeStatus` — closed set of 6: `OBSERVED, PROVISIONAL, VERIFIED,
  REVERSED, CANCELLED, SUPERSEDED` (current CAS-guarded state).
- `verificationState` is the status: `VERIFIED` means an authoritative evidence
  class stands behind the value; `PROVISIONAL` (user attestation) and `OBSERVED`
  (unverified external) are evidence-only states. **Downstream must never treat
  PROVISIONAL/OBSERVED value as authoritative revenue, and must never promote it.**

## 4. Value semantics

- Monetary: `valueType = MONETARY`, `amountMinor` integer minor units
  (`bigint` grammar; JPY exponent 0, others 2 via `currencyExponent`), negative
  only on reversal rows, `|amount| ≤ 1e15`. `currency` ∈ closed 20-code allowlist.
- Non-monetary: `valueType = NON_MONETARY`, `quantity` (1..1e9) + `metricUnit`
  (closed set of 8). Never a fabricated currency.
- **Net-value computation is downstream's own derivation.** R7-A preserves the
  original outcome value immutably and records reversal/refund/cancellation
  lineage as separate rows + immutable facts; any netting, time-series value, or
  aggregation must account for `reversesOutcomeId`, terminal statuses, and
  supersession — computed by R7-B/R7-C on their own authority, never written
  back to R7-A tables.

## 5. Evidence provenance

- `evidenceSource` (closed 8), `evidenceAuthority` (closed 7, server-derived),
  `evidenceIdentity` (bounded opaque reference: invoice id, payment reference,
  contract id, report key), `evidenceHash` (immutable-core sha256).
- Provenance says where the business-value evidence came from. It is not a
  narrative, contains no free-form text, no PII, and no credential material.
- Downstream must consume evidence fields as opaque lineage and must not treat
  any provenance reference as the attributed cause (§8).

## 6. Lifecycle semantics

`lifecycle` on the projection exposes the immutable fact history:
`statuses` (target status per immutable lifecycle fact, in recorded order),
`currentStatus` (= row `outcomeStatus`), `eventCount`.

- Terminal statuses: `REVERSED`, `CANCELLED`, `SUPERSEDED`. Terminal rows keep
  their full history and original value; they must not be double-counted.
- Full reversal flips the target to `REVERSED`/`CANCELLED`; a **partial reversal**
  leaves the target at `VERIFIED` (etc.) with the fact recorded — downstream
  derives partial reversal impact from the facts.
- Supersession replaces a non-reversal outcome: the superseded row is terminal;
  the replacement row carries `supersedesOutcomeId`. History is preserved on both.

## 7. Exact-once / replay semantics

- Recording is insert-first against durable unique anchors (`bo_outcome_id_uidx`,
  `bo_natural_key_uidx`): duplicates, concurrent records, and retries converge to
  one durable row (`duplicateClassification: "none" | "idempotent_replay"`).
- Replaying the same identity with different material fails closed:
  `OUTCOME_IDENTITY_CONFLICT`.
- Lifecycle facts converge on `bole_event_id_uidx` / `bole_external_uidx`;
  conflicting reuse fails closed (`OUTCOME_LIFECYCLE_CONFLICT`).
- Every read path re-verifies the evidence hash; tampering fails closed
  (`OUTCOME_EVIDENCE_CONFLICT`). Projections are pure functions of the durable
  row + its facts, so re-reading is inherently replay-safe.
- Downstream must key idempotency on `outcomeId`; there is no client idempotency
  identity.

## 8. Causation and attribution disclaimer

Every projection carries, verbatim:

```
causationClaimed: false
attributionClaimed: false
causationDisclaimer: "Outcome evidence only. This projection does not assert
  that any campaign, publication, opportunity, engagement or marketing activity
  caused this business outcome."
attributionDisclaimer: "Outcome evidence does not imply attribution. Credit
  allocation, causal scores and channel weights are R7-B derivations on their own
  authority, never derived from this projection's fields."
```

**Provenance ≠ causation ≠ attribution.** R7-B must derive attribution confidence,
causal scores, channel weights, and campaign credit on its own authority and must
retain/surface these disclaimers in any derived output that traces back to an
outcome. R7-C must treat outcomes as observed feedback evidence, never as proof
that a strategy caused the outcome.

## 9. Privacy restrictions

- The projection carries **no PII**: no name, email, phone, or company fields
  exist anywhere in the outcome tables or the projection.
- **No `userId` exposure**: the tenant id is internal to R7-A storage and never
  appears in the projection; downstream consumes within tenant scope through the
  tenant-scoped procedures only.
- Downstream inherits the minimization duty: do not join, enrich, or retain
  personal data onto this projection without a governance decision; honor R6-F
  privacy states (`SUPPRESSED`/`RESTRICTED`/`RETENTION_EXPIRED`) as stop signals
  for any optimisation action that touches a lead (R6→R7 handoff §8).

## 10. R7-B / R7-C-consumable fields

Exact top-level allowlist from `OUTCOME_PROJECTION_FIELD_KEYS` (27 keys —
asserted exact in acceptance):

| Key | Type | Semantics |
|---|---|---|
| `contractVersion` | `"conversion-outcome/v1"` | Frozen projection version |
| `outcomeId` | `string` | Opaque canonical identity (§1) |
| `businessId` | `number` | Owning business (server-verified) |
| `leadId` | `number \| null` | Server-verified lead linkage only (§2) |
| `leadIdentityVersion` | `string \| null` | Opaque R6-A reference, verbatim (§2) |
| `conversionId` | `string` | Canonical R6-E conversion reference (§2) |
| `outcomeType` | `string` | Closed vocab (§3) |
| `outcomeStatus` | `string` | Closed vocab; current lifecycle state (§3) |
| `valueType` | `string` | `MONETARY \| NON_MONETARY` (§4) |
| `amountMinor` | `number \| null` | Integer minor units; negative on reversal rows (§4) |
| `currency` | `string \| null` | Closed ISO allowlist (§4) |
| `currencyExponent` | `number \| null` | ISO 4217 exponent; JPY 0, others 2 (§4) |
| `quantity` | `number \| null` | Non-monetary metric quantity (§4) |
| `metricUnit` | `string \| null` | Closed vocab (§4) |
| `evidenceSource` | `string` | Closed vocab (§5) |
| `evidenceAuthority` | `string` | Closed vocab; server-derived (§5) |
| `evidenceIdentity` | `string` | Bounded opaque evidence pointer (§5) |
| `evidenceHash` | `string` | Immutable-core sha256 (§5) |
| `occurredAt` | `string` | Outcome time, ISO 8601 verbatim |
| `recordedAt` | `string` | Acceptance/record time, ISO 8601 |
| `reversesOutcomeId` | `string \| null` | Reversal lineage (§3/§6) |
| `renewsOutcomeId` | `string \| null` | Renewal lineage (§3) |
| `supersedesOutcomeId` | `string \| null` | Supersession lineage (§3) |
| `lifecycle` | `{ statuses: readonly OutcomeStatus[]; currentStatus: string; eventCount: number }` | Immutable fact history (§6) |
| `causationClaimed` | `false` | Always false (§8) |
| `causationDisclaimer` | `string` | Verbatim disclaimer (§8) |
| `attributionClaimed` | `false` | Always false (§8) |
| `attributionDisclaimer` | `string` | Verbatim disclaimer (§8) |

## 11. Fields downstream must derive itself

R7-B / R7-C own, and this projection deliberately does not provide:

- Attribution confidence, causal scores, channel/platform weights, touch-model
  output, campaign/publication credit or ROI
- Net-value, time-series, or aggregated revenue computations (derive from value
  fields + lineage + terminal statuses on downstream's own authority)
- Any optimisation signal (budget shifts, portfolio reallocation, strategy
  mutation, learning feedback weights)

Deriving these from provenance or value fields alone would restate the causation
and attribution this contract forbids (§8).

## 12. Fields downstream must not mutate

**All of them.** Every projected field (§10) and every durable row behind it
(`business_outcomes`, `business_outcome_lifecycle_events`) is read-only for R7-B /
R7-C. Corrections or derived state live in **R7-owned tables** keyed by `outcomeId`
references (no FKs). Downstream must not rewrite outcome authority, must not
back-fill or alter lead/conversion linkage, and must not "fix" amounts, statuses,
or evidence fields on R7-A rows — observed history is immutable (R7-A contract §9).

## 13. Schema dependencies

- `business_outcomes`, `business_outcome_lifecycle_events` — stream-local
  provisional migration `0035_r7_a_conversion_outcome_foundation` (**artefact only,
  NOT executed**; journal idx 35 + snapshot generated offline, no database
  touched). See `docs/recovery/r7-a-unexecuted-migrations.md`. R7-X owns final R7
  convergence; downstream must not execute or renumber migrations itself.
- **No FK constraints** couple these tables to anything (house convention: opaque
  references, predicate enforcement). Downstream tables must likewise reference
  `outcomeId` opaquely.

## 14. Security invariants

1. Downstream must consume outcomes only through the tenant-scoped procedures
   (`outcome.r7Projections` / `outcome.get` / `outcome.list`) and must revalidate
   tenant scope on every query — never expose or join `userId` across tenants.
2. Downstream must not promote PROVISIONAL/OBSERVED value to verified and must keep
   non-authoritative values out of any authoritative revenue total.
3. Downstream must not infer causation or attribution from provenance references
   and must retain/surface the disclaimers in any derived output (§8).
4. Downstream must honor reversal lineage and terminal statuses in any
   aggregation (§4/§6).
5. Downstream must not mutate projected fields or durable rows (§12).
6. Downstream must not demand PII: none exists in this projection, and none may be
   reconstructed by joining against personal data without governance authority.

---

**R7-B / R7-C: consume outcomes through this contract. Outcome evidence does not
imply attribution or causation — derive your own attribution and learning
authority. Do not redefine outcome authority.**
