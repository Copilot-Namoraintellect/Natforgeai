# CANONICAL CONVERSION OUTCOME INTELLIGENCE CONTRACT (WBS-R7-A)

> **Stream:** WBS-R7-A — Conversion Outcome Intelligence
> **Module authority:** `api/lib/outcome/`
> **Router:** `api/outcome-router.ts` (tRPC namespace `outcome`)
> **Schema:** `business_outcomes`, `business_outcome_lifecycle_events`
> (stream-local provisional migration `0035_r7_a_conversion_outcome_foundation` —
> artefact only, **NOT executed**; see
> `docs/recovery/r7-a-unexecuted-migrations.md`; R7-X owns canonical R7 sequencing)
> **Upstream (frozen, consumed not merged):** R6 Lead Autonomy V1
> (`integration/r6-lead-autonomy` @ `8030e97a…`) —
> `docs/contracts/conversion-event-contract.md`,
> `docs/contracts/conversion-to-attribution-contract.md`,
> `docs/contracts/lead-identity-contract.md`,
> `docs/contracts/lead-autonomy-to-business-optimisation-contract.md`
> **Downstream:** R7-B attribution / R7-C learning via
> `docs/contracts/conversion-outcome-to-attribution-learning-contract.md`
> **Status:** authoritative as of the R7-A acceptance harness

This contract defines the authoritative interpretation and persistence of
**business outcomes** derived from governed R6 conversion evidence. R6-E proves that
a conversion event occurred; R7-A answers what business outcome it produced, what
value was realised, what evidence supports that value, and whether that value is
final, provisional, reversed, refunded, renewed or otherwise changed.

**Required principle:** conversion evidence and business-value evidence are distinct.
A recorded amount always identifies currency, integer minor units, evidence authority,
status, occurred/recorded time, and whether it is provisional or verified. No
floating-point money. **Conversion ≠ revenue unless independently evidenced, and no
outcome record ever asserts that marketing activity caused the outcome.**

---

## 1. What this stream owns

Owns:

- Canonical business outcome identity (deterministic, tenant-anchored, §3)
- Outcome classification (deterministic, rule-first, §5)
- Outcome lifecycle and current-state projection (append-only, §8)
- Verified monetary value representation (integer minor units, §6)
- Non-monetary outcome representation (quantity + closed metric unit, §6)
- Reversal / refund / cancellation semantics (§8)
- Renewal / recurring outcome semantics where evidenced (§8)
- Commercial evidence provenance and evidence integrity (§7)
- Outcome verification state (server-derived, §6/§8)
- Exact-once outcome persistence (§9)
- Downstream outcome projection for R7-B / R7-C (§11)

Does **not** own: attribution, marketing causation, campaign credit allocation,
experimental treatment assignment, budget optimisation, strategy mutation, sales
qualification, lead identity (R6-A), conversion identity (R6-E), payment execution,
billing, invoice creation, CRM state, accounting ledger, or revenue-recognition
policy beyond truthful recorded evidence. R7-A never creates or mutates leads,
scores, qualifications, nurture/handoff records, conversions, or billing rows.

## 2. Closed vocabularies

**OUTCOME_TYPES (12):**

```
PURCHASE, SUBSCRIPTION, CONTRACT, BOOKING, RENEWAL, UPGRADE, DOWNGRADE,
REFUND, REVERSAL, CANCELLATION, NON_MONETARY_SUCCESS, OTHER_VERIFIED_OUTCOME
```

| Group | Types | Semantics |
|---|---|---|
| Positive outcome | `PURCHASE`, `SUBSCRIPTION`, `CONTRACT`, `BOOKING`, `RENEWAL`, `UPGRADE`, `DOWNGRADE`, `OTHER_VERIFIED_OUTCOME` | Observed business outcome; monetary amounts positive |
| Reversal | `REFUND`, `REVERSAL`, `CANCELLATION` | Reverse/cancel a prior outcome; monetary amounts negative; require `reversesOutcomeId` (§8) |
| Non-monetary | `NON_MONETARY_SUCCESS` | Verified success with no monetary value claim (demo completed, application submitted, consultation held) |

