# LEAD IDENTITY → SCORING / QUALIFICATION CONTRACT (WBS-R6-A → R6-B/C/D/E/F)

> **Producer:** R6-A (Lead Identity & Identity Resolution), branch
> `feature/r6-a-lead-identity`
> **Consumers:** R6-B (scoring), R6-C (qualification/CRM), R6-D (nurture),
> R6-E (conversion linkage), R6-F (governance)
> **Status:** canonical handoff contract — downstream streams consume, do not
> redefine
> **Implements:** `LEAD_IDENTITY_CONTRACT_VERSION = "lead-identity/v1"`
> **Source of truth:** `docs/contracts/lead-identity-contract.md` (R6-A
> canonical identity contract) + `api/lib/lead-identity/`
> **Upstream (frozen, consumed not merged):** R5-D opportunity contracts
> (`docs/contracts/opportunity-candidate-contract.md`,
> `docs/contracts/opportunity-to-lead-autonomy-contract.md`) @ integrated base
> `a947ecb`

This contract defines the durable, exactly-once handoff from R6-A lead
identity to the downstream R6 streams. **R6-A never scores, qualifies,
nurtures, contacts, converts, or creates CRM rows.** It produces one
canonical, evidence-backed, tenant-bound lead identity per deterministic
identity coordinate set, which downstream streams consume on their own
authority and schedule.

---

## 1. Lead identity

One canonical lead identity per deterministic coordinate set
(`docs/contracts/lead-identity-contract.md` §1):

- actor-present: `{ userId, businessId, actorKey }` — `actorKey` is the R5-D
  actor key verbatim (`sha256(provider|platform|actorReference)`), never the
  raw reference.
- anonymous: `{ userId, businessId, threadKey }` — thread-only evidence.

`identityKey = sha256(canonicalJson(coordinates))`; `leadId = "lid1:" +
identityKey` — deterministic, server-minted, opaque, immutable, tenant-bound.
Downstream must treat `leadId` as an opaque immutable reference and must never
mint a different one for the same identity.

## 2. Lead identity version

- Contract version: `leadIdentityVersion = "lead-identity/v1"` (immutable per
  record; new versions are new governed contract versions, never silent).
- Row CAS guard: `version` (optimistic concurrency; downstream never writes).
- Identity evolution (type/status/confidence) is derived, versioned by
  immutable provenance, and never rewrites history.

## 3. Source opportunity / handoff identity

Each identity carries its first-consumed source lineage:
`sourceOpportunityId` (`opp1:…`), `sourceHandoffId` (`oph1:…`), `provider`,
plus full provenance references (`handoffId`/`opportunityId` per observation).
R5 identities are opaque references — downstream must not re-derive,
re-interpret, or mutate R5 rows (handoff contract §17).

## 4. Identity status

Closed set: `active, anonymous, partially_identified, resolved, conflicting,
suppressed, merged, archived` (contract §4). Identity-lifecycle only — there
is **no** sales/qualification status in R6-A. `merged` rows carry
`canonicalLeadId`; downstream must follow the chain (read `getLeadIdentity`
returns the row as stored; follow `canonicalLeadId` when `merged`).

## 5. Identity confidence semantics

Bounded honest ordinals `unknown < low < medium < high` (contract §5) —
never calibrated probabilities, never client/model-set. Derivation is a pure
function over durable evidence: authenticated customer reference / ≥2 linking
key types / linking key + repeat observation ⇒ `high`; one linking key or
repeat observation ⇒ `medium`; single actor observation ⇒ `low`; anonymous ⇒
`unknown`. **R6-A identity confidence must not be read as purchase intent,
sales readiness, or outreach permission.** R6-B derives its own score.

## 6. Actor / reference semantics

- `externalActorReferenceHash` = R5-D `actorKey` (hash-only; raw references
  never exist in R6-A). `null` for anonymous identities.
- Linking keys are hashes with domain separation:
  `emailIdentityHash`, `phoneIdentityHash`, `customerReferenceHash`
  (authenticated customer reference and CRM external reference share the
  column; the immutable provenance records which class was verified).
- All other references (`handoffId`, `opportunityId`, `campaignId`,
  `businessId`) are internal opaque ids, not personal data.

## 7. Merge rules

