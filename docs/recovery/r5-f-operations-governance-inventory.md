# WBS-R5 STREAM F (F0) — OPERATIONS GOVERNANCE / OBSERVABILITY INVENTORY

> **Stream:** R5-F Marketing Operations Governance / Observability
> **Branch:** `feature/r5-f-operations-governance`
> **Common base:** `e4493a8` (R4 `FULL_AUTONOMY_V1_READY` acceptance commit)
> **Date:** 2026-10-24
> **Status:** F0 inventory — input to F1–F8

This document inventories every existing capability relevant to R5
operational governance and observability, records what R5-F reuses, and
identifies gaps, overlap risks and schema implications. It is the F0
deliverable required by the stream charter.

---

## 1. R5 programme position at inventory time

| Branch | Tip vs base `e4493a8` | State |
|---|---|---|
| `feature/r5-a-social-listening` | 2 commits ahead | A0 inventory + A1 canonical signal contract + unexecuted schema artefacts |
| `feature/r5-b-intent-sentiment` | 0 | label on base; no artefacts |
| `feature/r5-c-autonomous-engagement` | 0 | label on base; no artefacts |
| `feature/r5-d-opportunity-detection` | 0 | label on base; no artefacts |
| `feature/r5-e-policy-safety-cost` | 0 | label on base; no artefacts |
| `integration/r5-marketing-operations` | 0 | placeholder cut at the R4 acceptance commit |

Only **R5-A** has produced artefacts. Its contract
(`docs/contracts/social-signal-contract.md`, inspected from branch ref)
declares:

- R5-A owns **signal acquisition and normalization only**; `status` of a
  signal is `accepted` and nothing else.
- Identity: `signalKey = "sigv1:" + sha256(provider | providerAccountId | externalEventId)`;
  natural key `(provider, providerAccountId, externalEventId)`; immutable rows.
- Listening failure taxonomy (new, A-owned):
  `AUTO_RECOVER | OPERATOR_ACTION | FAIL_CLOSED`.
- Listening state per `social_integrations` binding: `mechanism
  webhook|polling|unsupported`, `status active|blocked|unsupported|stale`,
  counters `accepted/duplicate/rejected`, `lastFailureClass`,
  `lastFailureCode`, `lastFailureReason`.
- New unexecuted schema (migration `0029`, generated NOT executed):
  `social_signals`, `social_listening_states`.

**Implication for F:** B/C/D/E state does not exist yet anywhere. F's
projection must derive from (a) R4 durable authorities that exist on the
common base and (b) A's listening evidence via a **guarded, schema-free
read boundary** (information-schema check + narrow raw-SQL DTO), so F
neither duplicates A's schema nor breaks when A's migration has not run.
For not-yet-landed streams (B interpretation, C engagement, D
opportunity, E policy engine) the projection surfaces the area as
`unsupported`/`unavailable` — honestly, never guessed.

## 2. Reusable R4 patterns (verified on base)

### 2.1 Middleware / authority

`api/middleware.ts`:

- `publicQuery`, `authedQuery` (= `requireAuth`: `ctx.user` **and**
  `ctx.session.verified`), `adminQuery` (= `authedQuery` + `role === "admin"`).
- Rate limiters for public/user/AI/publish paths.

There is exactly one privileged role (`users.role = "admin"`); there is no
separate operator role and no impersonation. R5-F operator surface =
verified admin session, same as R4-F.

### 2.2 Audit authority (consume, do not rebuild)

- `api/lib/audit/audit-event.ts` — `createAuditEvent` (pure, caller-stamped,
  deep-frozen), `sanitizeAuditMetadata` (key-level secret redaction),
  `buildAuditEventFingerprint` (SHA-256, key-sorted).
- `api/lib/audit/audit-store.ts` — `persistAuditEvent(event, executor?)`,
  fingerprint-unique durable ledger; exact replay = `idempotent_replay`;
  same fingerprint with different content = `AUDIT_FINGERPRINT_CONFLICT`
  (fail closed).
- `api/lib/governance/admin-audit.ts` — `recordAdminMutationAudit`:
  closed vocabularies `ADMIN_AUDIT_ACTIONS` (20 actions) and
  `ADMIN_AUDIT_TARGET_TYPES` (12 types); fails closed on invalid actor /
  unknown action / unknown target; optional tx executor so mutation +
  audit commit or roll back as one unit.

### 2.3 Read-model / projection pattern

`api/lib/governance/lifecycle-projection.ts` (R4-F3, the direct predecessor
of F1):

