# CANONICAL EXPERIMENTATION CONTRACT (WBS-R7-D)

> **Stream:** WBS-R7-D — Experimentation Engine
> **Module authority:** `api/lib/experimentation/`
> **Router:** `api/experimentation-router.ts` (tRPC namespace `experimentation`)
> **Schema:** `experiments`, `experiment_lifecycle_events`,
> `experiment_assignments`, `experiment_outcome_evidence`, `experiment_results`
> (stream-local provisional migration `0035_r7_d_experimentation` — artefact
> only, **NOT executed**; see `docs/recovery/r7-d-unexecuted-migrations.md`;
> R7-X owns canonical R7 sequencing and collision resolution with the sibling
> provisional `0035_*` artefacts)
> **Upstream (frozen, consumed not merged):** R7-C Business Learning
> (`feature/r7-c-business-learning` @ `53b2ff4`) via
> `docs/contracts/business-learning-to-experiment-optimisation-contract.md`
> (projection `business-learning-to-experiment-optimisation/v1`); R7-A
> Conversion Outcome Intelligence (`feature/r7-a-conversion-outcome-intelligence`
> @ `3e8aea8`) via `conversion-outcome/v1`; R7-B Attribution Intelligence
> (`feature/r7-b-attribution-intelligence` @ `6ff9eca`) via
> `attribution-to-learning/v1`; R7-F Optimisation Governance
> (`feature/r7-f-optimisation-governance` @ `5e4ab95`) via
> `optimisation-governance/v1` — the sole governance authority.
> **Downstream:** R7-C learning handback + R7-E optimisation input via
> `docs/contracts/experiment-result-to-learning-optimisation-contract.md`.
> **Status:** authoritative as of the R7-D acceptance harness.

This contract defines the authoritative interpretation and persistence of
**governed experiments**: whether an R7-C learning hypothesis may be converted
into a governed experiment, and the safe, auditable management of that
experiment through design validation, governance binding, deterministic
assignment, lifecycle, evidence capture, and deterministic result calculation.

**Required principle:** *learning suggests what to test; it does not prove
causation.* Experimentation is the first R7 capability permitted to produce
**stronger causal evidence**, but only within explicit design limits and only
under R7-F governance clearance. No experiment may activate without a current
R7-F governance decision; assignment is deterministic; control/treatment are
immutable after activation; outcome evidence comes only from authoritative
R7-A/R7-B sources; no model mints a result; results preserve uncertainty and
limitations; no experiment directly alters global strategy or budget; unsafe
or invalid experiments fail closed. Every conclusion is bounded verbatim:
**"Within this governed experiment and its design assumptions…"**.

---

## 1. What this stream owns

Owns:

- Experiment identity (deterministic, tenant-anchored, §3)
- Hypothesis identity (deterministic, §3) and hypothesis↔learning binding
- Experiment design contract and design validation (§4, §5)
- Treatment/control identity and immutability after activation
- Assignment authority: deterministic, reproducible, tenant/business-scoped
  assignment logic and assignment persistence (§7)
- Experiment lifecycle: CAS-guarded immutable transitions, activation
  eligibility, stop conditions, observation window (§8)
- Experiment evidence capture: outcome/attribution binding to assignment and
  observation window (§9)
- Result calculation: deterministic, versioned, evidence-bounded (§10)
- Result confidence/evidence classification and limitations (§10)
- Experiment conclusion and immutable experiment history (§8, §11)
- Downstream result projections (read-only, §12)

Does **not** own: business-outcome truth (R7-A), attribution truth (R7-B),
business-learning truth (R7-C), governance policy or approval authority
(R7-F), global budget allocation or portfolio optimisation (R7-E), campaign
strategy authority, lead identity (R6-A), conversion identity (R6-E),
direct production rollout, provider/payment/billing execution, or
unrestricted causal claims outside the experiment design. R7-D never creates
or mutates learning records, outcomes, attributions, governance decisions,
approvals, campaigns, strategies, budgets, leads, conversions, or billing
rows.

---

## 2. Closed vocabularies

**EXPERIMENT_DESIGN_TYPES (2):**

