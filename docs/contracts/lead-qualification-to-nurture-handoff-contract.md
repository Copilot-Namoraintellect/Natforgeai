# LEAD QUALIFICATION → NURTURE HANDOFF CONTRACT (WBS-R6-C → R6-D)

> **Producer:** R6-C (Lead Qualification), branch `feature/r6-c-lead-qualification`
> **Consumer:** R6-D (Nurture / Sales Handoff), later R6-F projection reads
> **Status:** canonical handoff contract — R6-D consumes, does not redefine
> **Implements:** `LEAD_QUALIFICATION_CONTRACT_VERSION = "lead-qualification/v1"`
> (decision authority: `docs/contracts/lead-qualification-contract.md`)
> **Upstream (frozen, consumed not merged):** R6-A identity
> (`ded8f2876e7c`), R6-B scoring (`259dc88`), R6-F governance (`c4932c6`)

This contract defines the single safe projection through which R6-D may
consume lead qualification. **Qualification authority lives only in R6-C.**
Nothing in this contract authorizes outreach execution, CRM mutation, sales
assignment, or conversion; those remain governed by R6-D's own authority,
R5-E policy, and R6-F privacy gates.

---

## 1. Qualification identity

`qualificationId = "lqu1:" + sha256(canonicalJson({contractVersion, userId,
businessId, leadId, leadIdentityVersion, identityReference, leadScoreId,
scoringVersion, scoreContentHash, qualificationPolicyVersion,
evidenceSnapshotHash, engineVersion}))` — deterministic, server-minted,
immutable, tenant-bound. R6-D treats it as an opaque immutable reference and
must never mint, repair, or re-derive it.

## 2. Lead identity dependency

`leadId` is the R6-A canonical identity id (`lid1:…`). Qualification already
resolved `merged` identity chains to canonical at evaluation time; R6-D must
not re-resolve or re-derive identity. Identity status is never a pipeline
stage.

## 3. Score dependency

`scoreReference { leadScoreId ("lsc1:…"), scoringVersion, scoreContentHash }`
is an opaque, immutable reference to one R6-B score. R6-D must not recompute
scores, reapply weights, or treat any score field as qualification. Stale or
tampered scores never produce progression: an expired (`validUntil` past) or
superseded qualification projects `mayProgress: false`.

## 4. Qualification policy version

`qualificationPolicyVersion` (e.g. `lead-qualification-policy/v1`) binds the
decision to the exact server-side rules that produced it. Policy is
versioned and immutable; R6-D must not interpret decisions across policy
versions as comparable.

## 5. Decision vocabulary (closed)

`QUALIFIED · NOT_QUALIFIED · REVIEW_REQUIRED · INSUFFICIENT_EVIDENCE ·
BLOCKED`. No sales states exist in qualification. Unknown values ⇒ R6-D must
fail closed (treat as not progressible), never guess.

## 6. Reason-code vocabulary (closed)

The 20 codes of `docs/contracts/lead-qualification-contract.md` §4, ≤ 8 per
record. Codes explain; they never authorize.

## 7. Evidence snapshot semantics

`evidenceSnapshotReference { evidenceSnapshotHash }` is a reference-only,
immutable binding to the deterministic evidence snapshot (closed categories,
closed labels, no PII, no raw text). R6-D must not request, reconstruct, or
"enrich" evidence through this surface; the snapshot content is R6-C
authority and is not part of the D projection.

## 8. Confidence semantics

`confidenceScore` (0..10000 integer = fraction × 10000) is deterministic
evidence-density metadata, not a probability. It is informational for R6-D
prioritization and authorizes nothing by itself.

## 9. Staleness rules

A qualification is progression-eligible only while: (a) it is the lead's
current (latest) decision; (b) `now ≤ validUntil`; (c) privacy is actionable
(§12). Otherwise `mayProgress: false` with `progressBlockedReason:
"STALE_DECISION"` or `"PRIVACY_BLOCKED"`.

## 10. Re-evaluation rules

New identity content, score content, evidence, or policy version produces a
new `qualificationId`; prior decisions remain immutable history. R6-D must
always consume the current decision via this projection and must never cache
or mutate prior decisions.

## 11. Manual-review semantics

`review: null | { reviewId, status, outcome, reviewedAt }`. `REVIEW_REQUIRED`
decisions carry a durable review record bound to the exact decision
(`decisionBindingHash` over decision + reason codes + identity reference +
score content hash + evidence snapshot hash + policy/engine versions).
Progression requires `status === "progress_authorized"` (governed human
resolution, tx-audited); `progression_rejected` permanently blocks that
decision's progression. R6-D must not implement review, must not auto-resolve
it, and must not accept review state from any non-R6-C surface.

