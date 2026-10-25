# CANONICAL CONVERSION EVENT CONTRACT (WBS-R6-E E1)

> **Stream:** WBS-R6 Stream E — Conversion Tracking & Outcome Authority
> **Module authority:** `api/lib/conversion/`
> **Schema:** `conversion_events`, `conversion_lifecycle_events`
> (provisional migration `0034_early_mole_man` — artefacts only, **not
> executed**; see `docs/recovery/r6-e-unexecuted-migrations.md`; R6-X owns
> canonical sequencing)
> **Upstream (frozen, consumed not merged):** R5 integrated base `a947ecb` —
> `docs/contracts/opportunity-candidate-contract.md`,
> `docs/contracts/opportunity-to-lead-autonomy-contract.md`,
> `docs/contracts/engagement-to-opportunity-contract.md`,
> `docs/contracts/social-listening-to-intelligence-contract.md`,
> `docs/contracts/marketing-action-policy-contract.md`
> **Audience:** R6-X integration, R7 attribution (consume via
> `docs/contracts/conversion-to-attribution-contract.md`)
> **Status:** authoritative as of the R6-E acceptance harness

This contract defines the single canonical conversion/outcome event model.
R6-E owns **conversion event authority only**: deterministic identity,
ingestion, server-verified lead/outcome linkage, marketing provenance linkage,
lifecycle, exact-once persistence, evidence integrity, reversal/reconciliation,
bounded outcome value, and the downstream attribution input projection. It does
**not** own lead identity, lead scoring, qualification, nurture, sales
ownership, CRM orchestration, causal attribution, or campaign/portfolio
optimization (R6-A / R7).

**Required principle:** a conversion is an observed business outcome. **It is
NOT proof that a specific campaign caused that outcome.** No authority is
autonomous or client-declared: trust class, initial outcome status, identity
and evidence hashes are **server-derived only**.

---

## 1. What this stream owns

Owns:

- Conversion event identity (deterministic, tenant-anchored, §3)
- Ingestion (strict boundary, §12) and exact-once persistence (§7)
- Lead/outcome linkage — server-verified `leadId` only (§8)
- Marketing provenance linkage — reference-only (§9)
- Outcome lifecycle (reversal/refund/cancellation/dispute/correction facts, §11)
- Evidence integrity (immutable-core hash, tamper detection)
- Reversal/reconciliation of previously recorded outcomes (§11)
- Bounded outcome value (integer minor units, closed currency, §10)
- Downstream attribution **inputs** (frozen R7 projection, §14)

Does **not** own: lead identity, lead scoring, qualification, nurture, sales
ownership, CRM orchestration, causal attribution, campaign or portfolio
optimization. R6-E never creates leads, scores, or outreach (acceptance case
26).

## 2. Required principle

A conversion is an observed business outcome. **It is NOT proof that a
specific campaign caused that outcome.** Provenance lineage
(opportunity/engagement/signal/campaign/publication references) is recorded
but never asserted as causation; the R7 projection carries an explicit
causation disclaimer.

Additionally:

- Trust class is derived server-side from the closed source-system registry
  (§6). The client can never supply or influence it.
- Initial `outcomeStatus` is derived server-side from the trust class (§6).
  The client can never supply or self-confirm it (acceptance case 28).
- `conversionId` / `conversionKey` / `evidenceHash` are server-derived only
  (§3, §7). No client-supplied identity exists.

## 3. Conversion identity (deterministic, server-derived, tenant-anchored)

```
conversionKey = sha256(canonicalJson({ v: 1, tenantUserId,
                                       sourceSystem, externalConversionId }))
conversionId  = "cnv1:" + conversionKey
```

- One business + one source system + one stable external conversion event →
  one conversion identity. `tenantUserId` is bound **inside** the hash, so
  the same external id under a different tenant or source system produces a
  **distinct** identity — cross-tenant collision/correlation is impossible
  (acceptance cases 21–22).
