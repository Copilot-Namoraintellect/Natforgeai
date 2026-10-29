# CANONICAL BUSINESS LEARNING CONTRACT (WBS-R7-C)

> **Stream:** WBS-R7-C — Business Learning Engine
> **Module authority:** `api/lib/business-learning/`
> **Router:** `api/business-learning-router.ts` (tRPC namespace `businessLearning`)
> **Schema:** `business_learning_records`, `business_learning_lifecycle_events`
> (stream-local provisional migration `0035_r7_c_business_learning_foundation` —
> artefact only, **NOT executed**; see
> `docs/recovery/r7-c-unexecuted-migrations.md`; R7-X owns canonical R7
> sequencing and collision resolution with the sibling provisional `0035_*`
> artefacts)
> **Upstream (frozen, consumed not merged):** R7-A Conversion Outcome
> Intelligence (`feature/r7-a-conversion-outcome-intelligence` @ `3e8aea8`) via
> `docs/contracts/conversion-outcome-to-attribution-learning-contract.md`
> (projection `conversion-outcome/v1`); R7-B Attribution Intelligence
> (`feature/r7-b-attribution-intelligence` @ `6ff9eca`) via
> `docs/contracts/attribution-to-business-learning-contract.md` (projection
> `attribution-to-learning/v1`); R6 Lead Autonomy V1 (`8030e97a…`); R4/R5
> provenance contracts
> **Downstream:** R7-D experimentation / R7-E optimisation via
> `docs/contracts/business-learning-to-experiment-optimisation-contract.md`;
> R7-F governance binding per §13
> **Status:** authoritative as of the R7-C acceptance harness

This contract defines the authoritative interpretation and persistence of
**business learning**: durable, reusable, evidence-bounded learning records
derived from governed R7-A business outcomes, R7-B attribution results, and
durable provenance. R7-A establishes what business outcome occurred; R7-B
establishes what journey activity is legitimately associated with it and how
credit was allocated; **R7-C turns those governed facts into learning** —
what appears to have worked or not worked, under what context, with what
outcome, with what attribution confidence, with how strong evidence, and
what must not be inferred.

**Required principle:** *learning is evidence, not authority. Attribution is
not causation.* A learning record never asserts that any campaign, channel,
creative, audience or journey element **caused** an outcome. One successful
outcome never automatically becomes a generalised business rule. Learning
preserves uncertainty; contradictory evidence is never silently averaged
away; model-generated narrative is never authoritative learning by itself.

---

## 1. What this stream owns

Owns:

- Learning identity (deterministic, tenant-anchored, §3)
- Evidence-bundle identity (deterministic, §4)
- Learning-candidate derivation (deterministic, rule-first, §5)
- Learning type/classification (closed vocabulary, §2)
- Subject and context-scope derivation (server-side only, §5–§6)
- Supporting/contradicting evidence accounting (§5, §8)
- Confidence/evidence classification (deterministic, §7)
- Novelty/repetition/contradiction classification against existing learning (§8)
- Learning lifecycle and supersession (append-only + CAS transitions, §9)
- Current learning projection and downstream experiment/optimisation
  projections (read-only, §11)
- Learning audit/provenance (§12)

Does **not** own: business outcome truth (R7-A), attribution truth or credit
allocation (R7-B), causal inference or causal proof (R7-D owns experimental
evidence; nobody else may mint it), experimentation execution (R7-D), budget
allocation or portfolio optimisation (R7-E), optimisation governance
authority (R7-F), campaign mutation, strategy mutation, lead identity
(R6-A), conversion identity (R6-E), scoring (R6-B), qualification (R6-C),
nurture/handoff (R6-D), privacy governance (R6-F), provider execution,
billing/payment. R7-C never creates or mutates leads, scores,
qualifications, nurture/handoff records, conversions, outcomes,
attributions, campaigns, strategies, budgets, experiments, or billing rows.

---

## 2. Closed vocabularies

**LEARNING_TYPES (9):**

```
PERFORMANCE_PATTERN   AUDIENCE_PATTERN   CHANNEL_PATTERN
CREATIVE_PATTERN      JOURNEY_PATTERN    TIMING_PATTERN
VALUE_PATTERN         NEGATIVE_PATTERN   INSUFFICIENT_EVIDENCE
```

