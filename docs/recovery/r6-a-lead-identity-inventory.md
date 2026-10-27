# R6-A LEAD IDENTITY & IDENTITY RESOLUTION — REPOSITORY INVENTORY (A0)

> **Stream:** WBS-R6 Stream A — Lead Identity & Identity Resolution
> **Branch:** `feature/r6-a-lead-identity`
> **Base:** `a947ecb` (integration base, `integration/r6-lead-autonomy` lineage)
> **Status:** complete — inventory precedes all design authority (A0 gate)
> **Authority consumed (read-only):** R5-D opportunity contracts
> (`docs/contracts/opportunity-candidate-contract.md`,
> `docs/contracts/opportunity-to-lead-autonomy-contract.md`), R5-A/B/C/E/F
> contracts as supporting reference.

---

## 1. Scope of inventory

Per A0 mandate, all existing modules related to: leads; opportunities; CRM /
contact entities; customer / person records; campaign interest signals;
provider actor identifiers; engagement receipts; social signals; external
identifiers; user/business ownership; audit; idempotency; conversion records;
attribution.

## 2. Existing lead-like tables / models

| Table | File:line | What it is | Identity content | R6-A disposition |
|---|---|---|---|---|
| `leads` | `db/schema.ts:387` | Legacy CRM lead (name/email/phone/company, pipeline status `new→…→won/lost`, `score`) | **Raw PII** (name, email, phone); no actor/external id columns; no tenant-scoped external identity | Out of scope for identity authority. R6-A does NOT write `leads` (no CRM contact creation). Downstream R6-C owns any CRM bridging under its own contract. |
| `lead_activities` | `db/schema.ts:419` | Activity log on `leads` | None (notes/text) | Untouched. |
| `lead_scores` | `db/schema.ts:1015` | AI/audience scoring rows keyed by `(userId, campaignId, externalIdentifier)` with raw `handle`/`displayName` | Raw provider handles; `score`, `confidence`, `recommendedAction` | Scoring is downstream (R6-B); raw handles are a privacy risk (§6). R6-A never writes it. |
| `outreach_recommendations` | `db/schema.ts` (audience stack) | Outreach suggestions | Raw handles | R5/R6-C territory; untouched. |
| Audience tables (`social_profiles`, `social_engagement_events`, `campaign_interest_signals`) | `db/schema.ts:880/923/972` | Raw social ingestion/profile rows | **Raw** `externalId`, `handle`, `displayName`, `actorExternalId`, `externalIdentifier` | Pre-existing R5-A-era stores. R6-A does not read or write them; identity resolution in R6-A is hash-only and consumes R5-D `actorKey` semantics, not these raw stores. |
| `opportunity_candidates` / `opportunity_evidence` / `opportunity_suppressions` / `opportunity_handoffs` | `db/schema.ts:2144/…` | R5-D opportunity detection (canonical upstream) | `actorKey` (sha256), `threadKey`, `topicKey` — hash-only; `externalActorReference` always null | **Consumed read-only** via the frozen envelope contract. Never mutated by R6-A. |

No `contact`, `customer`, `person`, `subscriber`, or `crm_*` tables exist. No
`lead_identity*` symbols exist anywhere in the repo (naming space is free).

## 3. Duplicate identity risks (existing repo)

1. **Raw-handle identity in the audience stack** — `lead_scores` / `social_profiles`
   key "identity" by raw provider handles that can change and can collide
   across platforms. R6-A must not reuse these as identity authority.
2. **`campaign_interest_signals.externalIdentifier`** — raw, per-campaign scoped;
   not tenant-stable person identity.
3. **No cross-platform person model exists** — good; R6-A must not invent
   probabilistic cross-provider matching (A3/A4 prohibition).
4. **Legacy `leads` rows carry no external identity** — an opportunity-handoff
   lead and a legacy CRM lead can never be silently correlated by R6-A; any
   future linkage is R6-C/E authority under its own contract.

## 4. R5 opportunity handoff structure (consumed exactly)

Source of truth: `api/lib/opportunity/opportunity-contract.ts:272` —
`OpportunityHandoffEnvelope` (`HANDOFF_ENVELOPE_VERSION =
"opportunity-to-lead-autonomy/v1"`).

- `handoffId = "oph1:" + sha256(canonicalJson({…envelope fields…}))` —
  deterministic, server-minted, immutable; unique on `opportunity_handoffs`
  (`handoffId`) and `(userId, opportunityId)` → exactly-once (contract §11).
- Durable row: `opportunity_handoffs { handoffId, opportunityId, userId,
  businessId, envelope(json), evidenceSnapshotHash, handedOffAt, createdAt }`
  (`db/schema.ts:2283`).
- Identity spine (contract §1): `actorKey = sha256(provider|platform|
  actorReference)` — raw actor reference **never persisted** in R5;
  `externalActorReference` is typed `null` in the envelope. `threadKey`,
  `topicKey`, `opportunityKey` = sha256 coordinates. `"no-actor"` /
  `"no-thread"` / `"no-topic"` sentinels.
- Producer: `handoffToR6` (`api/lib/opportunity/detector.ts:988`) — replay-first
  (returns existing envelope with `duplicateClassification:
  "idempotent_replay"`).
- Envelope privacy posture (contract §14): references and closed labels only —
  no social text, no handles, no tokens, no model reasoning. R6-A inherits
  this minimization duty.
- R6 must derive (contract §16): lead identity and dedupe keys, scoring,
  qualification, CRM, consent, outreach, identity beyond the opaque `actorKey`.
- R6 must not mutate (contract §17): all R5 tables — enforcement by query
  predicates only, no FK coupling (repo convention).

## 5. Reusable actor / reference semantics