- Identity is a pure function of authoritative inputs: no wall-clock, no
  randomness. Replaying the same inputs reproduces the same identity.
- The DB enforces uniqueness of `conversionId` (`ce_conversion_id_uidx`) and
  of `(userId, sourceSystem, externalConversionId)` (`ce_natural_key_uidx`).
  Duplicate delivery, concurrent ingest and retries converge to **one durable
  row** (§7).
- Identity scheme prefixes (`cnv1:` for conversions, `clf1:` for lifecycle
  facts) make identities self-describing in logs and handoff envelopes.

## 4. Canonical record shape

Exactly `conversion_events` (`db/schema.ts` → `ConversionEventRow`):

```ts
ConversionEventRow {                    // conversion_events
  id: number;                           // serial PK
  conversionId: string;                 // varchar(69) NOT NULL — "cnv1:"+64hex (§3)
  userId: number;                       // bigint unsigned NOT NULL — tenant anchor
  businessId: number;                   // bigint unsigned NOT NULL — ownership-verified (§9)
  leadId: number | null;                // bigint unsigned NULL — server-verified linkage (§8)
  leadIdentityVersion: string | null;   // varchar(64) NULL — opaque R6-A reference (§8)
  externalConversionId: string;         // varchar(191) NOT NULL — provider event id
  sourceSystem: string;                 // varchar(32) NOT NULL — closed vocab §5
  sourceTrustClass: string;             // varchar(24) NOT NULL — server-derived (§6)
  conversionType: string;               // varchar(32) NOT NULL — closed vocab §5
  occurredAt: string;                   // varchar(32) NOT NULL — provider time, ISO 8601 verbatim
  observedAt: string;                   // varchar(32) NOT NULL — acceptance time (defaults to `now`)
  amount: number | null;                // bigint NULL — integer minor units, signed for reversals (§10)
  currency: string | null;              // varchar(3) NULL — closed vocab §5
  outcomeStatus: string;                // varchar(16) NOT NULL — closed vocab §5
  reversesConversionId: string | null;  // varchar(69) NULL — reversal lineage (§11)
  sourceOpportunityId: string | null;        // varchar(69) NULL — provenance (§9)
  sourceEngagementReceiptId: string | null;  // varchar(64) NULL — provenance (§9)
  sourceSignalId: string | null;             // varchar(64) NULL — provenance (§9)
  sourceCampaignId: number | null;           // bigint unsigned NULL — provenance (§9)
  sourcePublicationId: number | null;        // bigint unsigned NULL — provenance (§9)
  evidenceReference: string | null;     // varchar(255) NULL — bounded free-text evidence pointer
  evidenceHash: string;                 // varchar(64) NOT NULL — sha256 immutable core (§7)
  version: number;                      // int NOT NULL DEFAULT 1 — optimistic CAS guard (§11)
  createdAt: Date;                      // timestamp NOT NULL DEFAULT now()
}
```

## 5. Closed vocabularies

**CONVERSION_TYPES (14):**

```
purchase, subscription, booking, consultation, demo_completed,
contract_signed, application_submitted, renewal, retained_customer,
qualified_offline_outcome, refund, cancellation, reversal, unknown
```

| Group | Types | Semantics |
|---|---|---|
| Positive outcome | `purchase`, `subscription`, `booking`, `consultation`, `demo_completed`, `contract_signed`, `application_submitted`, `renewal`, `retained_customer`, `qualified_offline_outcome` | Observed business outcome; amounts non-negative |
| Reversal | `refund`, `cancellation`, `reversal` | Reverse a prior conversion; negative amounts permitted; require `reversesConversionId` (§11) |
| Reserved | `unknown` | Aggregation fallback; never fabricated from evidence |

**REVERSAL_TYPES:**

```
refund, cancellation, reversal
```

**CONVERSION_SOURCE_SYSTEMS (13):**

