# CANONICAL LEAD QUALIFICATION CONTRACT (WBS-R6-C D1)

> **Stream:** WBS-R6 Stream C — Lead Qualification Autonomy
> **Module authority:** `api/lib/qualification/`
> **Schema:** `lead_qualifications`, `lead_qualification_reviews`
> (provisional migration `0034_lead_qualification_autonomy` — artefacts only,
> **NOT executed**; see `docs/recovery/r6-c-unexecuted-migrations.md`; R6-X
> owns canonical sequencing)
> **Upstream (frozen, consumed not merged):** R6-A lead identity
> (`ded8f2876e7c`) via `docs/contracts/lead-identity-to-scoring-qualification-contract.md`;
> R6-B lead scoring (`259dc88`) via `docs/contracts/lead-scoring-to-qualification-contract.md`;
> R6-F governance (`c4932c6`) via `docs/contracts/lead-governance-operations-contract.md`
> **Audience:** R6-D (nurture/sales handoff), R6-F (governance projection),
> R6-X integration
> **Status:** authoritative as of the R6-C acceptance harness; §10 human-review
> authentication and the §14.10 privacy chain hardened 2026-10-27 (blocker
> closures — see docs/recovery/r6-c-lead-qualification-acceptance-report.md)

This contract defines the single canonical lead-qualification model. R6-C
owns **qualification only**: evidence assembly, qualification rules (policy),
deterministic decision authority, confidence/reasoning metadata,
manual-review requirement, qualification lifecycle, exact-once persistence,
re-evaluation, and the downstream handoff projection. It does **not** own
identity resolution (R6-A), scoring (R6-B), outreach/nurture execution
(R6-D), CRM lifecycle (`api/lead-router.ts`), sales assignment, conversion
(R6-E), attribution, or campaign optimization.

**Required principle:** *score is evidence, not qualification.* No
qualification may be inferred from score alone, and no autonomous
qualification occurs unless identity is valid and current, score evidence is
valid and current where required, required business-fit evidence exists,
qualification rules authorize the outcome, privacy/suppression allows
evaluation, and governance does not block progression. Every material
decision is deterministic, reproducible from governed evidence + rules,
immutable, and audited.

---

## 1. Qualification identity

One deterministic input set → one durable qualification decision.

```
identityReference = sha256(canonicalJson(LeadIdentityProjection))     // C-derived content binding
scoreContentHash  = sha256(canonicalJson(LeadScoreProjection subset)) // C-derived content binding
evidenceSnapshotHash = sha256(canonicalJson(QualificationEvidenceSnapshot content))

qualificationId = "lqu1:" + sha256(canonicalJson({
  contractVersion, userId, businessId, leadId,
  leadIdentityVersion, identityReference,
  leadScoreId, scoringVersion, scoreContentHash,
  qualificationPolicyVersion, evidenceSnapshotHash, engineVersion }))
```

- `contractVersion = "lead-qualification/v1"` (immutable per record).
- `engineVersion = "lead-qualification-engine/v1"`.
- Server-minted only. Clients may reference, never mint or supply.
- Same inputs ⇒ same `qualificationId`; retries/concurrent duplicates
  converge DB-authoritatively (unique anchor, §11). Changed identity
  content, score content, evidence, or policy version ⇒ different id ⇒ new
  immutable decision row (§12).

## 2. Qualification record

```ts
LeadQualification {
  qualificationId: string;              // "lqu1:" + 64 hex
  contractVersion: "lead-qualification/v1";
  engineVersion: "lead-qualification-engine/v1";
  userId: number;                       // server-resolved tenant owner
  businessId: number | null;            // from identity scope; never fabricated
  leadId: string;                       // R6-A canonical identity id (opaque)
  leadIdentityVersion: string;          // "lead-identity/v1" | "lead-identity-seam/v1:<hash>"
  identityReference: string;            // 64 hex content binding (§1)
  leadScoreId: string;                  // R6-B score reference (opaque)
  scoringVersion: string;               // R6-B scoring version consumed
  scoreContentHash: string;             // 64 hex content binding (§1)
  qualificationPolicyVersion: string;   // e.g. "lead-qualification-policy/v1"
  evidenceSnapshotHash: string;         // 64 hex (§5)
  evidenceSnapshot: QualificationEvidenceSnapshot;  // persisted immutable
  decision: QualificationDecision;      // §3
  reasonCodes: string[];                // §4 closed vocabulary, ≤ 8
  confidenceScore: number;              // 0..10000 integer = fraction × 10000 (§7)
  reviewRequired: boolean;
  evaluatedAt: string;                  // ISO-8601 (explicit scoring clock)
  validUntil: string;                   // evaluatedAt + policy.validityMs
  createdAt: string;
}
```

