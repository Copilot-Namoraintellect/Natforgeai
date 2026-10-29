# EXPERIMENT RESULT → LEARNING / OPTIMISATION HANDOFF CONTRACT (R7-D → R7-C / R7-E)

> **Producer:** R7-D (Experimentation Engine) — `feature/r7-d-experimentation`
> **Consumers:** R7-C (Business Learning Engine), R7-E (Budget/Portfolio Optimisation)
> **Status:** canonical handoff contract — downstream consumes, does not redefine
> **Implements:** `EXPERIMENT_RESULT_PROJECTION_VERSION = "experiment-result-to-learning-optimisation/v1"`
> **Source of truth:** `docs/contracts/experimentation-contract.md`
> (R7-D canonical experimentation contract) +
> `api/lib/experimentation/experimentation-projection.ts`
> `buildResultHandoffProjection`
> **Upstream (frozen, consumed not merged):** R7-A (`3e8aea8`) via
> `conversion-outcome/v1`; R7-B (`6ff9eca`) via `attribution-to-learning/v1`;
> R7-C (`53b2ff4`) via `business-learning-to-experiment-optimisation/v1`;
> R7-F (`5e4ab95`) via `optimisation-governance/v1`.

This contract defines the frozen, read-only projection through which R7-C and
R7-E consume durable experiment results. R7-D determines whether a learning
hypothesis could be converted into a governed experiment and manages that
experiment through a safe, auditable lifecycle. **An experiment result is
scoped causal evidence under governance — it is not a general causal claim,
it does not authorize budget change, and it does not mutate learning.**

**An experiment result does not authorize budget change. R7-E must
revalidate through R7-F before any optimisation action. An experiment result
does not directly mutate learning; R7-C consumes it read-only under its own
authority.**

---

## 1. Experiment / result identity

- `experimentId` — `"exp1:" + sha256(canonicalJson({ v: 1, tenantUserId,
  businessId, learningId, hypothesisId, designHash }))`, server-minted only
  (R7-D contract §3).
- `hypothesisId` — `"hyp1:" + sha256(...)` (R7-D contract §3).
- `resultId` — `"exr1:" + sha256(canonicalJson({ v: 1, experimentId,
  calculationVersion, evidenceFingerprint }))` (R7-D contract §10).
- Downstream must treat all three as **opaque, immutable references**: no
  re-derivation, no parsing, no construction of new identities from their
  parts. Deduplicate and join on them verbatim.

## 2. Consuming surface

R7-C/R7-E consume **only** through the tenant-scoped tRPC procedures
`experimentation.getResultHandoffProjection` /
`experimentation.listResultHandoffProjections` (or the pure projection builder
`buildResultHandoffProjection` at integration time). No other R7-D surface is
downstream-consumable, and downstream must never read R7-D tables directly.

## 3. Projection field allowlist

Exact top-level key allowlist from `RESULT_HANDOFF_PROJECTION_KEYS` (19 keys —
asserted exact in acceptance):

| Key | Type | Semantics |
|---|---|---|
| `contractVersion` | `"experiment-result-to-learning-optimisation/v1"` | Frozen projection version |
| `experimentId` | `string` | Opaque canonical experiment identity (§1) |
| `hypothesisId` | `string` | Opaque canonical hypothesis identity (§1) |
| `learningId` | `string` | Opaque `lrn1:` learning reference the experiment tested |
| `businessId` | `number` | Owning business (server-verified) |
| `design` | `object` | Bounded design summary: `designType`, `dimension`, `primaryMetric`, `controlDefinition`, `treatmentDefinitions`, `allocationPolicy` |
| `resultStatus` | `string` | `RESULT_VERDICTS` value, or `NO_RESULT` when not yet analyzed |
| `controlMetrics` | `object \| null` | Per-arm control summary (subjects/evidence/positive/reversal/revenue/metricValue) |
| `treatmentMetrics` | `object[]` | Per-arm treatment summaries (same shape) |
| `evidenceCount` | `number` | Total bound in-window evidence rows |
| `confidenceClass` | `string` | `INSUFFICIENT_EVIDENCE \| WEAK \| MODERATE \| STRONG` |
| `limitations` | `string[]` | What must NOT be inferred (R7-D contract §14) |
| `governanceReferences` | `object` | `governanceDecisionId`, `approvalReference`, `policyVersion` |
| `freshness` | `object` | `resultCalculatedAt`, `experimentStatus`, `terminal` |
| `resultVersion` | `string` | Opaque `exr1:` result identity (`""` when none) |
| `calculationVersion` | `string` | Versioned calculation method (`experiment-result/v1`) |
| `conclusion` | `string` | Bounded conclusion render (scoped causal framing only) |
| `scopedCausalEvidence` | `object` | `{ claim, withinDesignAssumptions: true }` — the verbatim scoped-evidence framing |
| `causationClaimed` | `false` | Always false (§5) |