Merges happen **only** through deterministic, evidence-authorized absorption
(contract §8): a verified authoritative linking key (email hash, phone hash,
authenticated customer reference, CRM external reference) shared by two
eligible identities of the same tenant + business scope. Canonical =
**older** identity (`createdAt`, tiebreak row id). The absorbed identity is
terminal (`merged`, `canonicalLeadId` pointer); its history and provenance are
immutable and preserved; linking-key ownership moves to the canonical row.
There is **no generic merge-anything endpoint** — downstream must not attempt
to merge identities directly. Operator-assisted conflict resolution is an
R6-F seam.

## 8. Cross-provider merge rules

Same actor reference on two providers ≠ the same person (A4 default). In R6-A
the raw cross-provider reference is never even available — actors are
provider-scoped hashes. Cross-provider merge occurs **only** when an
authoritative linking key (§7) is verified for both identities. Unknown or
unverified evidence keeps identities separate forever. A cross-channel
equivalence question backed only by channel actor evidence resolves to
`INSUFFICIENT_EVIDENCE` (see `classifyIdentityResolution`).

## 9. Conflict semantics

Conflicting authoritative identifiers fail safely: `identityStatus =
conflicting`, an immutable conflict provenance entry, a `lead_identity_conflict`
audit event, and **no merge** (contract §8). Both involved identities are
flagged. `conflicting` is sticky and cleared only by R6-F operator
resolution. Downstream must treat `conflicting` identities as
non-actionable for autonomous steps.

## 10. Privacy restrictions

- R6-A stores **hashes and opaque references only**: no raw email, phone,
  name, handle, profile URL, message text, tokens, or model reasoning exists
  anywhere in R6-A storage.
- Downstream must not join R6-A identities against raw-PII stores to
  "enrich" identity; any such bridging is a governance decision (R6-F) under
  its own contract.
- Suppression (`privacy_request`) is a governed terminal state; downstream
  must honor it as a stop signal.
- No sensitive-trait inference: R6-A stores no content from which protected
  traits could be derived, and downstream must not infer them either.

## 11. Downstream-safe fields

The single read surface (tRPC `leadIdentity.get` / `leadIdentity.list`)
projects exactly:

```
leadId, businessId, leadIdentityVersion, identityStatus, identityConfidence,
primaryIdentityType, externalActorReferenceHash, provider, sourceOpportunityId,
sourceHandoffId, canonicalLeadId, firstObservedAt, lastObservedAt,
provenance: [{ kind, handoffId?, opportunityId?, evidenceType?, occurredAt }]
```

Nothing else exists on the surface — no scores, no pipeline status, no
contact data, no conversion fields.

## 12. Fields R6-B (scoring) may consume

`leadId`, `businessId`, `identityStatus` (gate: skip `suppressed`, `archived`,
`conflicting`, and follow `merged`), `identityConfidence` (an input signal,
never the score), `firstObservedAt`/`lastObservedAt` (recency), `provenance`
observation counts, `sourceOpportunityId`/`sourceHandoffId` (lineage joins).

## 13. Fields R6-C (qualification) may consume

All of §11. Qualification/pipeline status and any CRM record creation are
R6-C's own authority; R6-A identity status is **not** a pipeline stage. CRM
bridging to legacy `leads` rows must key on `leadId` under R6-C's contract —
never on raw handles or cross-tenant identifiers.

## 14. Fields R6-D (nurture/handoff) may consume

All of §11. Outreach permission is **never** granted by identity: governed
actions remain under R5-E policy authority and R6's own gates. `suppressed`
identities must not be contacted; `merged` identities resolve to canonical
before any governed step.

## 15. Fields R6-E (conversion linkage) may consume

`leadId`, `sourceOpportunityId`, `sourceHandoffId`, `businessId`, provenance
`campaignId` lineage (via handoff provenance), `firstObservedAt`/
`lastObservedAt` for attribution windows. Conversion marking is R6-E's own
authority; R6-A never marks conversions.

## 16. Fields downstream must not mutate

All R6-A state: `leadId`, `identityKey`, identity status/confidence/type,
linking-key columns, provenance, merge records, source lineage. R6-A tables
are not shared-writable; corrections are new R6-A records (or R6-F governed
transitions), never edits. Downstream must not invent lead ids, force merges,
override confidence, or resurrect suppressed identities.

