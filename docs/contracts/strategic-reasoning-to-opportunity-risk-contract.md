# STRATEGIC REASONING → OPPORTUNITY / RISK CONTRACT (R8-D → R8-E)

> **Producer:** R8-D Strategic Reasoning (`feature/r8-d-strategic-reasoning`)
> **Consumer:** R8-E Strategic Opportunity / Risk Intelligence (and any later
> strategic consumer, read-only)
> **Status:** canonical downstream contract — consumers read, never redefine
> or mutate
> **Projection version:** `strategic-reasoning-to-opportunity-risk/v1`
> **Source of truth:** `docs/contracts/strategic-reasoning-contract.md` (R8-D
> canonical) + `api/lib/strategic-reasoning/strategic-reasoning-projection.ts`
> (`STRATEGIC_REASONING_PROJECTION_FIELD_KEYS` — asserted exact in acceptance)
> **Upstream (frozen, consumed not merged):** R8-A (`23d0f22`), R8-B
> (`055eece`), R8-C (`b366c5e`), R8-F (`44118e3`), R7 (`a2c084a`) via the
> frozen upstream contracts.

---

## 1. Purpose and boundaries

R8-D owns strategic-reasoning records and strategic conclusions. This
contract is the **only** surface through which R8-E consumes them.
Downstream may read and must never mutate: no R8-E call may write
`strategic_reasoning_bundles`, `strategic_reasoning_records`,
`strategic_reasoning_lifecycle_events`, or any upstream authority table, and
no consumer may mint reasoning identities, hypotheses, implications,
confidence classes, uncertainty classes, statuses or governance bindings.

**A strategic conclusion is a governed recommendation candidate, not an
opportunity/risk verdict and never an instruction.** R8-E may rank,
classify, cluster and prioritize opportunities and risks from these
projections; R8-E owns those verdicts on its own authority. No projected
field authorizes spend, campaigns, strategy changes, Business DNA changes,
mission creation, or any execution.

## 2. Consuming surface

Consumers read **only** through the tenant-scoped tRPC procedures on the
`strategicReasoning` router:

| Procedure | Read model |
|---|---|
| `strategicReasoning.getHandoffProjections` | Current-state conclusion projection list for a business (`includeNonActive: true` exposes labelled non-active conclusions) |
| `strategicReasoning.get` | One reasoning record + lifecycle + projection (contradiction visibility included) |
| `strategicReasoning.list` | Filtered rows + projections (status labelled) |
| `strategicReasoning.listLifecycle` | Immutable `srl1:` history of one record |

The pure projection builder `buildStrategicReasoningProjection`
(`api/lib/strategic-reasoning/strategic-reasoning-projection.ts`) is the
frozen builder; consumers at integration time may rebuild projections from
durable rows but must never extend the key allowlist.

## 3. Projection field allowlist (exact, 34 keys)

| Key | Type | Semantics |
|---|---|---|
| `contractVersion` | `"strategic-reasoning-to-opportunity-risk/v1"` | Frozen projection version |
| `reasoningId` | `rsn1:…` | Opaque canonical identity — reference verbatim, never parse or reconstruct |
| `businessId` | `number` | Owning business (server-verified) |
| `evidenceBundleId` | `evb1:…` | Exact bound evidence set |
| `hypothesisId` | `hyp1:…` | Deterministic hypothesis identity |
| `hypothesisType` | closed enum | §3.1 of the canonical contract |
| `implicationType` | closed enum | Attention verb only — never execution |
| `supportingEvidence` | `{ref, evidenceClass, role}[]` | `INTERNAL_MEMORY \| INTERNAL_CHANGE \| EXTERNAL_SIGNAL`; role ∈ `ANCHOR \| SUPPORT \| CONTEXT` |
| `contradictingEvidence` | `{ref, evidenceClass}[]` | Preserved verbatim — conflict stays visible |
| `missingEvidence` | closed enum[] | Explicit unknowns |
| `confidenceClass` | `INSUFFICIENT \| LOW \| MODERATE \| HIGH` | Evidence-derived; never promotable downstream |
| `uncertaintyClasses` | closed enum[] | Bounded (≤6) |
| `strategicRiskClass` | `LOW \| MEDIUM \| HIGH \| CRITICAL` | Carried verbatim from the bound R8-F decision |
| `status` | closed enum | `CANDIDATE \| SUPPORTED \| REVIEW_REQUIRED \| APPROVED_RECOMMENDATION \| BLOCKED \| SUPERSEDED \| CONTRADICTED \| STALE \| INVALIDATED` |
| `governanceDecisionId` | `sgd1:… \| null` | Bound R8-F decision |
| `governanceDecision` | `ALLOW_RECOMMENDATION \| REVIEW_REQUIRED \| BLOCK \| null` | Verbatim decision label |
| `approvalStatus` | `pending \| approved \| rejected \| none` | Derived read-only view of the governed ledger |
| `policyVersion` | `string` | Frozen R8-F policy artefact |
| `freshness` | `current \| stale` | Computed at read from `validUntil` + evidence freshness — never stored |
| `limitations` | `string[]` (≤8) | Preserved verbatim |
| `sourceVersions` | `{strategicMemory?, businessChange?, externalSignal?, strategicGovernance?}` | Frozen upstream contract versions bound at evaluation |
| `validUntil` | ISO 8601 \| null | Conclusion validity window |
| `supersedesReasoningId` | `rsn1:… \| null` | Exact predecessor (history preserved) |
| `createdAt` | ISO 8601 | Persistence timestamp |
| `causationClaimed` | `false` | Always false |
| `causationDisclaimer` | `string` | Verbatim disclaimer (§4) |
| `attributionClaimed` | `false` | Always false |
| `attributionDisclaimer` | `string` | Verbatim disclaimer (§4) |
| `executionClaimed` | `false` | Always false |
| `executionDisclaimer` | `string` | Verbatim disclaimer (§4) |

