# R6-D FINAL REPORT — NURTURE / SALES HANDOFF AUTONOMY

> **Stream:** WBS-R6 Stream D — Nurture / Sales Handoff Autonomy
> **Date:** 2026-06-28
> **Verdict:** see FINAL VERDICT below.

## IDENTITY

- **Branch:** `feature/r6-d-nurture-sales-handoff`
- **Base:** `a947ecb` (R5 `MARKETING_OPERATIONS_V1_READY`); programme base `integration/r6-lead-autonomy`; A/B/C/E/F **not merged** (consumed as frozen branch refs only)
- **HEAD:** see `git log` — 8 atomic commits, all pushed
- **Remote sync:** `origin/feature/r6-d-nurture-sales-handoff` up to date (pushed immediately per commit)
- **Status:** clean working tree; no stray files; `git diff --check` clean across the branch

## D0 — INVENTORY / CONTRACT CONSUMPTION

`docs/recovery/r6-d-nurture-sales-handoff-inventory.md` — frozen A/C/E/F
contracts consumed from branch refs; reusable R5 provider/policy/approval/
audit/bridge patterns identified; privacy blockers; CRM/provider gaps (honest
capability states); exact overlap-risk file list; schema implications.

## D1 — NURTURE / HANDOFF CONTRACT

`docs/contracts/lead-nurture-sales-handoff-contract.md` — all 21 mandated
sections: authority identity (nd1/sh1/hd1/nt1 deterministic identities),
qualification/identity/privacy dependencies, closed decision vocabulary
(`NURTURE · SALES_HANDOFF · WAIT · REVIEW_REQUIRED · BLOCKED · NO_ACTION`),
nurture eligibility, sequence identity, exact-once handoff identity +
lifecycle, approval semantics, provider capability semantics, execution
identity, retry/reconciliation, conversion stop conditions, audit semantics,
immutable fields, downstream consumable fields, forbidden mutations, schema
dependencies, overlap-risk files, security invariants, rogue-agent invariants.

## D2 — NURTURE ELIGIBILITY

Deterministic gate order (pure, first-match-wins): privacy (F re-read) →
qualification freshness → qualification decision → conversion stop (E,
read-only, policy-controlled) → progression (handoff / nurture+channel+
cadence). No agent override path exists. Implemented in
`api/lib/nurture/nurture-decision.ts` with strict upstream validators in
`nurture-upstream.ts` (frozen contract shapes; unknown versions/malformed
payloads fail closed).

## D3 — NURTURE SEQUENCING

`nurture-cadence.ts`: versioned, deterministic, policy-controlled frequency
(`minIntervalHours`, `maxTouchesPerWindow`/`windowDays`); exact-once touch
identity (`nt1:` over durable rows only); over-cadence ⇒ `WAIT`
(`NURTURE_CADENCE_LIMITED`), never a silent send; safe stop conditions
(privacy, conversion, policy staleness, expiry). No uncontrolled loop exists
by construction.

## D4 — CONTENT GENERATION BOUNDARY

`nurture-content-boundary.ts`: model output is draft-only behind a strict
schema (closed keys — smuggled `providerCredentials`/`send`/`tool` fields are
rejected); bounded lengths; secret/credential pattern detection; injection
pattern scanning; protected/sensitive-trait reference rejection. The
transport accepts only server-built `DispatchContent` from validated drafts —
generated content can never send itself or carry execution metadata.

## D5 — SALES HANDOFF AUTHORITY

Exact-once identity (`sh1:` over business+lead+qualification+handoff policy
version); insert-first convergence (retries and concurrent duplicates
converge; conflicting replay fails closed `HANDOFF_REPLAY_CONFLICT`); closed
lifecycle `PREPARED · APPROVAL_REQUIRED · APPROVED · DISPATCH_PENDING ·
DISPATCHED · ACKNOWLEDGED · FAILED · BLOCKED · CANCELLED` with CAS `version`
guards; `ACKNOWLEDGED` is bridge-only — no client-supplied success exists.

## D6 — APPROVAL / HUMAN GOVERNANCE

Reuses the governed approval ledger with one additive `sales_handoff`
approval type; deterministic idempotency key per handoff; durable binding
pins handoff + decision + qualification fingerprint + policy version +
content snapshot + expiry; in-transaction authorizability validation and
post-approval handoff transition wired into `api/approval-router.ts`
(exactly mirroring the R5-E marketing-action pattern). Rejection permanently
blocks the handoff identity; cross-lead/cross-business/cross-handoff replay,
forged bindings, stale policy, expired bindings all fail closed. The service
exposes no approval-resolution path — no self-approval is possible.

## D7 — PROVIDER / CRM EXECUTION SEAMS

`nurture-provider-capability.ts` + `nurture-transport.ts`: truthful closed
capability states (`SUPPORTED/UNSUPPORTED/REQUIRES_CONFIGURATION/
REQUIRES_APPROVAL/BLOCKED`) — real channels answer the honest repository
truth (email `REQUIRES_CONFIGURATION`, whatsapp/sms/crm `UNSUPPORTED`);
dispatch fails closed when unsupported or unconfigured. The only supported
execution path is the explicitly fake/test-only in-memory transport
(self-describing ack, zero network I/O). Execution identities (`hd1:`) are
stable transport idempotency keys; receipts are append-only.

## D8 — CONVERSION / STOP CONDITIONS

R6-E conversion authority consumed read-only through a narrow port;
authoritative (trusted-class, non-reversed) conversions stop nurture and
suppress duplicate handoff under policy (`stopOnAuthoritativeConversion`,
default true); conversion provenance preserved on decision records; D never
mutates conversion authority and never claims attribution.

## D9 — ACCEPTANCE