```
internal, stripe, paypal, shopify, woocommerce, salesforce, hubspot,
calendly, meta, linkedin, google_analytics, user_report, unverified_webhook
```

**CONVERSION_TRUST_CLASSES (6):**

```
VERIFIED_INTERNAL, VERIFIED_PROVIDER, VERIFIED_CRM, VERIFIED_PAYMENT,
USER_REPORTED, UNVERIFIED_EXTERNAL
```

| Class | Meaning |
|---|---|
| `VERIFIED_INTERNAL` | Recorded by NatForgeAI's own internal systems |
| `VERIFIED_PROVIDER` | Confirmed by a platform/provider integration |
| `VERIFIED_CRM` | Confirmed by an integrated CRM |
| `VERIFIED_PAYMENT` | Confirmed by a payment processor; value is authoritative revenue |
| `USER_REPORTED` | Self-reported by the tenant/user; stored as evidence, never silently verified revenue |
| `UNVERIFIED_EXTERNAL` | Unverified webhook; requires later corroboration before it can be authoritative |

**CONVERSION_OUTCOME_STATUSES (7):**

```
PENDING, CONFIRMED, REVERSED, REFUNDED, CANCELLED, DISPUTED, UNKNOWN
```

| Status | Meaning |
|---|---|
| `PENDING` | Recorded; awaiting corroboration (initial status for `UNVERIFIED_EXTERNAL`) |
| `CONFIRMED` | Accepted outcome (initial status for `VERIFIED_*` and `USER_REPORTED`) |
| `REVERSED` / `REFUNDED` / `CANCELLED` | Terminal reversal states set by the corresponding reversal event (§11) |
| `DISPUTED` | Outcome disputed |
| `UNKNOWN` | Outcome unknown |

**CONVERSION_LIFECYCLE_TYPES (6):**

```
confirmation, reversal, refund, cancellation, dispute, correction
```

**CURRENCY_CODES (20):**

```
USD, EUR, GBP, ZAR, CAD, AUD, NZD, JPY, CHF, SEK, NOK, DKK, INR, BRL,
MXN, SGD, HKD, AED, PLN, KES
```

ISO 4217 minor-unit exponents: `JPY` = 0 (zero-decimal); all others = 2
(`CURRENCY_EXPONENTS`, §10).

## 6. Source trust model (E2)

`SOURCE_TRUST_REGISTRY` — deterministic, closed, server-side only
(`conversion-trust.ts`):

| Source system | Trust class |
|---|---|
| `internal` | `VERIFIED_INTERNAL` |
| `stripe`, `paypal`, `shopify`, `woocommerce` | `VERIFIED_PAYMENT` |
| `salesforce`, `hubspot`, `calendly` | `VERIFIED_CRM` |
| `meta`, `linkedin`, `google_analytics` | `VERIFIED_PROVIDER` |
| `user_report` | `USER_REPORTED` |
| `unverified_webhook` | `UNVERIFIED_EXTERNAL` |

- Every member of `CONVERSION_SOURCE_SYSTEMS` maps to exactly one trust
  class; anything outside the closed vocabulary fails closed
  (`CONVERSION_SOURCE_SYSTEM_UNKNOWN` backstop).
- **FINANCIAL_AUTHORITY_TRUST_CLASSES** =
  `VERIFIED_INTERNAL, VERIFIED_PROVIDER, VERIFIED_CRM, VERIFIED_PAYMENT`.
  Only these classes make a monetary value authoritative ("verified") in the
  R7 projection; `USER_REPORTED` and `UNVERIFIED_EXTERNAL` expose the value
  as **reported only** (doc 2 §6). User-reported and unverified outcomes are
  stored as evidence but are **never silently verified revenue**.
- **Initial outcome status derivation** (`deriveInitialOutcomeStatus`):
  `VERIFIED_*` and `USER_REPORTED` → `CONFIRMED`; `UNVERIFIED_EXTERNAL` →
  `PENDING` (requires later corroboration before it can be authoritative).

