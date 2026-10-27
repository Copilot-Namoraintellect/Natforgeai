# WBS-R6 STREAM E — CONVERSION TRACKING & OUTCOME AUTHORITY: REPOSITORY / CONVERSION INVENTORY (E0)

> **Stream:** WBS-R6 Stream E — Conversion Tracking & Outcome Authority
> **Branch:** `feature/r6-e-conversion-tracking`
> **Base:** `a947ecb` (R5 authority: `MARKETING_OPERATIONS_V1_READY`)
> **Date:** 2026-10-25
> **Verdict:** Outcome-shaped data exists today in four places (analytics
> metrics, a freemium counter, customer billing, lead scoring), none of it a
> governed, idempotent, tenant-safe conversion ledger. R6-E adds new
> conversion tables; everything else is reused read-only, not rebuilt.
> **Rule:** Migration artefacts are created for parity and review only —
> **never executed** in this stream (same rule as
> `docs/recovery/r5-e-unexecuted-migrations.md`).

---

## 1. Existing outcome-like records (reuse, do not rebuild)

| Record | Location | Notes |
|---|---|---|
| `analytics` metric rows | `db/schema.ts:503-535` | `metricType` enum includes `conversions` and `revenue` (`db/schema.ts:513,515`). `observationId` varchar(191), NULL for manual rows, unique index `analytics_observation_id_idx` (`db/schema.ts:529,533`) — deterministic `obs:` + SHA-256 identity over campaign/platform/externalPostId/metricType/date (`db/schema.ts:523-528`). This is a **metric observation** log, not a conversion ledger: no per-event identity, no value provenance, no dedupe for manual rows. |
| `user_usage.successfulResults` | `db/schema.ts:595-605` | Freemium quota counter, not a durable outcome record. Incremented by `incrementResultUsage` (`api/lib/subscription.ts:154-165`) — read-modify-write (`getUserUsage` → `+1` → update), **no CAS, not idempotent**. Call sites: campaign → `completed` (`api/campaign-router.ts:718-736`, increment at `:735`), lead → `won` with `campaignId` (`api/lead-router.ts:124-141`, increment at `:140`). Quota gate is a separate read (`checkLimit`, `api/lib/subscription.ts:192-205`) — check-then-act, not atomic with the increment. |
| `payments` | `db/schema.ts:123-135` | Customer → platform billing. `amount` int **cents** (`db/schema.ts:127`), `currency` varchar(3) default `USD` (`db/schema.ts:128`). Recorded by users' subscriptions or admin (`admin.recordPayment`, `api/admin-router.ts:427`). **This is customer billing, not marketing revenue** — R6-E must never treat it as outcome value. |
| `lead_scores` | `db/schema.ts:1015-1053` | Score/confidence/recommendedAction per campaign + `externalIdentifier` + platform (`db/schema.ts:1024-1036`); non-unique index on `(userId, campaignId, externalIdentifier)` (`db/schema.ts:1047-1051`). Scoring output, not an outcome. |
| `outreach_recommendations` | `db/schema.ts:1058-1088` | Next-best-action records; `acceptedAt`/`dismissedAt` (`db/schema.ts:1081-1082`) but **no outcome/result column** — acceptance is not tracked to conversion. |
| `credit_wallets` / `credit_transactions` / `credit_reservations` | `db/schema.ts:1279-1381` | R4 customer billing authority: wallet balances, transactions with unique `idempotencyKey` (`db/schema.ts:1317`), reservations with sha256 `reservationId` unique (`db/schema.ts:1331-1332`) and `reserved→settled\|released` state machine (`db/schema.ts:1348-1350`). **Read-only boundary for R6-E — billing identity and settlement stay with R4.** |
| `ai_usage.actualCostUsd` / `estimatedCostUsd` | `db/schema.ts:1269-1270` | Cost-side money, micro-cents (`cents * 10000`). Not outcome value. |
| `generated_images.creditsCharged` / `providerCostUsd` | `db/schema.ts:586-587` | Credit + cost columns on image jobs. Not outcome value. |

Downstream consumer to respect: the learning engine normalises `analytics` rows
into observations (`api/lib/learning/contracts/observation.ts:2,50-58`) —
one analytics row → one observation, deterministically.

