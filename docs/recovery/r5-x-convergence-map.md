# R5-X1 Convergence Map — Marketing Operations Convergence & Acceptance

> **Date:** 2026-06-13
> **Base:** `e4493a8ecd30f513e2a022f4aca0941f5dced485` (R4 authority, FULL_AUTONOMY_V1_READY)
> **Integration branch:** `integration/r5-marketing-operations`
> **Status:** pre-integration map (X1). No stream merged at time of writing.

## 1. Frozen stream head verification

| Stream | Branch | Authority HEAD | Local HEAD | Remote HEAD | Verdict |
|--------|--------|---------------|------------|-------------|---------|
| R5-A Social Listening | `feature/r5-a-social-listening` | `c9a930e` | `c9a930e` | `c9a930e` | VERIFIED |
| R5-B Intent & Sentiment | `feature/r5-b-intent-sentiment` | `b939328` | `b939328` | `b939328` | VERIFIED |
| R5-C Autonomous Engagement | `feature/r5-c-autonomous-engagement` | `c2acfa1` | `c2acfa1` | `c2acfa1` | VERIFIED |
| R5-D Opportunity Detection | `feature/r5-d-opportunity-detection` | `a9e8b49` | `a9e8b49` | `a9e8b49` | VERIFIED |
| R5-E Policy/Safety/Cost | `feature/r5-e-policy-safety-cost` | `c936caa` | `c936caa` | `c936caa` | VERIFIED |
| R5-F Operations Governance | `feature/r5-f-operations-governance` | `5800626` | `5800626` | `5800626` | VERIFIED |

All six local and remote heads match the frozen authority exactly. Every stream is a
direct descendant of the base (`git merge-base` = `e4493a8`); no stream carries
pre-base divergence. Commits per stream above base: A=11, B=8, C=6, D=7, E=13, F=8.

## 2. Contract inventory (all present on the respective stream heads)

| Stream | Contract |
|--------|----------|
| A | `docs/contracts/social-listening-to-intelligence-contract.md`, `docs/contracts/social-signal-contract.md` |
| B | `docs/contracts/intelligence-to-engagement-opportunity-contract.md`, `docs/contracts/social-intelligence-contract.md` |
| C | `docs/contracts/engagement-to-opportunity-contract.md` |
| D | `docs/contracts/opportunity-candidate-contract.md`, `docs/contracts/opportunity-to-lead-autonomy-contract.md` |
| E | `docs/contracts/marketing-action-policy-contract.md` |
| F | `docs/contracts/marketing-operations-governance-contract.md` |

All seven contract files exist at the frozen heads. No contract contradictions found
during overlap inspection; seams are designed (see §5).

## 3. Changed-file sets (base → stream head)

| Stream | Files | New authority areas |
|--------|-------|---------------------|
| A | 39 | `api/lib/social-listening/**` (signal contract, ingest, webhook, polling, adapters, state store, observability), `listening-router`, migration 0029 |
| B | 39 | `api/lib/intelligence/**` (canonical-signal mirror, interpretation contract/identity/store, interpreter, input-safety, model-boundary, risk-classifier, rules-engine, confidence, relevance), `intelligence-router`, migration 0029 |
| C | 47 | `api/lib/engagement/**` (planning, response-generation, execution, provider-boundary, continuation, stores, intelligence, ops-evidence, source-loader, inbound), `engagement-router`, policy dir copy, migration 0030 |
| D | 27 | `api/lib/opportunity/**` (detector, detection-rules, evidence-strength, canonical-intelligence, engagement-evidence-seam, identity, lifecycle, store, policy-gates, contract), `opportunity-router`, migration 0030 |
| E | 33 | `api/lib/policy/**` (action-request, decision-engine, cost-governance, marketing-action-approval, policy-audit, authority-resolver, stores, model, risk-classification, types), `policy-router`, `policy-acceptance`, migration 0029 |
| F | 18 | `api/lib/governance/r5-*` (operations projection, blocker taxonomy, stream evidence, summary, stream-evidence), `operations-router`, readiness test, recovery test. **No migration, no schema change.** |

