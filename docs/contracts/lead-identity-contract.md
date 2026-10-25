# CANONICAL LEAD IDENTITY CONTRACT (WBS-R6-A D1)

> **Stream:** WBS-R6 Stream A — Lead Identity & Identity Resolution
> **Module authority:** `api/lib/lead-identity/`
> **Schema:** `lead_identities`, `lead_identity_provenance`, `lead_identity_merges`
> (provisional migration `0034_lead_identity_foundation` — artefacts only,
> **not executed**; see `docs/recovery/r6-a-unexecuted-migrations.md`)
> **Upstream (frozen, consumed not merged):** R5-D opportunity contracts
> (`docs/contracts/opportunity-candidate-contract.md`,
> `docs/contracts/opportunity-to-lead-autonomy-contract.md`) @ integrated base
> `a947ecb`; R5-A/B/C/E/F contracts via the handoff contract only.
> **Audience:** R6-B (scoring), R6-C (qualification/CRM), R6-D (nurture),
> R6-E (conversion linkage), R6-F (governance), R6-X integration.
> **Status:** authoritative as of the R6-A acceptance harness.

This contract defines the single canonical lead-identity model. R6-A owns
**lead identity only**: deterministic identity derivation from R5 opportunity
handoff envelopes, safe deduplication, identity provenance/evidence lineage,
exact-once handoff consumption, controlled deterministic enrichment and merge,
identity confidence classes, and privacy minimization. It does **not** own lead
scoring, qualification, nurture, CRM outreach, sales ownership, conversion, or
campaign optimization (R6-B/C/D/E). It performs no probabilistic identity
resolution and never merges cross-provider identities without authoritative
linking evidence.

**Required principle:** a lead must be evidence-backed and tenant-bound. No
lead may be created by trusting a client-supplied person/customer identity.
The server derives every identity fact; clients can only reference existing
server-minted identities.

---

## 1. Lead identity (deterministic, server-minted, tenant-anchored)

One deterministic identity coordinate set → one durable lead identity.

```
actorPresent   = envelope.actorKey !== "no-actor"
coordinates    = actorPresent
  ? { userId, businessId, actorKey }                 // actor-centric identity
  : { userId, businessId, threadKey }                // anonymous-thread identity
identityKey    = sha256(canonicalJson(coordinates))  // 64 hex, no wall-clock
leadId         = "lid1:" + identityKey               // opaque, server-minted only
```

- `userId` (tenant anchor) participates in every coordinate set, every natural
  key, and every query predicate. The same external actor under two tenants
  produces unrelated identities — no cross-tenant correlation is possible
  (adversarial case: same actor across different tenants).
- `actorKey` is the **R5-D actor key verbatim** (`sha256(provider|platform|
  actorReference)`); the raw actor reference is never demanded, reconstructed,
  persisted, or enriched (handoff contract §13). A different provider or
  platform yields a different `actorKey`, so identities never merge across
  providers by construction.
- `businessId` is `null` = tenant-unattributed scope (mirrors R5-B §3);
  ownership is re-verified against `businesses.id + userId` on every intake.
  The same actor under two business scopes of one tenant produces distinct
  identities; cross-business merge is impossible (§8).
- Anonymous/thread-only handoffs (`actorKey === "no-actor"`) anchor identity
  to the R5 `threadKey` — one anonymous lead per tenant + business scope +
  thread. Later authoritative evidence may resolve an anonymous lead (§9).
- The DB enforces uniqueness of `(userId, identityKey)` and `(userId,
  leadId)`. Duplicate delivery, concurrent delivery, and repeated intake
  converge to **one durable row** (§11).

## 2. Lead identity record

```ts
LeadIdentity {
  leadId: string;                     // "lid1:" + 64 hex — canonical identity
  identityKey: string;                 // 64 hex coordinate hash (§1)
  leadIdentityVersion: "lead-identity/v1";  // contract version, immutable
  rowVersion: number;                  // optimistic CAS guard (starts 1)
  userId: number;                      // server-resolved tenant owner
  businessId: number | null;           // server-validated ownership; never fabricated
  primaryIdentityType: IdentityType;   // §3 — strongest evidenced type
  identityStatus: IdentityStatus;      // §4
  identityConfidence: IdentityConfidence; // §5 (bounded, deterministic)
  externalActorReferenceHash: string | null; // R5 actorKey; null for anonymous
  provider: "meta" | "linkedin" | "twitter" | "tiktok" | null; // evidence lineage
  emailIdentityHash: string | null;    // verified normalized email hash (§7)
  phoneIdentityHash: string | null;    // verified normalized phone hash (§7)
  customerReferenceHash: string | null;// verified business-owned reference hash (§7)
  sourceOpportunityId: string;         // first consumed handoff's opportunity
  sourceHandoffId: string;             // first consumed handoff
  canonicalLeadId: string | null;      // set iff identityStatus = merged
  firstObservedAt: string;             // min evidence observedAt (ISO)
  lastObservedAt: string;              // max evidence observedAt (ISO)
  provenanceCount: number;             // immutable provenance entries bound
  identityEvidenceCount: number;       // verified identity-evidence entries
  statusChangedAt: string;
  createdAt: string;
  updatedAt: string;
}
```