| Semantic | Where defined | R6-A reuse |
|---|---|---|
| `actorKey` sha256 of `provider\|platform\|actorReference` | `api/lib/opportunity/opportunity-identity.ts` | Verbatim: the handoff actor reference **is** the R5 `actorKey`; R6-A stores it as the opaque `externalActorReferenceHash`. No raw reference is demanded, reconstructed, or enriched (contract §13). |
| Prefixed content-hash ids (`"opp1:"`, `"oph1:"`, `"sigv1:"`, `"ere_"`) stored `varchar(69)` | repo-wide convention | R6-A mints `"lid1:"` (lead identity) and `"lmg1:"` (merge record) ids, same construction. |
| `canonicalJson` / `sha256Hex` | exported copies at `api/lib/opportunity/opportunity-contract.ts:154,168` and `api/lib/intelligence/interpretation-identity.ts:47-57` | Repo convention is "each module owns a copy"; R6-A contract module owns its own copy. |
| Exact-once convergence | unique natural keys + read-first insert + `ER_DUP_ENTRY` catch + re-read (`api/lib/audit/audit-store.ts:180`, `detector.ts:996`) | Same DB-authoritative discipline; no in-memory dedupe. |
| Optimistic CAS | `version` int column, `UPDATE … WHERE version = expected`, zero rows → typed conflict error (`opportunity-store.ts`) | Same on `lead_identities.version`. |
| Audit | `createAuditEvent` / `persistAuditEvent` (`api/lib/audit/`), `AUDIT_EVENT_TYPES` append-only (`audit-event.ts:34`) | Additive `lead_identity_*` event types; one canonical event per durable effect. |
| Typed domain errors | `OpportunityError` subclasses with stable codes (`opportunity-contract.ts:93-148`) | Parallel `LeadIdentityError` taxonomy. |
| tRPC seams | `authedQuery` (`api/middleware.ts`), router registry `api/router.ts` | One additive `leadIdentity` registration. |

## 6. Privacy risks found (existing repo, inherited duty)

1. `social_signals.actorReference` / `actorDisplayName` (R5-A evidence store) —
   the only raw-actor store; PII-minimized by R5-A policy (no emails/phones).
   R6-A never reads it for identity.
2. `lead_scores` / `social_profiles` / `social_engagement_events` raw handles —
   pre-existing; out of R6-A scope, flagged for downstream governance.
3. Legacy `leads` raw name/email/phone — out of scope; R6-A creates **no** such
   rows and exposes **no** raw PII.
4. R6-A design answer: hash-only identity (`actorKey`, normalized email/phone/
   customer-reference hashes), no raw PII columns anywhere in the three new
   tables, no model reasoning, bounded string lengths at every seam.

## 7. Schema implications

- Three new R6-owned tables (no FK constraints to R5 tables — repo convention):
  - `lead_identities` — canonical lead identity row (one per deterministic
    identity coordinate set), unique `(userId, identityKey)`, `(userId,
    leadId)`, `(userId, emailIdentityHash)`, `(userId, phoneIdentityHash)`,
    `(userId, customerReferenceHash)`.
  - `lead_identity_provenance` — immutable append-only evidence/provenance;
    unique `(userId, handoffId)` (exact-once handoff consumption anchor) and
    `(userId, kind, evidenceHash)`.
  - `lead_identity_merges` — immutable merge records; unique `(userId,
    mergeId)`, `(userId, canonicalLeadId, absorbedLeadId)`.
- Provisional migration **`0034_lead_identity_foundation`** — artefacts only,
  **not executed** (see `docs/recovery/r6-a-unexecuted-migrations.md`).
  Journal chain currently ends at `0033_opportunity_detection_foundation`;
  R6-A appends 0034 and does not renumber or mutate any R5 artefact.
- No changes to `leads`, `lead_activities`, `lead_scores`, or any R5 table.

## 8. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Handoff producer / R5 tables | `api/lib/opportunity/*`, `db/schema.ts` (R5 tables), `db/migrations/0033_*` | R5-D owned — read-only consumption; never mutated |
| Legacy lead/CRM | `api/lead-router.ts`, `api/lib/agents/audience-intelligence-agent.ts` | R6-A never writes; R6-C evolves later |
| Audience aggregation | `api/lib/audience/*` | read-only shapes; never written |
| Router registry | `api/router.ts` | one additive `leadIdentity` registration |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive `lead_identity_*` values only |
| Schema / migrations | `db/schema.ts` (append-only tables), `db/migrations/` | append 0034 only; no renumbering |
| Boot / schedulers | `api/boot.ts` | untouched (no scheduler added; intake is envelope-driven) |
| Financial contract | `docs/contracts/financial-reliability-contract.md` | untouched — R6-A is non-billable |

## 9. Downstream B/C/D/E dependencies (A8 surface)

- **R6-B (scoring):** consumes lead identity projection (leadId, identity
  status/confidence class, source refs, first/last observed). Never mutates.
- **R6-C (qualification/CRM):** consumes the same projection; CRM bridging to
  legacy `leads` is R6-C authority, not R6-A.
- **R6-D (nurture/handoff):** consumes projection + provenance evidence
  references; outreach permission remains R5-E policy authority.
- **R6-E (conversion linkage):** consumes `leadId`, `sourceOpportunityId`,
  `campaignId` lineage for attribution; conversion marking is downstream.
- **R6-F (governance):** consumes audit trail + suppression/archive states;
  operator-assisted identity conflict resolution is documented as an R6-F
  seam (A5) — no unsafe override is implemented here.

## 10. A0 verdict

**INVENTORY COMPLETE.** One canonical lead-identity model can be defined (A1)
on the R5 handoff spine without colliding with any existing module; naming
space is free; the exact-once/CAS/audit/harness patterns are proven in-repo and
reused. No design authority beyond this inventory is required to proceed.
