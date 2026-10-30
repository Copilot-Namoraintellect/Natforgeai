# BUSINESS CHANGE INTELLIGENCE CONTRACT (WBS-R8-B)

> **Stream:** R8-B Business Change Intelligence
> **Branch:** `feature/r8-b-business-change-intelligence`
> **Status:** canonical R8-B contract — downstream (R8-D/E) consumes, never redefines
> **Contract version:** `business-change/v1`
> **Upstream (frozen, consumed not merged):** R8-A Strategic Memory
> (`feature/r8-a-strategic-memory`, accepted HEAD `23d0f22`, verdict
> `STRATEGIC_MEMORY_READY`) via
> `docs/contracts/strategic-memory-contract.md` +
> `docs/contracts/strategic-memory-to-reasoning-contract.md`; R8-F Strategic
> Governance (`feature/r8-f-strategic-governance`, accepted HEAD `44118e3`) by
> contract reference; R7 Business Optimisation V1 (`a2c084a1…`) via
> `docs/contracts/business-optimisation-to-strategic-intelligence-contract.md`;
> Business DNA / strategy snapshot authorities (see
> `docs/recovery/r8-b-business-change-inventory.md`).

---

## 1. Purpose and boundaries

R8-B detects and classifies **meaningful internal changes to the durable
strategic state of the business**. R8-A remembers; R8-B notices that something
worth remembering *changed*. Given the current R8-A memory state for a subject
plus newly observed authoritative internal evidence, R8-B performs a
deterministic state comparison and answers: what changed, when, from what prior
state, to what new state, with what confidence and significance, under which
strategic domain, and with what lifecycle status.

**Change detection compares authoritative states; it does not invent change.**
No change may be inferred solely from model narrative; no LLM is final change
authority; model/agent output has no field at this boundary at all.

R8-B owns: business-change identity (`chg1:`); the change-domain and
change-type taxonomies; before/after state binding (fingerprint-bound);
change evidence; significance classification (closed, evidence-bounded);
temporal ordering; the change lifecycle (with supersession/correction);
the internal change projection; audit/provenance; and the downstream
reasoning handoff surface.

R8-B does **not** own: strategic memory truth (R8-A); external market signals
(R8-C); strategic reasoning or recommendations (R8-D); opportunity/risk
conclusions (R8-E); strategy mutation; Business DNA mutation; budget changes;
campaign execution; governance approval (R8-F); provider/payment/billing
execution (R4). Internal business evidence and external market evidence remain
separate authorities — this contract governs internal change only.

## 2. Core principles (binding)

1. Change detection compares authoritative states; it does not invent change.
   A change requires a server-loaded previous state and a server-loaded
   current state; either missing ⇒ fail closed (`CHANGE_PREVIOUS_STATE_MISSING`
   / `CHANGE_COMPARISON_STATE_MISSING`).
2. No change may be inferred solely from model narrative. No boundary field
   accepts model output; no model call exists in this stream.
3. Internal business evidence and external market evidence remain separate
   authorities (this stream never consumes R8-C surfaces).
4. Change preserves before/after state and provenance: `previousStateRef` /
   `currentStateRef` bind `{authority, identity, version, fingerprint}` and
   the compared state material is fingerprint-bound into the immutable core.
5. Repeated identical evidence converges: same business + subject + change
   type + previous/current fingerprints ⇒ same `chg1:` identity; replays are
   `idempotent_replay` and emit zero new facts/audit.
6. Contradictory evidence never silently overwrites prior state: a revert
   (state pair swapped back) mints a contradiction lifecycle fact; both
   records persist and the conflict stays visible.
7. Strategic significance is evidence-based and bounded: a deterministic
   dimension model derives significance, and the source confidence caps it.
   Weak evidence can never rank HIGH/CRITICAL.
8. Change detection itself mutates nothing outside its own two tables: no
   Business DNA, strategy, budget, policy, campaign, approval, payment,
   provider, CRM, or R7/R8-A table write exists anywhere in this stream.

## 3. Record shape and closed vocabularies

`contractVersion = "business-change/v1"` on every record and projection.

