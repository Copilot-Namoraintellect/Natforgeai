# WBS-R4 STREAM X — X1 CONVERGENCE MAP

> **Date:** 2026-10-23
> **Integration branch:** `integration/r4-full-autonomy`
> **Common base:** `2f21a8fc959070b79cfb9c237a5b87922dc42f08`
> **Authority:** six stream contracts (A `r4-core-lifecycle-contract.md`, B `CREATIVE_TO_DISTRIBUTION_CONTRACT.md`, C `distribution-to-postlive-contract.md`, D `learning-to-next-cycle-contract.md`, E `financial-reliability-contract.md`, F `GOVERNANCE_AND_OPERATOR_CONTRACT.md`)

---

## 1. Branch / HEAD verification

| Stream | Branch | Stated HEAD | Actual HEAD | Remote sync |
|---|---|---|---|---|
| A | `feature/r4-a-core-autonomy` | e981e3a | e981e3a3b7b2 | in sync |
| B | `feature/r4-b-creative-autonomy` | 600fc14 | 600fc1403108 | in sync |
| C | `feature/r4-c-distribution-autonomy` | f7176dc | f7176dccbb1c | in sync |
| D | `feature/r4-d-learning-autonomy` | 84825d4 | 84825d4101cd | in sync |
| E | `feature/r4-e-financial-reliability` | 75f13cf | 75f13cf9003c | in sync |
| F | `feature/r4-f-governance-operations` | c5c7385 | c5c738579981 | in sync |

Integration branch was at the common base, clean, in sync with origin. Nothing pre-merged.

## 2. Changed-file footprint (vs common base)

| Stream | Paths | Notable additions |
|---|---|---|
| A | 31 | approval-continuation, strategy-entry-gates/readiness, next-cycle repeat, retry/resume tests, core contract + final report |
| B | 14 | `api/lib/creative/release-package.ts` + 5 test suites, creative contract + report |
| C | 17 | `creative-release-consumer.ts`, audience-intel billing key suite, provider-boundary/queue/launch acceptance suites, contract |
| D | 29 | post-live metrics observation (leased pass + persistence + health), engagement dedup, learning evidence suites, **migrations 0027/0028 + snapshots + journal**, contract |
| E | 25 | stale-reservation-reaper, exact-once/cost-pause/resume-gate/budget-autonomy suites, image/video billing tests, contract + 2 reports |
| F | 19 | governance admin-audit + lifecycle-projection libs, 4 governance suites, contract |

## 3. Overlap-risk files (touched by ≥2 streams)

| File | Streams | Conflict risk |
|---|---|---|
| `api/lib/workflow/triggers.ts` | A, B, C | **Textual.** A: +149 lines (strategy-approval lineage read, next-cycle dispatch, dedup of pending strategy reviews). B: +14 (release-package seal on `creatives_ready`). C: +21 (audience-intel billing identity at 2 dispatch sites). Disjoint regions except import block and `onAgentRunComplete`/`onApprovalResolved`/`onStrategyApproved` adjacency — merge by union, preserving all three semantics. A contract §5 declares this file consume-only for C/E, but the mission's dependency order and the C0.2/E §2 reconciliation explicitly authorise C's key-transport hunks; B's seal hook is B's own authority surface. |
| `api/lib/workflow/triggers.test.ts` | A, E | Low/moderate — check hunks; both extend trigger tests. |
| `api/lib/workflow/budget-resume.ts` | A, C | Low — A binds pause→approval (22 lines), C threads `continuationId`→billing identity (15 lines). Different functions, same import block. |
| `api/lib/billing/cost-control.ts` | A, E | **REAL.** E restructures `pauseWorkflowForCostLimit` (2 hunks) + `canRunAutonomousWorkflow` (1 hunk); A's approval-binding hunks sit inside E's first region. X3.2 manual merge: keep E's continuation/probe gate semantics AND A's `approvalId` pause binding. |
| `api/lib/billing/cost-control-cost-pause.test.ts` | A, E | Tests for the above — union, then reconcile expectations. |
| `api/lib/workflow/__tests__/autonomous-closed-loop-acceptance.test.ts` | B, D | Pre-existing typecheck debt noted by F contract §10; both streams touched. Verify but do not silently fix unrelated debt. |
| `api/campaign-router.ts` (+test) | A, E | A: callouts/create flow; E: billing calls. Check hunks. |
| `api/image-router.ts` | B, E | B vs E billing/flag semantics — check. |
| `api/health-router.ts` | D, F | D adds observation-health projection inputs; F adds governance surfaces. Check. |
| `api/boot.ts` | A, D | A wires sweep + post-live lifecycle scheduler (env-gated OFF); D wires metrics-observation scheduler (default-ON per D contract §8.3). Startup-order reconciliation in X3.4. |