Deliberately absent (downstream must derive or own itself): budget deltas,
portfolio weights, ROI, global strategy implications, unrestricted causal
claims. Deriving these from result fields alone would restate the causation
this contract forbids.

## 4. Verdict semantics downstream must honour

- `SUPPORTED_DIFFERENCE` / `DIRECTIONAL_SIGNAL` — scoped causal evidence that
  the treatment differed from control **within this governed experiment and
  its design assumptions**; the design, population, window and governance
  bound recorded in the projection bound any reuse.
- `NO_MEANINGFUL_DIFFERENCE` — the observed difference did not meet the
  meaningful-difference threshold; this is evidence of no detected effect,
  never proof of no effect.
- `INSUFFICIENT_EVIDENCE` — remains insufficient; downstream must never
  upgrade it.
- `INVALID_EXPERIMENT` — the experiment was invalidated; history is
  preserved and nothing may be concluded.

## 5. Causation framing (verbatim on every projection)

```
causationClaimed: false
scopedCausalEvidence: {
  claim: "Within this governed experiment and its design assumptions, the
    recorded arm difference is experimental causal evidence. It does not
    generalise beyond the design, population, window and governance bound
    recorded here.",
  withinDesignAssumptions: true
}
```

**Association ≠ contribution ≠ allocated credit ≠ causal evidence.** An
experiment result is the first R7 capability permitted to produce *stronger*
causal evidence, but only within explicit design limits. Any downstream
output that traces back to a result must retain and surface this framing.
Causal claims beyond the design are never authorized by this projection.

## 6. Mutability

**All projected fields are read-only for R7-C/R7-E.** R7-D durable rows are
immutable (append-only lifecycle; insert-only assignments/evidence/results).
Downstream must not rewrite experiment authority, must not "fix" verdicts,
counts, metrics or limitations, and must not delete inconvenient results.
Corrections or derived state live in downstream-owned tables keyed by these
identity references (no FKs, house convention).

## 7. Governance revalidation duty

- An experiment result **never authorizes a budget change.** R7-E must
  obtain a fresh R7-F governance decision
  (`evaluate` + `assertOptimisationActionExecutable`) before any material
  optimisation action; a favourable result is evidence in a proposal, not
  permission.
- R7-D consumed R7-F authority at creation and activation; the governance
  references in this projection bind the exact decision ids for audit.
  Downstream must not treat stale governance references as current authority.

## 8. Privacy

- The projection carries **no PII**: assignment subjects appear only as
  server-hashed opaque `subjectKey` values inside R7-D storage and are never
  projected; no name, email, phone or company field exists anywhere in the
  projection.
- **No `userId` exposure:** the tenant id is internal to R7-D storage and
  never appears in the projection; downstream consumes within tenant scope
  through the tenant-scoped procedures only.
- Downstream inherits the minimization duty and must honour R6-F privacy
  states as stop signals for any action touching a lead.

## 9. Exact-once / replay semantics

- Result calculation is insert-first against durable unique anchors
  (`exr_result_uidx`, `exr_natural_uidx`): replays and concurrent analyses
  converge to one durable row surfaced as `duplicateClassification:
  "none" | "idempotent_replay"`.
- Projections are pure functions of the durable experiment + result rows, so
  re-reading is inherently replay-safe. Downstream must key idempotency on
  `resultId`; there is no client idempotency identity.

## 10. Security invariants

1. Downstream must consume results only through the tenant-scoped procedures
   and must revalidate tenant scope on every query.
2. Downstream must not present a result as an unrestricted causal claim (§5).
3. Downstream must not promote `INSUFFICIENT_EVIDENCE` or `INVALID_EXPERIMENT`
   results as support.
4. Downstream must not mutate projected fields or durable rows (§6).
5. Downstream must obtain fresh R7-F governance authority before any
   material action; experiment results are never sufficient authority (§7).

---

**R7-C / R7-E: consume experiment results through this contract. An
experiment result is scoped causal evidence under governance — it does not
authorize budget change, does not mutate learning, and must not be read as
unrestricted causation. Do not redefine experiment authority.**