No raw email, phone, name, handle, profile URL, message text, token, or model
reasoning is stored anywhere in R6-A tables — hashes and opaque references
only (§10).

## 3. Identity types (closed)

```
provider_actor, email_hash, phone_hash, authenticated_customer_reference,
crm_external_reference, anonymous_thread, unknown
```

`primaryIdentityType` is the **strongest currently evidenced** type, by
deterministic precedence:

`authenticated_customer_reference > crm_external_reference > email_hash =
phone_hash > provider_actor > anonymous_thread > unknown`

(Within one precedence tier, first-evidenced wins; later evidence of the same
tier never displaces the primary type. Identity type evolution never changes
`identityKey` or `leadId` — history is preserved.)

## 4. Identity status (closed — identity lifecycle only)

```
active, anonymous, partially_identified, resolved, conflicting,
suppressed, merged, archived
```

There is **no sales-qualified, sales-ready, or converted status here** —
those belong to R6-B/C/E. Semantics:

| Status | Meaning |
|---|---|
| `active` | Provider-actor identity observed; no verified linking key yet. |
| `anonymous` | Thread-only evidence (`no-actor`); no actor reference. |
| `partially_identified` | ≥1 verified linking key (email/phone hash) attached, or actor observed across ≥2 distinct handoffs without a customer reference. |
| `resolved` | An authenticated customer reference or CRM reference is verified, or ≥2 distinct linking-key types are evidenced. |
| `conflicting` | Authoritative identifier collision detected; automatic merge blocked (§8). Requires R6-F operator resolution. |
| `suppressed` | Governed suppression (privacy request, safety, operator) — terminal until explicit unsuppress (R6-F). |
| `merged` | Absorbed into a canonical lead; `canonicalLeadId` is authoritative. |
| `archived` | Governed archival — terminal. |

`suppressed`, `archived`, and `merged` are terminal for automatic transitions;
`conflicting` is sticky until R6-F. All other statuses derive deterministically
from evidence via the pure status function (§5) after every durable event.

## 5. Identity confidence (bounded, deterministic — never a probability)

Closed ordinals: `unknown < low < medium < high`. Derived by a pure function
over durable evidence only; no client, model, or external system can set them.

| Class | Exact rule |
|---|---|
| `high` | An authenticated customer reference is verified; OR ≥2 distinct linking-key types are evidenced; OR ≥1 linking key AND the actor was observed via ≥2 distinct handoffs. |
| `medium` | ≥1 linking key (email/phone/customer reference); OR the actor was observed via ≥2 distinct handoffs. |
| `low` | Exactly one provider-actor observation, no linking key. |
| `unknown` | Anonymous thread with no verified linking key. |

R5 opportunity `confidenceClass`/`evidenceStrength` are **evidence only —
never identity authority** and never copied onto the lead identity record
(handoff contract §7).

## 6. R5 opportunity handoff consumption (exact-once)

Intake consumes the frozen envelope
(`HANDOFF_ENVELOPE_VERSION = "opportunity-to-lead-autonomy/v1"`) exactly:

1. **Strict schema validation** — closed vocabularies, bounded lengths,
   `externalActorReference` must be `null`, `actorKey` must be 64-hex or
   `no-actor`; unknown fields rejected.
2. **Tamper verification** — recompute `handoffId` from the canonical envelope
   content and compare; recompute `evidenceSnapshotHash` over the evidence
   manifest; any drift fails closed (`HANDOFF_TAMPERED`).
3. **Tenant verification** — `envelope.userId` must equal the authenticated
   tenant; `businessId`/`campaignId` lineage re-verified against durable rows
   (`OWNERSHIP_MISMATCH` otherwise). No client-supplied envelope is ever
   accepted: the production seam loads the durable envelope by
   `(userId, opportunityId)`; clients may pass only an `opportunityId`
   reference.
4. **Lineage + staleness** — the opportunity candidate must exist and be in
   `handed_off_to_r6`; evidence fully outside the configured evidence window
   (`now − lastObservedAt > staleEvidenceMs`, default 336h = 2× the R5 window)
   fails closed (`STALE_HANDOFF`).
5. **Replay check** — `lead_identity_provenance` unique `(userId, handoffId)`
   is the exact-once consumption anchor: a consumed handoff returns the
   existing lead (`duplicateClassification: "idempotent_replay"`), following
   the merge chain to the canonical lead if merged.