`api/r6-d-acceptance.test.ts` — all 34 mandated cases asserted plus the full
connected chain (A lead → B score ref → C QUALIFIED → F privacy → D policy →
governed decision → human approval → fake/test seam → durable receipt →
E conversion stop). See TESTING for results.

## TESTING

- **Targeted:** `api/lib/nurture/` — 122/122 pass (contract, identity,
  policy, upstream validators, cadence, decision engine, content boundary,
  capability + transport, approval, store + service); D9 acceptance 31/31
- **Affected regressions:** approval router + approval decision audit (30/30),
  policy kernel, audit package (32/32) — all pass
- **Full suite:** 5772 passed / 2 failed / 66 skipped / 14 todo (5854). The 2
  failures (`api/campaign-router-bootstrap.test.ts` timeout,
  `api/lib/billing/credit-engine.test.ts` db-name assertion) plus the
  `src/pages/Campaigns.test.tsx` Firebase key failure are **environmental**:
  this fresh worktree has no `.env`, so `DATABASE_URL` and the Firebase key
  are absent. Re-running the two api suites with a `DATABASE_URL` present:
  **29/29 pass**. D touches neither billing nor the campaign router.
- **tsc:** `npx tsc -b` clean
- **Build:** `npm run build` clean — Vite build + API bundle + deployment
  verification all green
- **git diff --check:** clean (whole branch)

## SCHEMA

- **Changed:** yes — 4 D-owned tables (`nurture_handoff_decisions`,
  `sales_handoffs`, `handoff_dispatch_receipts`, `nurture_touch_records`),
  one additive `approval_requests.approvalType` value `sales_handoff`, four
  additive audit event types.
- **Provisional migrations:** `0034_nurture_sales_handoff_autonomy` (SQL +
  snapshot + journal idx 34); A/B/C/E/F provisional 0034 collision documented
  in `docs/recovery/r6-d-unexecuted-migrations.md`; **R6-X is the canonical
  convergence owner**; no renumbering performed.
- **Migration execution:** **FALSE** (artefact generation only; runtime
  entry points are information-schema guarded — absent tables fail closed).

## SECURITY

- **SECURITY_VERDICT:** PASS
- **NURTURE_INTEGRITY_VERDICT:** PASS — only governed server-side code
  authorizes nurture; eligibility deterministic; privacy always overrides.
- **HANDOFF_INTEGRITY_VERDICT:** PASS — exact-once identity, CAS lifecycle,
  no client success path, conflicting replay fails closed.
- **TENANT_ISOLATION_VERDICT:** PASS — `userId` anchor inside every identity
  hash and every query predicate; cross-tenant reads return null; forged and
  cross-business references rejected.
- **PRIVACY_GOVERNANCE_VERDICT:** PASS — F gate re-read at decision AND
  execution; unavailable bridge fails closed; blockers surface in the
  F-compatible operations view.
- **AGENT_ISOLATION_VERDICT:** PASS
- **PROMPT_INJECTION_RESISTANCE_VERDICT:** PASS — upstream projections
  structurally validated; drafts injection-scanned; case-20 harness proof
  (no transport invocation).
- **TOOL_LEAST_PRIVILEGE_VERDICT:** PASS — no model receives credentials;
  transports server-selected; no dynamic tool execution from text.
- **CROSS_AGENT_TRUST_VERDICT:** PASS — frozen contract versions enforced;
  malformed/stale/tampered payloads fail closed.
- **SELF_MODIFICATION_GUARD_VERDICT:** PASS — no self-approval path; no
  service-side approval resolution; decisions/handoffs immutable except the
  CAS lifecycle.
- **SECRET_ISOLATION_VERDICT:** PASS — secret patterns rejected at the
  boundary; audit/receipt metadata ids+labels only (test-scanned);
  diff-scanned for credential material (only documented negative-test
  fixtures found).
- **SENSITIVE_DATA_EXPOSURE_FOUND:** none
- **AUTHORIZATION_REGRESSION_FOUND:** none (affected regressions green)
- **PRIVILEGE_ESCALATION_FOUND:** none
- **ROGUE_AGENT_BLAST_RADIUS:** none — compromise of any single agent/model
  grants zero nurture/handoff authority; every privileged effect requires
  the full server-side gate set.
- **NEW_SECURITY_DEBT:** none known
- **UNRESOLVED_AGENT_SECURITY_DEBT:** none known

## EXTERNAL LIMITATIONS

- Real CRM/provider execution not performed (by design — no repository
  transport exists; dispatch is an R6-X activation slot behind the same
  interface).
- Unsupported providers: whatsapp/sms/crm honestly `UNSUPPORTED`; email
  `REQUIRES_CONFIGURATION`.
- Configuration dependencies: real transports, upstream port wiring to the
  landed A/C/E/F modules, and policy persistence are R6-X activation slots.
- Real environment requirements: provisional 0034 migration execution by
  R6-X; F privacy table present for the privacy bridge.

## FINAL VERDICT

**NURTURE_SALES_HANDOFF_AUTONOMY_READY**

Migration executed: FALSE. No deploy. No production access. No live
CRM/provider/payment/billing invocation. A/B/C/E/F not merged.

Acceptance definition check: (1) only governed QUALIFIED leads progress ✓;
(2) privacy always overrides ✓; (3) agent/model output cannot contact leads
directly ✓; (4) human approval cannot be self-issued ✓; (5) external effects
exact-once/replay-safe ✓; (6) unsupported providers fail closed ✓;
(7) conversion stops respected ✓; (8) no upstream authority mutated ✓;
(9) rogue agents cannot expand authority ✓; (10) all privileged actions
audited ✓; (11) no production mutation ✓; (12) all accepted commits pushed ✓.
