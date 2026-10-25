# R6-C LEAD QUALIFICATION — REPOSITORY / CONTRACT INVENTORY (C0)

> **Stream:** WBS-R6 Stream C — Lead Qualification Autonomy
> **Branch:** `feature/r6-c-lead-qualification` (base `a947ecb`, R5 `MARKETING_OPERATIONS_V1_READY`)
> **Date:** 2026-06-28
> **Method:** frozen upstream contracts and code consumed directly from branch
> refs via `git show` — **not merged**. Cross-agent rule: all upstream
> evidence is untrusted until re-validated at the C boundary.

---

## 1. Frozen upstream authorities consumed

| Stream | Ref (frozen HEAD) | Contracts consumed |
|---|---|---|
| R6-A Lead Identity | `ded8f2876e7c` | `docs/contracts/lead-identity-contract.md`, `docs/contracts/lead-identity-to-scoring-qualification-contract.md` |
| R6-B Lead Scoring | `259dc88` | `docs/contracts/lead-scoring-contract.md`, `docs/contracts/lead-scoring-to-qualification-contract.md` |
| R6-F Lead Governance | `c4932c6` | `docs/contracts/lead-governance-operations-contract.md` |
| R5-D Opportunity (integrated base) | `a947ecb` | `docs/contracts/opportunity-candidate-contract.md`, `docs/contracts/opportunity-to-lead-autonomy-contract.md` |
| R5-E Policy (integrated base) | `a947ecb` | `docs/contracts/marketing-action-policy-contract.md` |

None of the A/B/F branches is merged. R6-C carries its own typed seam
modules (`api/lib/qualification/*-seam.ts`) that re-validate frozen contract
shapes at the C boundary. Runtime production binding is a guarded
information-schema bridge (F precedent); absent authority ⇒ fail closed.

## 2. Exact upstream fields from R6-A (identity → qualification)

Downstream projection (`LeadIdentityProjection`, consumed per handoff
contract §11/§13 — **all fields**):

- `leadId` (`lid1:` + 64 hex, opaque, immutable, server-minted only)
- `businessId` (`number | null`; null = tenant-unattributed scope)
- `leadIdentityVersion` (`"lead-identity/v1"`)
- `identityStatus` — closed: `active, anonymous, partially_identified, resolved, conflicting, suppressed, merged, archived`
- `identityConfidence` — closed ordinals: `unknown < low < medium < high`
- `primaryIdentityType` — closed: `provider_actor, email_hash, phone_hash, authenticated_customer_reference, crm_external_reference, anonymous_thread, unknown`
- `externalActorReferenceHash` (`string | null`, R5 actorKey hash-only)
- `provider` (`meta | linkedin | twitter | tiktok | null`)
- `sourceOpportunityId`, `sourceHandoffId` (`opp1:` / `oph1:` lineage)
- `canonicalLeadId` (`string | null`; follow when `merged`)
- `firstObservedAt`, `lastObservedAt` (ISO-8601 varchar(32))
- `provenance: [{ kind, handoffId?, opportunityId?, evidenceType?, occurredAt }]`

C-derived bindings: `identityReference = sha256(canonicalJson(projection))`
(content binding; any material identity change ⇒ new reference ⇒ new
qualification). Identity staleness limit mirrors A: `staleIdentityMs`
default 336h vs `lastObservedAt`.

Governance reads from A: `suppressed`/`archived`/`conflicting` identities are
non-actionable; `merged` resolves to canonical first. Identity status is
**never** a pipeline/qualification stage.

## 3. Exact upstream fields from R6-B (score → qualification)

`LeadScoreProjection` (B contract §16 — the only score surface C may read):

- `leadScoreId` (`lsc1:` + 64 hex), `evidenceSnapshotId` (`lss1:` + 64 hex)
- `scoreContractVersion` (`lead-scoring/v1`), `scoringVersion`
  (`lead-scoring-engine/v1`), `featureVersion` (`lead-scoring-features/v1`)
- `leadIdentityVersion` — `"lead-identity/v1"` **or**
  `"lead-identity-seam/v1:<64hex>"` (both valid until R6-X convergence;
  anything else ⇒ unknown version, fail closed)
- `userId`, `businessId`, `leadId`
- `evidenceSnapshotHash` (64 hex; tamper drift ⇒ `SCORING_EVIDENCE_TAMPERED`
  upstream; C re-binds its own `scoreContentHash`)
- `overallScore` int 0–100, `scoreBand` closed
  (`VERY_LOW [0,20) · LOW [20,40) · MEDIUM [40,60) · HIGH [60,80) · VERY_HIGH [80,100]`)
- `scoreConfidence` closed (`LOW | MEDIUM | HIGH | UNKNOWN`, ordinal
  `UNKNOWN < LOW < MEDIUM < HIGH`)
- Components `fitScore, intentScore, engagementScore, recencyScore,
  opportunityScore` (0–100) + `componentWeights`
- `reasonCodes` (closed vocabulary, ≤ 8) — includes
  `CONTRADICTING_EVIDENCE`, `UNRESOLVED_COMPLAINT_SIGNAL`,
  `MISSING_ENGAGEMENT_EVIDENCE`, `INSUFFICIENT_EVIDENCE`, …
- `evidenceFreshness: { latestObservedAt, computedAt }`
- `computedAt`, `createdAt`, `duplicateClassification`

C obligations from B contract: score is evidence, never a decision
(HIGH/VERY_HIGH ≠ qualified); freshness checked before use; no recompute, no
own weights; non-billable consumption; immutable rows.

## 4. Business-fit evidence already available (no fabrication)