| Type | Structure |
|---|---|
| `A_B` | exactly one `controlDefinition` + exactly one treatment |
| `MULTI_ARM` | exactly one `controlDefinition` + 2..4 treatments |

**EXPERIMENT_STATUSES (10):**

```
DRAFT   GOVERNANCE_REQUIRED   APPROVAL_REQUIRED   READY   ACTIVE
PAUSED   STOPPED   COMPLETED   INVALIDATED   CANCELLED
```

| Status | Meaning |
|---|---|
| `DRAFT` | Design created and validated; not yet submitted to governance |
| `GOVERNANCE_REQUIRED` | Submitted; awaiting/obtained R7-F `EXPERIMENT_CREATE` decision |
| `APPROVAL_REQUIRED` | R7-F returned `REVIEW_REQUIRED`; human approval bound before READY |
| `READY` | Governance clearance (ALLOW, or approval executable) obtained; eligible to activate |
| `ACTIVE` | Activated; observation window running; design immutable; assignments live |
| `PAUSED` | Observation suspended; reason required; assignments frozen |
| `STOPPED` | Stopped early by stop condition/operator; reason required; terminal-observation |
| `COMPLETED` | Observation window concluded and experiment closed; terminal |
| `INVALIDATED` | Discovered invalid/unsafe after the fact (tampered design, authority breach); history preserved; terminal |
| `CANCELLED` | Cancelled before/at governance (BLOCK) or pre-activation; terminal |

**EXPERIMENT_ARMS:** `CONTROL`, `TREATMENT` (assignment rows additionally
carry `armIndex`: control = 0, treatments = 1..n).

**EXPERIMENT_DIMENSIONS (9, mirrors R7-F `EXPERIMENT_DIMENSIONS`):**

```
channel   audience   creative   budget   schedule   placement   bidding   pricing   messaging
```

**PROTECTED_TRAIT_DIMENSIONS (10, mirrors R7-F `PROTECTED_TRAITS`):**

```
race   ethnicity   national_origin   religion   political_belief
health_condition   sexual_orientation   gender_identity   disability   financial_hardship
```

Any design dimension or declared touched trait in these lists is rejected
(`EXPERIMENT_PROTECTED_TRAIT_DIMENSION` / hard governance block). Dimensions
outside the closed `EXPERIMENT_DIMENSIONS` list are rejected
(`EXPERIMENT_UNSUPPORTED_DIMENSION`).

**EXPERIMENT_METRICS (closed primary/secondary metric vocabulary):**

```
CONVERSION_COUNT_PER_SUBJECT   OUTCOME_COUNT_PER_SUBJECT
REVENUE_MINOR_PER_SUBJECT      POSITIVE_OUTCOME_RATE
```

Each metric: `{ metric: EXPERIMENT_METRICS, direction: "HIGHER_IS_BETTER" | "LOWER_IS_BETTER" }`.

**GUARDRAIL_TYPES (closed):**

```
MINIMUM_SAMPLE_PER_ARM      BUDGET_CAP_MINOR
MAX_OBSERVATION_DURATION    STOP_ON_OUTCOME_REVERSAL
```

Guardrails are declared at design time as `{ guardrail, params? }` and
validated (closed set, param bounds). They narrow execution; they never
widen it.

**RESULT_VERDICTS (5):**

```
INSUFFICIENT_EVIDENCE   DIRECTIONAL_SIGNAL   SUPPORTED_DIFFERENCE
NO_MEANINGFUL_DIFFERENCE   INVALID_EXPERIMENT
```

**RESULT_CONFIDENCE_CLASSES (4):** `INSUFFICIENT_EVIDENCE | WEAK | MODERATE | STRONG`

**DUPLICATE_CLASSIFICATION:** `none | idempotent_replay`

**LIFECYCLE_EVENT_TYPES (closed):** `creation | governance | approval |
activation | pause | resume | stop | completion | invalidation | cancellation`

**SOURCE CONTRACT VERSIONS (closed):**

```
business-learning-to-experiment-optimisation/v1   conversion-outcome/v1
attribution-to-learning/v1                        optimisation-governance/v1
experimentation/v1                                 experiment-result/v1
```

---