## 7. Exact-once ingestion (E3)

Insert-first persistence against two durable unique anchors on
`conversion_events`:

- `ce_conversion_id_uidx` — UNIQUE(`conversionId`)
- `ce_natural_key_uidx` — UNIQUE(`userId`, `sourceSystem`,
  `externalConversionId`)

Semantics:

- Duplicate submission, concurrent ingest of the same logical conversion, and
  post-restart retries converge: one insert wins, losers re-read through the
  durable unique keys and verify the evidence fingerprint; the result is the
  single durable row classified `idempotent_replay` (acceptance cases 2–4).
- A stored row whose `evidenceHash` disagrees with the replayed material is
  an identity conflict and **fails closed** with
  `CONVERSION_IDENTITY_CONFLICT` — replaying the same identity with different
  material is never silently accepted.
- `observedAt` participates in the evidence hash (§16) and defaults to the
  server acceptance `now` when the client omits it — changing it (or any
  hashed field) is a material change and therefore a conflict.
- Historical conversion rows are **immutable after acceptance**; the
  `evidenceHash` proves byte-stability, and drift between a retained row and
  its hash is tampering evidence that fails closed
  (`CONVERSION_EVIDENCE_CONFLICT`) on every read.
- All convergence is DB-authoritative (unique keys + CAS). No in-memory
  dedupe. No client idempotency identity.

## 8. Lead linkage (E4)

- **Permitted:** a canonical `leadId` verified **server-side** against the
  durable `leads` row — same `userId`, and `lead.businessId` null-or-equal to
  the conversion's `businessId`. Cross-business linkage fails closed
  (`OWNERSHIP_MISMATCH`); cross-tenant linkage fails closed (`FORBIDDEN`)
  (acceptance cases 11–13).
- `leadIdentityVersion` (optional, ≤64 chars, safe-reference pattern) is
  stored **verbatim** as an opaque reference reserved for R6-A; it carries no
  trust or authority of its own (acceptance case 30).
- **Forbidden:** name similarity, fuzzy matching, demographic matching,
  sentiment matching, IP matching — never implemented, no such code path
  exists. An evidence reference mentioning a person's name never links
  anything (acceptance case 14).
- **Unlinked conversions are fully valid.** `leadId` stays NULL; no linkage
  is ever fabricated (acceptance case 15).
- R6-E never creates or mutates lead rows, scores, or outreach
  (acceptance case 26). R6-A owns lead identity; this stream links by durable
  ids only.

## 9. Marketing provenance (E5)

Five **reference-only** columns carry lineage:

```
sourceOpportunityId        — opportunity_candidates.opportunityId (R5-D)
sourceEngagementReceiptId  — engagement_receipts.engagementReceiptId (R5-C)
sourceSignalId             — social_signals.signalKey (R5-A)
sourceCampaignId           — campaigns.id
sourcePublicationId        — publication row id
```

- Ownership is **re-verified from durable rows on every call**, per
  reference, for the authenticated tenant: business anchor
  (`businesses.id + userId`); lead (`leads.id + userId`, business
  null-or-equal); campaign (`campaigns.id + userId`); opportunity
  (`opportunity_candidates.opportunityId + userId + businessId`); receipt
  (`engagement_receipts` userId + businessId); signal
  (`social_signals.signalKey + userId`).
- Any mismatch fails closed before identity or persistence work:
  `FORBIDDEN` (not found / cross-tenant) or `OWNERSHIP_MISMATCH` (different
  business/tenant) (acceptance case 29).
- **PROVENANCE LINK ≠ CAUSAL ATTRIBUTION.** These references say where the
  outcome was observed from, never what caused it. R7 derives attribution
  separately, on its own authority (doc 2 §9).

## 10. Value / revenue safety (E6)

- Amounts are **integer minor units** (`bigint`); non-integer or non-finite
  values rejected (`CONVERSION_AMOUNT_INVALID`).
