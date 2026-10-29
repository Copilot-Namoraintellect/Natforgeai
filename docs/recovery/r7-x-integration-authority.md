# R7-X Integration Authority Audit

> **Stage:** X0 — Integration Authority Audit
> **Date:** 2026-10-30
> **Verdict:** AUTHORITY_AUDIT_PASSED — all six frozen streams verified, all
> descend from the accepted R6 authority, no silent substitution detected.

---

## 1. Repository Authority State

| Item | Value |
|------|-------|
| Integration worktree | `C:\Users\27768\NatForgeAI-R4` |
| Integration branch | `integration/r7-business-optimisation` |
| Current integration HEAD | `8030e97adc9fe8e6bf1cc3a93a8a66da56025a46` |
| Origin integration HEAD | `8030e97adc9fe8e6bf1cc3a93a8a66da56025a46` |
| Working-tree status | clean |
| Local ↔ remote | in sync |
| Expected base | `8030e97adc9fe8e6bf1cc3a93a8a66da56025a46` — **MATCHES** |
| R6 accepted authority | `LEAD_AUTONOMY_V1_READY` |

## 2. Frozen Feature Head Verification

Every remote branch was fetched (`git fetch origin`) and its tip compared
against the frozen accepted head:

| Stream | Branch | Frozen HEAD | Remote HEAD | Match |
|--------|--------|-------------|-------------|-------|
| R7-A | `feature/r7-a-conversion-outcome-intelligence` | `3e8aea8` | `3e8aea8b4367da599bb8a28887c156c7241eae9c` | ✅ |
| R7-B | `feature/r7-b-attribution-intelligence` | `6ff9eca` | `6ff9ecad58e3861e472b6b26dbbf2c951a8707f5` | ✅ |
| R7-C | `feature/r7-c-business-learning` | `53b2ff4` | `53b2ff4191e832f7a562e62c0ff3b50d066aab99` | ✅ |
| R7-D | `feature/r7-d-experimentation` | `ab9eb64` | `ab9eb64da1c625d9d8cad53678ab948711dd822e` | ✅ |
| R7-E | `feature/r7-e-budget-portfolio-optimisation` | `83dc643` | `83dc6434b69ff8a4a919323f899760d2f227edc0` | ✅ |
| R7-F | `feature/r7-f-optimisation-governance` | `5e4ab95` | `5e4ab95c71702e4d30d05d34f7a0c76b96d28c20` | ✅ |

No branch differs materially from its accepted authority. No silent
substitution is present.

## 3. Descent From Accepted R6 Authority

`git merge-base --is-ancestor 8030e97adc9fe8e6bf1cc3a93a8a66da56025a46
origin/<branch>` was run for each of the six streams:

| Stream | Merge-base with base | Commits ahead | Base is ancestor |
|--------|---------------------|---------------|------------------|
| R7-A | `8030e97a…25a46` | 8 | ✅ YES |
| R7-B | `8030e97a…25a46` | 6 | ✅ YES |
| R7-C | `8030e97a…25a46` | 1 | ✅ YES |
| R7-D | `8030e97a…25a46` | 6 | ✅ YES |
| R7-E | `8030e97a…25a46` | 6 | ✅ YES |
| R7-F | `8030e97a…25a46` | 6 | ✅ YES |

All six feature branches diverge directly from the accepted R6 base
(`integration/r6-lead-autonomy` @ `8030e97a…25a46`, verdict
`LEAD_AUTONOMY_V1_READY`) and share no other unexpected merge ancestry.

## 4. Overlapping Path Inventory

Streams' diffs against the R6 base were intersected. Paths touched by ≥2
streams:

| Path | Streams touching | Count |
|------|------------------|-------|
| `db/schema.ts` | A, B, C, D, E, F | 6 |
| `db/migrations/meta/_journal.json` | A, B, C, D, E, F | 6 |
| `db/migrations/meta/0035_snapshot.json` | A, B, C, D, E, F | 6 (same filename, divergent content) |
| `api/router.ts` | A, B, C, D, E, F | 6 |
| `api/lib/audit/audit-event.ts` | A, B, C, D, E, F | 6 |
| `api/lib/audit/audit-event.test.ts` | A, B, C, D, E, F | 6 |
| `AGENTS.md` | A, B, E, F | 4 |

### 4.1 Schema / migration / meta

- Each stream independently created a **provisional `0035`** migration:
  - A: `db/migrations/0035_r7_a_conversion_outcome_foundation.sql`
  - B: `db/migrations/0035_r7_b_attribution_foundation.sql`
  - C: `db/migrations/0035_r7_c_business_learning.sql`
  - D: `db/migrations/0035_r7_d_experimentation.sql`
  - E: `db/migrations/0035_r7_e_budget_portfolio_optimisation.sql`
  - F: `db/migrations/0035_r7_f_optimisation_governance.sql`