## 12. Privacy / suppression semantics

`privacy: { state, actionable }` mirrors the R6-F gate
(`SUPPRESSED`/`RESTRICTED`/`RETENTION_EXPIRED`/`ARCHIVED` ⇒ not actionable).
`mayProgress` is always false when privacy is not actionable
(`progressBlockedReason: "PRIVACY_BLOCKED"`), regardless of decision or
review state.

## 13. Exact-once / replay semantics

One deterministic input set ⇒ one durable decision; replays converge
DB-authoritatively; replay conflicts fail closed (`QUALIFICATION_REPLAY_CONFLICT`).
R6-D reads are idempotent; D-side retries must key on `qualificationId` and
must not create second qualification records.

## 14. Immutable fields

Every field of the D projection is immutable. There is no update or delete
path. Corrections are new R6-C decisions (new `qualificationId`).

## 15. D-consumable fields (exact projection)

```
qualificationId, businessId, leadId, decision, reasonCodes,
scoreReference { leadScoreId, scoringVersion, scoreContentHash },
evidenceSnapshotReference { evidenceSnapshotHash },
qualificationPolicyVersion, engineVersion, evaluatedAt, validUntil,
review { reviewId, status, outcome, reviewedAt } | null,
privacy { state, actionable },
mayProgress, progressBlockedReason
```

Surface: `qualification.getHandoffProjection({ qualificationId })`
(tenant-scoped, authed). R6-X may additionally consume server-side via
`buildHandoffProjection` in `api/lib/qualification/qualification-handoff.ts`.

## 16. Fields D must not mutate

All of them. `lead_qualifications` / `lead_qualification_reviews` are not
shared-writable; R6-D writes nothing to R6-C tables. `decision`,
`reasonCodes`, `mayProgress` (derived), review state, and privacy state are
read-only downstream. Corrections are new R6-C records only.

## 17. Forbidden progression states

`NOT_QUALIFIED`, `BLOCKED`, `INSUFFICIENT_EVIDENCE` never progress
automatically (`mayProgress: false`, `DECISION_NOT_QUALIFIED`).
`REVIEW_REQUIRED` does not progress until governed review authorization
(`REVIEW_REQUIRED_PENDING` / `REVIEW_REJECTED` otherwise). Expired or
superseded decisions (`STALE_DECISION`) and non-actionable privacy
(`PRIVACY_BLOCKED`) never progress. Only a fresh, current, actionable
`QUALIFIED` (or `REVIEW_REQUIRED` with `progress_authorized` review)
projects `mayProgress: true` — and progression itself then remains subject
to R6-D/R5-E/R6-F governance.

## 18. Schema dependencies

`lead_qualifications`, `lead_qualification_reviews` — provisional migration
`0034_lead_qualification_autonomy` (artefacts only, NOT executed; R6-X owns
canonical sequencing). No FK constraints; enforcement in query predicates.

## 19. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Qualification authority | `api/lib/qualification/*` | R6-C owned |
| Handoff consumer | R6-D nurture/handoff modules | R6-D owned — reads §15 only |
| Router registry | `api/router.ts` | additive `qualification` registration only |
| Privacy gate | `api/lib/governance/lead-privacy-store.ts` (F) | F owned — read-only |
| CRM lifecycle | `api/lead-router.ts`, `leads` | untouched |
| Opportunity / R5 rows | `api/lib/opportunity/*` | read-only |

## 20. Security invariants

1. Tenant isolation: projection reads are owner-scoped (`userId` anchor);
forged/cross-tenant `qualificationId` ⇒ `QUALIFICATION_NOT_FOUND`.
2. No client-supplied authority: D inputs reference ids only; decisions,
reviews, and progression are never client/model-set.
3. Projection carries ids, hashes, closed labels, bounded enums, timestamps
— no PII, no social text, no raw evidence, no model reasoning.
4. Fail closed: unknown decision values, absent records, stale decisions,
and non-actionable privacy are not progressible — never guessed.
5. Exactly-once, replay-safe; immutable history; no destructive paths.
6. Cross-agent addendum: agents may propose; only server-side governed R6-C
code authorizes qualification. No agent output, upstream field, or injected
text can force `QUALIFIED`, forge review authorization, or lift privacy
blocks. Compromise of any single agent grants no qualification authority.

---

**R6-D: consume lead qualification exclusively through this projection.
Qualification is authority; a score is not. When in doubt, do not progress.**