`UPGRADE` / `DOWNGRADE` are proposal-only refinements of subscription/renewal
conversions (§5). No other client-supplied type ever overrides the classifier.

**OUTCOME_STATUSES (6):**

```
OBSERVED, PROVISIONAL, VERIFIED, REVERSED, CANCELLED, SUPERSEDED
```

| Status | Meaning |
|---|---|
| `OBSERVED` | Recorded from non-authoritative evidence (`UNVERIFIED_EXTERNAL`); value is not authoritative |
| `PROVISIONAL` | Recorded from user attestation (`USER_ATTESTED`); value recorded but not yet verified |
| `VERIFIED` | Recorded or transitioned under an authoritative evidence class (§6); value is authoritative |
| `REVERSED` / `CANCELLED` | Terminal reversal states set by the corresponding reversal outcome (§8) |
| `SUPERSEDED` | Replaced by a corrected outcome via supersession (§8); history preserved |

**OUTCOME_VALUE_TYPES (2):** `MONETARY`, `NON_MONETARY` — exactly one per outcome.

**NON_MONETARY_METRIC_UNITS (8):** `UNIT, SEAT, CONTRACT, BOOKING, APPOINTMENT,
SIGNUP, LICENSE, OTHER`.

**OUTCOME_EVIDENCE_SOURCES (8):**

```
payment_processor, accounting_system, contract_repository, crm_record,
platform_report, internal_system, user_attestation, unverified_external
```

**OUTCOME_EVIDENCE_AUTHORITY_CLASSES (7):**

```
VERIFIED_PAYMENT, VERIFIED_CONTRACT, VERIFIED_CRM, VERIFIED_PLATFORM,
VERIFIED_INTERNAL, USER_ATTESTED, UNVERIFIED_EXTERNAL
```

**OUTCOME_LIFECYCLE_TYPES (6):** `verification, reversal, refund, cancellation,
renewal, supersession`.

**CURRENCIES:** the closed 20-code ISO allowlist and minor-unit exponents of R6-E
(`CURRENCY_CODES` / `CURRENCY_EXPONENTS`, JPY = 0) — one money grammar, imported
not redefined.

## 3. Outcome identity (deterministic, server-derived, tenant-anchored)

```
outcomeKey = sha256(canonicalJson({ v: 1, tenantUserId, businessId,
                                   conversionId, evidenceSource, evidenceIdentity }))
outcomeId  = "out1:" + outcomeKey
```

- Same business + same canonical conversion + same authoritative business-outcome
  evidence (source + identity) → same outcome identity, for the same tenant.
- The tenant and business are bound **inside** the hash: identical upstream evidence
  under a different tenant or business yields a **distinct** identity — cross-tenant
  or cross-business correlation is impossible (acceptance cases 3–4).
- Identity is a pure function of authoritative inputs: no wall-clock, no randomness.
  Retries and webhook/evidence replays converge on the durable row (§9).
- Lifecycle fact identity: `obf1:` + sha256 over the fact material (§8) — provider
  retries of the same fact converge on one durable row.
- Prefixes (`out1:`, `obf1:`) make identities self-describing in logs and handoffs.
- **No client-selected outcome id exists.** Clients reference ids only; a client
  supplying `outcomeId`/`outcomeKey`/`evidenceHash` is rejected
  (`OUTCOME_CLIENT_AUTHORITY_FIELD_FORBIDDEN`).

## 4. Canonical record shape

Exactly `business_outcomes` (`db/schema.ts` → `BusinessOutcomeRow`):