## 3. Experiment & hypothesis identity (deterministic, server-minted)

```
designHash = sha256(canonicalJson({ v: 1, tenantUserId, businessId, designType,
    controlDefinition, treatmentDefinitions, allocationPolicy, primaryMetric,
    secondaryMetrics, guardrails, minimumSamplePerArm, durationDays }))

hypothesisKey = sha256(canonicalJson({ v: 1, tenantUserId, businessId, learningId,
    statement, designHash }))
hypothesisId  = "hyp1:" + hypothesisKey

experimentKey = sha256(canonicalJson({ v: 1, tenantUserId, businessId, learningId,
    hypothesisId, designHash }))
experimentId  = "exp1:" + experimentKey
```

- The tenant and business are bound **inside** every hash: identical design
  under a different tenant/business is a different identity — cross-tenant or
  cross-business correlation is impossible.
- Identity is a pure function of authoritative inputs: no wall-clock, no
  randomness. `createdAt` is provenance only and never participates in any
  hash.
- Same tenant + same learning + same hypothesis + same design ⇒ same
  experiment identity; retries/concurrent creations converge on the durable
  row (§11).
- **No client-selected experiment/hypothesis id exists.** Clients reference
  ids only; a client supplying `experimentId`/`hypothesisId`/`designHash`/
  `recordHash` or any authority field (status, arm assignment, result,
  verdict, confidence) is rejected (`EXPERIMENT_CLIENT_AUTHORITY_FIELD_FORBIDDEN`).

---

## 4. Experiment design contract

```ts
ExperimentDesign {
  designType: EXPERIMENT_DESIGN_TYPES;
  /** Closed experiment dimension being manipulated. */
  dimension: EXPERIMENT_DIMENSIONS;
  /** Control descriptor — inert, measurable, immutable after activation. */
  controlDefinition: { label: string; descriptor: Record<string, unknown>; };
  /** 1 (A_B) or 2..4 (MULTI_ARM) treatment descriptors, same shape. */
  treatmentDefinitions: { label: string; descriptor: Record<string, unknown>; }[];
  /** Per-arm allocation in integer basis points; must sum to exactly 10000. */
  allocationPolicy: { fractionsBps: number[] };
  primaryMetric: ExperimentMetric;
  secondaryMetrics: ExperimentMetric[];
  guardrails: { guardrail: GUARDRAIL_TYPES; params?: Record<string, number | string>; }[];
  /** Per-arm minimum assigned subjects before analysis may conclude support. */
  minimumSamplePerArm: number;
  /** Observation window length in whole days (1..90). */
  durationDays: number;
}
```

- Descriptors are opaque, bounded (≤ 4 KiB canonical JSON each), inert
  execution authority nothing: they describe what differs between arms; they
  are never executed by R7-D and never mutate campaigns/strategy/budget.
- Design validation (§5) rejects designs that cannot be measured safely.

## 5. Hypothesis & design validation (D2)

`create` accepts `{ learningId, statement, design, narrativeDraft? }` under
`z.strictObject`. Everything else is server-derived. Validation (fail closed):

1. `learningId` resolves through the R7-C seam to a frozen
   `business-learning-to-experiment-optimisation/v1` projection for the
   tenant; unknown → `EXPERIMENT_UNKNOWN_LEARNING`.
2. The learning's `businessId` must equal the design's business scope — the
   business is server-resolved from the learning, never client-selected;
   cross-business learning → `EXPERIMENT_CROSS_BUSINESS_LEARNING`.
3. Stale learning (`freshness.stale`) → `EXPERIMENT_STALE_LEARNING`.
4. Status gating: `SUPPORTED` learning may be tested. `CANDIDATE` learning is
   handled conservatively (allowed only as a `DRAFT` that governance will
   scrutinise; activation still requires R7-F). `CONTRADICTED` learning →
   `EXPERIMENT_LEARNING_CONTRADICTED`. `SUPERSEDED`/`DEPRECATED`/`INVALIDATED`
   → `EXPERIMENT_LEARNING_DEPRECATED`. Contradicted/deprecated learning is
   never silently testable.
