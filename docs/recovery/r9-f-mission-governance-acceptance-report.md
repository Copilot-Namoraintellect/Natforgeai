# R9-F — Mission Governance & Approval Acceptance Report (F10)

> **Stream:** WBS-R9 Stream F — Mission Governance & Approval
> **Branch:** `feature/r9-f-mission-governance`
> **Programme base:** `4fc43c3b` · **Frozen upstream:** R8 Strategic
> Intelligence (`STRATEGIC_INTELLIGENCE_V1_READY`, HEAD
> `4fc43c3b252baa81906cd409ca2ec290baa77825`) — consumed frozen, never merged
> from, never altered.
> **Date:** 2026-11-10

## FINAL VERDICT

```
MISSION_GOVERNANCE_READY
```

```
SECURITY_VERDICT=PASS
MISSION_GOVERNANCE_INTEGRITY_VERDICT=PASS
RISK_INTEGRITY_VERDICT=PASS
APPROVAL_INTEGRITY_VERDICT=PASS
EXECUTION_AUTHORIZATION_VERDICT=PASS
RETRY_GOVERNANCE_VERDICT=PASS
RECOVERY_GOVERNANCE_VERDICT=PASS
TENANT_ISOLATION_VERDICT=PASS
BUSINESS_ISOLATION_VERDICT=PASS
AGENT_ISOLATION_VERDICT=PASS
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS
TOOL_LEAST_PRIVILEGE_VERDICT=PASS
CROSS_AGENT_TRUST_VERDICT=PASS
SELF_MODIFICATION_GUARD_VERDICT=PASS
SECRET_ISOLATION_VERDICT=PASS
PRIVILEGE_ESCALATION_FOUND=FALSE
ROGUE_AGENT_BLAST_RADIUS=NONE (no execution surface exists in the stream)
UNRESOLVED_AGENT_SECURITY_DEBT=NONE
```

READY criteria check (forbidden if an agent can self-authorize, lower risk,
broaden approval scope, or execute outside exact authorization):

| Forbidden capability | Evidence |
|---|---|
| Self-authorize | OTP out-of-band proof; approval-row tenant binding; AC10/AC11 + security suite "self-authorization is impossible" |
| Lower risk | Server-derived class; raise-only declarations; semantic floors; AC15/16/17 + "risk integrity" suite |
| Broaden approval scope | Exact params-fingerprint + refs + subject binding; cross-subject/mission/plan/task/tenant/business all fail closed; AC4–AC13 |
| Execute outside exact authorization | Single gate `assertMissionActionConsumable`; no EXECUTE decision; no provider/billing/workflow imports (static blast-radius AC25) |

## 1. What was built

The authoritative mission-governance capability for Mission Control
(`api/lib/mission-governance/`, 11 modules; router `missionGovernance`):

- **F1 contract** — closed subject taxonomy (9 classes: MISSION_PROPOSAL,
  MISSION_PLAN, MISSION_SCHEDULE, TASK, EXECUTION_STEP, RETRY,
  RECOVERY_ACTION, CANCELLATION, ESCALATION), closed action taxonomy (20),
  decisions exactly `ALLOW / REVIEW_REQUIRED / BLOCK` — **no EXECUTE**.
- **F2 phase separation** — policy `autonomousPhases` (default:
  FORMULATION/PLANNING/SCHEDULING); execution + lifecycle subjects floor at
  REVIEW_REQUIRED; default **no phase escalation**; approval from one phase
  never authorizes another (proven AC4/AC5).
- **F3 risk classification** — deterministic, server-derived; declared
  dimensions (raise-only), action semantic floors (declarations cannot
  lower), ordered raise rules, injection raise; client/model can never set
  or lower risk.
- **F4 approval binding** — reuses the governed ledger
  (`approval_requests`, provisional `mission_action` enum extension) + the
  governed OTP primitive (purpose `review_authorization`); binding hash
  binds decision + policy version + action params fingerprint + risk class;
  forged/stale/cross-mission/cross-task/cross-tenant/cross-business/
  modified-action/self-approval all fail closed.
- **F5 receipts** — deterministic `mgd1:` identity (coordinates + policy +
  params fingerprint + summary + declaredRisk + retryContext); insert-only
  immutable rows; one `mission_governance_decision` audit event per inserted
  receipt; replay converges with zero extra events.
- **F6 consumption gate** — `assertMissionActionConsumable` is the single
  authority converter; verdict `authorityScope: "MISSION_ACTION"` for the
  exact bound action only; no client/agent/model ALLOW input exists.
- **F7 retry/recovery governance** — non-idempotent retries
  (`RETRY_NEW_SIDE_EFFECT_REVIEW`) and retries with altered parameters
  (`RETRY_SCOPE_BROADENED`) raise risk one level and floor at
  REVIEW_REQUIRED; recovery actions require fresh review; a failed/expired/
  rejected execution cannot broaden authority through retry or recovery.
- **F8 rogue-agent posture** — 18-case adversarial suite (below).
- **F9 downstream contract** — `docs/contracts/mission-governance-to-execution-contract.md`
  (`mission-governance-to-execution/v1`).
- **Schema** — `mission_governance_decisions` (canonical `@db/schema`) +
  enum extension; provisional `0037_r9_f_mission_governance_foundation`
  artefact set (SQL + snapshot + journal idx 37). **MIGRATION_EXECUTION =
  FALSE.** R8's canonical 0036 never modified; R9-X owns canonical 0037
  convergence.

