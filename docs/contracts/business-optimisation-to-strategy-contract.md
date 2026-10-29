# BUSINESS OPTIMISATION → STRATEGY HANDOFF CONTRACT (R7-E → R8)

> **Producer:** R7-E (Budget & Portfolio Optimisation), branch
> `feature/r7-e-budget-portfolio-optimisation`
> **Consumers:** R8 (Strategic Intelligence / Planning), R7-X
> **Status:** canonical handoff contract — downstream consumes, does not redefine
> **Implements:** `BUSINESS_OPTIMISATION_TO_STRATEGY_CONTRACT_VERSION =
> "business-optimisation-to-strategy/v1"`
> **Source of truth:** `docs/contracts/budget-portfolio-optimisation-contract.md`
> (R7-E canonical contract) + `api/lib/budget-portfolio/budget-portfolio-service.ts`
> `getStrategyHandoffProjection`
> **Upstream (frozen, consumed not merged):** R7-A (`3e8aea8`) via
> `conversion-outcome/v1`; R7-B (`6ff9eca`) via `attribution-to-learning/v1`;
> R7-C (`53b2ff4`) via `business-learning-to-experiment-optimisation/v1`;
> R7-F (`5e4ab95`) via `optimisation-governance/v1`; R6 Lead Autonomy V1
> (`8030e97a…`); R4 financial authority (settling only).

This contract defines the frozen, read-only projection through which R8
strategic intelligence/planning consumes R7-E optimisation output. R7-E turns
governed evidence and the approved budget envelope into bounded, explainable
reallocation proposals authorised by R7-F. **An optimisation proposal is
planning material, not execution permission, and never mutates strategy.**

---

## 1. Optimisation identity

- `optimisationId` — `"opt1:" + sha256(canonicalJson({v:1, tenantUserId,
  businessId, portfolioSnapshotId, objective, algorithmVersion,
  constraintVersion, evidenceBundleHash}))`, server-minted only, deterministic
  (R7-E contract §5). Stable for the life of the record.
- Downstream must treat `optimisationId` as an **opaque, immutable reference**:
  no re-derivation, no parsing, no construction of new identities from its
  parts. Deduplicate and join on it verbatim.
- `portfolioSnapshotId` — `"psn1:"` deterministic snapshot identity (R7-E
  contract §4); verbatim opaque reference.

## 2. Consuming surface

R8 consumes **only** through the tenant-scoped tRPC procedure
`budgetPortfolio.getStrategyHandoff` (or the pure projection builder
`getStrategyHandoffProjection` at integration time). No other R7-E surface is
downstream-consumable, and downstream must never read R7-E tables directly.

## 3. Projection field allowlist

Exact top-level key allowlist from
`OPTIMISATION_STRATEGY_HANDOFF_FIELD_KEYS` (23 keys — asserted exact in
acceptance):

| Key | Type | Semantics |
|---|---|---|
| `contractVersion` | `"business-optimisation-to-strategy/v1"` | Frozen projection version |
| `optimisationId` | `string` | Opaque canonical identity (§1) |
| `businessId` | `number` | Owning business (server-verified) |
| `budgetPeriod` | `string` | `YYYY-MM` budget period |
| `currency` | `string` | Closed 3-letter code |
| `objective` | `string` | Closed R7-E objective |
| `status` | `string` | Closed R7-E lifecycle status |
| `currentAllocations` | `{allocationKey, campaignId, provider, amountMinor}[]` | Authoritative starting allocation (integer minor units) |
| `proposedAllocations` | same shape | Solver-proposed allocation; Σ ≤ approved total |
| `deltaAllocations` | `{allocationKey, deltaMinor}[]` | Signed integer deltas; Σ = 0 for pure reallocations |
| `evidenceRefs` | `string[]` | Opaque upstream ids (out1:/atr1:/lrn1:) cited |
| `confidenceClass` | `string` | `STRONG \| MODERATE \| WEAK \| INSUFFICIENT` |
| `reasonCodes` | `string[]` | Closed R7-E explainability codes (≤8) |
| `constraints` | `{constraintVersion, concentrationCeilingBps, maxShiftPerCycleBps, maxShiftPerCycleMinor, minAllocationMinor, minChangeThresholdMinor}` | Frozen constraint set snapshot |
| `governance` | `{governanceDecisionId, decision, approvalRequired, policyVersion, riskClass} \| null` | Frozen R7-F binding (null for NO_CHANGE) |
| `authorisation` | `{instructionId, approvalRequestId, authorisedAt, expiresAt} \| null` | Authorised instruction pointer, once executed through the gate |
| `algorithmVersion` | `string` | Closed `budget-portfolio-algorithm/v1` |
| `createdAt` | `string` | Proposal time (ISO 8601) |
| `validUntil` | `string \| null` | Governance validity (null for BLOCKED/NO_CHANGE) |
| `causationClaimed` | `false` | Always false (§4) |
| `causationDisclaimer` | `string` | Verbatim disclaimer (§4) |
| `attributionClaimed` | `false` | Always false (§4) |
| `attributionDisclaimer` | `string` | Verbatim disclaimer (§4) |