5. `statement` (the hypothesis) is bounded (≤ 1024 chars), non-empty, and
   carries no authority claims. `narrativeDraft` (optional, ≤ 4096 chars) is
   model-assisted **non-authoritative text only**: stored in its own field,
   excluded from every identity/hash, rejected when it contains causal or
   authority claims (`EXPERIMENT_NARRATIVE_AUTHORITY_CLAIM`). No model may
   define hidden execution authority.
6. Design validation: dimension ∈ closed list
   (`EXPERIMENT_UNSUPPORTED_DIMENSION`); no protected-trait dimension
   (`EXPERIMENT_PROTECTED_TRAIT_DIMENSION`); design type structure (A_B = 1
   treatment, MULTI_ARM = 2..4); allocation fractions are positive integers
   summing to exactly 10000 with one fraction per arm
   (`EXPERIMENT_ALLOCATION_INVALID`); metric vocabulary closed;
   `minimumSamplePerArm` integer 1..1e6; `durationDays` integer 1..90;
   guardrails ∈ closed set with bounded params. Treatment/control
   descriptors must be measurable safely: non-empty, bounded, JSON-object
   descriptors (`EXPERIMENT_DESIGN_UNMEASURABLE`).
7. Unsupported experiment dimensions (any dimension not in the closed list,
   any protected trait) fail closed.

## 6. Governance & approval binding (D3)

R7-F is mandatory. Every experiment must obtain a current R7-F governance
decision for `EXPERIMENT_CREATE` before it can reach `READY`, and a fresh
`EXPERIMENT_ACTIVATE` evaluation immediately before activation.

- `submitGovernance` builds governance **proposal material only**
  (`{ proposalType: "EXPERIMENT_CREATE", experiment: { experimentKey,
  dimensions: [design.dimension], budgetMinor, durationDays,
  touchesProtectedTraits: [] }, ... }`) and calls the R7-F seam `evaluate`.
- The returned decision is consumed via the frozen governance seam shape.
  `ALLOW` → `READY` (when no approval required). `REVIEW_REQUIRED` →
  `APPROVAL_REQUIRED` with the approval request reference bound.
  `BLOCK` → `CANCELLED` (history preserved).
- `activate` re-evaluates governance (`EXPERIMENT_ACTIVATE`) immediately
  before the transition and calls the seam execution gate
  `assertOptimisationActionExecutable(decision, approval, currentPolicyVersion, now)`.
  A non-executable verdict fails closed (`EXPERIMENT_GOVERNANCE_DENIED`).
- Approval binding pins: business, experiment (`experimentId` +
  `designHash` via `proposalFingerprint` correlation), learning, exact
  hypothesis, exact treatment/control (all inside the proposal fingerprint),
  financial impact class, policy version, evidence snapshot, expiry.
- Rejected (fail closed): stale governance (`validUntil` passed /
  `STALE_POLICY_VERSION`), stale/expired approval, cross-experiment approval
  replay (approval binding's experiment/decision correlation mismatch →
  `EXPERIMENT_APPROVAL_REPLAY`), modified experiment after approval (design
  is immutable once approved; any material change is a new experiment →
  `EXPERIMENT_MODIFIED_AFTER_APPROVAL`), agent self-approval
  (`AGENT_SELF_APPROVAL_FORBIDDEN` from the seam), client-fabricated
  approval (client may reference an approval id only; the approval row +
  binding are loaded and re-verified server-side through the seam;
  `EXPERIMENT_FORGED_APPROVAL`).
- R7-D never evaluates governance itself and never mutates governance state.

## 7. Assignment authority (D4)

Assignment is deterministic, reproducible, tenant/business-scoped, stable per
subject, immutable during the active experiment, independent of model
opinion, and protected against reassignment gaming.

```
subjectKey = sha256(canonicalJson({ v: 1, tenantUserId, experimentId,
                                   normalize(subjectRef) }))     // never raw PII

bucket = int(sha256(canonicalJson({ v: 1, experimentId, assignmentVersion,
                                    subjectKey }))) mod 10000

armIndex = the unique i where cumulative(allocationPolicy.fractionsBps, i-1)
           <= bucket < cumulative(allocationPolicy.fractionsBps, i)
```

