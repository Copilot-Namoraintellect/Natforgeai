# GOVERNANCE_AND_OPERATOR_CONTRACT — WBS-R4 Stream F

> **Scope:** NatForgeAI R4 Stream F (Governance / Operator Control Plane)
> **Branch:** `feature/r4-f-governance-operations`
> **Status:** committed with the F1–F5 acceptance suites referenced below.

This contract is the single integration reference for R4 streams that
need governance, audit, authorization-assurance or operator-visibility
behaviour from Stream F. It describes what exists, what is guaranteed,
and what other streams must not bypass.

---

## 1. Operator roles and authorization assumptions

| Assumption | Guarantee |
|---|---|
| There is exactly one privileged role: `users.role = "admin"`. There is **no** separate "operator" role and **no impersonation** (`adminQuery` in `api/middleware.ts`). | Operator endpoints require an authenticated, OTP/2FA-verified (`ctx.session.verified`) admin session. |
| Actor identity for every privileged action is `ctx.user.id` from the verified session. | The admin audit authority **fails closed** when no positive-integer actor is available; it never invents an actor. |
| The operator surface is **admin-scoped by design**: an operator may inspect any campaign (owner user id is surfaced as `campaign.userId`). | User surfaces remain strictly owner-scoped; the projection lib itself is actor-agnostic and never receives client ownership. |
| Admin acting on a user's resources continues **that user's workflow** via governed services; the owner id is always derived from a durable row, never from client input. | `resumeBudgetPausedCampaign` reads `campaigns.userId` server-side before delegating. |
| Tenant isolation is enforced inline (`and(eq(resource.id, …), eq(resource.userId, ctx.user.id))`) on every user mutation. Verified adversarially in `api/governance-acceptance.test.ts` (F5.3). | Cross-business access is rejected or owner-scoped inert. No broad admin bypasses were added. |

## 2. Lifecycle projection fields (read model)

Produced by `projectCampaignLifecycle({ campaignId, executor?, now? })`
(`api/lib/governance/lifecycle-projection.ts`), exposed read-only as
`admin.getCampaignLifecycle({ campaignId })`.

| Field group | Contents |
|---|---|
| `campaign` | `id`, `userId` (owner), `businessId`, `name`, `status`, `workflowState`, `approvalMode`, `autoPublish` |
| `lifecycle` | `phase` (engine workflow state), `phaseKnown` |
| `strategy` | `snapshotsFound`, `latestVersion`, `latestSnapshotId`, `latestCapturedAt`, `approvalLineageStatus` |
| `approvals` | `pendingCount`, `pendingTypes`, `latestDecision {type,status}` |
| `creative` | `runningClaims`, `staleRunningClaims`, `failedClaims`, `assetsByStatus` |
| `audience` | `latestAgentRunStatus`, `latestAgentRunAt` |
| `distribution` | `queueCounts` by publishing_queue status, `openTerminalFailures`, `openReplayRequests` |
| `publication` | `publishedCount`, `publishedWithExternalId`, `retryingCount` |
| `postLive` | `liveAt` (immutable anchor), `lastObservedAt` (max analytics date) |
| `learning` | `latestRecordAt`, `latestConfidence` |
| `promotion` | `openProposalCount` (learning-promotion carrier approvals) |
| `nextCycle` | `present`, `status` (ready/dispatched/failed) |
| `budget` | `costPaused`, `costPause` provenance, `openReservations`, `reservedCredits` |
| `lastAutonomousActivity` | max of last workflow transition, latest agent run, latest audit event, latest learning evaluation |
| `blocker` | `classification`, `reason`, `recoverability`, `safeNextAction` |
| `status` / `notes` | overall health (`ok`/`blocked`/`inconsistent`/`unavailable`) and honesty notes |

Guarantees: deterministic (explicit-clock pure derivation), read-only,
derived from existing durable authorities only — **no second mutable
lifecycle state machine**. Missing authority → `unavailable`;
conflicting authority → `inconsistent`; never guessed.

## 3. Blocker / recoverability classifications

`classification`: `none` | `blocked` | `inconsistent` | `unavailable`

`recoverability`:
`not_blocked` | `recoverable_operator_action` | `recoverable_user_approval` |
`recoverable_budget_resume` | `blocked_awaiting_user` |
`inconsistent_authority` | `unavailable`

`safeNextAction` (vocabulary mirrors exactly what the control plane can
surface): `none` | `inspect_pending_approval` | `request_terminal_replay` |
`await_terminal_replay` | `resume_budget_continuation` |
`await_budget_approval` | `inspect_publishing_queue` |
`sweep_stale_creative_claims` | `review_inconsistent_authority`

## 4. Audit requirements (canonical ledger)

- Every privileged/admin mutation records exactly one canonical
  `admin_mutation` event through `recordAdminMutationAudit`
  (`api/lib/governance/admin-audit.ts`) into the WBS7A/WBS7B
  `audit_events` ledger (`source: "admin"`).