```ts
BusinessOutcomeRow {                  // business_outcomes
  id: number;                         // serial PK
  outcomeId: string;                  // varchar(69) NOT NULL — "out1:"+64hex (§3)
  userId: number;                     // bigint unsigned NOT NULL — tenant anchor
  businessId: number;                 // bigint unsigned NOT NULL — server-revalidated (§10)
  leadId: number | null;              // bigint unsigned NULL — conversion-carried, re-verified (§10)
  leadIdentityVersion: string | null; // varchar(64) NULL — opaque R6-A reference, verbatim
  conversionId: string;               // varchar(69) NOT NULL — canonical R6-E reference
  outcomeType: string;                // varchar(32) NOT NULL — closed vocab §2
  outcomeStatus: string;              // varchar(16) NOT NULL — closed vocab §2
  valueType: string;                  // varchar(16) NOT NULL — MONETARY | NON_MONETARY
  amountMinor: number | null;         // bigint NULL — integer minor units (§6)
  currency: string | null;            // varchar(3) NULL — closed allowlist (§6)
  quantity: number | null;            // int NULL — non-monetary metric quantity (§6)
  metricUnit: string | null;          // varchar(32) NULL — closed vocab §2
  evidenceSource: string;             // varchar(32) NOT NULL — closed vocab §2
  evidenceAuthority: string;          // varchar(24) NOT NULL — server-derived registry (§6)
  evidenceIdentity: string;           // varchar(191) NOT NULL — bounded evidence pointer
  evidenceHash: string;               // varchar(64) NOT NULL — sha256 immutable core (§7)
  occurredAt: string;                 // varchar(32) NOT NULL — outcome time, ISO 8601
  recordedAt: string;                 // varchar(32) NOT NULL — acceptance/record time, ISO 8601
  reversesOutcomeId: string | null;   // varchar(69) NULL — reversal lineage (§8)
  renewsOutcomeId: string | null;     // varchar(69) NULL — renewal lineage (§8)
  supersedesOutcomeId: string | null; // varchar(69) NULL — supersession lineage (§8)
  version: number;                    // int NOT NULL DEFAULT 1 — optimistic CAS guard (§8)
  createdAt: Date;                    // timestamp NOT NULL DEFAULT now()
}
```

## 5. Outcome classification (A3 — deterministic, rule-first)

Classification is a pure deterministic function of the canonical conversion row and
the (optional) client type proposal. **No LLM or model is outcome authority.** Where
unstructured-evidence parsing assistance exists, its output is an untrusted proposal
subject to the same strict schema, server-side evidence validation, and these rules;
it can never invent value, currency, or a commercial event, and low/ambiguous
evidence fails closed or lands `OBSERVED`/`PROVISIONAL`. Protected or irrelevant
personal traits never influence classification — no person attribute is a classifier
input and none exists in the schema.

**Derivation map** (conversionType → default outcomeType):

| conversionType | outcomeType |
|---|---|
| `purchase` | `PURCHASE` |
| `subscription` | `SUBSCRIPTION` |
| `booking` | `BOOKING` |
| `contract_signed` | `CONTRACT` |
| `renewal` | `RENEWAL` |
| `consultation`, `demo_completed`, `application_submitted` | `NON_MONETARY_SUCCESS` |
| `retained_customer`, `qualified_offline_outcome` | `OTHER_VERIFIED_OUTCOME` |
| `refund` | `REFUND` |
| `cancellation` | `CANCELLATION` |
| `reversal` | `REVERSAL` |
| `unknown` | **fail closed** (`OUTCOME_CLASSIFICATION_UNSUPPORTED`) — reserved aggregation fallback is never fabricated into a business outcome |

**Proposal rules** (`outcomeTypeProposal`, optional, closed vocab):

1. Reversal conversions → the proposal (if any) must equal the derived reversal type;
   otherwise the derived type stands. A positive-type proposal on a reversal
   conversion fails closed (`OUTCOME_TYPE_CONFLICT`).
2. `NON_MONETARY_SUCCESS` conversions → proposal must be `NON_MONETARY_SUCCESS` or
   absent. Monetary reclassification of a demonstrably non-commercial conversion
   event fails closed.
3. `PURCHASE`, `BOOKING`, `CONTRACT` conversions → proposal must equal the derived
   type or be absent.