No PII, no social text, no raw evidence payloads, no model reasoning — ids,
hashes, closed labels, bounded numbers, timestamps only.

## 3. Decision vocabulary (closed)

```
QUALIFIED · NOT_QUALIFIED · REVIEW_REQUIRED · INSUFFICIENT_EVIDENCE · BLOCKED
```

| Decision | Meaning |
|---|---|
| `QUALIFIED` | Sufficient, current evidence and policy authorization for downstream nurture/sales-handoff eligibility (subject to D/F governance). |
| `NOT_QUALIFIED` | Evidence is sufficient to decide and fails policy thresholds or hits a disqualifier. Immutable historical fact; re-evaluation requires new evidence/policy. |
| `REVIEW_REQUIRED` | Evidence ambiguous, conflicting, low-confidence, or policy-mandated review. Review is recorded against this decision; progression requires a new deterministic `QUALIFIED` decision (§10). |
| `INSUFFICIENT_EVIDENCE` | Required evidence categories missing/stale; qualification cannot be determined. Never inferred as qualified. |
| `BLOCKED` | Privacy/suppression, retention, or identity governance blocks evaluation or progression. Fail-closed outcome, not an error. |

There are **no sales states here** — no `sales_qualified`, no `contacted`,
no `converted`. Pipeline lifecycle remains with CRM (lead-router) and R6-D.

## 4. Reason-code vocabulary (closed, ≤ 8 per record)

```
IDENTITY_CURRENT, IDENTITY_NOT_ACTIONABLE, IDENTITY_CONFIDENCE_UNKNOWN,
PRIVACY_SUPPRESSED, RETENTION_EXPIRED,
FIT_EVIDENCE_PRESENT, MISSING_FIT_EVIDENCE,
INTENT_EVIDENCE_PRESENT, MISSING_INTENT_EVIDENCE,
RECENCY_WITHIN_POLICY,
SCORE_BAND_SUFFICIENT, SCORE_BELOW_THRESHOLD, LOW_SCORE_CONFIDENCE,
CONTRADICTING_EVIDENCE, DISQUALIFYING_EVIDENCE, INSUFFICIENT_EVIDENCE_DENSITY,
CONFIDENCE_SUFFICIENT, CONFIDENCE_BELOW_THRESHOLD,
REVIEW_TRIGGERED_BY_POLICY, POLICY_REQUIREMENTS_MET
```

Codes explain; they never authorize. Unknown codes are rejected at the
boundary.

## 5. Evidence snapshot semantics

Deterministic, immutable, reference-only. Categories (closed):

```
identity_validity · lead_score · business_fit · demonstrated_intent ·
engagement_evidence · recency · source_quality · opportunity_evidence ·
eligibility_restrictions · privacy_status
```

Entry status (closed): `present | missing | stale | contradicted | blocked |
not_required`. Entry `detail` is a bounded closed label (≤ 64 chars), never
free text. Snapshot content binds `identity`/`score`/`policy` references +
entries; hash recomputed and verified on every read (tamper ⇒ fail closed).

**Forbidden evidence:** race, ethnicity, religion, sex/gender, sexual
orientation, health status, political affiliation, disability,
socioeconomic class, income, age, zip code, nationality, and any
speculative demographic proxy. Such evidence is rejected at the boundary
(`FORBIDDEN_EVIDENCE`) and can never influence a decision.

## 6. Policy

Server-side, versioned, immutable per version. No model or client may alter
policy; there is no runtime mutation endpoint. New versions are new code-level
registry artefacts (`registerQualificationPolicy`, server-internal). Default
conservative policy (`lead-qualification-policy/v1`) defines: minimum score
band, minimum score confidence, fit/intent evidence thresholds, recency
limit, review triggers, disqualifying score reason codes, confidence
threshold, autonomy floor for identity confidence, validity window. Where a
business-specific rule does not exist, the default returns
`INSUFFICIENT_EVIDENCE`/`REVIEW_REQUIRED` — never fabricated criteria.

