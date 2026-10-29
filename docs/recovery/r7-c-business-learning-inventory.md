# R7-C Business Learning — Authority / Learning Inventory (C0)

> **Stream:** WBS-R7-C (Business Learning Engine)
> **Branch:** `feature/r7-c-business-learning`
> **Programme base:** `8030e97adc9fe8e6bf1cc3a93a8a66da56025a46`
> **Rule:** Inspect before editing. Frozen upstream contracts are consumed by
> branch reference only — never merged, never imported.

---

## 1. Frozen upstream authorities (consumed, not merged)

| Authority | Branch / HEAD | Consumed surface | Schema (provisional, NOT executed) |
|---|---|---|---|
| R7-A Conversion Outcome Intelligence | `feature/r7-a-conversion-outcome-intelligence` @ `3e8aea8` | `docs/contracts/conversion-outcome-intelligence-contract.md` + `docs/contracts/conversion-outcome-to-attribution-learning-contract.md` — projection `conversion-outcome/v1` (27-key frozen allowlist, verbatim causation/attribution disclaimers) | `business_outcomes`, `business_outcome_lifecycle_events` — `0035_r7_a_conversion_outcome_foundation` |
| R7-B Attribution Intelligence | `feature/r7-b-attribution-intelligence` @ `6ff9eca` | `docs/contracts/attribution-intelligence-contract.md` + `docs/contracts/attribution-to-business-learning-contract.md` — projection `attribution-to-learning/v1` (25-key frozen allowlist, verbatim causation disclaimer, `attributionClaimed: true`) | `attribution_results`, `attribution_lifecycle_events` — `0035_r7_b_attribution_foundation` |
| R7-F Optimisation Governance | `feature/r7-f-optimisation-governance` @ `5e4ab95` | `docs/contracts/business-optimisation-governance-contract.md` — `optimisation-governance/v1`; decisions `ALLOW \| REVIEW_REQUIRED \| BLOCK`; closed proposal taxonomy including `LEARNING_PROMOTION` | `optimisation_governance_decisions` (+ approval ledger enum extension) — `0035_r7_f_optimisation_governance` |
| R6 Lead Autonomy V1 (programme base) | `integration/r6-lead-autonomy` @ `8030e97a…` | `docs/contracts/lead-autonomy-to-business-optimisation-contract.md` + the seven R6 contracts | `0034_r6_lead_autonomy_foundation` (canonical, untouched) |

**Provisional migration collision (documented, NOT resolved here):** R7-A,
R7-B and R7-F each independently carry a stream-local `0035_*` migration.
R7-X owns canonical R7 migration convergence and collision resolution. R7-C,
if it needs schema, adds its own stream-local provisional artefact based on
the current branch and does **not** renumber or modify any sibling artefact.

---

## 2. Existing "learning" capabilities in the programme base — the C0 critical question

### 2.1 R4 campaign-level learning (EXISTS — narrower authority, not competing)

The programme base already contains a governed **campaign-level learning**
capability owned by the R4 streams:

- **Module:** `api/lib/learning/` (`learning-service`, `learning-cycle-service`,
  `learning-record-authority`, `learning-strategy-consumption`,
  `performance/loader+dataset`, `analysis/variant-analyzer`,
  `promotion/promotion-service`, `post-live-learning-trigger`, KPI assessment).
- **Storage:** `learning_records` table (`db/schema.ts`) — immutable,
  idempotency-keyed, campaign-scoped records with `confidence`
  (low/medium/high), `status` (`recorded`), evidence JSON, and governance
  pins (`autoApply: false`, `requiresApproval: true`).
- **Routers:** `learningRouter` (`evaluate`, `runGovernedCycle`, `records`,
  `record`) and `learningPromotionRouter`.
- **Contract:** `docs/contracts/learning-to-next-cycle-contract.md` —
  Stream D produces *approved learning evidence* (sealed
  `ApprovedPromotionEnvelope`); Stream A consumes it to create the NEXT
  governed Strategy version. Promotion is approval-gated; nothing auto-applies.

**What it derives from:** campaign performance observations (KPI datasets,
strategy-bound KPI assessment, variant analysis over durable observations,
post-live lifecycle metrics). It is **pre-outcome**: it learns whether
campaign execution performed against plan and derives engine recommendations.

**What it never touches:** business outcomes, revenue, attribution, credit
allocation, conversions. It has no R7-A/R7-B consumption surface.

### 2.2 Determination — authority boundary

The existing R4 capability **already owns a narrower campaign-level learning
authority**. R7-C therefore:

- does **not** compete with it, does **not** modify it, does **not** reuse its
  tables, ids, or promotion machinery;
- defines itself as **business-outcome learning** — learning derived from
  governed R7-A business outcomes + R7-B attribution results + durable
  provenance, sitting **above/beyond** campaign performance learning in the
  evidence stack;
- consumes R4/R5/R6 provenance as read-only context where available through
  existing contracts, and consumes R7-A/R7-B exclusively through their frozen
  downstream projections.

