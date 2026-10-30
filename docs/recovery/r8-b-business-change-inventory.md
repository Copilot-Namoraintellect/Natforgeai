# R8-B Business Change Intelligence — Authority / Change Inventory (B0)

> **Stream:** WBS-R8-B (Business Change Intelligence)
> **Branch:** `feature/r8-b-business-change-intelligence`
> **Programme base:** `a2c084a1f0bca110a00e51f83632733789cec5f7` (R7-X Business
> Optimisation V1 accepted HEAD; working tree clean at inventory time)
> **Frozen upstream authorities (consumed by branch ref only, NOT merged):**
> R8-A Strategic Memory @ `23d0f22` (verdict `STRATEGIC_MEMORY_READY`);
> R8-F Strategic Governance @ `44118e3` (verdict `STRATEGIC_GOVERNANCE_READY`)
> **Rule:** Inspect before editing. R8-B consumes upstream contracts; it never
> redefines, merges, or mutates them.

This document is the B0 authority/change inventory. It records which internal
authorities expose durable **before/after state** suitable for deterministic
change comparison, which expose only derived or snapshot-ambiguous state, and
which cannot support change detection without unsupported inference. It is the
design input for `docs/contracts/business-change-intelligence-contract.md`,
`docs/contracts/business-change-to-strategic-reasoning-contract.md` and the
`api/lib/business-change/` module set.

---

## 1. Identity established

| Item | Value |
|---|---|
| Worktree | `C:\Users\27768\NatForgeAI-R8-B` |
| Branch | `feature/r8-b-business-change-intelligence` |
| HEAD | `a2c084a1f0bca110a00e51f83632733789cec5f7` (exactly the programme base) |
| Remote | `origin` (`https://github.com/Copilot-Namoraintellect/Natforgeai.git`) |
| R8-A frozen ref | `23d0f22` (accepted HEAD, `STRATEGIC_MEMORY_READY`) — verified present locally |
| R8-F frozen ref | `44118e3` (accepted HEAD, `STRATEGIC_GOVERNANCE_READY`) — verified present locally |
| Base migration on this branch | `0035_r7_business_optimisation_foundation` (journal idx 35) |
| R8-A provisional migration (its branch, not merged) | `0036_r8_a_strategic_memory_foundation` (NOT EXECUTED) |
| R8-F provisional migration (its branch, not merged) | `0036_r8_f_strategic_governance_foundation` (NOT EXECUTED) |
| R8-B provisional migration (this stream) | `0036_r8_b_business_change_foundation` (CREATED, NOT EXECUTED — see `docs/recovery/r8-b-unexecuted-migrations.md`) |

## 2. Comparison-authority model (design outcome of inventory)

R8-B detects change by comparing two **server-loaded authoritative states**:

1. **Previous state** — the R8-A strategic-memory **current** record bound to
   the subject, consumed read-only through the frozen
   `strategic-memory-to-reasoning/v1` semantics (R8-A remains the memory
   authority; R8-B never writes memory). The memory seam
   (`api/lib/business-change/business-change-memory-seam.ts`) reads
   `strategic_memory_records` behind a guarded information-schema existence
   check (house seam pattern); when the table is absent the seam fail-closed
   degrades to "no previous state" and change detection refuses to run — a
   change is never fabricated without an authoritative before-state.
2. **Current state** — newly observed authoritative internal evidence named by
   the client as `(sourceAuthority, sourceIdentity)` (or an operator-attested
   bounded observation) and loaded **server-side** through the upstream seam
   (`api/lib/business-change/business-change-upstream-seam.ts`). Clients can
   never supply state payloads for governed sources.

Both states are reduced to closed-template **state views**, fingerprinted over
canonical-normalised material (`sha256(canonicalJson({v, authority, identity,
version, template, fields}))`). Change identity binds the exact before/after
fingerprints (B2): same business + subject + change type + previous/current
fingerprints ⇒ same `chg1:` identity; retries converge; conflicting replay
fails closed.

## 3. Authorities inventoried

### 3.1 R8-A Strategic Memory (frozen, consumed not merged) — COMPARISON AUTHORITY

Consumed via `git show 23d0f22:…` only. Canonical documents:
`docs/contracts/strategic-memory-contract.md` (record semantics, closed
vocabularies, FACT/ASSUMPTION distinction, `CURRENT/STALE/SUPERSEDED/
CONTRADICTED/EXPIRED/INVALIDATED` statuses) and
`docs/contracts/strategic-memory-to-reasoning-contract.md` (30-key read-only
projection, current-state semantics).

Durable before/after support: **yes** — this is the before-state authority.
Memory records bind `sourceAuthority` + `sourceIdentity` + immutable
`evidenceHash` + deterministic `memoryId`. The current projection exposes only
`CURRENT` memory as active. R8-B binds, per change, the exact memory id +
fingerprint of the previous state it compared against, so:

- stale/superseded memory is never silently treated as current (non-`CURRENT`
  rows are excluded from the active comparison set);