4. `subscription` / `renewal` conversions → proposal may be `UPGRADE`/`DOWNGRADE`
   (plan-change outcome evidenced by the same conversion) or the derived type.
5. `OTHER_VERIFIED_OUTCOME` conversions (ambiguous offline outcomes) → proposal may
   be any positive-outcome type or `NON_MONETARY_SUCCESS`, allowing the tenant to
   state the evidenced business meaning.

Value shape is validated independently of the label: a monetary label with no
authoritative value evidence simply lands at the verification state its evidence
class allows (§6) — the label never mints authority.

## 6. Value verification (A4 — safe value handling)

Monetary shape (`valueType = MONETARY`):

- `amountMinor` + `currency` are **both-or-neither**
  (`OUTCOME_VALUE_INCOMPLETE`).
- `amountMinor` is a finite integer in minor units; `|amount| ≤ 1e15`
  (`MAX_OUTCOME_MINOR_UNITS`, imported from the R6-E grammar)
  (`OUTCOME_AMOUNT_INVALID`). NaN/Infinity/non-integer rejected.
- `currency` ∈ closed 20-code allowlist, uppercase (`OUTCOME_CURRENCY_UNSUPPORTED`).
- Positive-outcome types require `amountMinor > 0`
  (`OUTCOME_AMOUNT_NOT_POSITIVE`); reversal types require `amountMinor < 0`
  (`OUTCOME_REVERSAL_AMOUNT_INVALID`). Monetary outcomes never carry zero value.
- No floating-point storage of money anywhere; bigint columns only.

Non-monetary shape (`valueType = NON_MONETARY`):

- `quantity` integer `1..1e9` and `metricUnit` ∈ closed vocab, both-or-neither with
  each other (`OUTCOME_METRIC_INVALID`). No currency, no amount — a non-monetary
  outcome **never fabricates a currency** (acceptance case 21).

Cross-field rules:

- `valueType` selects exactly one shape; mixing shapes fails closed.
- **R6-E amount revalidation:** when the canonical conversion carries an
  authoritative monetary value (financial-authority trust class), an outcome
  monetary value must match the conversion's amount and currency
  (`OUTCOME_VALUE_CONFLICT`). Conversion metadata is never trusted as business
  value merely because it contains a number; only an equality cross-check against
  the governed conversion amount passes (acceptance case 12).
- Reversal outcomes must match the referenced outcome's currency when both are
  monetary, and `|amountMinor|` must not exceed the target's
  (`OUTCOME_VALUE_CONFLICT`) — partial reversals are thereby supported while
  over-reversal fails closed.

**Evidence authority (server-derived only):**

| evidenceSource | evidenceAuthority | Initial outcomeStatus |
|---|---|---|
| `payment_processor` | `VERIFIED_PAYMENT` | `VERIFIED` |
| `contract_repository` | `VERIFIED_CONTRACT` | `VERIFIED` |
| `crm_record` | `VERIFIED_CRM` | `VERIFIED` |
| `platform_report` | `VERIFIED_PLATFORM` | `VERIFIED` |
| `accounting_system`, `internal_system` | `VERIFIED_INTERNAL` | `VERIFIED` |
| `user_attestation` | `USER_ATTESTED` | `PROVISIONAL` |
| `unverified_external` | `UNVERIFIED_EXTERNAL` | `OBSERVED` |

`OUTCOME_VALUE_AUTHORITY` classes (first five rows) make value authoritative.
`USER_ATTESTED` and `UNVERIFIED_EXTERNAL` are evidence classes only — stored, but
**never silently verified revenue**. Verification state is therefore a
server-derived function of the evidence registry; a client can never mark value
verified (acceptance cases 11, 26).

## 7. Evidence integrity and provenance

- `evidenceIdentity` is a bounded (`1..191`, safe-reference pattern
  `[A-Za-z0-9][A-Za-z0-9:_\-./]{0,190}`) opaque pointer: invoice id, payment
  reference, contract id, provider report key. It is an identity, never a narrative —
  free-form text cannot carry value claims, instructions, or PII
  (acceptance cases 24–25).
