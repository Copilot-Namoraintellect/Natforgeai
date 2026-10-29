# R7-D Experimentation — Authority & Experiment Inventory (D0)

> **Stream:** WBS-R7-D — Experimentation Engine
> **Branch:** `feature/r7-d-experimentation` (base `8030e97`)
> **Mission:** determine whether an R7-C learning hypothesis can become a
> governed experiment and manage it through a safe, auditable lifecycle.
> **Rule:** frozen upstream contracts/authorities are consumed **by branch
> reference only** — never merged, never imported. Sibling R7 branches are
> NOT merged here.

---

## 1. Frozen upstream authorities (consumed by ref, not merged)

| Stream | Branch | Accepted HEAD | Verdict | What R7-D consumes |
|---|---|---|---|---|
| R7-A Conversion Outcome Intelligence | `feature/r7-a-conversion-outcome-intelligence` | `3e8aea8` | `CONVERSION_OUTCOME_INTELLIGENCE_READY` | Outcome evidence via frozen projection `conversion-outcome/v1` (27-key allowlist) — the authoritative source of experiment outcome evidence (`business_outcomes`). |
| R7-B Attribution Intelligence | `feature/r7-b-attribution-intelligence` | `6ff9eca` | `ATTRIBUTION_INTELLIGENCE_READY` | Attribution evidence via frozen projection `attribution-to-learning/v1` (25-key allowlist) — bound where relevant (`attribution_results`). |
| R7-C Business Learning | `feature/r7-c-business-learning` | `53b2ff4` | `BUSINESS_LEARNING_ENGINE_READY` | Learning + evidence binding via frozen projection `business-learning-to-experiment-optimisation/v1` (23-key allowlist, `businessLearning.getExperimentProjection`). R7-D consumes `learningId`, business scope, status, confidence/evidence class, freshness metadata, limitations. |
| R7-F Optimisation Governance | `feature/r7-f-optimisation-governance` | `5e4ab95` | `OPTIMISATION_GOVERNANCE_READY` | Governance authority: closed action taxonomy includes `EXPERIMENT_CREATE` / `EXPERIMENT_ACTIVATE` / `EXPERIMENT_STOP`; decision record `ogd1:` + approval ledger (`approvalType = "optimisation_action"`, binding pins decision + policy version + proposal fingerprint + expiry). Execution gate: `assertOptimisationActionExecutable`. |

All four HEADs were verified locally against the programme-declared values
(`git rev-parse`): R7-A `3e8aea8b…`, R7-B `6ff9ecad…`, R7-C `53b2ff419…`,
R7-F `5e4ab95c7…`. **Match.**

### 1.1 R7-C learning contract — key constraints R7-D must honour

- Learning identity `lrn1:` is opaque downstream; R7-D references it, never
  re-derives or parses it (`business-learning-to-experiment-optimisation-contract.md` §1).
- Only `SUPPORTED` learning is meaningful promotion material;
  `CANDIDATE`/`CONTRADICTED`/`SUPERSEDED`/`DEPRECATED`/`INVALIDATED` are
  history, never current evidence (§4).
- `freshness { stale, provisional, contradictionUnresolved }` is
  governance-eligibility metadata only — R7-F alone decides (§5).
- Every projection carries `causationClaimed: false` + verbatim disclaimer;
  downstream outputs must retain it (§6).
- Learning projections are read-only for R7-D (§7); no `userId` exposure (§8).
- **Learning does not authorize experiment execution or budget change** —
  R7-D must separately obtain R7-F authority.

### 1.2 R7-F governance contract — key constraints R7-D must honour

- Decisions: `ALLOW | REVIEW_REQUIRED | BLOCK`. Authority only narrows (§2).
- Experiment actions are `EXPERIMENT_CREATE` / `EXPERIMENT_ACTIVATE` /
  `EXPERIMENT_STOP` (§3). Unknown action types blocked.
- Policy is a code-level immutable registry; no runtime mutation (§5).
  Experiment policy knobs: concurrency ceiling, per-experiment budget,
  prohibited dimensions, protected traits, duration bounds.
- Human approval binds business + proposal + action + financial impact +
  policy version + proposal fingerprint + expiry (§7). Rejected: stale
  approvals, cross-proposal replay, modified proposal after approval, agent
  self-approval, client-fabricated approval.
- `assertOptimisationActionExecutable(decision, approval, currentPolicyVersion, now)`
  is the only execution gate; revalidate immediately before any material
  state change (§10). R7-D MUST call it before activation.
- R7-F never computes experiment results, never assigns treatments (§12).

### 1.3 R7-A / R7-B evidence contracts — key constraints

- Outcomes: deterministic `out1:` identity, immutable rows, lifecycle
  (`OBSERVED/PROVISIONAL/VERIFIED/REVERSED/CANCELLED/SUPERSEDED`), integer
  minor units, `occurredAt` outcome time, `causationClaimed: false`.
- Reversed/cancelled/superseded outcomes are terminal for current-state
  purposes; reversal rows never create positive duplicate value.
- Attribution: deterministic `atr1:` identity, `totalCreditBps`, confidence/
  evidence class, `supersedesAttributionId` lineage; `attributionClaimed: true`,
  `causationClaimed: false`.

---

## 2. Existing experiment-like concepts in the repository (avoid duplicate authority)