- `assignmentVersion` is pinned at activation and immutable thereafter — a
  policy/governance change can never silently reshuffle live assignments.
- The computed assignment is persisted insert-first
  (`UNIQUE(userId, experimentId, subjectKey)`); re-derivation must match the
  persisted row or fail closed (`EXPERIMENT_ASSIGNMENT_CONFLICT`). Same
  subject + same experiment → same assignment (idempotent replay); different
  experiments derive independent assignments (different `experimentId` salt).
- Assignment is available only while `ACTIVE`; paused/stopped/completed
  experiments do not assign (`EXPERIMENT_NOT_ACTIVE`).
- Sensitive/protected traits are never assignment inputs; the only input is
  the opaque `subjectRef` (e.g. an R6-A `lid1:` lead identity or an opaque
  business subject key), normalized + hashed server-side. No client-selected
  assignment authority: the client supplies `subjectRef` only; the arm is
  always server-derived.

## 8. Experiment lifecycle (D5)

Status is a CAS-guarded column (`version` optimistic concurrency);
transitions mint exactly one immutable `experiment_lifecycle_events` fact.
Rows are otherwise immutable; corrections are new history.

Closed transition graph (anything else fails closed
`EXPERIMENT_TRANSITION_INVALID`):

```
DRAFT ─submit→ GOVERNANCE_REQUIRED
GOVERNANCE_REQUIRED ─ALLOW→ READY
GOVERNANCE_REQUIRED ─REVIEW_REQUIRED→ APPROVAL_REQUIRED
GOVERNANCE_REQUIRED ─BLOCK→ CANCELLED
APPROVAL_REQUIRED ─approval executable→ READY
APPROVAL_REQUIRED ─rejected/expired→ CANCELLED
READY ─activate (governance revalidated + executable)→ ACTIVE
READY ─cancel→ CANCELLED
ACTIVE ─pause(reason)→ PAUSED
PAUSED ─resume (governance revalidated)→ ACTIVE
ACTIVE ─pause→ STOPPED?  no: ACTIVE ─stop(reason)→ STOPPED
PAUSED ─stop(reason)→ STOPPED
ACTIVE/PAUSED ─invalidate(reason)→ INVALIDATED
(any non-terminal) ─unsafe→ INVALIDATED
ACTIVE ─window concluded→ COMPLETED
STOPPED ─(analysis may run; terminal as lifecycle)→
```

- Activation only from `READY`; duplicate activation converges
  (`idempotent_replay`); conflicting transition fails closed on CAS.
- Control/treatment definitions are immutable once `ACTIVE` (in fact once
  approved); there is no design-mutation endpoint at all.
- `pause`/`stop`/`invalidate` require a bounded `reasonCode`.
- Observation window: at activation, `startAt = activation now`,
  `endAt = startAt + durationDays`; both immutable thereafter.
- `COMPLETED` requires the window to be concluded (`now >= endAt`) or an
  explicit governed early-stop already in `STOPPED`. A `COMPLETED`
  experiment can never silently reopen (terminal).
- An `INVALIDATED` experiment preserves full history (assignments, evidence,
  any result) — invalidation never deletes.

## 9. Observation & result evidence (D6)

Outcome evidence is accepted only from authoritative sources through the
frozen seams:

`bindOutcomeEvidence` accepts `{ experimentId, subjectRef, outcomeId,
attributionId? }` under `z.strictObject`. Validation (fail closed):

1. Experiment exists for the tenant and is in an evidence-accepting state
   (`ACTIVE`; `STOPPED`/`COMPLETED` accept late-arriving in-window evidence
   for analysis; `PAUSED` queues no new evidence — fail closed
   `EXPERIMENT_NOT_ACCEPTING_EVIDENCE`).
2. The subject has a persisted assignment for this experiment
   (`EXPERIMENT_SUBJECT_NOT_ASSIGNED`); the bound `arm` is the persisted arm
   — the client can never supply an arm.
3. `outcomeId` resolves through the R7-A seam to a frozen
   `conversion-outcome/v1` projection; unknown →
   `EXPERIMENT_UNKNOWN_OUTCOME`. The outcome's `businessId` must equal the
   experiment's business (`EXPERIMENT_CROSS_BUSINESS_OUTCOME`).