| Type | Derived when (rule-first, §5) |
|---|---|
| `PERFORMANCE_PATTERN` | Primary credited subject is a `CAMPAIGN` touchpoint |
| `CHANNEL_PATTERN` | Primary credited subject is a `PUBLICATION` touchpoint or a channel-resolved campaign context |
| `JOURNEY_PATTERN` | Primary credited subject is `ENGAGEMENT`, `OPPORTUNITY`, `NURTURE_TOUCH` or `SALES_HANDOFF` |
| `VALUE_PATTERN` | Bundle mixes monetary outcome families across ≥2 distinct outcome types |
| `NEGATIVE_PATTERN` | Bundle's dominant outcome direction is negative (reversal-type outcomes or terminal `REVERSED`/`CANCELLED` outcomes) |
| `AUDIENCE_PATTERN` | Reserved: derivable only from lawful audience-segment evidence; default fail-closed (§6) |
| `CREATIVE_PATTERN` | Reserved: derivable only from creative-family provenance evidence; default fail-closed (§6) |
| `TIMING_PATTERN` | Reserved: derivable only from repeated time-clustered evidence; default fail-closed (§6) |
| `INSUFFICIENT_EVIDENCE` | No creditable subject could be derived, or all contributions are evidence-class `INSUFFICIENT_EVIDENCE` |

Reserved types exist in the closed vocabulary so derived records can name
them, but no derivation path fabricates their dimensions: they materialise
only when the required evidence exists, otherwise derivation fails closed
or lands `INSUFFICIENT_EVIDENCE`. **No client may supply a learning type.**

**LEARNING_SUBJECT_TYPES (8):** the R7-B touchpoint types, repository-native:

```
CAMPAIGN   PUBLICATION   ENGAGEMENT   OPPORTUNITY
NURTURE_TOUCH   SALES_HANDOFF   OUTCOME   INSUFFICIENT
```

`OUTCOME` is the degenerate subject when an outcome-attribution pair carries
no credited touchpoints (zero-credit / insufficient-evidence attribution);
`INSUFFICIENT` is the degenerate subject of an `INSUFFICIENT_EVIDENCE`
learning record.

**LEARNING_CONFIDENCE_CLASSES (4):** `INSUFFICIENT_EVIDENCE | WEAK | MODERATE | STRONG`

**LEARNING_EVIDENCE_CLASSES (4):** `VERIFIED | PROVISIONAL | MIXED | INSUFFICIENT` —
server-derived from the verification state of contributing outcomes and the
evidence classes of contributing attributions (§7).

**LEARNING_NOVELTY_CLASSES (5):**

```
NEW   REINFORCING   CONTRADICTING   DUPLICATE   SUPERSEDING
```

**LEARNING_STATUSES (6):**

```
CANDIDATE   SUPPORTED   CONTRADICTED   SUPERSEDED   DEPRECATED   INVALIDATED
```

| Status | Meaning |
|---|---|
| `CANDIDATE` | Derived learning awaiting sufficient independent support (confidence below the support threshold, or contradicting evidence present) |
| `SUPPORTED` | Server-derived: confidence `MODERATE`/`STRONG`, no unresolved contradiction, not provisional-capped |
| `CONTRADICTED` | Current projection of a record contradicted by newer retained evidence (§8); history preserved |
| `SUPERSEDED` | Replaced by a newer record via supersession (`supersedesLearningId` on the successor); history preserved |
| `DEPRECATED` | Governance/administrative deprecation (narrow governed path); not evidence-driven |
| `INVALIDATED` | Upstream authority change (outcome reversed/cancelled, attribution superseded, evidence tamper) destroyed the record's evidential basis; re-derived truth lives in a successor record |

**LEARNING_LIFECYCLE_TYPES (6):** `derivation | contradiction | supersession | invalidation | deprecation | reevaluation`

**LEARNING_DUPLICATE_CLASSIFICATION:** `none | idempotent_replay`

**LEARNING_DIRECTION:** `positive | negative | neutral` — deterministic from
outcome families: reversal outcome types (`REFUND`/`REVERSAL`/`CANCELLATION`)
and terminal `REVERSED`/`CANCELLED` outcomes are `negative`; positive outcome
types in non-terminal states are `positive`; otherwise `neutral`.

**SOURCE CONTRACT VERSIONS (closed):**