| Field | Type | Rule |
|---|---|---|
| `changeId` | `chg1:` + sha256-64 | Server-minted only (§4). |
| `userId` / `businessId` | bigint | Session tenant + server-verified business ownership (re-verified per call). |
| `changeDomain` | closed enum (§3.1) | Server-derived from subject + detected change type. |
| `changeType` | closed enum (§3.2) | Server-derived by the deterministic detection rules (§5). |
| `subjectType` | closed enum (§3.3) | Server-normalized. |
| `subjectId` | bounded string ≤191 | Opaque subject reference (e.g. `business:10`, `objective:growth`, `budget-envelope:business:10`, `provider-set:business:10`); verbatim. |
| `previousStateRef` | JSON closed shape (§3.5) | The R8-A current memory state compared against. |
| `currentStateRef` | JSON closed shape (§3.5) | The newly observed authoritative state. |
| `evidenceRefs` | `string[]` (each ≤191, closed pattern) | Exact upstream identities (§3.6). |
| `sourceAuthority` | closed enum (§3.4) | Where the new state came from. |
| `sourceVersion` | bounded string ≤48 | Frozen upstream contract version per source (§6). |
| `significanceClass` | closed enum (§3.7) | Server-derived deterministic model, confidence-capped (§7). |
| `confidenceClass` | closed enum (§3.8) | Server-derived deterministic mapping from source evidence (§6.3); never client-supplied, never promotable. |
| `status` | closed enum (§3.9) | Lifecycle status; CAS-guarded transitions only (§8). |
| `detectedAt` | ISO 8601 ≤32 | When the change was detected. |
| `effectiveAt` | ISO 8601 ≤32 | When the change took effect upstream (`observedAt` of the new state). |
| `recordedAt` | ISO 8601 ≤32 | When the change row was accepted. |
| `validUntil` | ISO 8601 ≤32 \| null | Optional validity bound (e.g. provisional changes). |
| `supersedesChangeId` | `chg1:…` \| null | Exact predecessor binding for corrections (§9). |
| `limitations` | `string[]` ≤8 × ≤191 | Preserved verbatim into every projection. |
| `evidenceHash` | sha256-64 | Immutable-core hash (§4.3). |
| `version` | int | Optimistic-CAS guard for status transitions. |
| `createdAt` | timestamp | DB default. |

### 3.1 Change domains (closed — v1 wired set, adapted to this repository)

```
BUSINESS_OBJECTIVE   PRODUCT_SERVICE   AUDIENCE   BUDGET
CAPABILITY           PORTFOLIO_PERFORMANCE
STRATEGIC_CONSTRAINT RISK_POSTURE
```

Evaluated and deferred (see inventory §4 — no durable before/after authority
without unsupported inference in v1): `PRICING`, `CHANNEL`,
`CUSTOMER_BEHAVIOUR`, `LEAD_CONVERSION`. A later version may extend this enum
only together with a named durable authority; unknown domains fail closed.

### 3.2 Change types (closed, directional)

```
OBJECTIVE_ADDED            OBJECTIVE_MODIFIED            OBJECTIVE_REMOVED
BUDGET_ENVELOPE_INCREASED  BUDGET_ENVELOPE_DECREASED
PROVIDER_SUPPORT_ADDED     PROVIDER_SUPPORT_REMOVED
PRODUCT_ADDED              PRODUCT_REMOVED               PRODUCT_REPOSITIONED
AUDIENCE_SEGMENT_ADDED     AUDIENCE_SEGMENT_REMOVED      AUDIENCE_REPOSITIONED
LEARNING_PATTERN_CONTRADICTED   LEARNING_PATTERN_SUPERSEDED
STRATEGY_REGIME_CHANGED
CONSTRAINT_TIGHTENED       CONSTRAINT_RELAXED
RISK_POSTURE_ELEVATED      RISK_POSTURE_REDUCED
```

Unknown/undetectable combinations fail closed
(`CHANGE_DOMAIN_UNSUPPORTED`). Directional types make revert/contradiction
detection exact (§9.2).

### 3.3 Subject types (closed)

```
OBJECTIVE   PRODUCT_SET   AUDIENCE_SET   BUDGET_ENVELOPE
PROVIDER_CAPABILITY   LEARNING   STRATEGY   CONSTRAINT   RISK_POSTURE
```

Subject ids are opaque, tenant-scoped references (`business:<id>`,
`objective:<key>`, `product-set:business:<id>`, `audience-set:business:<id>`,
`budget-envelope:business:<id>`, `provider-set:business:<id>`,
`learning:<lrn1-id>`, `strategy:campaign:<id>`, `constraint:<ogd1-id>`,
`risk-posture:business:<id>`).