Docs: `docs/recovery/r9-f-mission-governance-inventory.md`,
`docs/contracts/mission-governance-contract.md`,
`docs/recovery/r9-f-unexecuted-migrations.md`, AGENTS.md §31.

## 2. F10 — the 25 programme acceptance cases

Proven in `api/lib/mission-governance/r9-f-acceptance.test.ts` (32 connected
cases at the service layer over the in-memory fake; raw authority modules
never mocked):

| # | Case | Test |
|---|---|---|
| 1 | Low-risk mission proposal ALLOWs | AC1 |
| 2 | High-risk proposal REVIEW_REQUIRED | AC2 |
| 3 | Prohibited action BLOCK | AC3 (+ unknown subject/action) |
| 4 | Mission approval ≠ execution authority | AC4 |
| 5 | Plan approval ≠ different task | AC5 |
| 6 | Execution approval binds exact action | AC6 |
| 7 | Modified action invalidates approval | AC7 |
| 8 | Stale approval rejected | AC8 |
| 9 | Forged approval rejected | AC9 |
| 10 | Self-approval rejected | AC10 (+ OTP actor-binding) |
| 11 | Cross-tenant approval rejected | AC11 |
| 12 | Cross-business approval rejected | AC12 |
| 13 | Cross-mission approval rejected | AC13 |
| 14 | Model cannot return authoritative ALLOW | AC14 |
| 15 | Client cannot set risk | AC15 |
| 16 | Client cannot lower risk | AC15/16 (semantic floors) |
| 17 | Untrusted input raises, never lowers | AC17 |
| 18 | Retry cannot broaden authority | AC18 |
| 19 | Non-idempotent retry requires review | AC19 |
| 20 | Recovery requires fresh approval | AC20 |
| 21 | Provider action without gate fails closed | AC21 |
| 22 | Budget action without approval fails closed | AC22 |
| 23 | Receipt immutable | AC23 |
| 24 | Decision deterministic | AC24 |
| 25 | No production action occurs | AC25 (static blast radius) |

Plus: phase-floor autonomy suite, OTP challenge/verify lifecycle,
operations-projection truthfulness, revalidation drift, router surface
closure, policy-registry integrity.

## 3. Rogue-agent security suite

`api/lib/mission-governance/r9-f-security.test.ts` — 18 adversarial cases:
self-authorization (non-tenant minted approvals), pre-approval transaction
validation, risk floors (declared-false overrides, compound raises, scope
widening), nested-material smuggling, policy squatting/monotone violations,
receipt identity forgery, cross-decision rebind, risk-class tampering in
bindings, provider invocation without authorization, hidden-task
manufacture, retry manipulation, silent spend, tenant/business isolation,
R8-approval non-conflation (cross-agent trust), prompt-injection containment
(8 payload classes, raise-only), challenge-layer forgery.

## 4. Test evidence (all offline; no live DB, no network, no providers)

| Suite | Result |
|---|---|
| R9-F acceptance (`r9-f-acceptance`) | 32/32 PASS |
| R9-F rogue-agent (`r9-f-security`) | 18/18 PASS |
| R8-F strategic governance + tests | PASS (part of 197 below) |
| R7-F optimisation governance suites | PASS (part of 197 below) |
| Approval ledger (`approval-router`) | PASS (part of 197 below) |
| OTP/human approval (`auth/otp`) | PASS (part of 197 below) |
| Governance + approval + OTP batch | 197/197 PASS (13 files) |
| Audit ledger (`audit-event`) | 32/32 PASS (taxonomy extended with both R9-F event types) |
| Auth (`local-auth-router`) + qualification review + workflow replay | PASS (276/277 in batch; the 1 failure was the audit taxonomy expectation, fixed above) |
| `tsc -b` | CLEAN (exit 0) |
| `npm run build` (vite + esbuild + deploy verification) | PASS |
| `git diff --check` | CLEAN |
| Secret/PII scan of stream files | CLEAN (only test fixture tokens) |
| **Full offline suite (`vitest run`)** | 7274 passed / 1 failed / 68 skipped / 14 todo (7357 total, 443 files). The single failure (`r4-x6-full-autonomy-e2e` beforeEach hook timeout) is a CPU-contention flake: it passed 21/21 when re-run in isolation with the machine idle, and no R9-F change touches that path |

### Full-suite confirmation

```
FULL_SUITE: 7274 passed, 1 failed (environmental hook-timeout flake,
proven passing 21/21 in isolation), 68 skipped, 14 todo — 7357 tests,
443 files, 360s. No regressions attributable to R9-F.
FLAKE_REPRO: npx vitest run api/lib/workflow/__tests__/r4-x6-full-autonomy-e2e.test.ts
            → 1 file passed, 21/21 tests (idle machine).
NOTE: the suite was run concurrently with `npm run build` (esbuild/vite),
which starved the fake-timer hook budget; R4 E2E bootstrap is unrelated to
any R9-F file (zero workflow imports in the stream — asserted by AC25).
```

## 5. Boundaries honoured

- No branch switches; no merges of R9-A/siblings/R9-X; frozen R8 authority
  untouched (only additive code-level audit types + additive schema, same
  discipline as prior streams).
- No migration executed (`MIGRATION_EXECUTION=False`); no production access;
  no live provider/payment/billing/CRM invocation anywhere in the stream.
- Real-MySQL concurrency remains the R9-X / pre-production gate, as with
  R6/R7/R8 provisional migrations (guarded information-schema degradation
  fails closed until 0037 is canonically executed).