## 4. Migration / schema analysis (X4 pre-read)

- Base canonical chain: journal idx 0–26 (27 entries), root files `0000_*`–`0026_add_publishing_queue_metadata.sql`, terminal snapshot `0026_snapshot.json` (id `702eac9e-dd3c-4156-808f-5ccf1efaa359`).
- **The mission-flagged 0027/0028 collision is resolved by evidence:** `db/migrations/archived/0027_queue_durability_tables.sql` is a documented WBS-R1.8 relic (archived/README.md) whose queue-durability effects entered the canonical lineage at snapshot 0025 (verified present in `0026_snapshot.json`). It is NOT a journal entry and must never be applied. It causes no filename collision with D's root-level files.
- D's migrations are the correct next canonical numbers:
  - `0027_add_analytics_observation_id.sql` → `analytics.observationId` varchar(191) + unique `analytics_observation_id_idx`. Snapshot `109e37df-…`, prevId = 0026 id. ✔
  - `0028_add_campaign_interest_signal_actor_unique.sql` → unique `cis_campaign_actor_uidx` on (`campaignId`,`externalIdentifier`). Snapshot `2696bc82-…`, prevId = 0027 id. ✔
- No other stream adds migrations. F explicitly does not touch schema.
- X4 duties reduce to: verify journal idx 27/28 entries, verify D `schema.ts` ↔ `0028_snapshot.json` parity, verify no duplicate numbers in the canonical chain, and list 0027/0028 as unexecuted for production. No destructive assumptions needed.

## 5. Cross-stream semantic dependencies

| # | Seam | Resolution rule (from contracts + mission) |
|---|---|---|
| 1 | F closed `subscription.subscribe` self-grant (`confirmedByWebhook` input removed) | Keep F. E contract §13.2 residual is obsolete; final report reflects integrated state. |
| 2 | C removed `TEMP_AUDIENCE_INTELLIGENCE_USER_IDS` bypass from `api/lib/audience/access.ts` (base has it; C removes it; C's `access.test.ts` pins the removal) | Keep C's removal. |
| 3 | Audience-intel billing identity: format defined in E contract §2 (`agent-audience-intel-${sha256("workflow/agent-billing@v1:audience-intel:{campaignId}:{continuationId}")}`); builder + call-site plumbing landed in C (`agent-billing-identity.ts`, `triggers.ts` ×2, `budget-resume.ts`) | Preserve both; verify key format matches E exactly. |
| 4 | A vs E in `cost-control.ts` | X3.2 manual merge — both semantics kept (see §3). |
| 5 | D metrics-observation scheduler default-ON with kill-switch `POST_LIVE_METRICS_OBSERVATION_ENABLED=false`; post-live lifecycle scheduler stays default-OFF (`POST_LIVE_LIFECYCLE_ENABLED`); boot sweep ungated | Mission semantic #5: accept only if X3.4 proves Redis lease, no unsupported provider execution, no surprise billable action, working kill-switch, safe startup order. A contract §6 note about not flipping flags is superseded by the mission instruction for the metrics-observation scheduler only; lifecycle scheduler remains OFF. |
| 6 | E self-grant residual | Covered by #1. |
| 7 | B is sole creative-release authority (`api/lib/creative/release-package.ts`, package id `crp:{campaignId}:{creativeBriefFingerprint}`) | X3.1: verify C's `api/lib/publish/creative-release-consumer.ts` consumes B's package and holds no parallel seal authority; retire duplication if found. |
| 8 | C is sole publication-receipt authority (`publication:{platform}:{queueItemId}` exact-once) | D consumes only; A consumes queue exports; no stream re-derives. |
| 9 | F lifecycle projection is the only operator read model; no second state machine | X3.6: extend evidence only if a new durable authority appears. |
| 10 | Billing key registry frozen (E §2): `strategy-run-${runId}`, `creative-success:{campaignId}:{source}:{id}`, `publishing:{queueItemId}`, reservation settle/release keys | All streams verified to mint from these at integration (X5 checks 7–9). |

## 6. Integration order (X2)

A → B → E → C → D → F (mission-fixed). Merge with `--no-ff` per stream, deliberate conflict resolution, targeted tests per slice, `git diff --check`, boundary verification, secret scan, separate convergence-fix commits, push after each accepted slice.