### 2.3 Exact authority boundary (four planes)

| Plane | Owner | Derives from | Produces | Authority |
|---|---|---|---|---|
| **Campaign learning** | R4 (`api/lib/learning`, `learning_records`) | Campaign KPI/performance observations, strategy snapshots, variant analysis | Campaign-scoped learning records + engine recommendations (approval-gated promotion to next Strategy cycle) | Governed by `learning-to-next-cycle-contract.md`; never touches outcomes/attribution |
| **Business-outcome learning** | **R7-C (this stream)** | Verified/provisional R7-A outcomes + R7-B attribution results + R4/R5/R6 provenance + historical R7-C learning | Durable, immutable, evidence-bounded learning records (identity, classification, confidence/evidence class, novelty/contradiction, lifecycle, supersession) | This contract family; never asserts causation; never mutates strategy/budget/experiments |
| **Experiment evidence** | R7-D (future branch) | Controlled experiment execution + outcomes | Causal evidence (the only legitimate causal plane) | Frozen at base; R7-C hands off via read-only projection only |
| **Optimisation authority** | R7-E (future branch) + R7-F governance | R7-C learning projections + R7-D evidence + portfolio state | Budget/portfolio optimisation actions | R7-F `ALLOW` is required for any material action; R7-C learning is never execution permission |

Boundary rules:

1. R7-C learning records never enter `learning_records` and never flow through
   the R4 promotion envelope. R4 recommendations remain campaign-engine
   advice; R7-C learning remains outcome evidence.
2. R7-C never recomputes attribution credit, outcome value, or campaign KPIs.
3. R7-D/R7-E consume R7-C through a read-only projection and must separately
   obtain R7-F governance authority (`assertOptimisationActionExecutable`)
   before any material action. R7-C creates **no** governance engine and **no**
   execution path.
4. A future R7-X convergence may build read adapters; neither plane's durable
   authority is rewritten by the other.

---

## 3. Provenance / context inventory (read-only consumption candidates)

| Plane | Source | R7-C use |
|---|---|---|
| R4 strategy/campaign/creative/audience provenance | `strategy_snapshots`, `campaigns`, `businessDna` snapshots, publication receipts | Context-scope labels on learning (campaign objective, message family) where durably resolvable for the tenant |
| R5 engagement/intent/opportunity evidence | `social_signals`, `social_interpretations`, `engagement_receipts`, `opportunity_candidates/evidence` | Touchpoint/context lineage arrives **only via R7-B attribution projections** (which already bound eligibility). R7-C does not re-walk R5 tables |
| R6 lead/qualification/nurture/conversion history | R6 contracts via the R6→R7 handoff | Privacy stop signals (`SUPPRESSED`/`RESTRICTED`/`RETENTION_EXPIRED`) and lead lineage only through governed surfaces; R7-C stores no lead PII |
| Business/campaign/audience/channel metadata | `businesses`, `campaigns` | Server-revalidated context scope; protected/sensitive traits are never optimisation-learning dimensions (default reject) |

---

## 4. Historical concepts surveyed (no competing authority found)

- `optimisation_logs` — legacy unstructured summary log; superseded by
  `learning_records`; not an authority; untouched.
- `businessDna` (`api/lib/business-dna.ts`) — BI-owned business profile
  snapshot consumed by Creative; context metadata, not learning.
- R5-B `intelligence` — interpretation records (intent/sentiment); upstream
  evidence for R5, not learning authority.
- `learning-to-next-cycle` promotion infrastructure — R4-only (§2.1).
- Post-live lifecycle learning triggers (`post-live-learning-trigger.ts`,
  workflow post-live passes) — R4 campaign post-live loop; untouched.

**Conclusion:** no existing capability owns business-outcome learning. R7-C
is the first and sole authority for it; the R4 campaign-learning plane is
explicitly narrower and preserved untouched.

---

## 5. Audit taxonomy

`api/lib/audit/audit-event.ts` (`AUDIT_EVENT_TYPES`) is the canonical ledger.
R7-C adds exactly one material event type, `business_learning_recorded`, in
the additive house style (one deterministic event per inserted learning
record; zero on replay/convergence). Metadata carries ids, closed labels,
classes and hashes only — never evidence text or PII.

---

## 6. Current schemas / migrations

- `db/schema.ts` at base `8030e97` contains R6 tables (through
  `nurture_touch_records`) and R4 `learning_records`; it contains **no** R7
  tables (`business_outcomes`, `attribution_results` are absent — correct,
  they are sibling-branch provisional artefacts).
- R7-C will append its own stream-local provisional migration
  (`0035_r7_c_business_learning_foundation`) for its own tables only, and will
  not execute it (`MIGRATION_EXECUTION = False`). Collision with the three
  sibling `0035_*` artefacts is documented here and left to R7-X.

---

*Inventory complete. Authority boundaries fixed. R7-C proceeds to contract
authoring (C1) without modifying any upstream authority.*