Deliberately absent (downstream must derive or own itself): causal lift,
incrementality, ROI forecasts, strategy mutation, budget authority, campaign
execution. Deriving these from optimisation fields alone would restate the
causation this contract forbids (§4).

## 4. Causation and attribution disclaimer (verbatim on every projection)

```
causationClaimed: false
causationDisclaimer: "Optimisation allocations are evidence-bounded proposals
  derived from governed outcomes, attribution and learning. This projection
  does not assert that any allocation caused any business outcome."
attributionClaimed: false
attributionDisclaimer: "Attribution credit consumed by optimisation is
  association evidence, not causal proof. Credit allocation, causal scores and
  channel weights remain R7-B derivations on their own authority."
```

**Association ≠ contribution ≠ allocated credit ≠ causal evidence.** Any R8
output that traces back to an optimisation projection must retain and surface
these disclaimers. Causal claims require R7-D experimental evidence under R7-F
governance — never optimisation proposals alone.

## 5. Status semantics downstream must honour

- `NO_CHANGE` proposals carry no governance decision and no instruction — the
  portfolio holds; downstream must not invent movement.
- Only `AUTHORIZED` proposals carry an `authorisation` block; `ALLOWED` /
  `REVIEW_REQUIRED` / `BLOCKED` / `EXPIRED` / `REJECTED` are lifecycle states,
  never execution permission by themselves.
- The R7-F `decision` field is governance authority verbatim; downstream must
  never widen it (an `ALLOW` never becomes execution outside `validUntil`, a
  `BLOCK` never becomes executable).

## 6. Mutability

**All projected fields are read-only for R8.** R7-E durable rows are
insert-only (append-only lifecycle). Downstream must not rewrite optimisation
authority, must not "fix" allocations, classes or reason codes, and must not
delete inconvenient proposals. Corrections or derived state live in R8-owned
tables keyed by `optimisationId` references (no FKs, house convention).

## 7. Privacy

- The projection carries **no PII**: no name, email, phone or company fields
  exist anywhere in the optimisation tables or the projection.
- **No `userId` exposure**: the tenant id is internal to R7-E storage and
  never appears in the projection; downstream consumes within tenant scope
  through the tenant-scoped procedures only.
- Downstream inherits the minimization duty and must honour R6-F privacy
  states as stop signals for any strategy action that touches a lead.

## 8. Money

All allocation and delta fields are integer **minor units**. Downstream must
never re-denominate, net, or round these values; any aggregation must preserve
the exact integers and the Σ-delta = 0 conservation of pure reallocations.

## 9. Exact-once / replay semantics

- Proposals are insert-first against durable unique anchors
  (`bpp_user_optimisation_uidx`); replays converge to one durable row surfaced
  as `duplicateClassification: "none" | "idempotent_replay"`.
- The projection is a pure function of the durable row + its bound governance
  decision + its instruction; re-reading is inherently replay-safe.
  Downstream must key idempotency on `optimisationId`; there is no client
  idempotency identity.

## 10. Security invariants

1. Downstream must consume optimisation only through the tenant-scoped
   procedure and must revalidate tenant scope on every query.
2. Downstream must not present optimisation as causal proof (§4).
3. Downstream must not promote `NO_CHANGE`/non-authorized proposals as
   execution material (§5).
4. Downstream must not mutate projected fields or durable rows (§6).
5. Downstream must obtain its own governing authority (R7-F) before any
   material strategy action; optimisation projections are never sufficient
   authority.

---

**R8: consume optimisation through this contract. Optimisation proposes;
governance authorizes; R4 settles. Do not redefine optimisation authority.**