4. `occurredAt` must fall inside `[startAt, endAt]` — outcome before start or
   after end is excluded (`EXPERIMENT_OUTCOME_OUTSIDE_WINDOW`).
5. Where `attributionId` is supplied it must resolve through the R7-B seam
   (`EXPERIMENT_UNKNOWN_ATTRIBUTION`), reference the same outcome, share the
   business scope, and be current (non-superseded).
6. Duplicate binding of the same outcome for the same experiment converges
   (`UNIQUE(userId, experimentId, outcomeId)`;
   `EXPERIMENT_DUPLICATE_EVIDENCE` on conflicting material) — duplicate
   outcomes never inflate a result.
7. Reversed/cancelled/superseded outcomes (or reversal-type outcomes) are
   never counted as positive success; they are recorded with their lifecycle
   status and counted as negative evidence per the metric rules (§10).

No client-supplied metric values, no fabricated metrics, no client-supplied
final result (`EXPERIMENT_CLIENT_AUTHORITY_FIELD_FORBIDDEN`).

## 10. Result calculation (D7)

`analyze` is deterministic, versioned (`EXPERIMENT_RESULT_CALCULATION_VERSION
= "experiment-result/v1"`), and reproducible from durable rows + seam reads.
The same experiment + same calculation version + same evidence set converges
to one durable result (`UNIQUE(userId, experimentId, calculationVersion)` →
`idempotent_replay`); the same version with divergent material is
`EXPERIMENT_REPLAY_CONFLICT` (fail closed); a new calculation version mints a
new result row. Analysis requires the window to be closed (`now >= endAt`) or
the experiment `STOPPED`/`COMPLETED`.

Per arm, over bound in-window evidence:

```
subjects      = distinct assigned subjectKeys with >= 1 bound evidence row
evidenceCount = bound evidence rows for the arm
positiveCount = evidence rows whose outcome is a positive outcome type in a
                non-terminal, non-reversal state (VERIFIED/PROVISIONAL/OBSERVED)
reversalCount = evidence rows bound to REVERSED/CANCELLED outcomes or that
                are reversal-type outcomes           (negative evidence)
revenueMinor  = sum of amountMinor over monetary positive outcomes
                (reversals subtract; cancelled/superseded excluded)
metricValue   = per the primary metric:
                CONVERSION_COUNT_PER_SUBJECT → positiveCount / subjects
                OUTCOME_COUNT_PER_SUBJECT    → evidenceCount / subjects
                REVENUE_MINOR_PER_SUBJECT    → revenueMinor / subjects
                POSITIVE_OUTCOME_RATE        → positiveCount / evidenceCount
```

Classification (in order, deterministic):

1. Any arm `subjects < minimumSamplePerArm`, or total evidence 0 →
   `INSUFFICIENT_EVIDENCE` (confidence `INSUFFICIENT_EVIDENCE`). Insufficient
   evidence remains insufficient — never upgraded.
2. Experiment invalid (status `INVALIDATED`, or design authority breached) →
   `INVALID_EXPERIMENT`.
3. `meaningfulDiffBps` guardrail (default 0): if
   `|treatmentValue − controlValue|` below the guardrail threshold scaled to
   the control value → `NO_MEANINGFUL_DIFFERENCE`.
4. Else if every treatment arm's evidence count ≥ `minimumSamplePerArm` and
   ≥ 2 distinct subjects per arm → `SUPPORTED_DIFFERENCE` (confidence
   `MODERATE`/`STRONG` by per-arm subject counts: ≥ 2 subjects `MODERATE`,
   ≥ 10 `STRONG`).
5. Else → `DIRECTIONAL_SIGNAL` (confidence `WEAK`).

The result records: per-arm `subjects`/`evidenceCount`/`positiveCount`/
`reversalCount`/`revenueMinor`/`metricValue`; the control↔treatment
comparison; the verdict; the confidence class; the metric definitions; the
calculation version; and a `limitations` list (always populated, §14). The
conclusion is rendered from a bounded template — no model text, no causal
verb beyond the scoped claim: *"Within this governed experiment and its
design assumptions, the treatment arm(s) showed ⟨verdict⟩ on ⟨metric⟩
relative to control."* No arbitrary model-generated result exists.