6. **Resolve + persist** — deterministic coordinates (§1); existing identity →
   attach immutable provenance and re-derive status/confidence; new identity →
   insert under the unique `(userId, identityKey)` anchor (raced duplicates
   converge by re-read), then attach provenance. Retries, restarts, and
   concurrent intake can never create a second lead for one handoff.

**One R5 handoff creates at most one lead, ever.** R5-D never creates the
lead; R6-A never re-interprets R5 evidence.

## 7. Controlled enrichment (identity evidence)

The only enrichment path is `submitIdentityEvidence`, accepting closed
evidence types with **raw values that are normalized and hashed server-side
and never persisted**:

| Input type | Normalization | Stored as |
|---|---|---|
| `email` | trim + lowercase; strict email shape; ≤320 chars | `emailIdentityHash = sha256(canonicalJson({ keyType: "email_hash", value }))` |
| `phone` | digits only (leading `+` permitted, stripped); 7–15 digits | `phoneIdentityHash = sha256(canonicalJson({ keyType: "phone_hash", value }))` |
| `authenticated_customer_reference` | trim; 1–128 chars; business-owned opaque id | `customerReferenceHash = sha256(canonicalJson({ keyType: "authenticated_customer_reference", value }))` |
| `crm_external_reference` | trim; 1–128 chars; business-owned opaque id | `customerReferenceHash = sha256(canonicalJson({ keyType: "crm_external_reference", value }))` |

Hash domain separation (`keyType` inside the canonical JSON) prevents
cross-type confusion; uniqueness anchors `(userId, emailIdentityHash)`,
`(userId, phoneIdentityHash)`, `(userId, customerReferenceHash)` make key
ownership DB-authoritative. Oversized or malformed values fail closed before
any hashing. Terminal/conflicting leads reject enrichment (`STATE_CONFLICT`).

## 8. Merge and conflict authority

**Merge is permitted only on authoritative linking evidence** — a verified
email hash, phone hash, authenticated customer reference, or CRM external
reference shared by two eligible lead identities of the **same tenant and
same business scope**. Provider-actor evidence alone never authorizes a
merge; unknown/unverified evidence keeps identities separate (A4 default:
same actor reference on two providers ≠ the same person — and in R6-A even
the raw reference is never available, only the provider-scoped `actorKey`).

Deterministic merge semantics:

- **Eligibility:** both identities in `active | anonymous |
  partially_identified | resolved`; same `userId`; same normalized business
  scope; merge key type is one of the four authoritative linking keys.
- **Canonical designation:** the **older** identity (earlier `createdAt`,
  tiebreak lower row id) is canonical; the other is absorbed.
- **Absorption:** absorbed row → `identityStatus = merged`,
  `canonicalLeadId = canonical.leadId`; its linking-key columns are cleared
  (key ownership moves to the canonical row where null — evidence itself is
  never destroyed: the immutable merge record carries
  `linkingEvidenceType` + `linkingEvidenceHash`, and all provenance rows
  remain). Original lead IDs and history are preserved forever.
- **Replay:** `lead_identity_merges` unique `(userId, canonicalLeadId,
  absorbedLeadId)` + deterministic `mergeId` → repeated merge requests
  converge; a raced merge re-reads.
- **Blocked:** cross-business scope, terminal statuses, or conflicting
  authoritative identifiers block automatic merge and set the involved
  identity(ies) to `conflicting` with an immutable conflict provenance entry
  (`lead_identity_conflict` audit). There is **no generic merge-anything
  endpoint**; operator-assisted conflict resolution is an R6-F seam.

## 9. Anonymous identity and safe resolution

An anonymous lead (`anonymous_thread`) may remain anonymous indefinitely.
Later authoritative evidence (§7) attaches normally and deterministically
re-derives status (`anonymous → partially_identified → resolved`) — a safe
resolution, never a silent merge across business scopes or tenants.

## 10. Privacy / data minimization

- Stored identifying data: `actorKey` hash, linking-key hashes, opaque
  reference ids (`leadId`, `handoffId`, `opportunityId`, internal
  `businessId`/`campaignId`), closed labels, timestamps. **Nothing
  reversible; nothing raw.**
- Not stored: raw email, raw phone, social username/handle, display name,
  profile URL, message text, provider payloads, tokens/credentials, hidden
  model reasoning. R6-A runs no model at all.
- Retention: provenance is append-only; suppression/archival are the governed
  retention controls; evidence references expire per the R5 evidence-window
  semantics (historical context, not actionable signal).
- Audit metadata carries ids/hashes/closed labels only — no PII.

## 11. Replay / idempotency / concurrency semantics

