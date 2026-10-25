# CONVERSION → ATTRIBUTION HANDOFF CONTRACT (WBS-R6-E → R7)

> **Producer:** R6-E (Conversion Tracking & Outcome Authority), branch
> `feature/r6-e-conversion-tracking`
> **Consumer:** R7 (Attribution)
> **Status:** canonical handoff contract — R7 consumes, does not redefine
> **Implements:** `CONVERSION_PROJECTION_CONTRACT_VERSION =
> "conversion-to-attribution/v1"`
> **Source of truth:** `docs/contracts/conversion-event-contract.md` (R6-E
> canonical conversion contract) + `api/lib/conversion/conversion-projection.ts`
> `buildR7ConversionProjection`
> **Upstream (frozen, consumed not merged):** R5 integrated base `a947ecb` —
> `docs/contracts/opportunity-candidate-contract.md`,
> `docs/contracts/opportunity-to-lead-autonomy-contract.md`,
> `docs/contracts/engagement-to-opportunity-contract.md`,
> `docs/contracts/social-listening-to-intelligence-contract.md`,
> `docs/contracts/marketing-action-policy-contract.md`

This contract defines the frozen projection through which R7 consumes
durable conversion/outcome records. R6-E records observed business outcomes
and their lineage; **R6-E never asserts causation**. R7 derives attribution
on its own authority, from this projection only.

---

## 1. Conversion identity

- `conversionId` — `"cnv1:" + sha256(canonicalJson({ v: 1, tenantUserId,
  sourceSystem, externalConversionId }))`, server-minted only, deterministic,
  tenant-anchored (canonical contract §3). Stable for the life of the record.
- R7 must treat `conversionId` as an **opaque, immutable reference**: no
  re-derivation, no parsing, no construction of new identities from its
  parts. Deduplicate and join on it verbatim.
- The tenant id is bound inside the hash: identical upstream evidence under a
  different tenant or source system is a **different** conversion, never a
  duplicate.

## 2. Source-system identity

- `sourceSystem` — closed vocabulary of 13 (canonical contract §5):
  `internal, stripe, paypal, shopify, woocommerce, salesforce, hubspot,
  calendly, meta, linkedin, google_analytics, user_report,
  unverified_webhook`.
- Recorded **verbatim** from the provider/system that reported the outcome;
  part of the natural key `(userId, sourceSystem, externalConversionId)` —
  R7 must include it (with the tenant) in any correlation or dedupe logic.

## 3. Lead linkage rules

- `leadId` is present **only** where a server-verified linkage exists
  (durable `leads` row, same tenant, business null-or-equal); it is `null`
  otherwise. `null` means "no verified linkage", not "unknown person".
- `leadIdentityVersion` is an opaque reference stored verbatim, reserved for
  R6-A; it carries no trust or authority of its own.
- **Never fuzzy:** R6-E performs no name/demographic/sentiment/IP matching.
  R7 must not attempt retroactive linkage against R6-E records.
- R6-A owns lead identity (its contract is pending on that stream); linkage
  today is keyed by durable ids only.

## 4. Trust classes

Closed set of 6 (canonical contract §6):

```
VERIFIED_INTERNAL, VERIFIED_PROVIDER, VERIFIED_CRM, VERIFIED_PAYMENT,
USER_REPORTED, UNVERIFIED_EXTERNAL
```

**Financial-authority subset** (monetary value is authoritative —
`FINANCIAL_AUTHORITY_TRUST_CLASSES`):

```
VERIFIED_INTERNAL, VERIFIED_PROVIDER, VERIFIED_CRM, VERIFIED_PAYMENT
```

`USER_REPORTED` and `UNVERIFIED_EXTERNAL` are evidence classes only. Trust
class is server-derived; R7 must never reclassify a record on its own.

## 5. Conversion types

Closed set of 14 (canonical contract §5):

```
purchase, subscription, booking, consultation, demo_completed,
contract_signed, application_submitted, renewal, retained_customer,
qualified_offline_outcome, refund, cancellation, reversal, unknown
```

`refund`/`cancellation`/`reversal` are reversal types (§7); `unknown` is a
reserved aggregation fallback. R7 must handle the full closed set
gracefully but must not treat any label as an attribution decision.

## 6. Value / currency semantics

- Amounts are **integer minor units** (`bigint`); `|amount| ≤ 1e15`;
  negative only on reversal rows. Original amounts are immutable.
- `currencyExponent` — ISO 4217 minor-unit exponent from
  `CURRENCY_EXPONENTS`: `JPY` = 0 (zero-decimal), all other supported codes =
  2; `null` when the record carries no currency.
- **Verified vs reported split** (never both, never neither when a value
  exists):
  - Financial-authority trust classes (§4) → `verifiedAmount` /
    `verifiedCurrency` set, `reportedAmount` / `reportedCurrency` `null`.
  - `USER_REPORTED` / `UNVERIFIED_EXTERNAL` → `reportedAmount` /
    `reportedCurrency` set, `verifiedAmount` / `verifiedCurrency` `null`.