- `|amount| ≤ 1e15` (`MAX_CONVERSION_MINOR_UNITS = 1_000_000_000_000_000`).
- Negative amounts are permitted **only** for reversal types
  (`refund`/`cancellation`/`reversal`) — otherwise
  `CONVERSION_NEGATIVE_AMOUNT_NOT_PERMITTED` (acceptance case 9).
- `amount` and `currency` are **both-or-neither**;
  `CONVERSION_AMOUNT_CURRENCY_MISMATCH` otherwise.
- `currency` must be in the closed 20-code allowlist (uppercase);
  `CONVERSION_CURRENCY_UNSUPPORTED` otherwise (acceptance case 10).
- Payment-credential leak guard: any free-text field
  (`externalConversionId`, `evidenceReference`) containing a card/PAN-shaped
  run of 13–19 consecutive digits is rejected
  (`CONVERSION_PAYMENT_CREDENTIAL_REJECTED`) — card data, bank credentials
  and payment secrets are **never** persisted into the conversion ledger
  (acceptance case 23).
- The original amount is **immutable**; corrections happen only via new
  events (reversal rows + lifecycle facts, §11), never by editing the row.

## 11. Reversal / correction / lifecycle (E7)

Reversal rows (`refund`/`cancellation`/`reversal`):

- **Require** `reversesConversionId` (`CONVERSION_REVERSAL_TARGET_REQUIRED`);
  supplying it on a non-reversal type is likewise rejected.
- The target must exist for the authenticated tenant (`FORBIDDEN`), must not
  itself be a reversal (`CONVERSION_REVERSAL_OF_REVERSAL_FORBIDDEN`), and —
  when both currencies are present — the reversal currency must match the
  target currency (`CONVERSION_CURRENCY_MISMATCH`).
- On acceptance, a **deterministic lifecycle fact** is minted on the target
  and the target's `outcomeStatus` transitions via optimistic CAS:

| Reversal type | Lifecycle type | Target status |
|---|---|---|
| `refund` | `refund` | `REFUNDED` |
| `cancellation` | `cancellation` | `CANCELLED` |
| `reversal` | `reversal` | `REVERSED` |

- Lifecycle identity is deterministic — replays of the same provider
  lifecycle event reproduce the same id, so provider retries converge on one
  durable row:

```
lifecycleEventId = "clf1:" + sha256(canonicalJson({ v: 1, conversionId,
  lifecycleType, outcomeStatus, amount, currency, externalLifecycleId,
  occurredAt, reasonCode }))
```

  The reversal's `externalConversionId` **is** the provider lifecycle id, so
  provider reversal retries converge on `cle_external_uidx`. Reusing a
  provider lifecycle id for different material fails closed
  (`CONVERSION_LIFECYCLE_CONFLICT`).

```ts
ConversionLifecycleEventRow {         // conversion_lifecycle_events — immutable, append-only
  id: number;                          // serial PK
  lifecycleEventId: string;            // varchar(70) NOT NULL — "clf1:"+64hex
  conversionId: string;                // varchar(69) NOT NULL
  userId: number;                      // bigint unsigned NOT NULL — tenant anchor
  lifecycleType: string;               // varchar(16) NOT NULL — closed vocab §5
  outcomeStatus: string;               // varchar(16) NOT NULL — target status for this fact
  amount: number | null;               // bigint NULL
  currency: string | null;             // varchar(3) NULL
  externalLifecycleId: string | null;  // varchar(191) NULL — provider retry anchor
  occurredAt: string;                  // varchar(32) NOT NULL
  reasonCode: string | null;           // varchar(64) NULL
  createdAt: Date;                     // timestamp NOT NULL DEFAULT now()
}
```

- Durable unique anchors: `cle_event_id_uidx` (UNIQUE `lifecycleEventId`)
  and `cle_external_uidx` (UNIQUE(`conversionId`, `externalLifecycleId`) —
  NULL external ids are distinct per house convention).