- `projectCampaignLifecycle({ campaignId, executor?, now? })` — actor-agnostic,
  deterministic (explicit clock), read-only; derives from durable tables
  only; introduces **no second mutable lifecycle state machine**.
- Vocabulary: `LIFECYCLE_PROJECTION_HEALTH = ok|blocked|inconsistent|unavailable`;
  `BLOCKER_RECOVERABILITIES`; `SAFE_NEXT_ACTIONS` (both closed vocabularies).
- `deriveLifecycleBlocker(evidence)` — pure function, zero I/O.
- Honesty invariants: missing authority → `unavailable`, conflicting
  authority → `inconsistent`, never guessed.
- Cross-user visibility is the **caller's** decision (lib never receives
  client ownership). Admin router reads any campaign; user surfaces scope
  by owner before calling.

### 2.4 Recovery surfaces already governed (R4)

| Surface | Authority | Idempotency |
|---|---|---|
| Terminal replay D1/D2/D3 (`admin.requestTerminalReplay` / `executeTerminalReplay` / `reconcileTerminalReplays`) | `api/lib/queue/terminal-replay*.ts` | `replayKey` unique + `queue_replay_active_claims` mutex |
| Budget-pause resume (`admin.resumeBudgetPausedCampaign`) | `api/lib/workflow/budget-resume.ts` | exact-identity claim; `already_resumed` |
| Stale creative claim sweep (`admin.sweepStaleCreativeClaims`) | `api/lib/creative/creative-stale-claim-sweep.ts` | conditional UPDATE; re-run is a no-op |
| Next-cycle retry (`autonomousWorkflow.retryNextCycleDispatch`) | `dispatchNextCycleInstruction` / `retryFailedNextCycleInstruction` (CAS on exact instructionId) | malformed → refused; `dispatched` → noop |
| Publishing queue retry semantics | `publishing_queue.status` incl. `retrying`, `retryCount`, `nextRetryAt` | state-based |

All are admin-gated, kill-switch or env-gated where dangerous, audit every
mutation, and map errors through bounded mappers that never leak internals
(`mapTerminalReplayError` pattern).

### 2.5 Health / alerting surface

`api/health-router.ts`:

- `getSystemHealth` (public): db, redis, worker, post-live schedulers, api.
- `getQueueHealth`, `getAIUsageHealth`, `getPublishingHealth`,
  `listAlerts`, `acknowledgeAlert`, `resolveAlertCategory`,
  `getAlertSummary` (admin).
- `api/lib/alerts.ts`: dedup'd `system_alerts` (one unresolved per category
  per hour), bounded summaries.

### 2.6 Tenancy idiom

No shared tenancy helper: every user-scoped query chains
`and(eq(resource.id, …), eq(resource.userId, ctx.user.id))`. Operator
surfaces re-derive ownership from durable rows (`campaigns.userId`), never
from client input.

### 2.7 Operator contract precedent

`docs/GOVERNANCE_AND_OPERATOR_CONTRACT.md` (R4-F) — §5 lists governed
actions; §6 forbids force-complete / force-approve / arbitrary state
setters / audit-optional paths; §10 tells integrators to register new
durable authorities in the projection evidence and extend vocabulary +
contract together. R5-F follows the same discipline.

## 3. Durable authorities the R5 projection can read today

All present in `db/schema.ts` on the common base (no R5 migration needed):

| Area | Tables (columns that matter) |
|---|---|
| Business / tenant | `businesses` (`id`, `userId`), `campaigns` (`businessId`, `userId`, `workflowState`, `workflowContext`, `status`) |
| Listening (A) | `social_integrations` (`platform`, `status connected|expired|disconnected`, `businessId`); **A-branch:** `social_listening_states`, `social_signals` |
| Interpretation (B) | none yet → `unsupported` |
| Engagement work (C) | `publishing_queue` (`status` incl. `retrying`, `failed`, `safety_blocked`, `pending_approval`), `campaigns.workflowState`, `agent_runs` |
| Opportunity (D) | no D artefacts yet; R4 proxy evidence: `learning_promotion` proposal carrier approvals (`approval_requests`), `learning_records` |
| Policy / approval (E) | `approval_requests` (`approvalType` incl. `sensitive_reply`, `high_value_proposal`; `status pending|approved|rejected|edited`; `riskLevel`) |
| Queue / recovery | `queue_terminal_failures` (`terminalReason`, `status open`), `queue_replay_requests` (`status requested→failed`), `queue_replay_active_claims` |
| Billing / quota | `credit_wallets`, `credit_reservations` (`state reserved|settled|released`), `user_usage` (`campaignsCreated`, `successfulResults`), `subscription_tiers` (`maxCampaigns`, `maxResults`, …), `campaigns.workflowContext.costPause` |
| Provider readiness | `social_integrations.status` |
| Work claims | `creative_generation_claims`, `image_render_claims` (lease + stale sweep) |
| Alerts | `system_alerts` |
| Ledger | `audit_events` (fingerprint-unique) |