## 2. Source systems producing outcome-ish data today

| Source | Location | Behaviour |
|---|---|---|
| Manual metric recording | `analytics.record` tRPC (`api/analytics-router.ts:93-125`) | Plain `insert` (`:115-123`): no idempotency key, no `observationId`, **no ownership check on client-supplied `campaignId`/`businessId`** — any authed user can attribute a `conversions`/`revenue` row to any campaign id. |
| Provider metric upsert | `api/lib/workflow/post-live-metrics-observation-pass.ts:256-284` | `insert … onDuplicateKeyUpdate({ set: { value } })` with deterministic `buildObservationId` (`:173-188`) — replay-safe upsert onto one row per observation day. `loadLastObservedAt` explicitly excludes manual rows (`observationId IS NULL`, `:229-239`). |
| Campaign completion | `api/campaign-router.ts:718-736` | Status → `completed` (prior status ≠ completed, tenant-scoped read `:720-724`) → quota check → counter increment. No durable event row. |
| Lead won transition | `api/lead-router.ts:124-141` | Status → `won` **and** `campaignId` present (`:132`) → quota check → counter increment. No durable event row. |
| Admin-recorded payments | `api/admin-router.ts:427` | Manual payment rows (customer billing). |

## 3. Campaign/lead linkage and R6-A dependency status

- `leads.campaignId` / `leads.businessId`: `db/schema.ts:390-391`.
- **No unique lead external identity**: the `leads` table (`db/schema.ts:387-419`) has no external-id column and no unique index at all; `email` is a plain nullable varchar (`db/schema.ts:393`) — duplicate leads per email are possible.
- **No lead identity version concept**: no `leadIdentityVersion` column exists anywhere in `db/schema.ts`.
- **R6-A lead-identity contract does not exist yet** (git-verified): branch `feature/r6-a-lead-identity` exists but its head is `a947ecb` — identical to this branch's base; `git rev-list --count a947ecb..feature/r6-a-lead-identity` = **0 commits**. R6-E therefore stores `leadIdentityVersion` as a **nullable varchar reserved for R6-A**, nullable because R6-A has not landed.
- **No FK constraints (repo convention)**: zero `references()` calls in `db/schema.ts`; linkage is plain bigint columns and ownership is enforced in query predicates (e.g. `eq(campaigns.userId, ctx.user.id)` `api/campaign-router.ts:723`; `eq(leads.userId, ctx.user.id)` `api/lead-router.ts:129`). R6-E follows the same convention.

## 4. Revenue / value fields and money units

Two coexisting money units, no shared decimal validator:

| Field | Unit | Location |
|---|---|---|
| `payments.amount` | int **cents** + `currency` varchar(3) | `db/schema.ts:127-128` |
| `ai_usage.actualCostUsd` / `estimatedCostUsd` | int **micro-cents** (`0.01 USD = 10000`) | `db/schema.ts:1269-1270` |
| `generated_images.creditsCharged` | credit units (non-money) | `db/schema.ts:586` |

The only decimal conversion helper is learning-local
`microUsdToDecimalString` (`api/lib/learning/performance/dataset.ts:359`);
`decimal.js-light` is a transitive dependency only (`package-lock.json:9473`,
via recharts). R6-E conversion value fields need one explicit unit + one
shared validator; mixing cents and micro-cents silently would corrupt
attributed revenue.

## 5. Duplicate / integrity risks observed

1. `analytics.record` has **no dedupe** for manual rows (`api/analytics-router.ts:115-123`) — repeated calls create repeated `conversions`/`revenue` rows, and learning observations derive from these rows.
2. `user_usage.successfulResults` is **non-idempotent** read-modify-write (`api/lib/subscription.ts:154-165`); retries double-count and the quota check is a separate, non-atomic read.
3. **No external-id namespace for conversions**: analytics has `observationId` for provider metric rows only; there is no per-conversion event identity anywhere.
4. `leads.email` is not unique (`db/schema.ts:393`) — identity-based conversion attribution can fan out across duplicate lead rows.

## 6. Schema impact assessment

