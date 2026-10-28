# R7-A Conversion Outcome Intelligence — Authority / Domain Inventory (A0)

> **Stream:** WBS-R7-A (Conversion Outcome Intelligence)
> **Branch:** `feature/r7-a-conversion-outcome-intelligence`
> **Programme base:** `8030e97adc9fe8e6bf1cc3a93a8a66da56025a46`
> **Frozen upstream authority:** R6 Lead Autonomy V1 (`integration/r6-lead-autonomy`,
> accepted HEAD `8030e97a…`, verdict `LEAD_AUTONOMY_V1_READY`) — consumed, not merged
> **Status:** pre-implementation inventory. No code edited before this document.

---

## 1. Mission boundary (restated)

R6-E proves **that a conversion event occurred** (observed business outcome, exact-once,
tenant-anchored). R7-A answers: **what business outcome did it produce, what value was
realised, what evidence supports that value, and is that value final, provisional,
reversed, refunded, renewed or otherwise changed.** R7-A owns the authoritative
interpretation and persistence of business outcomes derived from governed R6 conversion
evidence. It does **not** own attribution, causation, experimentation, budget/portfolio
optimisation, sales qualification, lead identity, conversion identity, payment
execution, billing, invoicing, CRM state, or accounting ledger.

**Core principle (binding):** conversion evidence and business-value evidence are
distinct. `conversion ≠ revenue` unless independently evidenced. No floating-point
money — a recorded amount always identifies currency, integer minor units, evidence
authority, status, occurred/recorded time, and provisional-vs-verified state.

---

## 2. Inventory of existing authority

### 2.1 R6-E conversion event authority (upstream, frozen — consume, do not redefine)

- **Contract:** `docs/contracts/conversion-event-contract.md` (canonical);
  `docs/contracts/conversion-to-attribution-contract.md` (frozen R7 input projection).
- **Tables:** `conversion_events`, `conversion_lifecycle_events`
  (`db/schema.ts:2579-2669`; canonical migration `0034_r6_lead_autonomy_foundation`,
  **executed status: NOT executed** — artefact only; R7-X/R10 own execution).
- **Modules:** `api/lib/conversion/` — `conversion-contract` (closed vocabs, zod strict
  boundary, client-authority guard), `conversion-identity` (`cnv1:`/`clf1:` sha256
  identities, evidence hash), `conversion-trust` (source→trust registry,
  `FINANCIAL_AUTHORITY_TRUST_CLASSES`, initial-status derivation), `conversion-value`
  (integer minor units, `MAX_CONVERSION_MINOR_UNITS = 1e15`, 20-code currency allowlist
  + ISO exponents, both-or-neither pair rule, PAN/credential digit-run guard),
  `conversion-ownership` (durable-row re-verification), `conversion-store`
  (insert-first exact-once, CAS `version`, tamper-evident reads), `conversion-service`
  (orchestration + reversal effects + deterministic audit), `conversion-projection`
  (frozen 22-key `conversion-to-attribution/v1`).
- **Router:** `api/conversion-router.ts` (`ingest`, `get`, `list`, `r7Projections`,
  `listLifecycle`), registered in `api/router.ts:93`.
- **Key facts for R7-A:**
  - Conversion identity is **tenant-anchored**: `cnv1:` + sha256 over
    `{tenantUserId, sourceSystem, externalConversionId}`. R7-A must treat `conversionId`
    as opaque and verbatim.
  - Monetary truth in R6 lives **only** in `conversion_events.amount` (signed bigint
    minor units) + `currency`, verified-vs-reported split by trust class.
    `analytics.revenue`-style aggregates are explicitly NOT monetary truth
    (R6→R7 handoff §7).
  - Reversal rows carry negative amounts + `reversesConversionId`; reversal-of-reversal
    forbidden; currency must match target; CAS-guarded status transitions.
  - Lead linkage: server-verified numeric `leads.id` (same tenant, business
    null-or-equal) + opaque `leadIdentityVersion` string.

### 2.2 R6-A canonical lead identity (frozen)

- **Contract:** `docs/contracts/lead-identity-contract.md`;
  `docs/contracts/lead-identity-to-scoring-qualification-contract.md`.
- **Tables:** `lead_identities` (`lid1:` deterministic identities), `lead_identity_provenance`,
  `lead_identity_merges` (`db/schema.ts:2339-2460`).
- **Read surface:** tRPC `leadIdentity.get/list` projections (14 keys, hash-only — no
  raw PII anywhere).
- **Key facts for R7-A:** identity status vocabulary is identity-lifecycle only
  (`active/anonymous/partially_identified/resolved/conflicting/suppressed/merged/archived`).
  The `lid1:` ↔ numeric `leads.id` mapping is score-mediated (R6-C chain); R7 must
  consume through validated surfaces, never reconstruct from bare ids. R7-A outcomes
  therefore bind the **numeric lead reference carried by the server-verified R6-E
  conversion** plus the conversion's opaque `leadIdentityVersion`, re-verified from
  durable rows at outcome intake.

### 2.3 R6-B/C/D/F (frozen context)

- Scores (`lead_score_snapshots`) are evidence, never authority. Qualifications
  (`lead_qualifications`, closed decisions) and nurture/handoff (`nurture_handoff_decisions`,
  `sales_handoffs`) are downstream lifecycle authorities — R7-A must not create or
  mutate any of them. R6-F `lead_privacy_states` is a stop-signal surface; R7-A records
  outcomes against governed evidence only and performs no lead-touching action, so no
  privacy transition is triggered, but suppressed/archived leads remain valid as
  inert references (R7-A never re-resolves identity).