- **Reported value must never be promoted to verified downstream.** Only a
  future server-side corroboration flow could change a record's trust class;
  R7 must not treat reported amounts as authoritative revenue in any
  attribution, billing, or optimization output.

## 7. Reversal / refund semantics

- Reversal rows carry `reversesConversionId` — the `conversionId` they
  reverse — forming a durable lineage. Reversal-of-reversal is forbidden.
- Reversal types map deterministically onto the target's lifecycle:
  `refund` → `REFUNDED`, `cancellation` → `CANCELLED`, `reversal` →
  `REVERSED` (optimistic-CAS guarded; `CONVERSION_STALE_STATE` on stale
  writes).
- `lifecycle` on the projection exposes the fact history:
  `statuses` (outcome status per immutable lifecycle fact, in recorded
  order), `currentStatus` (= row `outcomeStatus`), `eventCount`.
- Terminal reversal states (`REVERSED`/`REFUNDED`/`CANCELLED`) mean the
  original outcome no longer stands at its face value; net-value and
  time-series computations over conversions are **R7's own derivation** and
  must account for reversal lineage.
- The original record's evidence material (amount, evidence hash, occurred
  time) is **preserved untouched** — reversals are new rows/facts, never
  edits.

## 8. Provenance semantics

Five reference-only lineage fields, grouped under `provenance`:

```
sourceOpportunityId        (string | null)  — R5-D opportunity candidate
sourceEngagementReceiptId  (string | null)  — R5-C engagement receipt
sourceSignalId             (string | null)  — R5-A social signal key
sourceCampaignId           (number | null)  — campaign row id
sourcePublicationId        (number | null)  — publication row id
```

- Reference-only: ownership was already re-verified server-side at ingest
  (cross-tenant references fail closed upstream). R7 must consume them as
  opaque lineage, must not re-resolve them into new claims, and must not
  treat any of them as the attributed cause (§9).
- Absence (`null`) means no provenance was recorded — it never implies
  organic/untouched origin.

## 9. Causation disclaimer

Every projection carries, verbatim:

```
causationClaimed: false
causationDisclaimer: "Provenance lineage only. This projection does not
assert that any campaign, publication, opportunity or engagement caused
this conversion."
```

**Provenance ≠ causation.** The presence of `sourceCampaignId` (or any other
provenance reference) on a conversion is observational lineage. Attribution
confidence, causal scores, and channel weights are R7-derived quantities that
this projection deliberately does not contain (canonical contract §14;
acceptance case 17).

## 10. Exact-once / replay semantics

- Ingest is insert-first against durable unique anchors
  (`ce_conversion_id_uidx`, `ce_natural_key_uidx`): duplicates, concurrent
  ingests, and retries converge to **one durable row**, surfaced as
  `duplicateClassification: "none" | "idempotent_replay"`.
- Replaying the same identity with different material (any hashed field,
  including `observedAt`) fails closed: `CONVERSION_IDENTITY_CONFLICT`.
- Provider lifecycle retries converge on
  `cle_event_id_uidx` / `cle_external_uidx` to one lifecycle fact;
  conflicting reuse fails closed (`CONVERSION_LIFECYCLE_CONFLICT`).
- Every read path re-verifies the evidence hash; tampering fails closed
  (`CONVERSION_EVIDENCE_CONFLICT`). Projections are pure functions of the
  durable row + its lifecycle rows, so re-reading is inherently replay-safe.
- R7 must key idempotency on `conversionId`; there is no client idempotency
  identity.

## 11. Immutable fields

Everything the projection exposes is immutable (canonical contract §16):

`conversionId`, `businessId`, `leadId`, `leadIdentityVersion`,
`conversionType`, `occurredAt`, `observedAt`, `sourceSystem`,
`sourceTrustClass`, `amount` (original), `currency`, `reversesConversionId`,
all five provenance references, `evidenceHash`, and `evidenceReference`
(internal — projected as `null`).

The only upstream-mutable field is `outcomeStatus` (guarded CAS lifecycle
transitions, §7), visible via `outcomeStatus` / `lifecycle.currentStatus`.
Lifecycle rows themselves are entirely immutable. Corrections are new
events, never edits.

## 12. Privacy restrictions

- The projection carries **no PII**: no name, email, phone, or company
  fields exist anywhere in the conversion tables or the projection.
- **No `userId` exposure**: the tenant id is internal to R6-E storage and
  never appears in the projection; R7 consumes within tenant scope through
  the tenant-scoped procedures only.
- **No `evidenceReference` exposure**: it is always `null` in the projection
  and stays internal to the evidence row.
- R7 inherits the minimization duty: do not join, enrich, or retain personal
  data onto this projection without a governance decision.

## 13. R7-consumable fields

Exact top-level allowlist from `PROJECTION_FIELD_KEYS` (22 keys — asserted
exact in acceptance case 25):