**Greenfield — no conversion tables exist** (grep of `db/schema.ts` for
"conversion" hits only the `schedules.contentType` enum value
`db/schema.ts:459` and the `analytics.metricType` enum value
`db/schema.ts:513`). Existing tables are insufficient: `analytics` rows are
day-grain metric observations without per-event identity, provenance, or
value governance; `user_usage` is a counter; `payments` is customer billing.

**Minimal necessary addition (provisional, for parity/review only):**

1. `conversion_events` — immutable, append-only conversion ledger rows;
   deterministic server-minted identity; provenance references; value in one
   declared unit; `leadIdentityVersion` nullable varchar reserved for R6-A.
2. `conversion_lifecycle_events` — append-only lifecycle/attribution
   transitions with guarded state changes.

Appended after head `db/migrations/0033_opportunity_detection_foundation.sql`
(journal idx 33 is the tail of `db/migrations/meta/_journal.json`) as
migration **0034**, journal idx **34** — a provisional artefact only,
**never executed**, per the R5-E house rule.

## 7. Privacy / security risks (R6-E must close)

1. **Manual analytics rows are ungoverned**: `analytics.record` accepts any
   `campaignId`/`businessId` without an ownership check
   (`api/analytics-router.ts:115-123`) and any `value` — a tenant can write
   `revenue` into another tenant's campaign attribution namespace. A
   conversion write path must verify ownership server-side (predicate-scoped,
   like `api/campaign-router.ts:723`).
2. **Lead PII must not leak into the conversion ledger**: `leads` carries
   `name`, `email`, `phone` (`db/schema.ts:392-394`). Conversion rows must
   reference lead ids / hashes only, never PII. House sanitisation pattern:
   `SENSITIVE_METADATA_KEY` regex + `sanitizeAuditMetadata`
   (`api/lib/audit/audit-event.ts:187-188,354`); R5 streams record "identity
   references + bounded labels only — never raw social content"
   (`api/lib/audit/audit-event.ts:53-69`) — the same minimisation rule
   applies to lead PII.
3. **Provider/external identifiers are untrusted input**: hash them into
   identities, never persist verbatim, never log
   (`api/lib/workflow/post-live-metrics-observation-pass.ts:165-171`;
   `actorKey` keyed-hash precedent `db/schema.ts:2100-2104`).

## 8. R7 handoff requirements

- **One controlled projection**: R6-E exposes outcomes to R7 through a single
  governed projection, mirroring the house pattern
  `api/lib/governance/r5-operations-projection.ts` (one read model, not
  per-consumer queries against ledger tables).
- **Provenance chain exists in R5 tables (read-only to R6-E)** — conversion
  attribution can reference, but never mutate:

| Table | Provenance reference columns | Location |
|---|---|---|
| `opportunity_candidates` | `campaignId`, `publicationId`, `provider` | `db/schema.ts:2146-2148` |
| `opportunity_evidence` | `signalId`, `interpretationId`, `engagementReceiptId`, `sourceCampaignId`; immutable append-only, unique `(interpretationId, kind)` and `engagementReceiptId` anchors | `db/schema.ts:2192-2196,2216,2182-2233` |
| `engagement_receipts` | `signalId`, `interpretationId`, `actionRequestId`, `policyDecisionId`, `executionId` | `db/schema.ts:2059-2065` |
| `social_signals` | `sourceCampaignId`, `sourcePublicationId`, `sourcePublicationReceiptId`; deterministic `signalKey` | `db/schema.ts:1692-1694,1651-1654` |
| `opportunity_handoffs` | exact-once R6 envelopes: `envelope` JSON + `evidenceSnapshotHash`, unique `(userId, opportunityId)` | `db/schema.ts:2283-2299` |

## 9. Exact-once / idempotency house patterns to reuse

