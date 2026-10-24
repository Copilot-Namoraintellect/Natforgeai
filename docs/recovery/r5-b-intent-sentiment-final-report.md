# WBS-R5 STREAM B — INTENT & SENTIMENT INTELLIGENCE: FINAL REPORT

> **Date:** 2026-10-24 · **Branch:** `feature/r5-b-intent-sentiment`
> **Base:** `e4493a8` (R4 FULL_AUTONOMY_V1_READY) · **Verdict:** INTENT_SENTIMENT_INTELLIGENCE_READY

---

## IDENTITY

- **Branch:** `feature/r5-b-intent-sentiment`
- **HEAD:** `54ff38e`
- **Remote sync:** all 7 commits pushed to `origin/feature/r5-b-intent-sentiment` (`3259721..54ff38e`)
- **`git status`:** clean at report time

## COMMITS (in order)

| # | Commit | Slice |
|---|---|---|
| 1 | `3259721` docs(r5-b): B1 canonical social intelligence interpretation contract | B1 |
| 2 | `cdb9786` docs(r5-b): B0 repository/intelligence inventory (pre-code authority) | B0 |
| 3 | `800fbd2` feat(r5-b): B2-B4 core interpretation lib (rules, model boundary, confidence, risk, relevance) | B2–B4 |
| 4 | `5abf1a9` feat(r5-b): B5-B7 durable exact-once store, orchestrator, router, schema | B5–B7 |
| 5 | `a9c0d2b` test(r5-b): B8 intelligence acceptance harness (25 scenarios) + in-flight exact-once registry | B8 |
| 6 | `5ac4f98` docs(r5-b): intelligence-to-engagement-opportunity handoff contract | Handoff |
| 7 | `54ff38e` feat(r5-b): align consuming boundary to frozen R5-A contract + NULL-businessId tamper hardening | R5-A convergence |

## B0 — REPOSITORY / INTELLIGENCE INVENTORY

**Verdict: COMPLETE.** `docs/recovery/r5-b-intent-sentiment-inventory.md` (151 lines, every
file:line re-verified). 47 schema tables counted; migration journal at idx 28 (next `0029_*`);
no prior intent taxonomy anywhere; reusable R4 authority identified (runner, reservation
engine, workflow-operation, audit, business-dna, rate-limit middleware); overlap risks flagged
(legacy `conversation_messages.sentiment`, closed `AgentType`/`AUDIT_EVENT_TYPES`/ai_usage
enums, `api/router.ts` hotspot).

## B1 — CANONICAL INTERPRETATION CONTRACT

**Verdict: COMPLETE.** `docs/contracts/social-intelligence-contract.md` — one canonical
`SocialInterpretation` record; closed vocabularies (15 intents, 5 sentiments, 4 urgencies,
4 relevances, 4 confidences, 6 handling classes, 10 risk flags, 6 opportunity indicators);
header updated to cite frozen R5-A upstream (§3/§5 aligned, slice 4).

## B2 — RULE-FIRST INTERPRETATION LAYER

**Verdict: COMPLETE.** `api/lib/intelligence/rules-engine.ts` — deterministic, versioned
(`intent-sentiment-rules/v1`), explainable, non-billable. Definitive classes only: empty text,
non-text signals, spam markers, deterministic safety triggers; `unknown` signal type rejected
fail-closed. Same canonical contract output as the model path; `source = RULE`.

## B3 — AI INTERPRETATION BOUNDARY

**Verdict: COMPLETE.** `api/lib/intelligence/model-boundary.ts` — single governed boundary via
`runAgent` (`agentType: "interpretation"`, structured output only, strict zod schema, defense-
in-depth re-validation `MODEL_OUTPUT_INVALID`). Untrusted text only inside fixed
BEGIN/END UNTRUSTED SOCIAL SIGNAL delimiters; system contract forbids obeying embedded
instructions, role override, prompt disclosure. Minimal context: businessName +
primaryOffering + productsAndServices only. No tokens/secrets/tenant internals in prompts.

## B4 — CONFIDENCE / UNCERTAINTY GOVERNANCE

**Verdict: COMPLETE.** `api/lib/intelligence/confidence.ts` — bounded ordinal
(`high|medium|low|unknown`) with explicit source (`deterministic_rule|model_self_assessed|
insufficient_evidence`); no fabricated probability; overall = ordinal min of dimensions;
gates: low/unknown ⇒ `monitor`/`human_review` only (never engagement/opportunity classes);
safety escalation survives all gates. `unknown`/`ambiguous` are first-class outcomes.

