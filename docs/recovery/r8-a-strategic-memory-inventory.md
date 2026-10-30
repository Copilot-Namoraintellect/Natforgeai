# R8-A STRATEGIC MEMORY — AUTHORITY / MEMORY INVENTORY (A0)

> **Stream:** WBS-R8-A Strategic Memory
> **Branch:** `feature/r8-a-strategic-memory`
> **Programme base:** `a2c084a1f0bca110a00e51f83632733789cec5f7`
> **Frozen upstream:** R7 Business Optimisation V1 (`integration/r7-business-optimisation`,
> accepted HEAD `a2c084a1…`, verdict `BUSINESS_OPTIMISATION_V1_READY`)
> **R7 handoff contract:** `docs/contracts/business-optimisation-to-strategic-intelligence-contract.md`
> **Status:** A0 deliverable — inspected before editing; read-only inventory, no code changes.

---

## 1. Purpose

Identify every authority R8-A must consume, reference or avoid duplicating before
building the strategic-memory capability. R8-A owns **strategic-memory records
and strategic-memory lifecycle only**; everything inventoried here remains
upstream authority that R8-A reads through frozen projections or references by
identity — never redefines.

## 2. Existing memory / context / history authorities

### 2.1 No pre-existing strategic memory

Repository-wide search (`strategic_memory|strategicMemory|memory_records|businessMemory`,
case-insensitive, all scopes) found **no existing strategic-memory tables,
routers, services or stores**. There is no strategy-memory, campaign-level
memory, Business-DNA-fact or long-term-business-context authority in the
repository today. R8-A creates this capability net-new and does not duplicate
any existing authority.

### 2.2 Memory-adjacent concepts that exist (and are NOT strategic memory)

| Concept | Location | Why it is not strategic memory |
|---|---|---|
| `learning_records` table | `db/schema.ts` (legacy R2, `api/lib/learning/`) | Legacy campaign-learning engine; superseded by R7-C `business_learning_records`. Time-bounded operational learning, not versioned strategic fact/assumption memory. R8-A must not touch it. |
| `optimisation_logs` | `db/schema.ts:1203` | Legacy optimisation logging; not a memory authority. |
| `conversation_threads/messages` | `db/schema.ts:1102/1120` | Chat/session storage; transient interaction context, not durable strategic memory. |
| `agent_runs` | `db/schema.ts:610` | Runtime execution tracking, not memory. |
| `audit_events` | `db/schema.ts:1602`, `api/lib/audit/` | Immutable material-event ledger. R8-A **emits** audit events (one per durable memory effect) but never treats the ledger as memory storage and never duplicates/shadows it. |
| `system_settings` | `db/schema.ts:1585` | Operational settings, not business memory. |

## 3. Business context authorities (consumed by reference, never re-owned)

### 3.1 Business DNA — authoritative business profile truth

- **Code:** `api/lib/business-dna.ts`, `api/lib/business-dna-store.ts`,
  `api/lib/business-dna-governance.ts`, `api/lib/business-profile-guard.ts`.
- **Table:** `business_dna_snapshots` (`db/schema.ts:208`) — versioned,
  hash-bound (`evidenceHashSha256`) snapshots per business+tenant; full
  governed payload in `snapshot` JSON; `capturedAt` caller-authority-marked.
- **Ownership verdict:** R8-A may **reference** a DNA snapshot id as stable
  business context (e.g. `contextScope.businessDnaSnapshotId`) and may read it
  through its store for validation. R8-A must **never** write DNA, mint DNA
  snapshots, or treat derived DNA content as its own fact authority without a
  governed ingestion binding.

### 3.2 Strategy snapshots — campaign strategy authority

- **Code:** `api/lib/strategy/strategy-snapshot*.ts` (pure core +
  materialization + DB store + tests).
- **Table:** `strategy_snapshots` (`db/schema.ts:237`) — per-campaign versioned
  snapshots, `strategyHashSha256`-bound, business-DNA-snapshot-linked.
- **Ownership verdict:** campaign strategy truth remains with this authority.
  R8-A may reference snapshot ids / strategy hashes as provenance for
  STRATEGIC_DECISION / BUSINESS_FACT records derived through governed
  ingestion; it never rewrites or re-derives strategy.

### 3.3 Campaigns

- **Table:** `campaigns` (`db/schema.ts:272`) — `userId`/`businessId`-scoped
  campaign authority. R8-A references `campaign:<id>` subject ids
  prefix-tolerantly (same convention as R7-B/C/E); ownership re-verified from
  durable rows on every call.

### 3.4 Businesses

- **Table:** `businesses` (`db/schema.ts:166`) — the business scope anchor.
  Every R8-A record binds `userId` + `businessId` from durable rows; exact
  business ownership is re-verified server-side per call.

## 4. R7 authorities consumed read-only (A6 ingestion sources)

All R7 tables live in canonical migration
`0035_r7_business_optimisation_foundation` (converged at R7-X; **NOT executed** —
`docs/recovery/r7-migration-convergence.md`). R8-A reads them through the
frozen projection surfaces listed in the R7→R8 handoff contract; production
seams follow the house pattern (canonical store reads + integrity assertions +
projection builders, behind guarded information-schema existence checks that
fail closed to "no evidence" when tables are absent).