- `evidenceHash` = sha256 over the canonical immutable core
  (`userId`, `businessId`, `leadId`, `leadIdentityVersion`, `conversionId`,
  `outcomeType`, `valueType`, `amountMinor`, `currency`, `quantity`, `metricUnit`,
  `evidenceSource`, `evidenceAuthority`, `evidenceIdentity`, `occurredAt`,
  `recordedAt`, `reversesOutcomeId`, `renewsOutcomeId`, `supersedesOutcomeId`).
  Drift between a retained row and its hash is tampering and fails closed on every
  read (`OUTCOME_EVIDENCE_CONFLICT`) (acceptance case 23).
- Payment-credential leak guard: `evidenceIdentity` containing a 13–19 digit
  PAN-shaped run is rejected (`OUTCOME_PAYMENT_CREDENTIAL_REJECTED`), reusing the
  R6-E guard. Card data, bank credentials and payment secrets never persist.
- Stale evidence: timestamps must be parseable ISO 8601, year ≥ 2000, not more than
  5 minutes in the future (`OUTCOME_TIMESTAMP_INVALID`). A recorded outcome whose
  evidence is stale relative to its conversion (outcome `occurredAt` before the
  conversion `occurredAt`) fails closed (`OUTCOME_EVIDENCE_STALE`) (acceptance
  case 22).
- Safe logs/audit: ids, closed labels, classes, hashes only — never evidence text or
  PII.

## 8. Outcome lifecycle (A5 — append-only, immutable)

Truthful changes are new immutable facts, never edits:

```
OBSERVED ─┬─→ PROVISIONAL ─→ VERIFIED
          └───────────────→ VERIFIED
(any non-terminal) ─→ REVERSED | CANCELLED        (reversal outcomes, §below)
(any non-terminal) ─→ SUPERSEDED                   (supersession)
RENEWAL outcome records renewal lineage            (renewal)
```

- `business_outcome_lifecycle_events` is immutable with **no update path**. Current
  state is derived: the row's `outcomeStatus` (CAS-guarded) plus the fact history.
- **Verification transition** (`verify` procedure): current status ∈
  `{OBSERVED, PROVISIONAL}`; corroborating evidence authority must be a
  `VERIFIED_*` class (`user_attestation`/`unverified_external` can never verify —
  `OUTCOME_VERIFICATION_AUTHORITY_INVALID`). Mints a `verification` fact, CAS
  transitions the status. Invalid transitions (e.g. `VERIFIED → VERIFIED`,
  terminal → anything) fail closed (`OUTCOME_TRANSITION_INVALID`)
  (acceptance cases 14–15).
- **Reversal outcomes** (`REFUND`/`REVERSAL`/`CANCELLATION` via `record`): require
  `reversesOutcomeId`; the target must exist for the tenant (`FORBIDDEN`), must not
  itself be a reversal outcome (`OUTCOME_REVERSAL_OF_REVERSAL_FORBIDDEN`), must be in
  a non-terminal state, must share business scope, and passes the §6 value checks.
  On acceptance, a deterministic lifecycle fact (`reversal`/`refund`/`cancellation`)
  is minted on the target and its status CAS-transitions (`VERIFIED → REVERSED` /
  `CANCELLED`; partial reversals leave the target `VERIFIED` with the fact recorded).
  Reversal replay converges on the fact identity (§9); refunds/reversals never
  create positive duplicate value (acceptance case 18).
- **Renewal outcomes** (`RENEWAL` via `record` with `renewsOutcomeId`): target must
  be a `SUBSCRIPTION` or `RENEWAL` outcome in non-terminal state; same tenant and
  business. Mints a `renewal` fact on the target (status unchanged — the renewal is
  a new positive outcome, not a correction).