## B5 — EXACT-ONCE INTERPRETATION / VERSIONING

**Verdict: COMPLETE.** Deterministic identities (no clock/random): `signalContentHash` (14
aligned signal fields incl. R5-A `providerEvidenceHash`), `interpretationId`,
`billingIdentity`, `interpretationFingerprint`. Durable unique keys + null-aware natural-key
pre-resolution (MySQL NULL semantics closed at the app layer; oldest committed row is
authority). In-flight registry collapses concurrent duplicates to one evaluation. Proven:
duplicate → one row; concurrent → one record/one model call; restart → replay; timeout →
release + retry-safe; rules→AI never double-write; classifier bump → new versioned rows;
tamper (incl. NULL-businessId and evidence-hash drift) → fail-closed; cross-business
collision → distinct identities + server-side ownership rejection. Records immutable.

## B6 — BUSINESS CONTEXT / RELEVANCE

**Verdict: COMPLETE.** `api/lib/intelligence/relevance.ts` — deterministic token overlap vs
Business DNA snapshot (authoritative when present; snapshot id stored immutably);
context-free path: `relevance: unknown`, confidence low, no fabricated linkage; nullable
`businessId` (R5-A unattributed) interprets tenant-scoped. Owner scoping: business loaded by
id **and** userId (router + defense-in-depth loader).

## B7 — SAFETY / RISK CLASSIFICATION

**Verdict: COMPLETE.** `api/lib/intelligence/risk-classifier.ts` — bounded marketing-
governance classes, evidence-linked (`{flag, evidence ≤160 chars}`), deterministic markers +
model hints. Safety-critical flags force `safety_escalation`; other flags force `human_review`;
no moderation product, no auto-action. Privacy marker: email/phone regex in public text.

## B8 — INTELLIGENCE ACCEPTANCE

**Verdict: COMPLETE.** `api/lib/intelligence/intelligence-acceptance.test.ts` — all 25 mandated
scenarios (#25 split a/b) on the connected harness (fixture → routing → sanitized request →
structured interpretation → normalization → durable record → downstream-ready shape
assertions). Model fakes throughout (`vi.mock` runner / scripted fakes); no live provider.

## BILLING / COST CONTROL

- **Non-billable:** RULE path (`billingIdentity: null`, no reservation, no ai_usage).
- **Billable:** MODEL path — exactly one governed `runAgent` call with
  `billingIdempotencyKey = billingIdentity` minted at the trigger boundary; reserve → one
  provider call → settle/release via the existing reservation authority; schema/provider/quota
  failures follow the existing refund/settlement policy unchanged.
- **Stable identity:** `interpretation:{sha256("intelligence/interpretation-billing@v1:…")}` —
  registered as one row in `docs/contracts/financial-reliability-contract.md` §2 (frozen
  formats otherwise untouched); `ai_usage`/`agent_runs` enums extended; cost estimate
  `interpretation: 1`.
- **Double-charge evidence:** harness scenarios 12 (sequential replay — one model call), 13
  (concurrent — one record, one call), 15 (timeout → retry re-enters with the same key);
  invariants rest on the R4 reservation engine's own `runner-billing-identity` /
  `exact-once-financial-acceptance` suites (unchanged, passing).

## TESTING

- **Targeted:** `api/lib/intelligence` + `api/intelligence-router.test.ts` +
  `api/lib/audit` + `api/lib/agents` → **36 files / 522 tests, all passing.**
- **Regression (pre-alignment full suite):** 5080 passed, 2 failed — both `beforeEach` hook
  timeouts under maxWorkers=2 load; both files pass in isolation (verified).
- **Full suite (final code):** **5097 passed, 2 failed / 5165 total** — the two failures are
  the same parallel-load flake in files untouched by R5-B: `r4-x6-full-autonomy-e2e.test.ts`
  (**21/21 in isolation**, verified) and one queue terminal-replay file (all three
  terminal-replay files: **119/119 in isolation**, verified). No failure touches
  intelligence, router, audit, agents, billing, or schema code.
- **tsc:** `npx tsc -b` exit 0.
- **Build:** `npm run build` PASS — vite build 31s, `dist/boot.js` + `dist/worker.js`
  API bundles emitted, deployment verification passed (web.config rewrites verified).
- **Lint of change:** `git diff --check` clean; secret scan over the full diff clean.

## SCHEMA / MIGRATION

- **Changed:** `db/schema.ts` — new `socialInterpretations` table (18 columns; `businessId`
  nullable; unique `interpretationId`; unique `(businessId, signalId, signalVersion,
  classifierVersion)`; 2 secondary indexes) + `interpretation` added to `agentRuns.agentType`
  and `aiUsage.agentType` enums.