## 4. Overlap-risk map (files touched by 2+ streams)

| File | Streams | Risk | Resolution strategy |
|------|---------|------|---------------------|
| `api/router.ts` | A,B,C,D,E,F | tRPC router registration | **Union**: each stream registers one disjoint router key (`listening`, `intelligence`, `policy`, `engagement`, `opportunity`, `operations`). C and E both add `policy: policyRouter` — single entry (identical import). |
| `db/schema.ts` | A,B,C,D,E | Table definitions | **Union**: each stream adds its own tables; no same-table edits detected — verify during merge. |
| `db/migrations/meta/_journal.json` | A,B,C,D,E | Journal append collision | **Regenerate** canonical chain (see §6). |
| `db/migrations/meta/0029_snapshot.json` | A,B,C,E | Snapshot collision (4 streams) | **Regenerate**; provisional snapshots discarded. |
| `api/lib/audit/audit-event.ts` (+ test) | B,C,D,E | Audit event vocabulary | **Union**: additive event-type constants per stream (`interpretation_recorded`; `policy_decision`; `engagement_execution`, `engagement_receipt`; `opportunity_detected/suppressed/state_changed/handed_off`). C and E both add `policy_decision` — identical lines. |
| `api/lib/policy/**` (19 files) | C,E | Vendored duplicate policy engine | **Byte-identical** (0 diff lines on every file, verified). Single on-disk copy after merge; C's engagement imports resolve to E's authority. See X3.2. |
| `api/approval-router.ts` | C,E | Approval binding validation | C carries E's exact change (verified identical diff). Merge as one copy. |
| `api/policy-router.ts` | C,E | Policy routes | Byte-identical; single copy. |
| `api/boot.ts` | A,C | Server boot wiring | **Union**: A adds listening webhook pass + default-off polling scheduler; C adds engagement provider transport wiring (also default-off). Verify placement during merge. |
| `api/lib/env.ts` | A,C | Environment flags | **Union**: A adds polling flags; C adds `engagementProviderTransportEnabled`. Disjoint names. |
| `AGENTS.md` | A,D,E | Documentation | Manual union of stream feature notes. |

## 5. Designed cross-stream seams (from contract inspection)