- Target `outcomeStatus` transitions **only** via optimistic CAS on
  `version` (`transitionOutcomeStatus`); stale writes fail closed with
  `CONVERSION_STALE_STATE`; the reversal loop re-reads and retries up to 5
  attempts and swallows a race only when the stored status already equals the
  target fact.
- Lifecycle rows have **no update path**; the original conversion's evidence
  material (`amount`, `evidenceHash`, `occurredAt`, …) is never mutated by a
  reversal (acceptance case 20). The whole flow is replay-safe through the
  same executor.

## 12. Client authority boundary

The ingest surface is `conversionIngestInputSchema` — a `z.strictObject`
(unknown keys rejected, `CONVERSION_INPUT_INVALID`):

```ts
{
  businessId: number;              // int > 0
  sourceSystem: ConversionSourceSystemEnum;
  externalConversionId: string;    // 1..191, /^[A-Za-z0-9][A-Za-z0-9:_\-./]{0,190}$/
  conversionType: ConversionTypeEnum;
  occurredAt: string;              // ≤32; parseable ISO 8601, year ≥ 2000, ≤5 min future
  observedAt?: string;             // ≤32; same checks; defaults to server acceptance `now`
  amount?: number;                 // int (minor units)
  currency?: CurrencyCodeEnum;
  leadId?: number;                 // int > 0
  leadIdentityVersion?: string;    // ≤64, safe-reference pattern
  sourceOpportunityId?: string;    // ≤69
  sourceEngagementReceiptId?: string;  // ≤64
  sourceSignalId?: string;         // ≤64
  sourceCampaignId?: number;       // int > 0
  sourcePublicationId?: number;    // int > 0
  evidenceReference?: string;      // ≤255
  reversesConversionId?: string;   // ≤69
}
```

`assertNoClientAuthorityFields` runs **before** the schema parse and rejects,
fail closed, any attempt to smuggle server-side authority — never silently
ignored (hiding a probe would itself be a failure):

```
trustClass, sourceTrustClass, outcomeStatus, conversionId, conversionKey,
evidenceHash, userId, id, createdAt, verified, verifiedAmount,
verifiedCurrency, reportedAmount, reportedCurrency
```

→ `CONVERSION_CLIENT_AUTHORITY_FIELD_FORBIDDEN` (acceptance case 8).
Attribution/causal fields (`attributedCampaignId`, `attributionScore`,
`causalScore`, …) are rejected as unknown keys by the strict schema
(acceptance case 27). Trust class is **never** client-supplied.

## 13. Privacy restrictions

- **No PII columns**: `conversion_events` / `conversion_lifecycle_events`
  carry no name, email, phone, or company fields; people appear only as
  server-verified numeric references (`leadId`) (acceptance case 24).
- Provenance is reference-only (§9); raw provider payloads, tokens and
  webhook bodies are never persisted.
- Safe logs: metadata, audit entries and error surfaces carry ids, trust
  classes, types, statuses and hashes only — never social content or PII.
- `evidenceReference` is bounded (≤255 chars) and payment-credential-guarded
  (§10); it is internal to the evidence row and never exposed in the R7
  projection (doc 2 §12).

## 14. Downstream projection (E8)

The R7 handoff view is `buildR7ConversionProjection` —
`CONVERSION_PROJECTION_CONTRACT_VERSION = "conversion-to-attribution/v1"`, a
frozen 22-key projection (exact allowlist asserted in acceptance case 25):

- Monetary value is exposed as **either** verified (financial-authority trust
  classes) **or** reported (everything else) — never both.
- Provenance lineage only; **no causal field exists** (no
  `attributedCampaignId`, no `attributionScore`, no causal strength —
  asserted by serialized-scan in acceptance case 17).
- `evidenceReference` is always `null`; `causationClaimed` is always `false`;
  a verbatim causation disclaimer is carried on every projection.