### 3.4 Source authorities (closed — new-state sources)

| Source | Wired dimensions (v1) | Confidence ceiling |
|---|---|---|
| `business_dna` | PRODUCT_SERVICE, AUDIENCE | AUTHORITATIVE (hash-verified snapshot) |
| `strategy_snapshot` | PORTFOLIO_PERFORMANCE (strategy regime) | AUTHORITATIVE |
| `r7_budget_portfolio` | BUDGET, CAPABILITY(provider) | VERIFIED |
| `r7_learning` | PORTFOLIO_PERFORMANCE (learning lifecycle) | mapped from learning confidence |
| `r7_governance` | STRATEGIC_CONSTRAINT, RISK_POSTURE | VERIFIED |
| `operator_attestation` | BUSINESS_OBJECTIVE (bounded observed state) | PROVISIONAL (UNVERIFIED if basis is PENDING_VERIFICATION) |

R7-A outcomes and R7-B attributions are **evidence refs only** in v1 — never
change authorities (two-point comparisons cannot establish behaviour regimes;
attribution stays association). `r7_outcome`/`r7_attribution` are therefore
deliberately absent from this enum.

### 3.5 State reference shape (closed)

```
{ authority: string,        // memory sourceAuthority of the compared row
  memoryId: string,         // mem1: identity of the compared memory record
  sourceIdentity: string,   // upstream identity the memory derives from
  sourceVersion: string,    // frozen upstream contract version
  statementType: "FACT"|"ASSUMPTION",
  stateFingerprint: sha256-64 }  // sha256 over the canonical-normalised compared state view
```

The `currentStateRef` uses the same shape with the memory fields set to the
newly-observed material (for a new observation not yet in memory, `memoryId`
is the empty sentinel `mem0:none` and `statementType` is `FACT` for governed
sources). State fingerprints bind the exact compared material — drift between
a retained row and a recomputed fingerprint is tampering and fails closed on
every read (`CHANGE_EVIDENCE_CONFLICT`).

### 3.6 Evidence reference patterns (closed)

`out1:[a-f0-9]{64}`, `atr1:…`, `lrn1:…`, `evb1:…`, `exp1:…`, `exr1:…`,
`opt1:…`, `ins1:…`, `ogd1:…`, `psn1:…`, `bdna_[A-Za-z0-9:_-]{1,127}`,
`ssnap_[A-Za-z0-9:_-]{1,127}`, `campaign:[0-9]+`, `business:[0-9]+`,
`att1:[a-f0-9]{64}` (operator attestation coordinates). No other shape is
accepted.

### 3.7 Significance classes (closed)

`LOW < MODERATE < HIGH < CRITICAL` — deterministic derivation in §7.
Server-derived only; a model may not increase significance (no model field
exists at the boundary); confidence caps apply (§7.3).

### 3.8 Confidence classes (closed)

`AUTHORITATIVE > VERIFIED > PROVISIONAL > OBSERVED > UNVERIFIED` (R8-A scale).
Server-derived only, by the deterministic mapping in §6.3; monotonic downward
under re-evaluation; no promotion path exists.

### 3.9 Change lifecycle statuses (closed)

`DETECTED`, `CONFIRMED`, `PROVISIONAL`, `CONTRADICTED`, `SUPERSEDED`,
`INVALIDATED`, `EXPIRED`. Deterministic state (§8). Status is a denormalized,
CAS-guarded projection of the append-only lifecycle facts; never client-writable.

### 3.10 Protected traits (closed rejection set)

`race, ethnicity, religion, belief, health, genetic, biometric, political
opinion, trade union membership, sexual orientation, precise geolocation`.
Change material (observed state, basis, limitations, subject references) whose
text references a protected trait is rejected
(`CHANGE_PROTECTED_TRAIT_REJECTED`) under the default policy. No v1
lawful-authority exception path exists.

## 4. Identity and evidence binding (B2)

### 4.1 Change identity

```
changeKey = sha256(canonicalJson({
  v: 1,
  tenantUserId, businessId,
  subjectType, subjectId,
  changeType,
  previousStateFingerprint,   // from previousStateRef
  currentStateFingerprint     // from currentStateRef
}))
changeId  = "chg1:" + changeKey
```