- **Supersession** (`record` with `supersedesOutcomeId`): target must be a
  non-reversal, non-terminal outcome in the same tenant/business (the corrected
  evidence normally shares the conversion but carries a new `evidenceIdentity`).
  Mints a `supersession` fact and CAS-transitions the target to `SUPERSEDED`. The
  superseded row's value is never counted twice — its status is terminal for
  current-state purposes while its history remains fully readable (acceptance
  case 20).
- At most one lineage reference (`reversesOutcomeId` / `renewsOutcomeId` /
  `supersedesOutcomeId`) per outcome, each legal only for its outcome family
  (`OUTCOME_LINEAGE_INVALID`).
- Status transitions are optimistic-CAS guarded on `version`
  (`OUTCOME_STALE_STATE` on stale writes; bounded retry with re-read).

```ts
BusinessOutcomeLifecycleEventRow {      // business_outcome_lifecycle_events
  id: number;                           // serial PK
  outcomeLifecycleEventId: string;      // varchar(70) — "obf1:"+64hex (§3)
  outcomeId: string;                    // varchar(69) NOT NULL
  userId: number;                       // bigint unsigned NOT NULL
  lifecycleType: string;                // varchar(16) NOT NULL — closed vocab §2
  outcomeStatus: string;                // varchar(16) NOT NULL — target status
  amountMinor: number | null;           // bigint NULL
  currency: string | null;              // varchar(3) NULL
  externalLifecycleId: string | null;   // varchar(191) NULL — provider retry anchor
  occurredAt: string;                   // varchar(32) NOT NULL
  reasonCode: string | null;            // varchar(64) NULL
  createdAt: Date;                      // timestamp NOT NULL DEFAULT now()
}
```

## 9. Exact-once persistence and concurrency (A7)

Insert-first against durable unique anchors:

- `bo_outcome_id_uidx` — UNIQUE(`outcomeId`)
- `bo_natural_key_uidx` — UNIQUE(`userId`, `conversionId`, `evidenceSource`,
  `evidenceIdentity`)
- Lifecycle: `bole_event_id_uidx` — UNIQUE(`outcomeLifecycleEventId`); provider-retry
  anchor `bole_external_uidx` — UNIQUE(`outcomeId`, `externalLifecycleId`) (NULLs
  distinct, house convention).

| Scenario | Result |
|---|---|
| Duplicate record (identical material) | `idempotent_replay`; one durable row |
| Concurrent duplicate record | One insert wins; losers re-read via natural key → `idempotent_replay` |
| Replay of same identity with different material | `OUTCOME_IDENTITY_CONFLICT` — fail closed |
| Same evidence under different tenant/business | Distinct `outcomeId` (both inside the hash) |
| Reversal/verification/renewal/supersession replay | Same fact identity → one durable fact |
| Fact identity reused for different material | `OUTCOME_LIFECYCLE_CONFLICT` — fail closed |
| Concurrent status transition | CAS on `version`; bounded re-read/retry; persistent staleness → `OUTCOME_STALE_STATE` |
| Evidence hash drift on any read | `OUTCOME_EVIDENCE_CONFLICT` — fail closed |

All convergence is DB-authoritative. No in-memory dedupe. No client idempotency
identity. Rows are insert-only; corrections are new outcomes/facts.

## 10. Tenant / security / privacy (A6)

- `userId` comes from the authenticated session only and anchors every identity,
  query predicate, and hash.
- `businessId` is **revalidated server-side**: the referenced conversion must exist
  for the tenant, the supplied `businessId` must equal the conversion's
  `businessId`, and the business row must be owned by the tenant
  (`OWNERSHIP_MISMATCH` / `FORBIDDEN`).
- Lead binding re-verifies the conversion-carried numeric `leadId` from the durable
  `leads` row (same tenant; business null-or-equal). Cross-tenant or cross-business
  lead references fail closed (acceptance case 4). Unlinked conversions yield
  `leadId = NULL` outcomes — fully valid, never fabricated.
- No client force-state: `outcomeStatus`, `evidenceAuthority`, `outcomeId`,
  `evidenceHash`, any `verified*` field is server-derived; smuggling fails closed
  before schema parse.