## 17. Replay / idempotency semantics

- One R5 handoff ⇒ one lead identity, exactly once: provenance unique
  `(userId, handoffId)` is the consumption anchor; replay returns the existing
  identity (`duplicateClassification: "idempotent_replay"`), following merge
  chains to canonical.
- Same actor coordinates ⇒ same identity; unrelated actors ⇒ distinct
  identities; cross-tenant actors ⇒ unrelated identities (structurally
  impossible to merge).
- Repeated evidence submission and repeated merges converge
  (`IDEMPOTENT_REPLAY`); all convergence is DB-authoritative (unique keys +
  CAS). No in-memory dedupe exists anywhere.

## 18. Merge provenance

`lead_identity_merges` records are immutable: `mergeId` (`lmg1:…`),
`mergeHash`, `canonicalLeadId`, `absorbedLeadId`, `linkingEvidenceType`,
`linkingEvidenceHash`, `createdAt`. Unique `(userId, canonicalLeadId,
absorbedLeadId)` and `(userId, mergeId)` make replays converge. Merge
provenance entries (kind `merge`) are recorded on both identities; inherited
keys are re-lined as `identity_evidence` provenance on the canonical identity
(`inheritedFrom` binding in the content hash). Original lead ids, history,
and absorbed-row provenance are preserved forever — no destructive deletion.

## 19. Schema dependencies

- R6-owned tables: `lead_identities`, `lead_identity_provenance`,
  `lead_identity_merges` (provisional migration `0034_lead_identity_foundation`
  — **artefacts only, not executed**; see
  `docs/recovery/r6-a-unexecuted-migrations.md`). R6-X owns canonical
  sequencing; downstream must not execute or renumber migrations.
- No FK constraints couple R5 tables (enforcement in query predicates).
- `AUDIT_EVENT_TYPES` gains `lead_identity_created`, `lead_identity_observed`,
  `lead_identity_evidence_attached`, `lead_identity_merged`,
  `lead_identity_conflict`, `lead_identity_suppressed`,
  `lead_identity_archived` (code-level additive).

## 20. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Identity authority | `api/lib/lead-identity/*`, `docs/contracts/lead-identity-contract.md` | R6-A owned |
| R5 handoff producer | `api/lib/opportunity/*` | R5-D owned — read-only |
| Legacy lead/CRM | `api/lead-router.ts`, `api/lib/agents/audience-intelligence-agent.ts` | R6-C evolves; R6-A never writes |
| Audience aggregation | `api/lib/audience/*` | read-only shapes |
| Router registry | `api/router.ts` | additive `leadIdentity` registration only |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive `lead_identity_*` values only |
| Schema / migrations | `db/schema.ts` (append-only), `db/migrations/` | append 0034 only |
| Financial contract | `docs/contracts/financial-reliability-contract.md` | untouched — R6-A is non-billable |

## 21. Security invariants

1. Tenant isolation: `userId` anchors every identity and query; cross-tenant
   references fail closed (`OWNERSHIP_MISMATCH`).
2. No client-supplied authority: identity, confidence, status, merges, and
   envelopes are server-minted/validated; strict schemas reject injected
   fields (including any client-supplied `leadId`).
3. Exactly-once, replay-safe, fail-closed on hash drift, stale lineage, or
   stale CAS.
4. Envelope untrusted-data discipline: R5 envelopes are re-validated and
   tamper-verified at the R6-A seam; no agent/client output ever becomes
   execution authority (cross-agent security addendum).
5. Lead ≠ contact: no `leads`/`lead_activities`/`lead_scores` rows are ever
   created by R6-A; no score/qualification/contact/conversion occurs here.
6. Privacy minimization: hash-only identity; no raw PII, tokens, payloads,
   or model reasoning retained or logged; safe errors (stable codes, no PII).
7. No cross-tenant correlation; no cross-provider merge without
   authoritative linking evidence; no probabilistic/fuzzy person matching.
8. Bounded honest confidence; conflicting identity fails safely; suppressed
   identities are non-actionable downstream.

---

**R6-B/C/D/E: consume lead identity through this contract. Do not redefine
lead identity. Identity confidence is an evidence class, not a score and not
permission.**