| Scenario | Behavior |
|---|---|
| Same handoff consumed twice | Provenance unique `(userId, handoffId)` → replay returns existing lead (`idempotent_replay`). |
| Concurrent intake of same handoff | Unique anchors serialize; one winner, loser re-reads and converges to the same lead. |
| Process restart after lead persistence | Identity is derived from durable rows; replay of the handoff returns the same `leadId`. |
| Same actor, second handoff | Same `(userId, identityKey)` → same lead; provenance appended. |
| Unrelated actor | Distinct `actorKey` → distinct identity. |
| Same actor, different tenant | `userId` in coordinates → unrelated identities. |
| Same actor id, unsupported/different provider | `actorKey` binds provider+platform → distinct identities; no automatic merge. |
| Authoritative cross-provider key shared | Deterministic merge (§8). |
| Conflicting identifiers | `conflicting` status + immutable conflict record; no silent merge. |
| Repeated merge / evidence replay | Unique merge/evidence anchors → `idempotent_replay`, converged state. |

All convergence is **DB-authoritative** (unique keys + CAS). No in-memory
dedupe. No client idempotency identity.

## 12. Downstream identity surface (A8)

R6-B/C/D/E/F consume **one** read projection, tenant-scoped:

```ts
LeadIdentityProjection {
  leadId, businessId, leadIdentityVersion, identityStatus,
  identityConfidence, primaryIdentityType, externalActorReferenceHash,
  provider, sourceOpportunityId, sourceHandoffId, canonicalLeadId,
  firstObservedAt, lastObservedAt, provenance: ProvenanceRef[]
}
ProvenanceRef { kind, handoffId?, opportunityId?, evidenceType?, occurredAt }
```

Downstream **must not** mutate identity authority: no status overrides, no
score/qualification/contact/conversion fields exist here, and no downstream
stream may mint a different `leadId` for the same identity. Mutation seams in
R6-A are: handoff intake (envelope-driven only), governed identity evidence,
governed suppress/archive, and deterministic merge. R6-F gains an
operator-conflict-resolution seam in a later stream — not in R6-A.

## 13. Schema dependencies

- Provisional migration `0034_lead_identity_foundation` creates the three
  R6-owned tables. **Created, not executed.** R6-X owns canonical sequencing;
  R6-A appends after the accepted R5 chain (journal idx 33) and does not
  renumber, execute, or duplicate any upstream artefact.
- No FK constraints coupling R5 tables (repo convention: enforcement in query
  predicates).
- `AUDIT_EVENT_TYPES` gains `lead_identity_created`,
  `lead_identity_observed`, `lead_identity_evidence_attached`,
  `lead_identity_merged`, `lead_identity_conflict`, `lead_identity_suppressed`,
  `lead_identity_archived` (code-level additive).

## 14. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Handoff producer / R5 tables | `api/lib/opportunity/*`, `db/schema.ts` (R5 tables), `db/migrations/0033_*` | R5-D owned — read-only |
| Legacy lead/CRM | `api/lead-router.ts`, `api/lib/agents/audience-intelligence-agent.ts` | R6-A never writes |
| Audience aggregation | `api/lib/audience/*` | read-only shapes |
| Router registry | `api/router.ts` | one additive `leadIdentity` registration |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive `lead_identity_*` values only |
| Schema / migrations | `db/schema.ts` (append-only), `db/migrations/` | append 0034 only |
| Financial contract | `docs/contracts/financial-reliability-contract.md` | untouched — non-billable |

## 15. Security invariants (asserted by the R6-A acceptance suite)

1. Server-side authorization on every surface; tenant scoping from
   `ctx.user.id` only; ownership re-verified from durable rows on every
   reference.
2. Deterministic server-minted identity; no client-supplied identity,
   leadId, merge, confidence, status, or envelope content.
3. Exact-once convergence is DB-authoritative; replay-safe; tampered,
   stale, forged, or cross-tenant handoffs fail closed.
4. Immutable provenance after acceptance; merge preserves history; no
   destructive deletion of evidence.
5. Lead ≠ contact: no `leads`/`lead_activities`/`lead_scores` rows are ever
   created by R6-A; no score, qualification, outreach, or conversion occurs.
6. Privacy minimization: hash-only identity; no raw PII, tokens, payloads,
   or model reasoning retained or logged.
7. No cross-tenant correlation; no cross-provider merge without
   authoritative linking evidence; no probabilistic/fuzzy person matching.
8. Bounded honest confidence; low/unknown identity never surfaces as
   resolved/high-confidence.
9. No sensitive-trait inference of any kind (race, religion, political
   beliefs, health, sexual orientation, or other protected traits); R6-A
   stores no content from which such traits could be derived.
10. Social text never enters the R6-A path; closed enums + strict schemas at
    every seam (prompt-injection resistance by construction).

---

**R6-B/C/D/E: consume lead identity through this contract and
`docs/contracts/lead-identity-to-scoring-qualification-contract.md`. Do not
redefine lead identity.**