Same business + subject + change type + previous authoritative state +
current authoritative state ⇒ same change identity. No fuzzy comparison; no
model-generated before/after state. Retries/concurrent observations converge
on one durable row (`duplicateClassification: "none" | "idempotent_replay"`).
Re-observation of the same natural identity with different compared material
is conflicting replay and fails closed (`CHANGE_IDENTITY_CONFLICT`).

Observation of an already-recorded change from a **different** source
authority converges on the same row and mints exactly one `confirmation`
lifecycle fact (§9.3) — independent corroboration, not a duplicate.

### 4.2 Rejections (fail closed, at the boundary)

- `CHANGE_PREVIOUS_STATE_MISSING` — no current R8-A memory for the subject.
- `CHANGE_COMPARISON_STATE_MISSING` — no authoritative current state loaded.
- `CHANGE_CROSS_TENANT_SOURCE` / `CHANGE_CROSS_BUSINESS_SOURCE` — resolved row
  belongs to another tenant/business.
- `CHANGE_SOURCE_UNKNOWN` — source identity does not resolve in tenant scope.
- `CHANGE_SOURCE_VERSION_UNSUPPORTED` — stale/unknown upstream contract version.
- `CHANGE_STATE_FINGERPRINT_CONFLICT` — recomputed compared-state fingerprint
  disagrees with supplied/retained material (tamper/injection).
- `CHANGE_SUBJECT_SOURCE_MISMATCH` — the source's subject does not match the
  requested subject (e.g. a campaign strategy snapshot evaluated against a
  business objective subject).

### 4.3 Immutable core

```
evidenceHash = sha256(canonicalJson({v:1, userId, businessId, changeDomain,
  changeType, subjectType, subjectId, previousStateRef, currentStateRef,
  evidenceRefs (order-normalized), sourceAuthority, sourceVersion,
  significanceClass, confidenceClass,
  supersedesChangeId, limitations (order-normalized)}))
```

`recordedAt`, `detectedAt` and `effectiveAt` (timing provenance — for
attestations `effectiveAt` defaults to acceptance time) are deliberately
excluded: the convergence anchor is exactly the compared before/after state
pair plus bound classifications/source/lineage, so re-observation converges
as an idempotent replay rather than conflicting on clock drift. Rows are
insert-only; drift between a retained row and a recomputed hash is tampering
and fails closed on every read (`CHANGE_EVIDENCE_CONFLICT`). Before/after
fingerprints are immutable — there is no update path of any kind.

## 5. Change detection (B3)

Rule-first deterministic comparison over canonical-normalised state views
(representations normalised: string trim/collapse, set-order-insensitive
arrays, integer minor units for money — documented per template; no semantic
guessing). Examples of wired rules:

| Subject | Rule | Change types |
|---|---|---|
| OBJECTIVE | objective text changed / appeared / removed | OBJECTIVE_* |
| BUDGET_ENVELOPE | `approvedTotalBudgetMinor` delta sign (non-zero integer) | BUDGET_ENVELOPE_INCREASED / _DECREASED |
| PROVIDER_CAPABILITY | `supportedProviders` set add/remove | PROVIDER_SUPPORT_* |
| PRODUCT_SET | `productsAndServices` set add/remove; `primaryOffering` change | PRODUCT_ADDED / PRODUCT_REMOVED / PRODUCT_REPOSITIONED |
| AUDIENCE_SET | `targetCustomerSegments` set add/remove; headline segment change | AUDIENCE_SEGMENT_* / AUDIENCE_REPOSITIONED |
| LEARNING | learning lifecycle status/contradiction changed vs memory-bound prior | LEARNING_PATTERN_CONTRADICTED / _SUPERSEDED |
| STRATEGY (campaign) | `strategyHashSha256` changed between snapshot versions | STRATEGY_REGIME_CHANGED |
| CONSTRAINT | governance decision outcome tightened/relaxed vs memory-bound prior | CONSTRAINT_TIGHTENED / _RELAXED |
| RISK_POSTURE | governance `riskClass` ordinal moved | RISK_POSTURE_ELEVATED / _REDUCED |

Trivial representation differences (ordering, whitespace, formatting) produce
identical fingerprints and therefore **no** change. Equal canonical states
produce no change row at all. When no rule fires the evaluation returns
`{ change: null }` — detection is silent, not creative.

## 6. Source provenance (B6 + new-state loading)

### 6.1 Frozen versions