## 4. R5-specific gaps (what F must add)

1. **No business-scoped operational projection.** R4's projection is
   campaign-scoped. R5 operators need one business-scoped read model
   aggregating listening → interpretation → policy → engagement →
   opportunity → billing/quota → provider readiness.
2. **No R5 health classification.** Need `HEALTHY / DEGRADED /
   BLOCKED_OPERATOR / BLOCKED_CONFIGURATION / AUTO_RECOVERING /
   UNSUPPORTED / FAIL_CLOSED` over a business's R5 operations.
3. **No controlled blocker/recovery taxonomy for R5.** A defines listening
   classes only. F must own the cross-stream blocker classes and recovery
   classifications (AUTO_RECOVER / OPERATOR_ACTION / FAIL_CLOSED /
   GOVERNANCE_APPROVAL) as pure policy.
4. **No R5 readiness surface on health endpoints.** Queue/AI/publishing
   health exist; R5 component readiness does not.
5. **No operator read endpoints for R5 questions** (the ten F4 questions).
6. **No R5-specific governed recovery adapter.** Existing recoveries are
   campaign- or queue-shaped; F adds a narrow, evidence-backed operator
   retry over existing authorities with staleness + convergence semantics.
7. **No acceptance harness** wiring fixture states → projection →
   classification → operator read → recovery → audit → updated projection.

## 5. Overlap-risk files (coordinate before changing)

| File | Risk |
|---|---|
| `api/admin-router.ts` | R4-F operator surface; F adds a separate `operations` router instead of growing this further |
| `api/health-router.ts` | F extends with an R5 readiness procedure (admin-gated) |
| `api/lib/governance/admin-audit.ts` | F extends `ADMIN_AUDIT_ACTIONS` / `ADMIN_AUDIT_TARGET_TYPES` closed vocabularies (additive only) |
| `api/lib/governance/lifecycle-projection.ts` | F consumes, does not modify |
| `api/router.ts` | F registers one new `operations` router |
| `db/schema.ts` | **F does not modify** (no migrations in this stream) |
| `api/lib/social-listening/*` (A-branch) | A-owned; F reads via schema-free guarded DTO only |
| `api/middleware.ts`, `api/context.ts` | sufficient as-is; F does not modify |

## 6. Sensitive-data exposure assessment (pre-build)

Potential exposure channels and the control F applies:

- **Provider credentials/tokens:** `social_integrations` token columns must
  never be selected by the projection; DTO selects explicit columns only.
- **Raw social payloads:** A's `social_signals.contentText` is
  provider-derived content — projections expose counts/freshness only, no
  content. Justified evidence stays bounded in A-owned stores.
- **Secrets in audit metadata:** reuse `recordAdminMutationAudit` + canonical
  sanitizer; allow-listed metadata only.
- **Error internals:** bounded error mapping (R4 `mapTerminalReplayError`
  pattern); no raw exception text leaves the server.
- **Cross-business visibility:** operator reads are admin-scoped by design;
  user surfaces keep inline owner scoping. Adversarially tested (F8).

## 7. Schema implications

**No schema changes required for F1–F8.** The projection is read-only over
existing authorities plus a schema-free guarded read of A's listening
tables. Recovery reuses existing governed services; convergence is derived
from durable state (conditional updates + existing idempotency keys), not
new tables. Migration artefacts: **none created by F**. If a later stream
adds durable R5 authorities, register them in the projection evidence and
extend the contract (R4 §10 discipline).

## 8. Test approach (matches repo idiom)

- Pure derivation: unit tests over evidence fixtures (no DB), mirroring
  `lifecycle-projection.test.ts`.
- Router/service tests: `vi.mock` the connection module with an in-memory
  drizzle evaluator (pattern from `api/admin-operator-control-plane.test.ts`),
  plus module mocks for governed services — no live MySQL, no live Redis,
  no live providers.
- F8 acceptance: one deterministic harness file covering the 24 charter
  checks end-to-end at the tRPC caller boundary.