- No arbitrary value/lifecycle mutation: outcomes are immutable; the only mutation
  paths are the governed lifecycle transitions (§8).
- **Rogue-agent containment:** no runtime agent/model may create fake revenue, alter
  verified monetary value, mark provisional value verified, fabricate refund/
  reversal, move outcomes across businesses, alter conversion or lead authority,
  invoke payment/billing, or expand its own permissions. Model/agent output is
  untrusted data and reaches persistence only through the strict boundary, the
  evidence registry, and the classifier — never around them.
- No PII columns; people appear only as server-verified numeric references.

## 11. Downstream projection (A8)

`buildOutcomeProjection` — `OUTCOME_PROJECTION_CONTRACT_VERSION =
"conversion-outcome/v1"`, frozen key allowlist asserted in acceptance. Read-only;
downstream may consume ids, business, lead, conversion, type, current status,
verification state, value + currency, lineage, evidence provenance, and lifecycle
summary — and must never mutate R7-A authority. Every projection carries
`causationClaimed: false` and `attributionClaimed: false` with verbatim
disclaimers. Full semantics:
`docs/contracts/conversion-outcome-to-attribution-learning-contract.md`.

## 12. Acceptance

Thirty connected adversarial cases in `api/outcome-acceptance.test.ts`, running the
REAL outcome router + store/service/projection against an in-memory fake database
replicating the durable unique anchors. No real database, no provider, no clock
dependence (explicit `now` injected). Mapping:

1–30 enumerated in `docs/recovery/r7-a-conversion-outcome-acceptance-report.md`
(canonical R6 conversion → valid outcome; unknown conversion rejected;
cross-business rejected; cross-tenant lead rejected; replay/convergence set;
value-integrity set; lifecycle set; evidence-integrity set; security/rogue-agent set;
projection exactness; no attribution claim).

## 13. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Conversion authority (R6-E owned) | `api/lib/conversion/*`, `api/conversion-router.ts` | read-only consumption |
| Canonical conversion contract | `docs/contracts/conversion-event-contract.md` | R6-E owned — not edited |
| Schema | `db/schema.ts` | append-only (outcome tables) |
| Migrations | `db/migrations/` | append-only provisional `0035_r7_a_conversion_outcome_foundation`; **NOT executed**; 0034 untouched |
| Router registry | `api/router.ts` | one additive `outcome` registration |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive outcome event types only |
| Legacy analytics | `api/analytics-router.ts` | untouched — governed outcomes never routed through ungoverned `metricType` `revenue` |
| Billing / payments (R4) | `api/lib/billing/*`, `api/billing-router.ts` | read-only — never charged, never invoked |
| Leads / CRM | `api/lead-router.ts` | untouched |

## 14. Security invariants (asserted by the acceptance suite)

1. Tenant isolation: session `userId` anchors every identity, predicate and hash;
   business/conversion/lead ownership re-verified from durable rows on every call.
2. Fail closed everywhere: unknown vocabulary, malformed value, ownership mismatch,
   identity conflict, stale CAS, hash drift, stale evidence, credential pattern.
3. Server-derived authority only: status, verification state, evidence authority,
   identities, hashes — no client-supplied authority field is accepted.
4. Value integrity: integer minor units, closed currency, positive/negative
   polarity by outcome family, magnitude bounds, conversion-amount cross-check.
5. No fuzzy anything: deterministic identity over exact coordinates; no matching,
   no inference, no model in the authority path.
6. Immutability: evidence hash proves byte-stability; lifecycle rows have no update
   path; corrections are new rows.
7. No causation/attribution claims: projections disclaim both, verbatim.
8. Auditability: exactly one deterministic audit event per durable effect;
   convergence paths emit zero.

---

**R7-B / R7-C and all downstream consumers: consume outcomes through
`docs/contracts/conversion-outcome-to-attribution-learning-contract.md`. Do not
redefine outcome authority. Outcome evidence does not imply attribution or
causation.**