`business_dna → business-dna/v1`; `strategy_snapshot → strategy-snapshot/v1`;
`r7_budget_portfolio → business-optimisation-to-strategy/v1`;
`r7_learning → business-learning-to-experiment-optimisation/v1`;
`r7_governance → optimisation-governance/v1`;
`operator_attestation → operator/v1`. Any other version fails closed
(`CHANGE_SOURCE_VERSION_UNSUPPORTED`).

### 6.2 Consumption discipline

The new state is loaded exclusively server-side through the upstream seam,
behind guarded information-schema existence checks where the table is not
stream-local. The client names `(sourceAuthority, sourceIdentity)` only; for
`operator_attestation` the client supplies a bounded `observedState` object
(closed shape per subject template, ≤4 KiB, protected-trait scanned, stored
verbatim as untrusted content). Missing upstream tables degrade fail-closed to
"no evidence" — change is never fabricated.

### 6.3 Deterministic confidence mapping (server-derived only)

| Source material | confidenceClass |
|---|---|
| `business_dna` snapshot, `strategy_snapshot` (hash-verified rows) | AUTHORITATIVE |
| `r7_budget_portfolio` snapshot; `r7_governance` decision | VERIFIED |
| R7-C learning confidence STRONG → VERIFIED; MODERATE → PROVISIONAL; WEAK → OBSERVED; NONE → UNVERIFIED | mapped |
| `operator_attestation` | PROVISIONAL ceiling (UNVERIFIED when basis is PENDING_VERIFICATION) |

## 7. Significance classification (B4)

### 7.1 Dimensions (bounded, deterministic)

`magnitude` (0–2: relative size of the delta — budget ratio bands, set-change
fraction, ordinal distance), `scope` (0–2: business-wide vs subject-local),
`financialImplication` (0–2: integer minor-unit delta bands; 0 for
non-monetary domains), `strategicObjectiveImpact` (0–2: objective/constraint/
risk domains score higher by construction of the subject), `persistence` (0–1:
corroborated by an independent source ⇒ 1, else 0).

### 7.2 Class mapping

score = Σ dimensions ⇒ `0–1 LOW, 2–3 MODERATE, 4–5 HIGH, ≥6 CRITICAL`, then
the confidence cap (§7.3) is applied. Authority only ever narrows.

### 7.3 Confidence caps (binding)

`UNVERIFIED ⇒ ≤ LOW`; `OBSERVED ⇒ ≤ MODERATE`; `PROVISIONAL ⇒ ≤ MODERATE`;
`VERIFIED ⇒ ≤ HIGH`; `AUTHORITATIVE ⇒ ≤ CRITICAL`. High significance with weak
evidence is therefore impossible by construction — attested or low-confidence
changes stay bounded and review-oriented, and only hash-verified snapshot
authorities can mint CRITICAL. Significance can never be increased by a
model/agent (no such path exists) and never by the client (no boundary field).

## 8. Temporal / lifecycle model (B5)

Deterministic status (recomputed identically at read; CAS-guarded when
materialized), precedence:

1. `SUPERSESSION` fact (or bound successor) ⇒ `SUPERSEDED`
2. unresolved `CONTRADICTION` fact ⇒ `CONTRADICTED`
3. `INVALIDATION` fact ⇒ `INVALIDATED`
4. `validUntil` < now ⇒ `EXPIRED`
5. `CONFIRMATION` fact ⇒ `CONFIRMED`
6. stored provisional ⇒ `PROVISIONAL`
7. otherwise ⇒ `DETECTED`

Initial status at insert: `PROVISIONAL` for `operator_attestation` sources,
otherwise `DETECTED`. Terminal lineage states (`SUPERSEDED`/`CONTRADICTED`/
`INVALIDATED`) are absorbing — corrections are new rows bound by
`supersedesChangeId`, history is never edited. Duplicate observation converges
(idempotent replay; only the first observation from a *different* source
authority mints a confirmation fact).

## 9. Lineage: confirmation, contradiction, correction, invalidation

### 9.1 Supersession (correction)

When source state is corrected, the successor change binds
`supersedesChangeId`; the predecessor is CAS-transitioned to `SUPERSEDED` with
one immutable `bcl1:` supersession fact. Predecessor rows are never deleted or
edited (B9.18).

### 9.2 Contradiction (revert visibility)

