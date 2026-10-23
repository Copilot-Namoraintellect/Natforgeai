# WBS-R4E Stream E Final Report — FINANCIAL AUTONOMY / RELIABILITY / SELF-HEALING

> **Branch:** `feature/r4-e-financial-reliability`
> **HEAD:** `41fdadfeab70cb833f122cf298039c6acc064009`
> **Common base:** `2f21a8fc959070b79cfb9c237a5b87922dc42f08`
> **Stream A contract consumed:** `docs/recovery/r4-core-lifecycle-contract.md` @ `e981e3a` (read from the Stream A branch; not merged)
> **Date:** 2026-06-29

## Verdict

**FINANCIAL_RELIABILITY_READY**

## Commits (all pushed to `origin/feature/r4-e-financial-reliability`)

| Commit | Subject |
|---|---|
| `75e7b3e` | fix(billing): make budget resume recheck reachable and harden cost pause |
| `7f3ad1d` | fix(publishing): key the publishing charge by queue item identity |
| `12cda81` | fix(video): key premium-video charge and enforce feature flags fail closed |
| `b471546` | fix(engagement): event-stable billing identity for webhook replies |
| `874c9c1` | feat(billing): governed reaper for stale credit reservations |
| `2cfd1d2` | feat(agents): extend stale-run terminalisation to all workflow agent types |
| `198070b` | fix(campaign): reconcile the Stream A strategy charge gap on campaign create |
| `7926218` | fix(image): make the legacy image worker-failure refund live and add the budget gate |
| `ccfd231` | test(workflow): E3 budget autonomy acceptance — pause, top-up, exact resume |
| `fad1394` | docs(contracts): WBS-R4E financial reliability contract (E5) |
| `d53353a` | test(billing): E2 exact-once financial acceptance suite |
| `89c86e9` | docs(recovery): WBS-R4E financial autonomy matrix (E1) |
| `41fdadf` | chore(types): clean tsc for Stream E files |

## E1 — Financial autonomy matrix

**VERDICT: COMPLETE.** `docs/recovery/r4-e-financial-autonomy-matrix.md` inventories 14 billable /
externally-costly operation groups (strategy ×5 boundaries, creative, audience, distribution,
audience-intelligence, engagement, sales, publishing, safety check, legacy image, premium image,
premium/basic video, smoke test, unbilled provider surfaces, subscription grant) with all mandated
fields per row: initiating boundary, stable identity, reservation identity, quota/budget checks,
charge/settlement/release points, retry identity, crash windows, owning module, and sufficiency.

Matrix headline: 2 of 11 agent-chain operations were already reservation-governed (workflow
auto-audience, auto-distribution); this stream brought the other live double-charge surfaces under
stable identities (publishing, premium video, engagement webhooks, campaign-create strategy) and
documented the rest with dispositions.

## E2 — Exact-once financial acceptance