```
conversion-outcome/v1          attribution-to-learning/v1
attribution/v1                 conversion-outcome-to-attribution-learning/v1
business-learning/v1           (learning derivation engine version, §3)
```

**PROTECTED_TRAIT_DIMENSIONS (closed, default-reject):** personal or
sensitive trait labels (`race`, `ethnicity`, `religion`, `political`,
`health`, `sexual_orientation`, `biometric`, `genetic`, `age`, `gender`,
`disability`, …) are never optimisation-learning dimensions; any context
dimension key in this list — arriving from any source — fails closed
(`LEARNING_PROTECTED_TRAIT_DIMENSION`).

---

## 3. Learning identity (deterministic, server-derived, tenant-anchored)

```
upstreamStateFingerprint = sha256(canonicalJson(
    outcomeIds.map(o => ({ outcomeId: o.outcomeId, outcomeStatus: o.outcomeStatus }))
      .sort(byOutcomeId)))

evidenceBundleKey = sha256(canonicalJson({ v: 1, tenantUserId, businessId,
    outcomeIds: sorted, attributionIds: sorted, sourceVersions }))
evidenceBundleId  = "evb1:" + evidenceBundleKey

learningKey = sha256(canonicalJson({ v: 1, tenantUserId, businessId,
    learningType, subjectType, subjectId, outcomeTypeFamily,
    contextScope, evidenceBundleId, derivationVersion,
    upstreamStateFingerprint }))
learningId  = "lrn1:" + learningKey
```

- Same tenant + same business + same derived candidate + same authoritative
  evidence set + same upstream state → same learning identity. Retries and
  concurrent derivations converge on the durable row (§10).
- `upstreamStateFingerprint` binds the verification/lifecycle state of every
  contributing outcome at derivation time: an outcome verification
  transition (`PROVISIONAL` → `VERIFIED`) or terminal change mints a **new**
  learning identity rather than mutating history, so re-evaluation is new
  fact + supersession lineage, never silent edit (§9; cases 3, 22, 23).
  Attributions are consumed current-only (§5), so their immutable rows need
  no state term.
- The tenant and business are bound **inside** both hashes: identical
  upstream evidence under a different tenant or business is a different
  identity and a different evidence bundle — cross-tenant/cross-business
  correlation is impossible (acceptance cases 6–7).
- Identity is a pure function of authoritative inputs: no wall-clock, no
  randomness. `derivedAt` is recorded for provenance only and never
  participates in any identity or hash.
- Prefixes (`evb1:`, `lrn1:`, `lbf1:`) make identities self-describing in
  logs and handoffs.
- **No client-selected learning id exists.** Clients reference ids only; a
  client supplying `learningId`/`learningKey`/`evidenceBundleId`/`recordHash`
  or any authority field (confidence, evidence class, novelty class, status,
  support/contradiction counts) is rejected
  (`LEARNING_CLIENT_AUTHORITY_FIELD_FORBIDDEN`).

---

## 4. Evidence bundle

An evidence bundle binds the exact source authorities a learning record is
reproducible from:

```ts
LearningEvidenceBundle {
  evidenceBundleId: string;            // "evb1:" + sha256 (§3)
  userId: number;                      // tenant anchor
  businessId: number;                  // server-verified scope
  outcomeIds: string[];                // canonical out1: ids, sorted
  attributionIds: string[];            // canonical atr1: ids, sorted
  sourceVersions: Record<string, string>; // closed set (§2)
  outcomeFingerprints: string[];       // evidenceHash per outcome, sorted by outcomeId
  attributionFingerprints: string[];   // journeyHash per attribution, sorted by attributionId
                                        // (the integrity fingerprint exposed by the frozen
                                        // attribution-to-learning/v1 projection)
  bundleFingerprint: string;           // sha256 over the canonical bundle core
}
```

- Same authoritative evidence set → same `evidenceBundleId` (acceptance
  case 11). No raw evidence text, secrets or PII is hashed or persisted —
  only ids, closed labels and the upstream integrity hashes.
- The bundle is validated at intake (§5): every outcome and attribution must
  exist for the tenant, share one business scope, and each attribution must
  reference an outcome **in the bundle** (`LEARNING_ATTRIBUTION_OUTCOME_MISMATCH`).
- Reused bundle with divergent fingerprints is tampering
  (`LEARNING_EVIDENCE_BUNDLE_CONFLICT`).