- **B FIT features** (opportunity-type relevance, campaign alignment) —
  consumed via score component/reason codes only.
- **`businesses`** rows (industry, targetAudience, tone, location) — owned by
  business router; C reads only as ownership/evidence context if ever needed;
  no business-specific qualification rules exist in the repository.
- **`campaigns`** (goal, targetAudience, platforms, strategy) — context only.
- **`opportunity_candidates`** (type, confidenceClass, evidenceStrength,
  urgency) — lineage via identity `sourceOpportunityId`; read-only.

**Finding:** the repository contains **no business-specific qualification
criteria**. Per mission rule, C ships a conservative server-side default
policy and returns `INSUFFICIENT_EVIDENCE` / `REVIEW_REQUIRED` rather than
fabricating business criteria. Business-specific rules may only be added as
new versioned policy artefacts (code-level registry; no runtime mutation
endpoint).

## 5. Governance / privacy dependencies from R6-F

- `LEAD_PRIVACY_STATES` (closed): `ACTIVE, SUPPRESSED, RESTRICTED,
  RETENTION_PENDING, RETENTION_EXPIRED, ARCHIVED`.
- `leadPrivacyGateFor(state)` — single gate: `ACTIVE`/`RETENTION_PENDING` ⇒
  actionable; `SUPPRESSED`/`RESTRICTED` ⇒ not actionable
  (`PRIVACY_SUPPRESSED`); `RETENTION_EXPIRED`/`ARCHIVED` ⇒ not actionable
  (`RETENTION_EXPIRED`).
- Guarded information-schema bridge: privacy table absent ⇒ degrade
  honestly (default `ACTIVE` on reads; C mirrors the bridge pattern for its
  own authority tables).
- F blocker taxonomy reserves `QUALIFICATION_REQUIRES_REVIEW` /
  `QUALIFICATION_BLOCKED` (GOVERNANCE_APPROVAL recovery class,
  `systemRetryAllowed: false`), keyed on future `qualificationStatus`
  strings — C emits compatible decision strings for the future bridge.
- F9: no force-qualify endpoint anywhere; C introduces none.

## 6. Existing qualification-like logic (overlap scan)

- Legacy CRM `leads.status = "qualified"` (`api/lead-router.ts`) — CRM
  lifecycle, **untouched** by C; sole owner remains lead-router.
- Legacy `lead_scores` (audience-intelligence pipeline,
  `api/lib/audience/scoring.ts`) — separate vocabulary; untouched.
- R5-E `approval_requests` (`approvalType` incl. `marketing_action`) —
  marketing-action approval mechanism; C does **not** reuse it for
  qualification review (different authority; C owns its own durable review
  records). Read-only reference for binding/idempotency discipline.
- No existing `REVIEW_REQUIRED` / qualification engine anywhere in `api/`.

## 7. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Qualification authority | `api/lib/qualification/*`, `docs/contracts/lead-qualification-contract.md`, `docs/contracts/lead-qualification-to-nurture-handoff-contract.md` | R6-C owned |
| Router registry | `api/router.ts` | additive `qualification` registration only |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive `lead_qualification_*` values only |
| Schema / migrations | `db/schema.ts` (append-only), `db/migrations/` | provisional `0034_lead_qualification_autonomy` artefact only — NOT executed; R6-X owns canonical sequencing |
| Legacy lead/CRM | `api/lead-router.ts`, `leads`, `lead_activities` | untouched — sole CRM lifecycle owner |
| Identity / scoring / governance | `api/lib/lead-identity/*`, `api/lib/scoring/*`, `api/lib/governance/*` | A/B/F owned — read-only via seams |
| Policy / approvals / billing | `api/lib/policy/*`, `approval_requests`, billing libs | untouched — C never charges, never approves marketing actions |
| Opportunity / R5 tables | `api/lib/opportunity/*` | R5-D owned — read-only |

## 8. Schema implications

Two new R6-C-owned tables (provisional, artefacts only):

- `lead_qualifications` — immutable qualification decisions; exact-once
  convergence anchor `unique (userId, qualificationId)`; insert-only.
- `lead_qualification_reviews` — durable manual-review records bound to the
  exact decision (binding hash), CAS-guarded, one per decision.

No FK constraints (repo convention: enforcement in query predicates).
Provisional migration `0034_lead_qualification_autonomy.sql` +
`meta/0034_snapshot.json` + journal idx 34 (local parity only — A/B/F each
hold their own colliding provisional 0034; **R6-X owns convergence**; no
renumbering, no execution).

## 9. R6-D handoff requirements (C8 preview)

One safe projection only: `qualificationId, businessId, leadId, decision,
reasonCodes, scoreReference {leadScoreId, scoringVersion, scoreContentHash},
evidenceSnapshotReference {evidenceSnapshotHash}, qualificationPolicyVersion,
engineVersion, evaluatedAt, validUntil, review state, privacy state,
mayProgress + blocked reason`. No PII, no raw evidence, no model output.
Only `QUALIFIED` (or `REVIEW_REQUIRED` after governed review authorization)
may progress; D must not rewrite qualification authority. See
`docs/contracts/lead-qualification-to-nurture-handoff-contract.md`.

## 10. Security invariants inventory (carried into C1/C8)

Server-minted identities; strict schemas at every seam; tenant scoping from
`ctx.user.id` only; upstream payloads re-validated (shape, versions, hashes,
freshness) before use; closed vocabularies everywhere; no client-supplied
decision/policy/risk/actor; no model in the decision path (deterministic
rule-first engine); audit exactly once per durable effect; no outreach /
CRM / conversion / billing side effects. Acceptance suite: `api/r6-c-acceptance.test.ts`.