**VERDICT: COMPLETE.** `api/lib/billing/exact-once-financial-acceptance.test.ts` — 14 tests through
the real runner and the real reservation/ledger state machine, with a stateful wallet ledger that
only moves on actual settlement. All 12 mandated classes covered: duplicate workflow trigger;
retry before provider call; retry after provider success before DB ack; retry after charge
persisted; process restart; concurrent duplicate execution (deferred-promise interleave);
reservation already exists; reservation settled already; reservation released already;
stale/expired reservation (real reaper); partial operation failure (provider class → release,
charge-retained class → settle); refund/release replay. Plus an adversarial cross-user
identity-reuse guard (engine `RESERVATION_IDENTITY_CONFLICT`; runner maps to `PAYMENT_REQUIRED`;
first owner's charge untouched). Invariant asserted numerically: `totalDeducted` and wallet
balance move exactly once per logical operation.

## E3 — Budget / quota autonomy

**VERDICT: COMPLETE.** `api/lib/workflow/budget-autonomy-acceptance.test.ts` (7 tests) plus
`api/lib/billing/cost-control-resume-gate.test.ts` prove with the REAL production affordability
gate: insufficient credit → governed pause (durable provenance, exactly one budget approval);
top-up → exact-identity claim → exactly one continuation dispatch → pre-pause state restored →
no billing mutation in the resume cycle; replay after completed resume no-ops; crash after claim
before dispatch cannot double-execute; still-failing recheck keeps the pause without duplicating
the approval; cross-owner resume scope-isolated (returns null, pause untouched).

**Found and fixed (release-blocking):** the budget-resume affordability recheck called
`canRunAutonomousWorkflow` while the campaign was still `status="paused"`, and the gate rejected
every paused campaign — so an approved budget increase could never auto-resume in production
(every existing test injected a mocked gate, hiding it). Forward-dispatch gates (all pass a
`continuation`) still reject paused campaigns; bare affordability probes (no continuation) are now
gated on credits only. **No developer command is needed for normal budget resumption.**

## E4 — Self-healing / failure recovery

**VERDICT: COMPLETE.** Classification of every mandated failure class is in the matrix §E4:

- AUTO_RECOVER (implemented/preserved): stale strategy **and** non-strategy agent runs (the
  strategy-only reaper left audience/distribution settle-failure crashes stalled forever —
  extended with the same exact-once conditional write and 30-minute TTL); stale credit
  reservations (new governed reaper, deterministic `stale-reap:{reservationId}` key, integration
  wiring only because `api/boot.ts` is shared); interrupted schedulers / queue claim loss /
  worker restart (BullMQ re-queue + deterministic job ids, preserved); provider transient failure
  (runner release + idempotent retry, preserved); DB-commit-then-crash and
  provider-success-then-DB-ack-failure (identity replay, E2-proven); Redis lease expiry (CAS
  lease, preserved); budget exhaustion (E3-proven exact resume).
- FAIL_CLOSED (preserved/proven): uncertain image-render commits; terminal reservation
  transitions; malformed/foreign/refunded strategy charge evidence; unbound Stream A approval
  decisions.
- OPERATOR_ACTION / integration decision: subscription self-grant semantics, unscoped
  `publishDuePosts`, unsigned Creatify webhook, premium-leaflet claims activation. No uncertain
  failure was turned into a blind replay.

## E5 — Shared financial / reliability contract

**VERDICT: COMPLETE — committed and pushed before completion.**
`docs/contracts/financial-reliability-contract.md`: frozen billing-key registry, reservation
lifecycle, charge/settlement/refund semantics, Strategy billing identity, creative / audience /
distribution / engagement / publishing / video identities, retry identity rules, the
external-call safe pattern, budget pause/resume rules, self-healing classifications, crash-window
handling, the modules downstream streams must consume, overlap-risk files, security invariants,
and tracked residuals.

## Strategy charge-gap final disposition

**RECONCILED at every live boundary.** `strategy-run-${runId}` (frozen format, unchanged) now
covers: agent-router manual/agent runs, campaign-create auto-start (fresh runs charged,
reused runs reconciled — the previously uncharged live path), and both regeneration mutations
(unchanged). Charge is claim-first on the unique ledger key; reuse reconciles with fail-closed
evidence verification; billing faults fail soft so the lifecycle cannot strand. The one latent
boundary, `dispatchNextCycleInstruction` (no production caller), is documented with the required
treatment for when it is wired.

## Targeted tests added

- `api/lib/billing/cost-control-resume-gate.test.ts` (5) — resume-gate semantics, pause dedup/order
- `api/lib/billing/stale-reservation-reaper.test.ts` (5) — reaper classification, exact-once release
- `api/lib/workflow/__tests__/publishing-runner.test.ts` (+1) — `publishing:{queueItemId}` charge key
- `api/lib/creative/premium-video-billing.test.ts` (2) — keyed video deduction, already-charged short-circuit
- `api/video-router.test.ts` (5) — fail-closed feature-flag gates
- `api/lib/agents/__tests__/engagement-agent.test.ts` (+4) — event-stable billing identity
- `api/image-create-billing.test.ts` (4) — charge persisted, refund live, budget gate
- `api/lib/workflow/budget-autonomy-acceptance.test.ts` (7) — E3 cycle
- `api/lib/billing/exact-once-financial-acceptance.test.ts` (14) — E2 invariant
- Extended: `cost-control-cost-pause.test.ts`, `stale-strategy-run.test.ts`, `campaign-router.test.ts`, `triggers.test.ts`

## Regression

Full suite (`vitest run`, DATABASE_URL set): **4475 passed, 65 skipped, 5 failed** under full
parallelism. Failure analysis:

- `approval-decision-audit.test.ts > strategy_review still validates lineage…` — fails
  identically on the pristine base `2f21a8f` in the same environment (verified in a temporary
  worktree): pre-existing, unrelated to Stream E.
- The other four (`publishing-router` one-off post at 10072ms, two `creative-agent-lineage` at
  10027ms/580ms, `terminal-content-replay-executor` binding idempotency) are 10-second
  testTimeout flakes under full parallel load on this machine: all three files pass in
  isolation (63/63), as do all other previously-flaky candidates re-run the same way.

Targeted isolation: every Stream E test file passes, including the E2 (14/14), E3 (7/7),
reaper, engagement, video, image, and charge-key suites.

Type check (`tsc -b`): clean for every Stream E file. The only remaining errors are two in
`api/lib/workflow/__tests__/autonomous-closed-loop-acceptance.test.ts`, a file byte-identical
to the base, and `npx tsc -b` on a pristine-base worktree reports exactly those same two
errors — pre-existing type drift, zero new errors introduced by Stream E.

## Security report

SECURITY_VERDICT=PASS
SECURITY_CONTROLS_CHANGED=cost-control pause dedup + provenance-before-clobber order; canRunAutonomousWorkflow probe-vs-dispatch gate semantics; publishing/video/engagement/strategy-create billing identity keys; server-side fail-closed video feature flags; live image worker-failure refund; stale-hold governed reaper; stale-run reaper extended to all workflow agent types
SECURITY_TESTS_ADDED=E2 exact-once suite (14, incl. cross-user identity-reuse guard); E3 budget autonomy (7) incl. cross-owner scope isolation; cost-control resume-gate (5); engagement/video/image/publishing key tests (16)
SENSITIVE_DATA_EXPOSURE_FOUND=False
AUTHORIZATION_REGRESSION_FOUND=False (billing endpoints keep authedQuery/aiActionQuery/adminQuery scoping; no router accepts client-supplied billing identity — verified by grep)
NEW_SECURITY_DEBT=subscription.subscribe trusts client confirmedByWebhook (pre-existing, product semantics — integration-owner decision); publishing.publishDuePosts global due-scan reachable by any authed user (recommend admin gate); Creatify webhook signature unverified (bounded to attacker's own jobs); safety-check provider failure keeps its 1-credit charge; unbilled LLM surfaces listed in the contract; audience-intelligence retry re-charge until its key is plumbed (below)

## Unresolved integration dependencies (none blocking Stream C)

1. **Audience-intelligence billing identity** — key format fixed in the contract
   (`agent-audience-intel-${sha256(...)}`); minting requires passing a per-step key from dispatch
   sites in Stream A consume-only files (`triggers.ts`, `budget-resume.ts`) — coordinate with
   Stream A at integration. Until then the agent's own up-front deduction can re-charge on a
   recovered retry (pre-existing; previously masked by a permanent stall).
2. **cost-control.ts semantic merge with Stream A** — Stream A's branch edits the same function
   (approval binding). Conflict is textual + ordering (provenance-first vs bind-after-insert);
   both semantics compose (dedup + binding + provenance-first). Integration owner merges.
3. **Reservation reaper wiring** — exported + tested; schedule from integration-owned `api/boot.ts`.

## Overlap-risk files

`api/lib/billing/cost-control.ts` (Stream A co-edits), `api/lib/workflow/budget-resume.ts` +
`triggers.ts` (Stream A consume-only — untouched by E), `api/lib/agents/runner.ts`,
`api/lib/agents/strategy-agent.ts` (frozen key), `api/lib/agents/creative-agent.ts` +
`api/lib/creative/service.ts` (Stream C internals), `api/lib/workflow/publishing-runner.ts`
(execution shared with Stream C), `api/lib/engagement/inbound.ts` + `engagement-agent.ts`
(pipeline semantics not owned by E), `api/campaign-router.ts` (Stream A callouts),
`api/video-router.ts` + `api/image-router.ts` (product-visible flags/refunds).

## May Stream C start?

**YES.** Stream C has no dependency on Stream E deliverables: the lifecycle entry points, queue
exports, and billing boundaries it consumes are unchanged in shape; the new key formats are
additive and frozen in the E5 contract for C to consume (not duplicate).

## git status

Clean (`git status --porcelain` empty at HEAD `41fdadf`). Every accepted commit was pushed
immediately; `origin/feature/r4-e-financial-reliability` == `41fdadf`.
