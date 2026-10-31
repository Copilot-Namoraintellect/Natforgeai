# R9-D Execution Coordination — Execution Authority Inventory (D0)

> **Stream:** R9-D Execution Coordination (`feature/r9-d-execution-coordination`)
> **Programme base:** `4fc43c3b252baa81906cd409ca2ec290baa77825`
> **Date:** 2026-11-10
> **Purpose:** inspected-before-editing inventory of every existing execution
> surface, upstream authority and side-effect protection relevant to R9-D.
> Nothing here was merged from the frozen R9 streams; upstream code was read
> by branch ref only.

---

## 1. Frozen upstream authorities (consumed read-only, never merged)

| Authority | Frozen HEAD | Surface R9-D consumes | Classification |
|---|---|---|---|
| R9-A Mission Authority | `273ce4074b48d80923325b099a03d36fdee030bb` | `mission_proposals` durable rows via guarded raw-SQL seam (mission currency, tenant/business match, validity window, closed status vocabulary) | REQUIRES_GOVERNANCE_BINDING (read-only consumption is safe; never mutated) |
| R9-B Mission Planning | `a358f53c3b46a2d137e039f50cd8bbed85ef3841` | `mission_plans` / `mission_plan_tasks` durable rows via guarded seam (task∈plan, plan currency, capability classification, constraint preservation) | REQUIRES_GOVERNANCE_BINDING (read-only) |
| R9-C Dependency & Scheduling | `1c5837fa7bbb59385a4ad65496fc4b3630026712` | `mission_schedules` + `mission_task_plan_snapshots` durable rows; frozen 20-key `mission-scheduling-to-execution/v1` projection semantics | REQUIRES_GOVERNANCE_BINDING (read-only) |
| R9-F Mission Governance | `1665d2f9c7fe59e825c403ce966b0ebdead3d385` | `mission_governance_decisions` + `approval_requests` durable rows; frozen `assertMissionActionConsumable` gate semantics (`mission-governance-to-execution/v1`) | REQUIRES_GOVERNANCE_BINDING (read-only; the gate is the sole execution-consumption authority) |

All four tables are **provisional on the frozen branches** (unexecuted `0037`
artefacts). R9-D re-implements the upstream reads behind guarded
information-schema checks (house seam pattern) so absence fails closed
(`EXECUTION_AUTHORITY_UNAVAILABLE`) instead of fabricating authority.

## 2. Existing execution surfaces in the repository