Deliberately absent (downstream must derive or own): opportunity/risk
ranking, causal lift, ROI forecasts, strategy-mutation authority, budget
authority, execution flags, model reasoning, raw evidence text or external
content.

## 4. Verbatim disclaimers (on every projection)

```
causationClaimed: false
causationDisclaimer: "A strategic conclusion is evidence-preserving synthesis,
  not causal proof. This projection does not assert that any marketing
  activity, attribution credit, optimisation, market event or source claim
  caused any business outcome."
attributionClaimed: false
attributionDisclaimer: "Attribution-derived evidence is association evidence,
  not causal proof. Credit allocation and channel weights remain R7-B
  derivations on their own authority."
executionClaimed: false
executionDisclaimer: "A strategic conclusion recommends attention only. It is
  never an instruction to execute: no campaign, strategy, budget, Business
  DNA, provider, payment, billing or mission state may be mutated from this
  projection."
```

**Association ≠ corroboration ≠ truth ≠ causal evidence ≠ execution
authority.**

## 5. Current-state semantics downstream must honour

- `getHandoffProjections` returns **only voiceable/current conclusions**
  (`SUPPORTED`, `APPROVED_RECOMMENDATION`, and open `REVIEW_REQUIRED`) as
  active. Non-active records (`BLOCKED`, `SUPERSEDED`, `CONTRADICTED`,
  `STALE`, `INVALIDATED`, `CANDIDATE`) appear only with
  `includeNonActive: true`, always status-labelled — never silently active.
- A `SUPERSEDED` record's successor is bound by `supersedesReasoningId`;
  both remain queryable forever.
- A `CONTRADICTED` record and its contradicting successor remain visible;
  downstream must surface the conflict, never pick a winner silently.
- `freshness: "stale"` (computed) demotes the conclusion to historical
  context: it must not anchor a new opportunity/risk verdict without
  re-evaluation by R8-D.
- Confidence ceilings are binding downstream: a conclusion projected `LOW`
  is never "moderately confident" because a downstream model prefers it.

## 6. Tenant, scope and freshness discipline

- Every read is tenant-scoped (`userId`-predicated) and business-scoped; the
  session anchors all reads. Cross-tenant/cross-business evidence never
  resolves.
- Re-validate at consumption time: `contractVersion`, `reasoningId` pattern
  (exactly `rsn1:` + 64 hex), bound upstream `sourceVersions`, and
  `governanceDecisionId` pattern (`sgd1:` + 64 hex) when present.
- `contextScope` bounds generalisation: a conclusion anchored on
  campaign-scoped evidence must not be generalised business-wide without new
  evidence.

## 7. Mutability and audit

- All projected fields are read-only. Corrections or derived state live in
  consumer-owned tables keyed by `reasoningId` references (no FKs, house
  convention).
- The canonical `audit_events` ledger records every durable R8-D effect
  (`strategic_reasoning_recorded`, `strategic_reasoning_lifecycle`);
  consumers must not duplicate or shadow that authority.

## 8. Security invariants

1. Consumers must consume only through the tenant-scoped procedures and
   revalidate tenant scope on every query.
2. Consumers must not present a conclusion as causal proof (§4), as verified
   fact beyond its `confidenceClass`, or as execution authority.
3. Consumers must not promote `confidenceClass`, lower `strategicRiskClass`,
   resolve contradictions, or mark conclusions current — no such
   path exists and none may be built.
4. Consumers must not mutate projected fields or durable rows (§7).
5. A model-generated summary is never source authority; consumers may
   summarize conclusions but the records themselves never change.

---

**R8-E: consume strategic conclusions through this contract. Reasoning
concludes; it never executes — and opportunity/risk verdicts belong to you.**