- Inline mutations persist the audit event **in the same transaction**;
  an audit failure rolls the mutation back (no silent bypass).
  Service-delegated mutations audit after success with loud, retry-safe
  failure; failed governed steps record a best-effort `failed` event.
- Event content: authenticated actor, closed-vocabulary `action`,
  `targetType`, `targetId`, caller-supplied `occurredAt`, bounded reason,
  safe before/after metadata, advisory `requestId` (well-formed
  `x-request-id` only).
- Never recorded: passwords, tokens, provider credentials, connection
  strings, encrypted material, banking account numbers (metadata is
  allow-listed per call site plus WBS7A key redaction).

## 5. Governed recovery actions exposed (operator surface)

| Procedure | Governed service reused | Idempotency |
|---|---|---|
| `admin.getCampaignLifecycle` | `projectCampaignLifecycle` (read-only) | n/a |
| `admin.requestTerminalReplay` / `executeTerminalReplay` / `reconcileTerminalReplays` | existing queue replay authorities (kill-switch gated, pre-R4-F) | `replayKey` unique + guarded transitions |
| `admin.resumeBudgetPausedCampaign` | `resumeWorkflowAfterApprovedCostIncrease` | exact-identity claim; `already_resumed` |
| `admin.sweepStaleCreativeClaims` | `sweepStaleCreativeGenerationClaims` (terminalization only) | conditional UPDATE; re-run is a no-op |

Every action: authenticates, authorizes (admin), validates input,
re-authorizes the target, audits, and returns bounded secret-free errors.

## 6. Forbidden / manual-override actions (do not add)

- force-complete / force-approve / force any workflow phase
- arbitrary workflow-state setters or generic "update campaign state" ops
- arbitrary database mutation endpoints
- approval-decision fabrication or stale-approval "repair" into approvals
- client-supplied payment/confirmation flags (the `subscription.subscribe`
  `confirmedByWebhook` backdoor is closed in this stream)
- audit-optional privileged paths

The acceptance suite asserts no `force|override|setState` procedure
exists on the admin router (F5.11).

## 7. Security invariants

- Fail closed by default; least privilege; strict tenant isolation.
- Never trust client-supplied ownership; re-authorize every referenced
  resource; parameterized ORM only.
- Canonical audit actor always required; secrets never enter audit
  payloads; errors never leak internals (bounded mapping).
- Admin user listing projects explicit safe columns (no password hashes
  or provider linkage identifiers).
- Privileged mutations are retry-safe (fingerprint-deduplicated ledger,
  idempotent governed services).

## 8. APIs / modules integration should consume

| Need | Consume |
|---|---|
| Record a privileged mutation | `recordAdminMutationAudit` (`api/lib/governance/admin-audit.ts`) |
| Campaign status / blocker | `projectCampaignLifecycle` / `admin.getCampaignLifecycle` |
| Resume after budget approval | `resumeWorkflowAfterApprovedCostIncrease` (`api/lib/workflow/budget-resume.ts`) — do not reimplement |
| Terminal failure recovery | queue replay modules under `api/lib/queue/terminal-replay*` |
| Stale creative claims | `sweepStaleCreativeGenerationClaims` (`api/lib/creative/creative-stale-claim-sweep.ts`) |
| Blocker vocabulary | `deriveLifecycleBlocker` (pure; reuse instead of inventing) |

## 9. Shared files likely to overlap another R4 stream

- `api/admin-router.ts` — operator surface (replay plane owned with
  recovery stream work; F added lifecycle/resume/sweep + replay audits).
- `api/lib/audit/audit-event.ts` — taxonomy gained `admin_mutation`.
- `api/banking-router.ts`, `api/billing-router.ts`, `api/health-router.ts`,
  `api/integration-router.ts`, `api/subscription-router.ts` — audit hooks
  and the subscription fail-closed fix (billing-adjacent; security-driven,
  semantics preserved).
- `api/autonomous-workflow-router.ts` — **not modified** by F; its
  `getWorkflowStatus` remains the user-facing status read. F3/F4 serve
  the operator/admin surface instead of extending it.
- `db/schema.ts` — **not modified** (no migrations in this stream).

## 10. Integration dependencies

- None blocking. The projection consumes only existing durable tables.
- If another stream adds a new lifecycle authority (e.g. a new durable
  blocker store), register it in `lifecycle-projection.ts` evidence and,
  if operator-actionable, extend the `SafeNextAction` vocabulary +
  contract together.
- The pre-existing typecheck debt in
  `api/lib/workflow/__tests__/autonomous-closed-loop-acceptance.test.ts`
  and one pre-existing case in `api/approval-decision-audit.test.ts`
  exists on the base commit and is unrelated to Stream F.