| Surface | Location | What it does today | Classification |
|---|---|---|---|
| Autonomous workflow engine | `api/lib/workflow/` (`engine.ts`, `next-cycle-dispatcher.ts`, `approval-continuation.ts`, `launch-approval.ts`, `publishing-runner.ts`) | AI marketing workflow engine: runs workflow cycles, dispatches publish steps, handles approvals/cost pauses | REQUIRES_GOVERNANCE_BINDING — a future R9-X adapter target (`INTERNAL_WORKFLOW`); R9-D never invokes it |
| BullMQ worker queue | `api/lib/queue/` (`bullmq.ts`, `content-generation-worker.ts`, `publishing-worker.ts`, terminal replay/reconciliation suite) | Background job processing with terminal-failure/replay reconciliation | REQUIRES_GOVERNANCE_BINDING for any mission-bound dispatch; not invoked by R9-D |
| Content generation job | `api/lib/jobs/content-generation-job.ts` | AI content generation job enqueue/dispatch | REQUIRES_GOVERNANCE_BINDING (`CONTENT` adapter class); not invoked |
| Publication idempotency | `api/lib/publish/publication-idempotency.ts`, `publication-receipt-store.ts` | Existing publication attempt idempotency + immutable receipts — the conceptual ancestor of R9-D dispatch intent/attempt | SAFE_REUSABLE (pattern); publication flows themselves REQUIRES_GOVERNANCE_BINDING (`SOCIAL`/`CONTENT`) |
| Publishing pre-validation | `api/lib/publish/pre-publish-validation.ts` | Provider-publish pre-validation | REQUIRES_GOVERNANCE_BINDING (`SOCIAL` adapter); not invoked |
| Campaign activation | `api/campaign-router.ts` (`status` update draft→active) | Direct campaign status mutation with freemium limit checks; **no mission governance binding** | LEGACY_BYPASS — pre-mission-control surface; R9-D must not route around it; a governed `CAMPAIGN` adapter is the future binding point |
| CRM lead mutations | `api/lead-router.ts` | Direct lead CRUD + pipeline status | LEGACY_BYPASS — future `CRM` adapter target; not invoked |
| Platform integration adapters | `api/lib/integrations/adapters`, `oauth.ts`, `webhook-authenticity.ts` | Meta/LinkedIn OAuth + publish adapters, webhook verification | REQUIRES_GOVERNANCE_BINDING (`SOCIAL` adapter class); credentials resolved server-side already — pattern reused for D10 secret isolation; no live call from R9-D |
| Agent runner | `api/lib/agents/` (distribution/engagement/creative runners) | AI agent execution with billing identity | REQUIRES_GOVERNANCE_BINDING; not invoked |
| Approval ledger | `approval_requests` (+ OTP review authority, `review_authorization`) | Durable governed approval ledger reused by R6-C/R7-F/R8-F/R9-F | SAFE_REUSABLE (read-only via seam; R9-F owns writes) |
| Canonical audit ledger | `api/lib/audit/audit-event.ts`, `audit-store.ts` | Immutable, fingerprinted, insert-first audit events | SAFE_REUSABLE (R9-D adds `execution_*` material event types) |
| Canonical hashing | `api/lib/conversion/conversion-contract.ts` (`canonicalJson`, `sha256Hex`) | Key-sorted canonical JSON + SHA-256 | SAFE_REUSABLE |
| In-memory fake DB harness | `api/r5-test-support.ts` + harness pattern from R5–R8 acceptance suites | Durable unique-index-replicating fake for offline connected acceptance | SAFE_REUSABLE |
| Billing/settlement | `api/lib/billing*`, R4 authorities | Money movement | NOT_APPLICABLE — R4 owns; R9-D never touches |
| Strategic intelligence R8 | `api/lib/strategic-*` | Mission inputs only | NOT_APPLICABLE — R9-A owns consumption |
| Mission governance R9-F | `api/lib/mission-governance/` (frozen branch) | Execution authorization decisions | NOT_APPLICABLE as ownership — consumed read-only through the gate |
| Retry governance / recovery | — (R9-F owns retry authorization policy; R9-E future) | R9-D emits retry/recovery **candidate state only** | NOT_APPLICABLE as ownership |

## 3. Side-effect protections already present (reused patterns)

- **Insert-first + durable unique anchors + replay convergence** — every R5–R8
  authority stream (`persistAuditEvent`, R6 identity intake, R7 outcome
  records, R8 memory records). R9-D applies the same discipline to dispatch
  intents and attempts.
- **Optimistic CAS (`version`) on mutable rows** — R8 lifecycle stores; reused
  for dispatch-state transitions.
- **Immutable-row hash assertions (`*_TAMPER`)** — R7/R8 stores; reused as
  `EXECUTION_TAMPER` for attempt/action rows.
- **Secret hygiene** — integration adapters resolve OAuth tokens server-side
  and never expose them in UI/payloads; `createAuditEvent` metadata hygiene
  strips sensitive keys; R9-D extends this with an explicit secret-key
  rejection boundary on action material.
- **Approval exact-binding (F5-style)** — R6-C/R7-F/R8-F/R9-F all bind
  `approvalBindingHash`; R9-D consumes R9-F's binding verbatim and never
  re-derives approval authority.

## 4. Gaps this stream must close

1. No governed dispatch intent existed between "schedule READY" and provider
   invocation — R9-D creates it (D4).
2. No execution-attempt identity or conservative result classification existed
   — R9-D mints `exr1:` attempts and classifies SUCCEEDED / FAILED_RETRYABLE /
   FAILED_FINAL / PENDING_EXTERNAL / UNCERTAIN (D7).
3. No closed adapter registry — R9-D adds the server-controlled boundary (D5).
4. No R9-E recovery projection — R9-D adds the read-only
   `mission-execution-to-state-recovery/v1` handoff (D11).

## 5. Posture

- `LIVE_EXECUTION=False` — no real provider/CRM/payment calls; fake/in-memory
  adapters only (D6).
- `MIGRATION_EXECUTION=False` — provisional `0037_r9_d_execution_coordination_foundation`
  is an artefact only; R9-X owns canonical convergence; canonical R8 `0036`
  untouched.
- No merge of R9-A/B/C/F/E/X; frozen refs consumed by branch ref only.