### 2.4 Billing / payment authority (R4 — strictly out of scope)

- **Tables:** `credit_wallets`, `credit_transactions`, `credit_reservations` (internal
  credit currency; `balanceAfter` int), `payments` (`amount` int cents USD, admin-recorded),
  `subscription_tiers.priceUsd`, `banking_details`.
- **Modules:** `api/lib/billing/` (credit engine, reservations, cost tracker with
  micro-cent formatting). `docs/contracts/financial-reliability-contract.md` governs
  retry/charge authority.
- **Collision check:** none. Billing value is platform-internal credit; R7-A business
  outcome value is **tenant business value** in ISO minor units. R7-A never writes
  billing tables, never charges, never invokes payment.

### 2.5 Legacy analytics / KPI / learning (out of scope, collision checked)

- `analytics.metricType` includes ungoverned `conversions`/`revenue` (int, no currency
  discipline) — R7-A must not route governed outcomes through it.
- `api/lib/learning/kpi/*` maps strategy KPI *names* to metric references; volumes are
  observations, not monetary truth. R7-C will consume outcomes via the A8 projection.

### 2.6 Existing monetary utilities (reuse, not redefine)

- `api/lib/conversion/conversion-value.ts`: currency allowlist + exponents, bounds,
  both-or-neither, credential guard. R7-A reuses the same currency vocabulary and
  bounds discipline (imported — not duplicated) so downstream sees one money grammar.
- No floating-point money anywhere in governed paths; R7-A continues bigint minor units.

### 2.7 Audit taxonomy

- `api/lib/audit/audit-event.ts` `AUDIT_EVENT_TYPES` — additive-only per house rule.
  R6 pattern: one deterministic audit row per durable effect; convergence paths emit
  zero; metadata carries ids/closed labels/hashes only. R7-A will add outcome event
  types (exact set decided at implementation, §A8 of the contract).

### 2.8 Router / service conventions

- tRPC routers via `createRouter` + `authedQuery` (`api/middleware.ts`); strict zod
  boundaries; fail-closed error mapping to TRPCError codes; executor-seam stores
  (`ConversionStoreExecutor` pattern) so tests inject in-memory fakes replicating
  durable unique anchors; no FK constraints (opaque references, predicate enforcement);
  deterministic identities `prefix + sha256(canonicalJson(...))`; `now` injected as
  explicit ISO string (no clock in pure modules).

### 2.9 Migration state

- Journal tail: `0034_r6_lead_autonomy_foundation` (canonical R6; **not executed**).
- Prior stream-local provisional 0034 artefacts were converged into the canonical 0034
  by R6-X (`docs/recovery/r6-migration-convergence.md`). R7-A therefore numbers its
  stream-local provisional artefact **0035** and does not touch 0034.
- `drizzle.config.ts` requires `DATABASE_URL`; parity generation must be offline with a
  dummy URL (no DB connection), mirroring `docs/recovery/r6-e-unexecuted-migrations.md`.
  **`MIGRATION_EXECUTION = False`.**

### 2.10 External provider / payment seams

- `api/lib/integrations/` (OAuth adapters, webhook authenticity) and R4 billing are the
  only live-provider touchpoints. R7-A ingests **evidence references only**
  (`evidenceSource` closed vocabulary + bounded `evidenceIdentity`); it never calls
  providers, never verifies webhooks itself, never executes payment/billing.

---

## 3. Authority collision resolution

| Domain question | Owner | R7-A stance |
|---|---|---|
| Did a conversion occur? (event, exact-once) | **R6-E** | consume `conversionId` verbatim; unknown conversion rejected |
| Who is the lead? (identity) | **R6-A** | bind conversion-carried numeric lead ref + opaque `leadIdentityVersion`, re-verified; never re-derive |
| Conversion monetary field meaning | **R6-E** | revalidate provenance/authority before use as business value (A4); mismatches fail closed |
| Business outcome classification/value/lifecycle | **R7-A (this stream)** | new `business_outcomes` + `business_outcome_lifecycle_events` |
| Attribution / causation / credit allocation | **R7-B (future)** | projection carries explicit non-attribution disclaimer |
| Learning feedback / optimisation | **R7-C (future)** | read-only projection only |
| Charging / credits / invoices / ledger | **R4 billing** | no write path; no invocation |
| CRM pipeline / sales qualification | **CRM / R6-D** | no write path |
| Revenue recognition policy | **beyond platform** | R7-A records truthful evidence only, never recognition |

**No collisions found.** The `business_outcome*` namespace is unused across
`api/`, `db/`, and `docs/` (verified by search). R7-A tables reference R6 authority
opaquely (`conversionId`, numeric `leadId`, `leadIdentityVersion`) — no FKs, per house
convention.

## 4. Deliverables checklist (A0 → A9)

- [ ] A1 `docs/contracts/conversion-outcome-intelligence-contract.md`
- [ ] A2-A6 `api/lib/outcome/*` modules + `api/outcome-router.ts`
- [ ] A7 `db/schema.ts` (append-only) + provisional `0035` artefact (not executed) +
      `docs/recovery/r7-a-unexecuted-migrations.md`
- [ ] A8 `docs/contracts/conversion-outcome-to-attribution-learning-contract.md`
- [ ] A9 `api/outcome-acceptance.test.ts` (30 connected cases)
- [ ] Final report `docs/recovery/r7-a-conversion-outcome-acceptance-report.md`