## 7. Confidence semantics

`confidenceScore` is a deterministic integer 0..10000 (fraction × 10000)
derived purely from evidence density: identity confidence ordinal, score
confidence ordinal, presence/staleness of required evidence categories.
**Not a probability, not model self-confidence, never client/model-set.**
`reviewRequired` is engine-derived (policy triggers, ambiguity,
confidence below policy floor); it is never accepted from clients.

## 8. Freshness / staleness

- Identity: `now − lastObservedAt > policy.staleIdentityMs` (default 336h,
  mirroring R6-A) ⇒ evaluation input rejected (`STALE_IDENTITY`).
- Score: `now − evidenceFreshness.latestObservedAt > policy.maximumEvidenceAgeMs`
  (default 336h) ⇒ rejected (`STALE_SCORE`).
- Decision validity: `validUntil = evaluatedAt + policy.validityMs`
  (default 168h). Expired decisions remain immutable history and are not
  progression-eligible.

## 9. Engine (deterministic, rule-first)

Pure function over validated inputs:
`evaluate({identity, score, policy, evidenceSnapshot, privacyGate, now}) →
{decision, reasonCodes, confidenceScore, reviewRequired, validUntil}`.
No model in the decision path; no AI-generated verdict. If AI is ever used
for bounded feature extraction it must be schema-validated, treated as
untrusted evidence, and the deterministic engine remains final authority.
Normative precedence (first match wins): `BLOCKED` (privacy gate not
actionable; identity status suppressed/archived/conflicting) →
`INSUFFICIENT_EVIDENCE` (required categories missing/stale) →
`NOT_QUALIFIED` (disqualifying evidence, then score below policy floor) →
`REVIEW_REQUIRED` (policy review triggers: contradicting evidence, unknown
score confidence, unknown identity confidence, confidence below floor) →
`QUALIFIED`.

## 10. Manual review

`REVIEW_REQUIRED` decisions may be reviewed through exactly one governed
mechanism: a durable `lead_qualification_reviews` record bound to the exact
decision via `decisionBindingHash = sha256(canonicalJson({qualificationId,
decision, reasonCodes, identityReference, scoreContentHash,
evidenceSnapshotHash, qualificationPolicyVersion, engineVersion}))`.
Resolution (`progress_authorized | progression_rejected`) requires:

1. **Independent human-review authentication.** The resolution must present
   the review-bound out-of-band challenge issued by
   `requestReviewResolution` — a single-use, expiring (10-minute), attempt-
   limited email OTP under the governed `review_authorization` challenge
   purpose — consisting of the challenge token stored on the review row plus
   the 6-digit code delivered only to the reviewer's mailbox. The server
   derives the reviewer identity from the consumed challenge (it must be the
   session's own tenant user); no client-supplied reviewer id, human flag,
   model output or session presence alone is accepted. A verified tenant
   session by itself can never resolve: runtime agents operate under the
   tenant's own JWT and cannot observe the emailed code. Resolution fails
   closed when the gateway is unconfigured, the token is not bound to this
   exact review, the challenge is invalid/expired/consumed, or the challenge
   belongs to a different actor.
2. The review exists and is `pending`; the actor is the owning tenant user
   or an admin (server-derived actor only); the bound qualification is still
   the lead's current decision (stale binding ⇒ rejected,
   `REVIEW_STALE_BINDING`); audit is tx-atomic with the CAS update.
   `requestReviewResolution` runs the same preconditions before a code is
   ever issued, so dead reviews can neither be authorized nor resolved.
   There is **no generic approve-lead endpoint**; review never mutates the
   immutable decision or grants downstream progression. Expired decisions
   and non-actionable privacy also reject resolution and reject
   authorization requests.

## 11. Exact-once / replay / immutability

- Convergence anchor: unique `(userId, qualificationId)`. Same inputs ⇒
  replay returns the existing decision (`duplicateClassification:
  "idempotent_replay"`). Concurrent duplicates converge by re-read. No
  in-memory dedupe.