## 11. Exact-once persistence and concurrency

Insert-first against durable unique anchors:

- `exp_experiment_id_uidx` — UNIQUE(`experimentId`)
- `exp_natural_key_uidx` — UNIQUE(`userId`,`learningId`,`hypothesisId`,`designHash`)
- `exl_event_id_uidx` — UNIQUE(`experimentLifecycleEventId`)
- `exa_assignment_uidx` — UNIQUE(`userId`,`experimentId`,`subjectKey`)
- `exe_evidence_uidx` — UNIQUE(`userId`,`experimentId`,`outcomeId`)
- `exr_result_uidx` — UNIQUE(`resultId`); `exr_natural_uidx` —
  UNIQUE(`userId`,`experimentId`,`calculationVersion`)

| Scenario | Result |
|---|---|
| Identical create replayed | `idempotent_replay`; one durable row; zero new audit events |
| Concurrent identical create | One insert wins; losers re-read via natural key → `idempotent_replay` |
| Same identity, different material | `EXPERIMENT_REPLAY_CONFLICT` — fail closed |
| Duplicate activation | converges (`idempotent_replay`) |
| Concurrent status transition | CAS on `version`; persistent staleness → `EXPERIMENT_STALE_STATE` |
| Record hash drift on any read | `EXPERIMENT_EVIDENCE_CONFLICT` — fail closed |
| Same subject re-assigned | persisted row replayed; divergent re-derivation → `EXPERIMENT_ASSIGNMENT_CONFLICT` |

## 12. Downstream result projections (read-only)

`EXPERIMENTATION_CONTRACT_VERSION = "experimentation/v1"`;
`EXPERIMENT_RESULT_PROJECTION_VERSION = "experiment-result-to-learning-optimisation/v1"`.

- **Result → learning/optimisation projection**
  (`buildResultHandoffProjection`) — the frozen read-only surface for R7-C
  and R7-E per
  `docs/contracts/experiment-result-to-learning-optimisation-contract.md`:
  experiment id, learning/hypothesis id, design summary, result status,
  control/treatment metrics, evidence counts, confidence/evidence class,
  limitations, governance references, freshness, result version.
  `causationClaimed` is `false` for learning-consumable fields; the
  scoped causal-evidence framing (§10) is carried only in
  `scopedCausalEvidence` with the verbatim design-assumptions bound.
- Downstream may consume and must never mutate. An experiment result does
  not itself authorize budget change; R7-E must revalidate through R7-F.
  An experiment result does not directly mutate learning; R7-C consumes it
  read-only under its own authority.

## 13. Canonical record shapes

```ts
ExperimentRow {                        // experiments
  id: number;                          // serial PK
  experimentId: string;                // varchar(69) — "exp1:"+64hex (§3)
  hypothesisId: string;                // varchar(69) — "hyp1:"+64hex (§3)
  userId: number;                      // bigint unsigned — tenant anchor
  businessId: number;                  // bigint unsigned — server-resolved from learning
  learningId: string;                  // varchar(69) — lrn1: reference (§5)
  statement: string;                   // varchar(1024) — bounded hypothesis
  designType: string;                  // varchar(16) — closed vocab §2
  dimension: string;                   // varchar(24) — closed vocab §2
  controlDefinition: unknown;          // json — inert descriptor (§4)
  treatmentDefinitions: unknown;       // json — inert descriptors (§4)
  allocationPolicy: unknown;           // json — fractionsBps (§4)
  primaryMetric: unknown;              // json (§2)
  secondaryMetrics: unknown;           // json (§2)
  guardrails: unknown;                 // json (§2)
  minimumSamplePerArm: number;         // int
  durationDays: number;                // int
  startAt: string | null;              // varchar(32) — set at activation (§8)
  endAt: string | null;                // varchar(32) — set at activation (§8)
  assignmentVersion: string | null;    // varchar(64) — pinned at activation (§7)
  status: string;                      // varchar(24) — closed vocab §2 (CAS-guarded)
  governanceDecisionId: string | null; // varchar(69) — ogd1: reference (§6)
  approvalReference: string | null;    // varchar(64) — approval request reference (§6)
  designHash: string;                  // varchar(64) — immutable design hash (§3)
  resultId: string | null;             // varchar(69) — "exr1:" once concluded (§10)
  recordHash: string;                  // varchar(64) — immutable-core sha256
  narrativeDraft: string | null;       // text — untrusted non-authoritative draft (§5)
  version: number;                     // int — optimistic CAS guard
  createdAt: Date;
}
```