Search of the base tree (`api/`, `db/`, `contracts/`, `src/`) for
`experiment | ab_test | a/b | variant | split test | treatment | control`:

- **`api/lib/business-dna-governance.ts` / `business-dna-governance.test.ts`:**
  "experiment" appears only as business-DNA prose vocabulary, not an
  experiment authority. No experiment tables, no assignment, no results.
- **Creative "variants":** `api/lib/creative/*` — creative/artifact variants
  and message-approval hashing. These are creative-production lineage
  concepts, NOT statistical experiments; no treatment/control/assignment/
  result authority exists there.
- **`strategy_snapshot_materialized` / campaign versions:** R4 learning
  autonomy materializes strategy snapshots and campaign-level learning
  (`api/lib/learning/*`, `learningRouter`, `learningPromotionRouter`) — a
  narrower campaign plane, per the R7-C inventory §2. Not experiment authority.
- **Audience segmentation:** audience-intelligence agents segment audiences
  for targeting; no governed experiment assignment.
- **A/B terminology:** no existing A/B-test, split-test, treatment-arm, or
  control-group tables, routers, or lifecycle exist anywhere in the base.

**Conclusion:** there is NO existing experiment authority. R7-D owns
experiment identity/design/assignment/lifecycle/evidence/result as net-new
capability. No duplicate-authority conflict; overlap-risk files are limited
to the shared registry/schema/audit touchpoints listed in §5.

---

## 3. Relevant shared infrastructure consumed (read-only)

- **Audit ledger** `api/lib/audit/audit-event.ts` + `audit-store.ts` —
  append-only, fingerprinted; R7-D adds one event type, reuses unchanged.
- **Approval ledger** `approval_requests` (status
  `pending|approved|rejected|edited`; `context` JSON binding) — R7-F's
  `optimisation_action` approvals live here; R7-D references, never mints.
- **tRPC middleware** `api/middleware.ts` — `authedQuery` (session-verified)
  is the procedure class for all R7-D mutations/queries.
- **Router registry** `api/router.ts` — one additive `experimentation`
  registration.
- **Schema** `db/schema.ts` (2 929 lines, ends at R6 nurture tables) —
  append-only experiment tables.
- **Scheduling/timing:** `schedules` table (content calendar) is content
  publishing scheduling, NOT experiment timing; R7-D keeps its own
  observation-window fields on the experiment row.
- **Budget reservation:** R4 `creditReservations` / billing authority —
  R7-D never reserves, charges, or settles; experiment budget is a declared,
  governance-checked cap (integer minor units) only.
- **Campaign/strategy authority:** `campaigns`, strategy snapshots — R7-D
  never mutates; treatment/control definitions are inert descriptors.

---

## 4. Consumption architecture (house seam pattern)

R7-D cannot import sibling code (branches not merged). Following the
established R7 seam pattern (as R7-C consumes R7-A/R7-B):

- **Frozen-shape seams** (`api/lib/experimentation/experimentation-seams.ts`)
  mirror the frozen projection key allowlists verbatim (R7-C learning
  projection 23 keys; R7-A outcome projection 27 keys; R7-B attribution
  projection 25 keys; R7-F decision + approval shapes) and validate them
  strictly. Any structural drift fails closed
  (`EXPERIMENT_UPSTREAM_CONTRACT_MISMATCH`).
- **Authority ports** (learning / outcome / attribution / governance) are
  injected: production reads run against the upstream tables behind guarded
  information-schema existence checks (fail-closed "no such evidence" when a
  table is absent until R7-X materialises it); tests inject fakes serving
  frozen shapes.
- All convergence is DB-authoritative; tests run the REAL service + stores +
  pure modules against an in-memory fake DB replicating the durable unique
  anchors.

---

## 5. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Learning authority (R7-C) | `business_learning_records`, `api/lib/business-learning/*` | seam consumption only; never imported/merged |
| Outcome authority (R7-A) | `business_outcomes`, `api/lib/outcome/*` | seam consumption only |
| Attribution authority (R7-B) | `attribution_results`, `api/lib/attribution/*` | seam consumption only |
| Governance authority (R7-F) | `optimisation_governance_decisions`, `approval_requests`, `api/lib/optimisation-governance/*` | seam consumption only; R7-D never evaluates governance itself |
| Schema | `db/schema.ts` | append-only (experiment tables) |
| Migrations | `db/migrations/` | append-only provisional `0035_r7_d_experimentation`; **NOT executed**; 0034 + sibling `0035_*` untouched |
| Router registry | `api/router.ts` | one additive `experimentation` registration |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive experiment event types only |
| Billing / payments (R4) | `api/lib/billing/*` | read-only — never charged, never invoked |
| Campaign / strategy / CRM | `campaign-router`, `learningRouter`, `lead-router` | untouched |

## 6. Provisional migration collision (documented, NOT resolved here)

Sibling R7 streams each carry a stream-local provisional `0035_*` migration
(`0035_r7_a_*`, `0035_r7_b_*`, `0035_r7_c_*`, `0035_r7_f_*`). R7-D adds
`0035_r7_d_experimentation.sql`. R7-X owns canonical convergence/renumbering;
this stream must not renumber or modify any sibling artefact.
`MIGRATION_EXECUTION = False`.