| R7 evidence | Durable rows (identity pattern) | Consumable surface (frozen version) |
|---|---|---|
| Business outcomes (R7-A) | `business_outcomes` / `business_outcome_lifecycle_events` — `out1:` / `obf1:` | `outcome.r7Projections` — `conversion-outcome/v1` (27-key projection, verbatim causation/attribution disclaimers) |
| Attribution (R7-B) | `attribution_results` / `attribution_lifecycle_events` — `atr1:` | `attribution.list/get` — `attribution-to-learning/v1` (association only; `causationClaimed: false`) |
| Business learning (R7-C) | `business_learning_records` / `business_learning_lifecycle_events` — `lrn1:` / `evb1:` | `businessLearning.list/get` + experiment-optimisation projections; confidence classes + contradictions + novelty preserved |
| Experimentation (R7-D) | `experiments` / `experiment_results` (`exr1:`) / assignments / outcome evidence | `experimentation.getResult` / `getResultHandoffProjection` — results are scoped causal evidence within design assumptions only |
| Budget & portfolio (R7-E) | `budget_portfolio_snapshots` (`psn1:`) / `_proposals` (`opt1:`) / `_allocation_instructions` (`ins1:`) | `budgetPortfolio.getStrategyHandoff` — `business-optimisation-to-strategy/v1` (23-key allowlist); `getOptimisationProposal` / `getInstruction` |
| Optimisation governance (R7-F) | `optimisation_governance_decisions` — `ogd1:` | `optimisationGovernance.get` / `listDecisions`; decisions immutable, expiry computed |

**Ingestion binding rules (A6):** R8-A never reclassifies R7 evidence into
stronger truth than its source supports. VERIFIED outcomes remain verified
facts; PROVISIONAL/OBSERVED remain provisional; attribution remains
*association*, never causal fact; learning confidence/limitations travel
verbatim; experiment results keep their design-assumption limitations;
optimisation proposals/instructions remain bounded by their governance context
(`governance` block, `validUntil`, causation/attribution disclaimers verbatim).

## 5. Identity / provenance / vocabulary patterns to reuse (no re-invention)

- **Deterministic identity:** `"<prefix>1:" + sha256(canonicalJson({v:1, tenantUserId, businessId, …}))` — house pattern across `out1:`/`atr1:`/`lrn1:`/`exp1:`/`exr1:`/`opt1:`/`ogd1:`/`psn1:`/`cnv1:`/`lid1:`/`smf` families. R8-A mints `mem1:` (memory record) and `smf1:` (memory lifecycle fact).
- **Exact-once convergence:** insert-first against durable unique indexes; replay re-reads and compares evidence fingerprints; conflicting replay fails closed; `duplicateClassification: "none" | "idempotent_replay"`.
- **Immutable rows + append-only lifecycle:** history is never edited; supersession/contradiction are new rows/facts binding exact predecessors; CAS `version` guards computed transitions.
- **Strict zod boundary + client-authority guard:** clients reference ids only; server-side authority fields (memoryId, factStatus, confidenceClass, evidenceHash, …) are rejected when client-supplied (`z.strictObject` + explicit field ban, fail closed).
- **Audit:** canonical `audit_events` ledger via `createAuditEvent` / `persistAuditEvent`; one event per durable effect (`strategic_memory_recorded`, `strategic_memory_lifecycle`), convergence emits zero.
- **Test harness:** in-memory fake DB replicating durable unique indexes, REAL routers/services/stores (`api/outcome-acceptance.test.ts` pattern).

## 6. Closed vocabularies worth aligning with

- R7-A outcome statuses: `OBSERVED | PROVISIONAL | VERIFIED | REVERSED | CANCELLED | SUPERSEDED` — R8-A temporal statuses are distinct (memory lifecycle), but R7 status is ingested verbatim as evidence material.
- R7-B evidence classes: `DIRECT_LINKAGE | STRONG_ASSOCIATION | WEAK_ASSOCIATION | INSUFFICIENT_EVIDENCE`; confidence `HIGH | MEDIUM | LOW | NONE`.
- R7-E confidence classes: `STRONG | MODERATE | WEAK | INSUFFICIENT`.
- R7-F decisions: `ALLOW | REVIEW_REQUIRED | BLOCK`.
- R6-F privacy states act as hard stops where lead-derived memory is concerned.

## 7. Migration state

- Executed journal ends at `0034_r6_lead_autonomy_foundation` (plus R7-X's
  converged `0035_r7_business_optimisation_foundation` present in tree, **not
  executed** — MIGRATION_EXECUTION=False programme-wide).
- R8-A schema delta → stream-local provisional **`0036_r8_a_strategic_memory_foundation`**
  (artefact only; R8-X owns canonical convergence). No R7 migration is altered.

## 8. A0 verdicts to the critical questions

| Question | Answer |
|---|---|
| Strategy memory exists? | **No.** Net-new capability. |
| Campaign-level memory exists? | **No.** Only campaign strategy snapshots (execution-time authority) and legacy learning records — neither is strategic memory. |
| Business DNA facts exist? | DNA snapshots exist as business-profile authority; no derived "fact memory". R8-A references, never duplicates. |
| Long-term business context exists? | **No.** Conversations/runs/logs are transient. R8-A creates durable versioned memory. |
| Competing authority risk? | Mitigated by §3–§4 reference-only consumption and the MUST-NOT-OWN list; downstream contract (A8) is read-only. |

**A0 = COMPLETE.** No code changed in this slice.