- `FACT` vs `ASSUMPTION` remains distinct in the comparison (a change whose
  previous state was an ASSUMPTION is classified and bounded differently —
  significance confidence ceiling, provisional-friendly review orientation);
- contradiction history is preserved (R8-A rows are never written by R8-B; a
  change carries reference-only lineage);
- change can never rewrite memory (read-only seam; the only write R8-B emits
  downstream is a labelled **memory candidate** inside its own projection).

Classification: **directly observable change** (the memory row itself is the
durable prior observation).

### 3.2 Business DNA snapshots (in-tree, frozen) — CURRENT-STATE AUTHORITY

`api/lib/business-dna.ts` (canonical `BusinessDNASnapshot`),
`api/lib/business-dna-store.ts`, table `business_dna_snapshots`
(migration lineage pre-R7). Immutable write-once rows: `snapshotId`, `version`,
`evidenceHashSha256`, governed payload (`productsAndServices`,
`targetCustomerSegments`, `customerPainPoints`, `capabilities`,
`supportedOutcomes`, `approvedClaims`, `prohibitedClaims`, …), `capturedAt`.

Durable before/after support: **yes, for DNA-bound dimensions**. A newer
hash-verified snapshot under the same business is an authoritative new state;
the previous state is the DNA-derived memory (R8-A `BUSINESS_FACT` over
`business_dna`) or a previously observed snapshot view bound in memory.

- **PRODUCT_SERVICE** — `productsAndServices` set + `primaryOffering`: set
  add/remove and offering repositioning are directly comparable
  (representation-normalised: order-insensitive sets). Classification:
  **directly observable change**.
- **AUDIENCE** — `targetCustomerSegments` set add/remove/change: directly
  comparable. Classification: **directly observable change**.
- **CAPABILITY (business self-description)** — `capabilities` set: comparable,
  but business-declared capability is weaker evidence than operational
  provider capability (3.6); v1 wires the provider-capability dimension from
  the budget snapshot instead. Classification: **derived change** (v1 uses it
  only as corroborating evidence, never as primary change authority).

### 3.3 Strategy snapshots (in-tree, frozen) — CURRENT-STATE AUTHORITY

`api/lib/strategy/strategy-snapshot*.ts`, table `strategy_snapshots`:
immutable versioned rows per campaign (`snapshotId`, `campaignId`, `version`,
`strategyHashSha256`, governed `snapshot` payload, `capturedAt`).

Durable before/after support: **yes** for campaign strategy material — a new
snapshot version with a different `strategyHashSha256` under the same campaign
is a directly observable strategy-content change. v1 exposes
`strategy_snapshot` as a wired source for campaign-scoped strategy-state
comparison; domain mapping: **PORTFOLIO_PERFORMANCE** (strategy regime) with
change type `STRATEGY_REGIME_CHANGED`. Classification: **directly observable
change**.

### 3.4 R7 Business Optimisation V1 (in-tree at base, frozen)

R7-A outcomes (`business_outcomes`, `out1:`), R7-B attribution (`atr1:`),
R7-C learning (`business_learning_records`, `lrn1:`), R7-D experiments
(`exp1:`/`exr1:`), R7-E budget/portfolio (`budget_portfolio_snapshots`,
`psn1:`; proposals `opt1:`; instructions `ins1:`), R7-F governance
(`optimisation_governance_decisions`, `ogd1:`). Consumed through each
authority's own store read + integrity assertion behind the upstream seam —
never direct unvalidated table reads.

- **R7-E budget portfolio snapshots — BUDGET / CAPABILITY(provider) /
  PORTFOLIO_PERFORMANCE**: `approvedTotalBudgetMinor` (integer minor units),
  `committedMinor`, `reservedMinor`, `currency`, `supportedProviders` (closed
  provider strings), `currentAllocations`, `lockedAllocationKeys`,
  `disabledAllocationKeys`. A newer snapshot for the same business/budget
  period is an authoritative new state. Envelope total change
  (increase/decrease), provider support set change, and allocation-regime
  change are directly comparable. Classification: **directly observable
  change**.
- **R7-C learning records — PORTFOLIO_PERFORMANCE**: `status`
  (`CANDIDATE/…` lifecycle), `confidenceClass` (`STRONG/MODERATE/WEAK/NONE`),
  `contradictionCount`, `upstreamStateFingerprint`. A learning whose status
  moved to a contradicted/superseded terminal, or whose confidence class
  dropped, is an authoritative performance-regime signal. Classification:
  **directly observable change** (for the learning-lifecycle dimension).
- **R7-A outcomes — CUSTOMER_BEHAVIOUR / LEAD_CONVERSION**: individual outcome
  rows are authoritative (`outcomeStatus`, `amountMinor`), but "pattern
  changed" (trend/regime) requires aggregation over windows. v1 does **not**
  wire outcome-aggregate regime detection: a two-point comparison is not a
  trend, and inventing a statistical regime model would be unsupported
  inference. Classification: **unsupported inference in v1** (deferred; the
  seam still consumes single outcomes as evidence refs for other domains).