---

## 5. Derivation (deterministic, rule-first)

`derive` accepts exactly `{ outcomeIds, attributionIds, narrativeDraft? }`
under `z.strictObject`. Everything else is server-derived.

**Intake validation (fail closed):**

1. Every `outcomeId` resolves through the R7-A seam to a frozen
   `conversion-outcome/v1` projection for the tenant; unknown →
   `LEARNING_UNKNOWN_OUTCOME` (case 4).
2. Every `attributionId` resolves through the R7-B seam to a frozen
   `attribution-to-learning/v1` projection for the tenant; unknown →
   `LEARNING_UNKNOWN_ATTRIBUTION` (case 5).
3. All outcomes and attributions must share one `businessId`
   (`LEARNING_CROSS_BUSINESS_EVIDENCE`, case 6). Tenant scope is enforced by
   the seams themselves (case 7).
4. Every attribution must bind an outcome present in the bundle
   (`LEARNING_ATTRIBUTION_OUTCOME_MISMATCH`, case 8) and must be **current**
   (non-superseded): `supersedesAttributionId` chains are walked to the
   current result (`LEARNING_STALE_ATTRIBUTION`, case 22).
5. Every consumed projection must carry a supported source contract version
   (`LEARNING_UNSUPPORTED_SOURCE_VERSION`, case 9).
6. Reversal outcome rows (types `REFUND`/`REVERSAL`/`CANCELLATION`) bind via
   `reversesOutcomeId` to a target **in the same bundle** when they are
   present; a dangling reversal reference fails closed
   (`LEARNING_DANGLING_REVERSAL`). Reversal rows never count as independent
   positive support.
7. Outcomes in terminal `REVERSED`/`CANCELLED`/`SUPERSEDED` states contribute
   to direction/contradiction, never to positive support (§7).

**Candidate generation (deterministic):**

For each **current** outcome-attribution pair, the credited touchpoints
(`creditBps > 0`) are ordered by `(creditBps desc, occurredAt asc, type asc,
sourceIdentity asc)`; the first is the **primary subject**. One candidate is
generated per distinct `(learningType, subjectType, subjectId,
outcomeTypeFamily, contextScope)` across the bundle:

- `learningType` from the primary touchpoint type / bundle shape via the
  closed derivation map (§2).
- `subjectType`/`subjectId` from the primary touchpoint (`sourceIdentity`
  verbatim; `OUTCOME`/`INSUFFICIENT` degenerates otherwise).
- `outcomeTypeFamily`: the sorted distinct set of contributing outcome
  types; a single type names itself, otherwise `MIXED`.
- `contextScope` (server-derived, §6).
- Each candidate carries its supporting pairs and any contradicting
  contributions (negative-direction pairs for positive candidates and vice
  versa).

**Statement structure (bounded, deterministic):**

```ts
LearningStatement {
  text: string;   // bounded template, e.g.
                  // "Subject <id> (<type>) is repeatedly associated with
                  //  outcome family <family> in scope business <id>; support
                  //  N outcome-attribution pair(s), contradiction(s) M;
                  //  attribution confidence <class>; this is association
                  //  evidence, not causation."
  templateVersion: string;   // "learning-statement/v1"
  variables: Record<string, string | number>;  // the exact bound values
}
```

The statement is rendered from bound variables only — no model text, no
client text. **No causal verb ever appears** (rendered from a closed
template; "is associated with" is the strongest verb).

**Optional LLM narrative (untrusted draft only):** `narrativeDraft` is an
optional client/agent-supplied draft string (≤ 4 096 chars). It is stored in
its own non-authoritative field, **excluded from every identity and hash**,
rejected when it contains causal/authority claims (`LEARNING_NARRATIVE_AUTHORITY_CLAIM`),
and surfaced only as a clearly-labelled draft. It can never add facts,
confidence, scope or causation (acceptance cases 27–29).

---

## 6. Context scope and generalisation boundaries

`contextScope` is derived **server-side only** and bounds where the learning
may legitimately apply:

```ts
LearningContextScope {
  businessId: number;             // server-verified, from the evidence
  campaignIds: number[];          // sorted set of credited CAMPAIGN touchpoint ids (resolved tenant-side)
  windowStart: string;            // earliest attribution windowStart, ISO 8601
  windowEnd: string;              // latest windowEnd (= latest outcome time)
  journeyStageTypes: string[];    // sorted credited touchpoint types
  outcomeTypes: string[];         // sorted contributing outcome types
  // reserved for lawful, evidenced dimensions only — never auto-populated:
  audienceSegment?: never; geography?: never; creativeFamily?: never; channel?: never;
}
```

- Learning never silently generalises: evidence from one campaign stays
  campaign-scoped (`campaignIds` names exactly the credited campaigns);
  evidence from one audience never becomes all-audience truth (no audience
  dimension is ever derived without governed evidence, case 25).
- Clients cannot supply, widen or override the scope
  (`LEARNING_CLIENT_AUTHORITY_FIELD_FORBIDDEN`, case 24): a client proposing
  a broader scope simply receives a record bounded to the evidenced scope.
- Protected/sensitive traits are never optimisation-learning dimensions;
  any protected-trait dimension arriving from any source fails closed
  (`LEARNING_PROTECTED_TRAIT_DIMENSION`, case 26).
- The scope participates in the identity hash (§3): widening evidenced scope
  is a new record, never a mutation.

---

## 7. Confidence and evidence classification (deterministic)

Derived from source evidence only — never from model opinion, never by
averaging attribution confidence without a defined rule:

```
supportCount        = number of distinct current outcome-attribution pairs
                      contributing positive-direction support, where the
                      outcome is non-terminal and non-reversal and the
                      attribution is non-superseded with totalCreditBps > 0
contradictionCount  = number of distinct current pairs contributing
                      opposite-direction evidence to the candidate's direction
attributionFloor    = min over contributing attributions of
                      confidenceRank(HIGH=3, MEDIUM=2, LOW=1, NONE=0)
verificationAll     = every contributing outcome is VERIFIED
verificationAnyProvisional = any contributing outcome is PROVISIONAL/OBSERVED
```

Closed classification rules (in order):

1. `supportCount == 0` or `attributionFloor == 0` → `INSUFFICIENT_EVIDENCE` / class `INSUFFICIENT`.
2. `contradictionCount > 0` → confidence drops one full class from the
   table below (floor `INSUFFICIENT_EVIDENCE`); the contradiction remains
   visible (cases 17–18).
3. Otherwise:

| supportCount | attributionFloor | confidence (verificationAll) | confidence (otherwise) |
|---|---|---|---|
| 1 | ≥2 | `WEAK` | `WEAK` |
| ≥2 | ≥2 | `MODERATE` | `WEAK` |
| ≥2 | 3 | `STRONG` | `MODERATE` |
| ≥3 | 3 | `STRONG` | `MODERATE` |

4. `verificationAnyProvisional` caps confidence at `MODERATE` and forces
   evidence class `PROVISIONAL` (provisional-derived learning stays labelled,
   per the R7-B handoff §4). Mixed verification → class `MIXED`.
5. A single outcome-attribution pair can never yield `STRONG` (case 15);
   multiple consistent pairs can strengthen (case 16).

Evidence class: `VERIFIED` (all outcomes VERIFIED and
attributionFloor ≥ 2), `PROVISIONAL` (provisional cap active),
`MIXED` (mixed verification), `INSUFFICIENT` (rule 1).

**Initial status (server-derived):** `SUPPORTED` iff confidence ∈
{`MODERATE`, `STRONG`} and `contradictionCount == 0`; otherwise `CANDIDATE`.
No client can mark a record `SUPPORTED`, raise confidence, or set
`STRONG` (case 30).

---

## 8. Novelty / repetition / contradiction (deterministic)

Each derived candidate is compared against **existing current learning** for
the same tenant with equal `(learningType, subjectType, subjectId)` and an
**equal-or-broader evidenced context** (same `businessId`; candidate
`campaignIds ⊆` existing `campaignIds` or equal sets):

- `DUPLICATE` — an existing record already binds the identical
  `evidenceBundleId`. The existing record is replayed (`idempotent_replay`);
  support counts are **never** incremented by repeated identical evidence
  (case 10, case 19).
- `REINFORCING` — existing current record, same direction, disjoint evidence
  bundle. The new record persists with its own support; the current
  projection aggregates support across the retained bundle history (case 20).