- **Migration artefacts:** `db/migrations/0029_add_social_interpretations.sql` +
  `meta/0029_snapshot.json`; journal idx 29 verified.
- **Execution confirmation: FALSE** — `db:migrate`/`db:push` never run; no live database
  touched.
- **R5-X convergence item:** R5-A's provisional `0029_social_listening_foundation` collides
  at idx 29 across branches; R5-B did not execute, renumber, or duplicate it (documented in
  both contracts).

## SECURITY

- SECURITY_VERDICT=PASS
- SECURITY_CONTROLS_CHANGED=input sanitizer (unicode/bounds/rejection), prompt-injection
  delimiters + system contract, structured-output-only model boundary with re-validation,
  deterministic identity + tamper fail-closed, null-aware natural-key authority, tenant
  ownership enforcement, evidence/PII bounding, secret-redacting audit metadata, in-flight
  exact-once registry
- SECURITY_TESTS_ADDED=adversarial scenarios 18-25 in the acceptance harness + input-safety
  unit tests + store tamper/replay suites (oversized, malformed unicode, injection, extraction,
  tampered/evidence-hash drift, cross-tenant, replay/concurrent/restart, low-confidence,
  malformed/vocab-violating model output, timeout)
- SENSITIVE_DATA_EXPOSURE_FOUND=False
- AUTHORIZATION_REGRESSION_FOUND=False (router ownership tests + full audit/agents suites green)
- PROMPT_INJECTION_RESISTANCE_VERDICT=PASS
- MODEL_OUTPUT_VALIDATION_VERDICT=PASS
- NEW_SECURITY_DEBT=None known. Residual: model self-assessed confidence is ordinal, not
  calibrated (documented, by design); keyword rules are deterministic-only classes.

## HANDOFF

- **Contract:** `docs/contracts/intelligence-to-engagement-opportunity-contract.md`
  (22 mandated sections; §2 signal identity aligned to frozen R5-A §11; §20 migration
  dependencies incl. R5-X convergence item; §22 invariants).
- **Downstream dependencies for R5-C/R5-D:** consume `SocialInterpretation` records +
  `intelligence.get` / `intelligence.listForSignal`; act only through their own policy gates.
- **Overlap-risk files:** `api/router.ts` (intelligence key), `db/schema.ts` +
  `db/migrations/` (0029 provisional — R5-X converges), `api/lib/agents/runner.ts`
  (AgentType), `api/lib/audit/audit-event.ts` (taxonomy), `docs/contracts/financial-
  reliability-contract.md` (§2 row), `api/lib/billing/cost-tracker.ts`, legacy
  `conversation_messages.sentiment` (unchanged), R5-A-owned `api/lib/social-listening/` +
  `social_signals` (read-only, never written by R5-B).

## EXTERNAL LIMITATIONS

- Model boundary uses the platform's existing gpt-4o-mini structured-output channel; no new
  provider capabilities were assumed. All acceptance used model fakes; no live provider was
  called.
- Confidence is an ordinal self-report, not statistical calibration.
- Deterministic rules cover only high-precision classes; ambiguous content honestly routes to
  the model or `unknown`.
- Business DNA relevance is token-overlap (explainable, not semantic).
- R5-A is consumed at the structural seam (`adaptSocialSignal` / frozen §11 fields) until
  R5-X integration physically joins the branches; R5-A authority was not merged or modified.

## FINAL VERDICT

**INTENT_SENTIMENT_INTELLIGENCE_READY** — against the 11-point acceptance definition:

1. Canonical signals interpret without developer intervention — YES (router + orchestrator).
2. Tenant-safe — YES (server-side ownership, cross-tenant tests, NULL-safe scoping).
3. Social text cannot override model/system instructions — YES (delimiters, system contract,
   harness scenarios 18/19).
4. Model output strictly validated — YES (zod schema + re-validation; 16/17 green).
5. Intent/sentiment/risk semantics controlled and versioned — YES (closed vocab + classifier
   version pinned into identity).
6. Ambiguity represented honestly — YES (unknown/low-confidence first-class; gates).
7. Duplicate/retry/restart does not duplicate interpretation or billing — YES (store replay,
   in-flight registry, deterministic billing identity).
8. Historical interpretations immutable — YES (no update/delete path; natural-key authority).
9. Downstream receives one stable contract — YES (22-section handoff contract).
10. No action executed by this stream — YES (classification only; no engagement/lead writes).
11. All accepted commits pushed — YES (`54ff38e` on origin).