- **R7-B attribution**: association evidence only; never a change authority
  (`causationClaimed:false` travels verbatim into R8-A memory and into R8-B
  limitations). Classification: **unsupported as change authority** (reference
  only).
- **R7-F governance decisions — STRATEGIC_CONSTRAINT / RISK_POSTURE**: closed
  decision vocabulary (`ALLOW/REVIEW_REQUIRED/BLOCK`), `riskClass`
  (`LOW/MEDIUM/HIGH/CRITICAL`), `policyVersion`. A newer decision for the same
  proposal/subject with a tightened outcome or raised risk class is directly
  comparable. Classification: **directly observable change**.

### 3.5 Campaigns / leads / conversions (operational state, in-tree)

`campaigns` (status, budget, platforms), `leads`, `conversion_events`.

- Campaign status transitions (`active→paused`, `draft→active`) are durable
  and tenant-scoped, but campaign lifecycle is operational truth owned by the
  CRM/campaign routers — a status flip is not by itself a *strategic* change.
  v1 uses campaign rows only for ownership re-verification and as opaque
  subject references. Classification: **derived change** (available as
  evidence refs; not a v1 change domain).
- Lead/conversion *patterns* (customer/lead behaviour regime) require
  aggregation; same objection as 3.4. Classification: **unsupported inference
  in v1**.

### 3.6 Provider / payment capability state

Provider truth lives operationally in R7-E snapshot `supportedProviders`
(+ R4 billing authority, which R8-B never touches). Payment-method rows
(`banking_details`) are R4 admin authority — out of scope. v1 wires the
provider-capability dimension exclusively from `supportedProviders` set
comparison (CAPABILITY domain, `PROVIDER_SUPPORT_ADDED/REMOVED`).
Classification: **directly observable change** (snapshot-bound).

### 3.7 Business DNA (mutable `businesses` row)

The live `businesses` row is mutable and explicitly **not** the historical
authority (`business_dna_snapshots` supersedes it for durable state).
Classification: **not a comparison authority** (reference only).

### 3.8 Existing change/event/audit infrastructure

- `audit_events` (canonical ledger, `eventFingerprint` exact-once): R8-B adds
  `business_change_detected` + `business_change_lifecycle`; no shadow ledger.
- Lifecycle/version concepts exist across R6/R7 (`*_lifecycle_events`,
  CAS `version`, supersession columns) — R8-B mirrors that house pattern
  (`business_change_lifecycle_events`, `bcl1:` facts, CAS `status`).
- No pre-existing generic "change" authority exists; R8-B creates none over
  upstream tables (own two tables only).

## 4. Domain classification summary (closed set adopted)

| Change domain | Before authority | New-state source (v1 wired) | Classification |
|---|---|---|---|
| BUSINESS_OBJECTIVE | R8-A `STRATEGIC_OBJECTIVE` memory (current) | `operator_attestation` (bounded observation) | directly observable |
| PRODUCT_SERVICE | R8-A DNA-derived memory | `business_dna` snapshot | directly observable |
| AUDIENCE | R8-A DNA-derived memory | `business_dna` snapshot | directly observable |
| BUDGET | R8-A snapshot-derived memory | `r7_budget_portfolio` latest snapshot (`approvedTotalBudgetMinor`) | directly observable |
| CAPABILITY (provider) | R8-A snapshot-derived memory | `r7_budget_portfolio` snapshot `supportedProviders` | directly observable |
| PORTFOLIO_PERFORMANCE | R8-A learning/snapshot-derived memory | `r7_learning` record lifecycle; `r7_budget_portfolio` allocation regime; `strategy_snapshot` regime | directly observable |
| STRATEGIC_CONSTRAINT | R8-A governance-derived memory | `r7_governance` decision | directly observable |
| RISK_POSTURE | R8-A governance-derived memory | `r7_governance` `riskClass` | directly observable |

Evaluated and **deferred** (no durable before/after authority without
unsupported inference in v1 — documented, not silently adopted):
**PRICING** (no authoritative pricing field exists in DNA/snapshot/schema;
`monthlyBudget` is budget, not price), **CHANNEL** (no channel-state authority
distinct from campaigns/platforms operational flags), **CUSTOMER_BEHAVIOUR**
and **LEAD_CONVERSION** (require windowed aggregation over outcomes/leads —
unsupported inference from two-point comparison).

These deferred domains are excluded from the v1 closed vocabularies; a later
contract version may adopt them only with a named durable authority.

## 5. Boundary consequences

- R8-B writes **only** `business_change_events` +
  `business_change_lifecycle_events` (+ canonical audit events). It never
  writes R8-A memory, R7 tables, Business DNA, strategy snapshots, campaigns,
  budgets, approvals, payments, providers, or CRM.
- Change detection emits a downstream **memory candidate** (labelled,
  reference-only) inside its own projection; minting the new memory record is
  R8-A's authority at integration.
- Governance semantics (R8-F) are consumed by contract reference only for the
  advisory `governanceEligibilityHint`; R8-F remains the recommendation
  authority.