- `CONTRADICTING` — existing current record with **opposite direction**, or
  the bundle contributes opposite-direction evidence to the candidate. The
  new record persists with `noveltyClass = CONTRADICTING`; the contradicted
  current record CAS-transitions to `CONTRADICTED` with one immutable
  `contradiction` lifecycle fact (§9). Both histories remain fully readable;
  no contradiction is ever deleted or averaged away (cases 17–18, 31).
- `SUPERSEDING` — existing current record whose evidential basis changed
  upstream (a contributing attribution was superseded, or an outcome
  verification state changed) and the new bundle reflects the newer
  authority. The new record binds `supersedesLearningId`; the prior record
  CAS-transitions to `SUPERSEDED` with a `supersession` fact. History is
  preserved (case 21).
- `NEW` — no existing current record for the subject.

Contradiction history is append-only: later reinforcing evidence does not
erase an earlier contradiction; it creates a new record the current
projection resolves (§9).

---

## 9. Lifecycle, immutability, supersession

Learning rows are **immutable after acceptance** — the only mutable column
is the CAS-guarded `status` (optimistic concurrency on `version`). Truthful
change is new history:

- Derivation mints the record + one `derivation` lifecycle fact.
- Contradiction, supersession, invalidation, deprecation each CAS-transition
  the affected current record and mint exactly one immutable lifecycle fact
  (`contradiction` / `supersession` / `invalidation` / `deprecation`).
- **Upstream change re-evaluation** (`synchronize`): when an outcome becomes
  `REVERSED`/`CANCELLED`/`SUPERSEDED`, an outcome verification changes, or a
  contributing attribution is superseded, dependent learning is
  re-evaluated: records whose support basis is destroyed CAS-transition to
  `INVALIDATED` (fact: `invalidation` or `reevaluation`) and, where newer
  authority supports it, a successor record is derived (cases 3, 22, 23).
  No stale learning remains silently active.
- `DEPRECATED` is a narrow governed administrative transition only; it is
  never evidence-driven and never fabricates or hides evidence.

Current projection per `(userId, learningType, subjectType, subjectId)` =
the latest non-`SUPERSEDED`/non-`DEPRECATED` record, with contradictions
resolved to the newest direction-bearing record.

---

## 10. Exact-once persistence and concurrency

Insert-first against durable unique anchors:

- `blr_learning_id_uidx` — UNIQUE(`learningId`)
- `blr_natural_key_uidx` — UNIQUE(`userId`, `evidenceBundleId`, `learningType`, `subjectType`, `subjectId`, `upstreamStateFingerprint`) — the evidence bundle participates here (never as a standalone unique key: supersession successors legitimately share a bundle under a new upstream state)
- Lifecycle: `bll_event_id_uidx` — UNIQUE(`learningLifecycleEventId`)

| Scenario | Result |
|---|---|
| Identical derivation replayed | `idempotent_replay`; one durable row; zero new audit events |
| Concurrent identical derivation | One insert wins; losers re-read via natural key → `idempotent_replay` |
| Same identity, different material (tamper) | `LEARNING_REPLAY_CONFLICT` — fail closed |
| Same bundle, divergent fingerprints | `LEARNING_EVIDENCE_BUNDLE_CONFLICT` — fail closed |
| Record hash drift on any read | `LEARNING_EVIDENCE_CONFLICT` — fail closed |
| Concurrent status transition | CAS on `version`; bounded re-read/retry; persistent staleness → `LEARNING_STALE_STATE` |

All convergence is DB-authoritative. No in-memory dedupe. No client
idempotency identity. Rows are insert-only; corrections are new rows/facts.

---

## 11. Downstream projections (read-only)

`BUSINESS_LEARNING_CONTRACT_VERSION = "business-learning/v1"`.

- **Current learning projection** (`buildLearningProjection`) — the frozen
  record view; key allowlist asserted in acceptance.
- **Experiment/optimisation projection**
  (`buildExperimentOptimisationProjection`,
  `BUSINESS_LEARNING_TO_EXPERIMENT_CONTRACT_VERSION = "business-learning-to-experiment-optimisation/v1"`)
  — narrow read-only surface for R7-D/R7-E per
  `docs/contracts/business-learning-to-experiment-optimisation-contract.md`:
  learning id, business, type, subject/context, evidence/confidence class,
  support/contradiction counts, source outcome/attribution ids, limitations,
  freshness (`derivedAt`/`validUntil`/`status`), and governance-eligibility
  **metadata** (`stale`, `provisional`, `contradictionUnresolved`,
  `governanceAuthorityRequired: "R7-F"`). Downstream may consume and must
  never mutate (cases 35–36).