| Key | Type | Semantics |
|---|---|---|
| `contractVersion` | `"conversion-to-attribution/v1"` | Frozen projection version |
| `conversionId` | `string` | Opaque canonical identity (§1) |
| `businessId` | `number` | Owning business (server-verified) |
| `leadId` | `number \| null` | Server-verified lead linkage only (§3) |
| `leadIdentityVersion` | `string \| null` | Opaque R6-A reference, verbatim (§3) |
| `conversionType` | `string` | Closed vocab (§5) |
| `occurredAt` | `string` | Provider event time, ISO 8601 verbatim |
| `observedAt` | `string` | Server acceptance time, ISO 8601 |
| `outcomeStatus` | `string` | Closed vocab; current lifecycle state (§7) |
| `sourceSystem` | `string` | Closed vocab (§2) |
| `sourceTrustClass` | `string` | Closed vocab (§4) |
| `reportedAmount` | `number \| null` | Non-authoritative value (§6) |
| `reportedCurrency` | `string \| null` | Non-authoritative value (§6) |
| `verifiedAmount` | `number \| null` | Authoritative value, financial-authority classes only (§6) |
| `verifiedCurrency` | `string \| null` | Authoritative value (§6) |
| `currencyExponent` | `number \| null` | ISO 4217 exponent; JPY 0, others 2 (§6) |
| `reversesConversionId` | `string \| null` | Reversal lineage (§7) |
| `provenance` | `{ sourceOpportunityId: string \| null; sourceEngagementReceiptId: string \| null; sourceSignalId: string \| null; sourceCampaignId: number \| null; sourcePublicationId: number \| null }` | Reference-only lineage (§8) |
| `lifecycle` | `{ statuses: readonly ConversionOutcomeStatus[]; currentStatus: string; eventCount: number }` | Immutable fact history (§7) |
| `evidenceReference` | `null` | Always null — internal only (§12) |
| `causationClaimed` | `false` | Always false (§9) |
| `causationDisclaimer` | `string` | Verbatim disclaimer (§9) |

## 14. Fields R7 must derive itself

R7 owns, and this projection deliberately does not provide:

- Attribution confidence and causal scores of any kind
- Channel/platform weights and any touch-model output
- Campaign/publication effectiveness or ROI
- Any optimization signal (budget shifts, portfolio reallocation)
- Trust calibration of reported values (e.g. how much weight a
  `USER_REPORTED` amount deserves)

These require R7's own models and governance; deriving them from provenance
alone would restate the causation this contract forbids (§9).

## 15. Fields downstream must not mutate

All of them. Every projected field (§13) and every durable row behind it
(`conversion_events`, `conversion_lifecycle_events`) is read-only for R7.
Corrections or derived state live in **R7-owned tables** keyed by
`conversionId`. R7 must not rewrite conversion authority, must not
back-fill or alter `leadId` linkage, and must not "fix" amounts or statuses
on R6-E rows — observed history is immutable (canonical contract §16).

## 16. Schema dependencies

- `conversion_events`, `conversion_lifecycle_events` — provisional migration
  `db/migrations/0034_early_mole_man.sql` (**artefacts only, not executed**;
  journal idx 34 + snapshot generated offline, no database touched). See
  `docs/recovery/r6-e-unexecuted-migrations.md`. R6-X owns convergence; R7
  must not execute or renumber migrations itself.
- **No FK constraints** couple these tables to anything (repo convention:
  enforcement in query predicates). R7's own tables must likewise reference
  `conversionId` opaquely.

## 17. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Conversion authority (R6-E owned) | `api/lib/conversion/*`, `api/conversion-router.ts` | R7 read-only consumption via `conversion.r7Projections` / `conversion.get` / `conversion.list` |
| Canonical conversion contract | `docs/contracts/conversion-event-contract.md` | R6-E owned |
| Schema / migrations | `db/schema.ts`, `db/migrations/` | R7 must not edit; `0034` provisional, not executed |
| Attribution tables (future R7) | R7-owned | keyed by `conversionId` references; no FKs |
| Legacy analytics | `api/analytics-router.ts` | untouched by R6-E; R7 must not route governed conversions through the legacy ungoverned `metricType` `conversions`/`revenue` path |
| Leads / CRM | `api/lead-router.ts` | untouched |

## 18. Security invariants

1. R7 must consume conversions only through the tenant-scoped procedures
   (`conversion.r7Projections` / `conversion.get` / `conversion.list`) and
   must revalidate tenant scope on every query — never expose or join
   `userId` across tenants.
2. R7 must not promote reported values to verified, and must keep
   `USER_REPORTED` / `UNVERIFIED_EXTERNAL` records out of any authoritative
   revenue total.
3. R7 must not infer causation from provenance references and must retain/
   surface the causation disclaimer in any derived output that traces back
   to a conversion.
4. R7 must handle reversal states: honor `reversesConversionId` lineage and
   terminal statuses (`REVERSED`/`REFUNDED`/`CANCELLED`) in any aggregation.
5. R7 must not mutate projected fields or durable rows, and must not
   back-fill linkage (canonical contract §16).
6. R7 must not demand PII or `evidenceReference`: none exists in this
   projection, and none may be reconstructed by joining against personal
   data without governance authority.

---

**R7: consume conversions through this contract. Provenance is lineage, not
causation — derive your own attribution authority. Do not redefine
conversion authority.**