1. **A → B (social signal).** B ships `api/lib/intelligence/canonical-signal.ts`, a
   pure, side-effect-free *structural mirror* of A's frozen signal contract
   (comment block states: "No R5-A code is imported; the structural mirror below is
   the only coupling"). It maps `signalId ← A.signalKey`, `signalVersion ←
   A.ingestionVersion`, freezes the 11 signal types, provider/platform/attribution
   enums and the 1024-char content bound. X3.1 evaluates replacing the mirror with a
   direct import of A's `signal-contract.ts` (A lands first); identities
   (`signalKey`, `ingestionVersion`, `providerEvidenceHash`, nullable `businessId`)
   must be preserved either way.

2. **E → C (policy).** C vendored E's entire policy engine byte-identically and
   consumes it through the shared `api/lib/policy/*` path — no second copy exists
   under `api/lib/engagement/`. After E lands, the on-disk files ARE E's authority;
   X3.2 proves C's behavior is unchanged and that no parallel policy state machine
   exists.

3. **C → D (engagement evidence).** D ships `engagement-evidence-seam.ts` as an
   *optional* adapter. D must detect opportunities from A+B alone (no C); a valid C
   receipt may only strengthen a candidate (enrich, never redefine identity; never
   turn opportunity into lead). X3.3 binds the seam and proves forged/cross-business
   receipt rejection + replay non-duplication.

4. **F (projection).** F is schema-free by design: it reads R5-A tables through an
   `information_schema` existence guard (`stream_tables_absent` ⇒ honest
   "unavailable", never guessed) and imports only R4 tables from `@db/schema`. F's
   frozen readiness tests *require* the absent-table guard to remain (migrations are
   unexecuted). X3.4 registers A/B/C/D/E durable-state readers into the single
   projection and removes only true placeholders — the guard itself is retained
   authority, not a temporary bridge.

5. **Provider capability (X5).** Listening: Meta webhook supported; LinkedIn polling
   seam only; Twitter/TikTok unsupported. Engagement execution: public reply on
   Facebook/Instagram via Meta seam; LinkedIn/Twitter/TikTok unsupported; reactions
   and private messages unsupported. Final eligibility rule:
   `policy allows AND provider supports AND binding valid AND transport enabled`,
   else fail closed. Policy-side action-type existence must never make an action
   executable.

## 6. Schema / migration deltas and canonical plan

Base journal: 29 entries (idx 0–28), last migration `0028_add_campaign_interest_signal_actor_unique`.

| Stream | Provisional SQL | Journal idx/tag | Snapshot file | Defect |
|--------|----------------|-----------------|---------------|--------|
| A | `0029_social_listening_foundation.sql` | 29 / `0029_social_listening_foundation` | `0029_snapshot.json` | number collision |
| B | `0029_add_social_interpretations.sql` | 29 / `0029_add_social_interpretations` | `0029_snapshot.json` | number collision |
| E | `0029_sad_donald_blake.sql` | 29 / `0029_sad_donald_blake` | `0029_snapshot.json` | number collision |
| C | `0030_engagement_execution_foundation.sql` | **29** / `0030_engagement_execution_foundation` | `0029_snapshot.json` | idx≠number, wrong snapshot name |
| D | `0030_opportunity_detection_foundation.sql` | 30 / `0030_opportunity_detection_foundation` | `0030_snapshot.json` | idx gap at 29 |
| F | — none — | — | — | — |

Canonical plan (X4): one linear post-R4 chain regenerated with `drizzle-kit generate`
at each dependency-ordered integration step, so snapshots and `prevId` chaining are
tool-correct rather than hand-edited:

| Canonical | Source stream | Supersedes (provisional) |
|-----------|---------------|--------------------------|
| `0029` social listening | A | `0029_social_listening_foundation.sql` |
| `0030` social interpretations | B | `0029_add_social_interpretations.sql` |
| `0031` policy foundation | E | `0029_sad_donald_blake.sql` |
| `0032` engagement foundation | C | `0030_engagement_execution_foundation.sql` |
| `0033` opportunity foundation | D | `0030_opportunity_detection_foundation.sql` |

Requirements carried into X4: no duplicate numbers/idx, no lost change, correct
chaining, schema↔final-snapshot parity, `drizzle-kit` drift-clean, provenance
documented, **no migration executed**.

## 7. Duplicate / temporary authority introduced only by stream isolation

| Authority | Isolation artifact | Convergence action |
|-----------|--------------------|--------------------|
| Policy engine | C's byte-identical copy of E's 19 policy files | Single copy (E) on disk; verify C imports resolve; delete nothing extra — duplicates collapse by content identity. |
| Policy approval binding | C's identical `approval-router.ts`/`policy-router.ts` changes | Single copy. |
| Canonical social signal | B's structural mirror module | X3.1: bind to A's real contract where import-safe; else keep mirror with identity parity proven by test. |
| Ops projection bridges | F's `stream_tables_absent` guards + `r5-stream-evidence.ts` | Keep guard (required for unexecuted migrations); register real A/B/C/D/E readers; no second state machine. |
| Provider capability | Policy-side action types vs engagement transport capability | X5: single truthful capability matrix; fail closed on mismatch. |

## 8. Integration order (X2)

A → B → E → C → D → F (per mission). After each step: targeted tests, cross-stream
regressions, `git diff --check`, secrets scan, convergence commit, push.