A newly detected change **contradicts** an active change on the same
(tenant, business, subjectType, subjectId, changeDomain) when their compared
state *values* are exactly swapped — the version-independent canonical value
fingerprints (`sha256(template + normalised fields)`) exchange places: the
new change's previous value equals the sibling's current value and vice versa
(the world reverted, even when the revert is captured through a different
source row/version). The older change receives a `CONTRADICTION` fact +
`CONTRADICTED` status; both rows persist and the conflict stays visible in
projections. Contradiction is never silently resolved downstream. Version-bound
fingerprints (identity anchors) never participate in this scan.

### 9.3 Confirmation (independent corroboration)

A change observed from source authority A that already exists (same `chg1:`
identity) and is now observed from a **different** source authority B with
identical compared material mints exactly one `CONFIRMATION` fact and becomes
`CONFIRMED`. Same-source replays converge silently. No client or agent can
mark a change `CONFIRMED` directly — no boundary field accepts status.

### 9.4 Invalidation

When the upstream evidence a change is bound to goes terminal-negative (e.g.
a learning row's upstream state invalidated), dependent active changes receive
an `INVALIDATION` fact + `INVALIDATED` status. Re-affirming evidence mints
`REAFFIRMATION` facts. One fact per dependent change per re-evaluation;
replays converge.

## 10. Strategic memory binding (B6, binding proofs)

- The previous-state authority is R8-A's **current** memory, consumed through
  the read-only memory seam enforcing `strategic-memory-to-reasoning/v1`
  semantics: only `CURRENT` memory is an active comparison anchor; stale/
  superseded/contradicted/expired/invalidated rows never silently serve as
  current.
- `FACT` and `ASSUMPTION` remain distinct end-to-end: the compared
  `statementType` is bound into both state refs; an objective change whose
  prior state was an ASSUMPTION is confidence-capped (ASSUMPTION-anchored
  comparisons derive at most `PROVISIONAL` confidence) and its projection
  labels the distinction.
- R8-B never writes `strategic_memory_records` (or any upstream table). Where
  a change should eventually become memory, the downstream projection emits a
  labelled `memoryCandidate` (reference-only) — minting memory is R8-A's
  authority at R8-X integration.

## 11. Security, tenant and agent boundaries (B7)

- Session `userId` anchors everything; business/subject/lineage/source
  ownership re-verified from durable rows on every call; cross-tenant /
  cross-business resolution fails closed.
- Client-authority smuggling fails closed
  (`CHANGE_CLIENT_AUTHORITY_FIELD_FORBIDDEN`): `changeId, status,
  significanceClass, confidenceClass, changeType, changeDomain, evidenceHash,
  previousStateRef, currentStateRef, userId, id, version, createdAt` and any
  `*Claimed/*Disclaimer/confirmed*` field are server-side only.
- A runtime agent/model may never: fabricate previous/current state; fabricate
  evidence; increase significance; suppress contradiction; mark a provisional
  change confirmed; mutate Business DNA; mutate strategy; alter budget;
  execute shell/SQL/tools; access secrets; change its own permissions. No
  surface in this stream enables any of these.
- Prompt-injected internal text is inert data: operator statements are bounded
  verbatim content, protected-trait scanned, never authority; governed-source
  loading uses only server-loaded rows (never client payloads).
- **Non-execution invariant:** no code path writes campaigns, budgets,
  experiments, approvals, payments, providers, CRM, Business DNA, strategy, or
  any R7/R8-A table.

## 12. Audit

Canonical `audit_events` ledger only: one `business_change_detected` event per
inserted change row and one `business_change_lifecycle` event per inserted
lifecycle fact; convergence/replay paths emit zero. Metadata carries ids /
closed labels / classes / hashes only — never state text.

## 13. Schema and migration

Tables `business_change_events` and `business_change_lifecycle_events`
(stream-local provisional migration `0036_r8_b_business_change_foundation`,
artefact only — **NOT executed**; R8-X owns canonical sequencing and collision
resolution with the R8-A/R8-F stream-local `0036` provisionals;
`docs/recovery/r8-b-unexecuted-migrations.md`). R7's `0035` migration is
untouched.

## 14. Downstream contract

Read-only projection for R8-D/E:
`docs/contracts/business-change-to-strategic-reasoning-contract.md`
(`business-change-to-reasoning/v1`). Downstream may read, never mutate; no
projected field authorizes strategy, spend, or execution; the
`governanceEligibilityHint` is advisory — R8-F remains the sole governance
authority for whether any recommendation may be voiced.