- Every projection carries, verbatim:

```
causationClaimed: false
causationDisclaimer: "Learning records are association evidence derived from
  governed outcomes and attributed journey activity. This projection does not
  assert that any subject caused any business outcome."
```

Learning does not authorize experiment execution (case 34). Learning does
not authorize budget change (case 33). R7-D/R7-E must separately obtain R7-F
governance authority before any material action (case 37; §13).

---

## 12. Provenance, audit, source versions

- `recordHash` = sha256 over the canonical immutable core (every material
  column of §14 except `id`/`createdAt`/`version`/`status`). Drift between a
  retained row and its hash is tampering and fails closed on every read
  (`LEARNING_EVIDENCE_CONFLICT`).
- `sourceVersions` records the consumed contract versions (§2) as served by
  the upstream projections.
- Exactly one `business_learning_recorded` audit event per inserted learning
  record (and one lifecycle-typed audit companion per status transition);
  convergence/replay paths emit zero events. Metadata carries ids, closed
  labels, classes and hashes only — never evidence text, narrative drafts,
  or PII.

---

## 13. R7-F governance binding

R7-F (`feature/r7-f-optimisation-governance` @ `5e4ab95`, consumed not
merged) is the sole optimisation governance authority. R7-C:

- is an **evidence operation** — learning creation, comparison, lifecycle
  and projection carry no governance decisions;
- exposes eligibility **metadata only** (`stale`, `provisional`,
  `contradictionUnresolved`) so R7-F policies can consider learning
  freshness; this metadata narrows nothing and widens nothing;
- never calls or embeds a governance engine; R7-D/R7-E must call R7-F
  (`evaluate` + `assertOptimisationActionExecutable`) before any material
  action. **Learning eligibility ≠ execution permission.**

---

## 14. Canonical record shape

Exactly `business_learning_records` (`db/schema.ts` →
`BusinessLearningRecordRow`):

```ts
BusinessLearningRecordRow {            // business_learning_records
  id: number;                          // serial PK
  learningId: string;                  // varchar(69) NOT NULL — "lrn1:"+64hex (§3)
  evidenceBundleId: string;            // varchar(69) NOT NULL — "evb1:"+64hex (§3/§4)
  userId: number;                      // bigint unsigned NOT NULL — tenant anchor
  businessId: number;                  // bigint unsigned NOT NULL — server-verified
  learningType: string;                // varchar(32) NOT NULL — closed vocab §2
  subjectType: string;                 // varchar(24) NOT NULL — closed vocab §2
  subjectId: string;                   // varchar(191) NOT NULL — verbatim upstream identity
  outcomeTypeFamily: string;           // varchar(64) NOT NULL — derived family / MIXED
  contextScope: unknown;               // json NOT NULL — server-derived (§6)
  statement: unknown;                  // json NOT NULL — bounded template render (§5)
  outcomeIds: unknown;                 // json NOT NULL — sorted out1: ids
  attributionIds: unknown;             // json NOT NULL — sorted atr1: ids
  upstreamStateFingerprint: string;    // varchar(64) NOT NULL — outcome state binding (§3)
  supportCount: number;                // int NOT NULL
  contradictionCount: number;          // int NOT NULL
  confidenceClass: string;             // varchar(24) NOT NULL — closed vocab §2
  evidenceClass: string;               // varchar(24) NOT NULL — closed vocab §2
  noveltyClass: string;                // varchar(24) NOT NULL — closed vocab §2
  status: string;                      // varchar(24) NOT NULL — closed vocab §2 (CAS-guarded)
  limitations: unknown;                // json NOT NULL — what must NOT be inferred (§15)
  sourceVersions: unknown;             // json NOT NULL — consumed contract versions
  narrativeDraft: string | null;       // text NULL — untrusted draft, non-authoritative (§5)
  validUntil: string | null;           // varchar(32) NULL — expiry where appropriate
  supersedesLearningId: string | null; // varchar(69) NULL — supersession lineage
  recordHash: string;                  // varchar(64) NOT NULL — immutable-core sha256 (§12)
  version: number;                     // int NOT NULL DEFAULT 1 — optimistic CAS guard
  derivedAt: string;                   // varchar(32) NOT NULL — provenance only
  createdAt: Date;                     // timestamp NOT NULL DEFAULT now()
}
```