- Each stream also regenerated `db/migrations/meta/0035_snapshot.json` and
  appended its entry to `db/migrations/meta/_journal.json` at idx 35.
- `db/schema.ts` gained new tables/enums in every stream. All deltas inspected:
  **purely additive** against base (no deletions/weakening of R6 schema).
  These must be merged semantically — **no schema delta may be lost**.
- **X2 owns canonical convergence** of the six provisional `0035` artefacts
  into one canonical linear migration order after R6
  (`0034_r6_lead_autonomy_foundation`). R6 and earlier migrations `0000`–`0034`
  must not be modified.

### 4.2 Router surface (`api/router.ts`)

All six streams register new tRPC routers with **identical hunk location**
(same import insertion point, same `appRouter` tail line). Expected textual
conflicts with a purely **additive** semantic resolution — every accepted
router registration is preserved:
A `outcome`, B `attribution`, C `businessLearning`, D `experimentation`,
E `budgetPortfolio`, F `optimisationGovernance`.

### 4.3 Audit taxonomy (`api/lib/audit/audit-event.ts` + test)

All six streams extend the audit-event kind union with **closed, disjoint**
event sets:
A `business_outcome_recorded` / `business_outcome_lifecycle`;
B `attribution_calculated` / `attribution_superseded`;
C `business_learning_recorded`;
D `experiment_created` / `experiment_state_changed` /
`experiment_assignment_recorded` / `experiment_evidence_bound` /
`experiment_result_recorded`;
E `portfolio_snapshot_created` / `optimisation_proposal_created` /
`optimisation_instruction_authorized`;
F `optimisation_governance_decision` / `optimisation_governance_recovery`.
Resolution: union of all accepted kinds; exact-list tests extended union-wise.

### 4.4 Documentation surface (`AGENTS.md`)

A, B, E, F each append a new top-level section (all numbered §21 in
isolation). Resolution: renumber sequentially (§21–§24) preserving every
stream's content verbatim.

### 4.5 Runtime seams (X3 / X4 / X5 convergence targets)

Isolated-stream provisional seams exist and are **integration targets, not
lost work**:

| Stream | Seam file | Upstream it provisionally binds |
|--------|-----------|--------------------------------|
| B | `api/lib/attribution/attribution-outcome-seam.ts` | R7-A outcomes |
| C | `api/lib/business-learning/business-learning-upstream-seam.ts` | R7-A outcomes + R7-B attribution |
| D | `api/lib/experimentation/experimentation-seams.ts` | governance + outcome/attribution evidence |
| E | `api/lib/budget-portfolio/governance-seam.ts`, `budget-portfolio-bridge.ts` | R7-F governance + outcome/attribution/learning |
| F | `api/lib/optimisation-governance/optimisation-governance-bridge.ts` | downstream-facing F authority surface |

X3/X4/X5 replace or verify these seams against the **actual integrated
authorities**; no duplicate authority may survive convergence.

### 4.6 Test-support / harness surfaces

- **E modifies `api/r6-x-harness.ts`** (R6-X connected harness): additive
  schema-anchor map entries for its three provisional-0035 tables. Must be
  preserved; re-anchored at canonical 0035 during X2.
- **F modifies `api/r5-test-support.ts`** (shared R5 test support): additive
  in-memory duplicate-key simulation for `optimisation_governance_decisions`
  unique `(userId, governanceDecisionId)`. Must be preserved.
- C is a single squashed commit (41/41 acceptance suite included).
- E ships `api/r7-e-contract-compatibility.test.ts` — to be re-run against
  integrated contracts in X3/X4/X7.

## 5. Merge Sequence Decision

Recommended sequence: **A → B → C → F → D → E** (truth → attribution →
learning → governance → experiment → optimisation). The repository conflict
topology does not require deviation: all streams diverge from the same base
and overlap only on additive-capable surfaces plus the schema/migration block
which X2 converges after all merges. F is merged **before** D and E so that
X5 binds D/E to canonical integrated R7-F rather than to provisional seams.
Deviation from the recommended order will be documented here if it occurs.

## 6. Audit Verdict

- Integration branch and HEAD: **verified**
  (`integration/r7-business-optimisation` @ `8030e97a…25a46`, clean,
  remote-synced).
- Frozen source branch authority: **verified** for all six streams — every
  remote head equals the frozen accepted head.
- Descent from accepted R6 authority: **verified** for all six streams.
- Overlap inventory: **complete** (§4).
- Blocking conditions: **none**.

**X0 result: AUTHORITY_AUDIT_PASSED. Proceeding to X1 controlled feature
merges.**