Full semantics: **`docs/contracts/conversion-to-attribution-contract.md`**.

## 15. Exact-once / replay semantics

| Scenario | Result |
|---|---|
| Same ingest replayed (identical material) | `idempotent_replay`; the single durable row and the single deterministic `conversion_recorded` audit row (§19.9) |
| Concurrent ingest of same natural key | One insert wins; losers re-read via `ce_natural_key_uidx` / `ce_conversion_id_uidx` → `idempotent_replay` |
| Restart / fresh caller replay | Returns the existing conversion (`idempotent_replay`) |
| Replay of same identity with different material (e.g. different `observedAt`) | `CONVERSION_IDENTITY_CONFLICT` — fail closed |
| Same `externalConversionId`, different source system or tenant | Distinct `conversionId` (both are inside the hash); two valid rows |
| Provider reversal retry | Same `lifecycleEventId` + same `externalLifecycleId` converge on one lifecycle fact |
| Provider lifecycle id reused for different material | `CONVERSION_LIFECYCLE_CONFLICT` — fail closed |
| Concurrent outcome-status transition | CAS on `version`; loser re-reads/retries (≤5); persistent staleness → `CONVERSION_STALE_STATE` |
| Evidence hash drift on any read | `CONVERSION_EVIDENCE_CONFLICT` — tampering, fail closed |

All convergence is DB-authoritative. No in-memory dedupe. No client
idempotency identity.

## 16. Immutable fields

`conversion_events` rows are immutable after acceptance. The hashed immutable
core (bound by `evidenceHash`): `userId`, `businessId`, `leadId`,
`leadIdentityVersion`, `externalConversionId`, `sourceSystem`,
`conversionType`, `occurredAt`, `observedAt`, `amount`, `currency`,
`sourceOpportunityId`, `sourceEngagementReceiptId`, `sourceSignalId`,
`sourceCampaignId`, `sourcePublicationId`, `evidenceReference`,
`reversesConversionId`, `evidenceHash`, `conversionId`.

The **only** mutable fields are `outcomeStatus` (guarded CAS transitions,
§11) and `version` (the CAS guard itself). `conversion_lifecycle_events`
rows are entirely immutable — there is no update path. Corrections are new
rows/events, never edits.

## 17. Schema dependencies

- Tables: `conversion_events` (§4), `conversion_lifecycle_events` (§11) —
  defined in `db/schema.ts`.
- Migration: `db/migrations/0034_early_mole_man.sql` — **created, not
  executed** (artefact only). Journal parity (`meta/_journal.json` idx 34 +
  `0034_snapshot.json`) was generated offline with a dummy `DATABASE_URL`; no
  database connection was opened. Until executed, the runtime degrades
  gracefully and fail-closed. See
  `docs/recovery/r6-e-unexecuted-migrations.md`.
- R6-X owns canonical sequencing/convergence; R6-E does not renumber,
  execute, or duplicate upstream artefacts.
- **No FK constraints** — downstream/upstream tables are coupled by opaque
  references only; enforcement lives in query predicates (repo convention).

## 18. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Schema | `db/schema.ts` | append-only (conversion tables) |
| Migrations | `db/migrations/` | append-only; `0034_early_mole_man` provisional, not executed |
| Router registry | `api/router.ts` | one additive `conversion` registration |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive `conversion_recorded` value only |
| Legacy analytics | `api/analytics-router.ts` | untouched — legacy `metricType` `conversions`/`revenue` stays ungoverned |
| Leads / CRM | `api/lead-router.ts` | untouched |
| Opportunity (R5-D) | `api/lib/opportunity/*` | read-only |
| Engagement (R5-C) | `api/lib/engagement/*` | read-only |
| Policy (R5-E) | `api/lib/policy/*` | read-only |
| Billing (R4) | `api/lib/billing/*` | read-only — this stream never charges |

## 19. Security invariants (asserted by the R6-E acceptance suite)