```ts
BusinessLearningLifecycleEventRow {    // business_learning_lifecycle_events
  id: number;                          // serial PK
  learningLifecycleEventId: string;    // varchar(70) NOT NULL — "lbf1:"+64hex
  learningId: string;                  // varchar(69) NOT NULL
  userId: number;                      // bigint unsigned NOT NULL
  lifecycleType: string;               // varchar(24) NOT NULL — closed vocab §2
  status: string;                      // varchar(24) NOT NULL — target status
  reasonCode: string | null;           // varchar(64) NULL
  occurredAt: string;                  // varchar(32) NOT NULL — ISO 8601
  createdAt: Date;                     // timestamp NOT NULL DEFAULT now()
}
```

## 15. Limitations (always populated)

Every record's `limitations` list carries, at minimum:

- `"association_not_causation"` — attributed credit is association evidence;
- `"bounded_context"` — the learning applies only within `contextScope`;
  cross-context application requires new evidence;
- `"attribution_model_assumption"` — credit derives from the recorded
  `modelType`/`modelVersion` assumptions;
- `"provisional_cap"` (when evidence class is `PROVISIONAL`/`MIXED`) —
  provisional/observed outcome value must not be treated as verified;
- `"no_single_outcome_generalisation"` — a single outcome never generalises
  to a business rule.

---

## 16. Security invariants (asserted by the acceptance suite)

1. Tenant isolation: session `userId` anchors every identity, predicate and
   hash; business/outcome/attribution ownership re-verified from durable
   projections on every call.
2. Fail closed everywhere: unknown ids, cross-business evidence,
   attribution-outcome mismatch, stale/superseded attributions, unsupported
   source versions, dangling reversals, protected traits, identity conflict,
   bundle conflict, hash drift, stale CAS.
3. Server-derived authority only: type, subject, context, counts, classes,
   novelty, status, identities, hashes — no client-supplied authority field
   is accepted (`LEARNING_CLIENT_AUTHORITY_FIELD_FORBIDDEN`).
4. No causal authority: no code path converts credit, outcome value or
   narrative into a causal claim; every projection disclaims causation
   verbatim.
5. Rogue-agent containment: model/agent output (including `narrativeDraft`)
   is untrusted data and reaches persistence only through the strict
   boundary — never around it. Agents have no SQL/shell/secret access and
   cannot modify permissions; prompt-injected text cannot alter learning
   authority (cases 27–29).
6. No upstream mutation: R4/R5/R6/R7-A/R7-B tables and authorities are
   read-only for this stream.
7. No downstream mutation: R7-D/R7-E projections are read-only; learning
   never changes strategy, budget, campaign or experiment state (cases
   32–34).
8. Auditability: exactly one deterministic audit event per durable effect;
   convergence paths emit zero.

---

## 17. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Outcome authority (R7-A owned, frozen branch) | R7-A `api/lib/outcome/*` | consumed via seam only; never imported/merged |
| Attribution authority (R7-B owned, frozen branch) | R7-B `api/lib/attribution/*` | consumed via seam only; never imported/merged |
| Campaign learning authority (R4 owned) | `api/lib/learning/*`, `learning_records`, `learningRouter`, `learningPromotionRouter` | untouched — narrower campaign-level plane (see `docs/recovery/r7-c-business-learning-inventory.md` §2) |
| Governance authority (R7-F owned, frozen branch) | R7-F `api/lib/optimisation-governance/*` | never created/duplicated here |
| Schema | `db/schema.ts` | append-only (learning tables) |
| Migrations | `db/migrations/` | append-only provisional `0035_r7_c_business_learning_foundation`; **NOT executed**; 0034 and sibling `0035_*` untouched |
| Router registry | `api/router.ts` | one additive `businessLearning` registration |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive `business_learning_recorded` only |
| Billing / payments (R4) | `api/lib/billing/*` | read-only — never charged, never invoked |

---

**R7-D / R7-E and all downstream consumers: consume learning through
`docs/contracts/business-learning-to-experiment-optimisation-contract.md`.
Learning is evidence, not authority. Learning does not authorize experiment
execution or budget change. Do not redefine learning authority.**