| Pattern | Implementation | Tables using it |
|---|---|---|
| Insert-first + `ER_DUP_ENTRY` reread | `api/lib/audit/audit-store.ts:206-226` (raced insert re-read + verified → `idempotent_replay`); `isDuplicateKeyError` walks `cause` chain (`:59-72`); credit reservation store settles/releases via guarded conditional UPDATE, "the guard is the concurrency authority" (`api/lib/billing/credit-reservation-store.ts:294-295,384-385`); policy decision convergence on duplicate (`api/policy-router.ts:157-187`) | `audit_events`, `credit_reservations`, `policy_decisions` |
| Deterministic sha256 ids | `buildObservationId` (`api/lib/workflow/post-live-metrics-observation-pass.ts:173-188`); `signalKey` (`db/schema.ts:1651-1654`); `opportunityKey` tenant-anchored thread hash (`db/schema.ts:2100-2104`); `reservationId` (`db/schema.ts:1331-1332`); `eventFingerprint` (`db/schema.ts:1597-1599`); `engagementReceiptId` (`db/schema.ts:2057`); `policyDecisionId` (`db/schema.ts:1879`) | `analytics`, `social_signals`, `opportunity_candidates`, `credit_reservations`, `audit_events`, `engagement_receipts`, `policy_decisions` |
| CAS version guards | guarded UPDATE `version = expectedVersion + 1 WHERE version = expectedVersion`, stale write rejected (`api/lib/opportunity/opportunity-store.ts:346-373`); `version` column declared "Optimistic CAS guard" (`db/schema.ts:2160-2161`) | `opportunity_candidates` |
| Immutable append-only rows | "Rows are immutable after acceptance — there is no update path" (`db/schema.ts:1646`); opportunity evidence "No update path — evidenceHash proves byte-stability; drift fails closed" (`db/schema.ts:2182-2185`); policy decisions durable-immutable with unique `decisionScopeKey` convergence (`db/schema.ts:1886-1888,1918`) | `social_signals`, `opportunity_evidence`, `policy_decisions`, `audit_events` |

R6-E conversion persistence should mirror these: deterministic server-minted
identity + unique convergence scope, insert-first with duplicate-reread,
append-only rows, guarded lifecycle transitions.

## 10. Overlap-risk files (do not regress)

| File / area | Risk | R6-E posture |
|---|---|---|
| `db/schema.ts` | Shared by all streams | **Append-only** — new tables only; no edits to existing tables. |
| `db/migrations/` + `db/migrations/meta/` | Canonical chain ends at idx 33 (`0033_opportunity_detection_foundation`) | Provisional `0034` artefact + journal idx 34 appended for parity; **never executed**; R6-X/integration owns canonical re-sequencing if streams collide. |
| `api/router.ts` | Root `appRouter` registration (`api/router.ts:33,54+`) | Additive: register one `conversion` router alongside existing routers. |
| `api/lib/audit/audit-event.ts` | `AUDIT_EVENT_TYPES` taxonomy (`api/lib/audit/audit-event.ts:34-70`) | Additive enum value(s) only (per-stream precedent documented in-file); sanitisation rules unchanged. |
| `api/analytics-router.ts` | Existing manual metric path (`api/analytics-router.ts:93-125`) | **Untouched** — learning and KPI consumers depend on current semantics; conversions are a new ledger, not a change to metric rows. |
| `api/lead-router.ts` | Won-transition quota increment (`api/lead-router.ts:124-141`) | **Untouched** — `successfulResults` counter stays the freemium quota mechanism. |
| `api/campaign-router.ts` | Completion increment (`api/campaign-router.ts:718-736`) | **Untouched**. |
| `api/lib/billing/*` | R4 credit/billing authority (`credit-engine.ts`, `credit-reservation-*.ts`, `cost-*.ts`) | **Untouched** — read-only boundary; R6-E never charges or settles. |
| `api/lib/opportunity/*` | R5-D candidate/evidence/handoff authority | **Untouched** — read-only provenance references only. |
| `api/lib/learning/*` | Consumes `analytics` rows (`api/lib/learning/contracts/observation.ts`) | **Untouched** — conversion ledger is a new evidence source, not a replacement. |
| `api/lib/governance/r5-operations-projection.ts` | R5-F single-projection pattern | Read as the pattern reference; R7 projection is additive and separate. |

---

*Evidence gathered on `feature/r6-e-conversion-tracking` at base `a947ecb`;
all file:line citations verified against working-tree sources.*