- Snapshot assembly wall time is metadata, excluded from the evidence hash.
  Delayed retries preserve the first decision's timestamps and validity; they
  cannot renew eligibility by retrying. Freshness is checked again before replay.
- Replay verification: stored input bindings (identityReference,
  scoreContentHash, evidenceSnapshotHash, policy/engine versions) are
  re-verified on replay; drift ⇒ fail closed (`QUALIFICATION_REPLAY_CONFLICT`).
- All persisted fields immutable; no update/delete path. Corrections are new
  decisions. Review rows CAS-guarded (`version`), one review per decision
  (unique `(userId, qualificationId)`).
- Audit: exactly one `lead_qualification_evaluated` event per inserted
  decision; `lead_qualification_review_resolved` per review resolution;
  convergence paths emit zero events. Fingerprint-unique ledger.

## 12. Re-evaluation

New evidence snapshot, score content, identity content, or policy version ⇒
new deterministic qualificationId ⇒ new immutable row; prior rows remain
immutable history. `listHistory(leadId)` oldest-first. The current decision
is the latest row; progression checks reject stale (`validUntil` expired) or
superseded decisions. Nothing is silently mutated.

## 13. Downstream surface (summary; full contract in
`docs/contracts/lead-qualification-to-nurture-handoff-contract.md`)

One safe projection for R6-D: ids, decision, reason codes, references,
versions, timestamps, review state, privacy state, derived `mayProgress`.
`QUALIFIED` (fresh, actionable privacy) may progress automatically;
`REVIEW_REQUIRED` never progresses, including after review authorization;
`NOT_QUALIFIED` / `BLOCKED` / `INSUFFICIENT_EVIDENCE` never progress
automatically.

## 14. Security invariants (asserted by the R6-C acceptance suite)

1. Tenant isolation: `userId` anchors every record and query; cross-tenant /
   forged leads fail closed (`LEAD_NOT_FOUND`, indistinguishable).
2. Cross-business scope assertion mismatch ⇒ `OWNERSHIP_MISMATCH`.
3. No client-supplied evaluation authority: no decision, reason codes,
   confidence, policy content or actor is accepted. `resolveReview` accepts a
   bounded resolution request plus the review-bound human-review challenge,
   not an evaluation outcome. `z.strictObject` at the router; unknown fields
   rejected.
4. Upstream untrusted-data discipline: A/B/F payloads re-validated at the C
   seam (strict shape, closed vocabularies, version allow-list, hash
   recompute, freshness). Internal source ≠ trusted source.
5. Score ≠ qualification: no path maps score/band directly to `QUALIFIED`;
   required fit/intent evidence and policy authorization gate every outcome.
6. No protected/sensitive traits or speculative demographics anywhere in the
   pipeline (`FORBIDDEN_EVIDENCE` at the boundary).
7. Prompt-injection resistance: evidence is closed labels only; external or
   upstream text can never alter rules, decisions, or review outcomes.
8. Self-qualification prohibition: no agent/model/upstream field can mark a
   lead qualified; review actors are server-derived; decision outcomes are
   reproducible from evidence + rules alone.
9. Tool least privilege: no caller-controlled shell, SQL, provider or tool
   execution; only server-owned database reads/writes and audit persistence.
   No billing or outreach/CRM/conversion side effects. Host/runtime privilege
   isolation is not established by these API tests.
10. Privacy: suppression/restriction/expired retention ⇒ `BLOCKED` /
    not actionable; suppressed leads cannot progress. The R6-F state is read
    only through the authoritative chain — canonical R6-A identity (exact
    tenant/business ownership) ← validated R6-B score → score-authoritative
    legacy numeric `leads.id` → `lead_privacy_states` — never from a bare
    numeric id, client payload, model output or cached state; when the chain
    cannot be established (no numeric score key, unavailable table,
    cross-business privacy row) evaluation fails closed.
11. Fail closed on: missing/unknown policy version, unknown identity/score
    versions, tampered hashes, stale inputs, unavailable authority bridge,
    replay conflicts.
12. Audit exactly once per durable effect; tx-atomic with mutations; no
    secrets/PII in events or projections.

---

**R6-D/F/X: consume lead qualification through this contract and
`docs/contracts/lead-qualification-to-nurture-handoff-contract.md`. Do not
redefine qualification. A score is evidence; a decision is authority.**