1. Tenant isolation: `userId` comes from the authenticated session only and
   anchors every identity and query predicate; ownership of business/lead/
   campaign/opportunity/receipt/signal is re-verified from durable rows on
   every call.
2. Fail closed on every boundary: unknown vocabulary, malformed input,
   ownership mismatch, identity conflict, stale CAS, evidence-hash drift.
3. Trust class and initial outcome status are server-derived only; no
   client-supplied identity, trust, status, or "verified*" field is accepted
   (`CONVERSION_CLIENT_AUTHORITY_FIELD_FORBIDDEN`).
4. No fuzzy linkage: no name/demographic/sentiment/IP matching code path
   exists; unlinked conversions are first-class valid records.
5. Bounded values: integer minor units, `|amount| ≤ 1e15`, closed currency
   allowlist, closed enums everywhere; negative amounts only for reversal
   types.
6. Credential rejection: payment-credential digit-run guard on free-text
   fields; no card data, bank credentials, or payment secrets are persisted.
7. Evidence immutability: `evidenceHash` proves byte-stability of the
   immutable core; drift fails closed (`CONVERSION_EVIDENCE_CONFLICT`).
8. No causation claims: provenance is recorded but never asserted as
   causation; no causal field exists on the row or the projection.
9. Auditability: every accepted ingest report emits a `conversion_recorded`
   audit event (metadata carries ids/classes/hashes only). The event is
   deterministic per durable conversion (conversion `occurredAt` + stable
   id/class metadata — no wall-clock, no replay-varying fields), so replays
   and concurrent losers reproduce the byte-identical canonical event and the
   fingerprint-deduplicated audit ledger converges to exactly one
   `conversion_recorded` row per conversion; audit failure is loud and never
   rolls back the conversion.
10. No lead/score/outreach creation: `leads`, `lead_scores`,
    `outreach_recommendations` are never written by this stream.

## 20. Acceptance

Thirty adversarial cases in `api/conversion-acceptance.test.ts`, running the
REAL router + store/service/projection against an in-memory fake database
that replicates the durable unique indexes (`conversion_events`,
`conversion_lifecycle_events`, `audit_events`):

1. Verified purchase persists (stripe)
2. Duplicate event converges to idempotent replay
3. Concurrent duplicate converges to one row
4. Restart (fresh caller) returns the existing conversion
5. Trusted CRM outcome accepted (salesforce consultation)
6. Trusted payment value is verified in the projection (paypal subscription)
7. User-reported outcome is non-authoritative
8. Fabricated revenue (client trust/verified fields) rejected, no row
9. Invalid amount rejected (out of bounds and non-integer), no row
10. Invalid currency rejected (unknown code and lowercase), no row
11. Cross-business lead linkage rejected
12. Forged (cross-tenant) lead rejected
13. Authoritative lead linkage succeeds
14. Fuzzy/name-only matching never links a lead
15. Unlinked conversion remains valid
16. Campaign provenance preserved and projected
17. Provenance does not become causation (exact key set, no causal fields)
18. Refund references original and flips its outcome
19. Duplicate refund converges to a single lifecycle fact
20. Reversal preserves the original evidence material
21. Cross-tenant collision is impossible and reads are tenant-scoped
22. Source-system collision yields distinct conversions for one tenant
23. Payment-credential leak rejected with no row
24. PII minimized (no name/email/phone on row or projection)
25. R7 projection field allowlist is exact
26. No qualification/nurture/outreach side effects
27. Unknown/extra client fields (attribution or authority) rejected, no row
28. Agent cannot self-mark an unverified outcome authoritative
29. Cross-tenant provenance reference rejected
30. Client-supplied `leadIdentityVersion` is opaque and never affects authority

---

**R7 attribution and all downstream consumers: consume conversions through
this contract and `docs/contracts/conversion-to-attribution-contract.md`. Do
not redefine conversion authority.**