Lifecycle, assignment, evidence and result rows are defined in
`db/schema.ts` (see the provisional migration). Lifecycle rows are immutable
with no update path; assignment and evidence rows are insert-only; result
rows are insert-only.

## 14. Limitations (always populated on every result)

- `"scoped_causal_evidence_only"` — the result is causal evidence only
  within this governed experiment and its design assumptions; it does not
  generalise outside the design, window, population or context;
- `"assignment_not_attribution"` — arm differences reflect deterministic
  assignment, not R7-B credit allocation;
- `"bounded_population"` — conclusions apply only to the assigned subject
  population and observation window;
- `"reversals_counted_negative"` — reversed/cancelled outcomes were counted
  as negative evidence, never positive success;
- `"no_business_outcome_authority"` — this stream does not assert business-
  outcome truth (R7-A) or attribution truth (R7-B);
- `"governance_bound"` — the result binds the exact governance decision and
  policy version; re-use under changed authority is invalid.

## 15. Security invariants (asserted by the acceptance suite)

1. Tenant isolation: session `userId` anchors every identity, predicate and
   hash; learning/outcome/attribution ownership re-verified from durable
   projections on every call.
2. Fail closed everywhere: unknown learning/outcome/attribution, cross-
   business evidence, stale/contradicted/deprecated learning, unsupported
   dimension, protected trait, unmeasurable design, invalid allocation,
   governance denial, forged/replayed/stale approval, modified-after-
   approval, invalid transition, stale CAS, hash drift, duplicate evidence.
3. Server-derived authority only: identity, status, arm, verdict, confidence,
   counts, hashes — no client-supplied authority field is accepted.
4. No fabricated results: result calculation is deterministic over durable
   evidence rows; no model is in the result path; uncertainty and limitations
   are preserved.
5. Rogue-agent containment: model/agent output (including `narrativeDraft`)
   is untrusted data reaching persistence only through the strict boundary;
   agents have no SQL/shell/secret access, cannot self-approve, cannot alter
   governance, and prompt-injected text cannot alter design, assignment, or
   results.
6. No upstream mutation: R6/R7-A/R7-B/R7-C/R7-F tables and authorities are
   read-only for this stream.
7. No downstream mutation: R7-C/R7-E projections are read-only; an experiment
   result never changes learning, strategy, budget, or campaign state.
8. Auditability: exactly one deterministic audit event per durable effect;
   convergence paths emit zero.

## 16. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Learning authority (R7-C) | `business_learning_records`, R7-C lib | seam only; never imported/merged |
| Outcome authority (R7-A) | `business_outcomes`, R7-A lib | seam only |
| Attribution authority (R7-B) | `attribution_results`, R7-B lib | seam only |
| Governance authority (R7-F) | `optimisation_governance_decisions`, R7-F lib | seam only |
| Schema | `db/schema.ts` | append-only (experiment tables) |
| Migrations | `db/migrations/` | append-only provisional `0035_r7_d_experimentation`; **NOT executed**; 0034 + sibling `0035_*` untouched |
| Router registry | `api/router.ts` | one additive `experimentation` registration |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive experiment event types only |
| Billing / payments (R4) | `api/lib/billing/*` | read-only — never charged, never invoked |

---

**R7-C / R7-E and all downstream consumers: consume experiment results
through `docs/contracts/experiment-result-to-learning-optimisation-contract.md`.
An experiment result is scoped causal evidence under governance — it does not
authorize budget change, does not mutate learning, and must not be read as
unrestricted causation. Do not redefine experiment authority.**
