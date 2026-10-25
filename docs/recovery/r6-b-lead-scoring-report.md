# R6-B LEAD SCORING AUTONOMY — FINAL STREAM REPORT

> **Stream:** WBS-R6 Stream B — Lead Scoring Autonomy
> **Authority basis:** R5 `MARKETING_OPERATIONS_V1_READY` (base `a947ecb`);
> R6 derives its own score/rationale per `opportunity-to-lead-autonomy` §16.

---

## IDENTITY

| Item | Value |
|---|---|
| Branch | `feature/r6-b-lead-scoring` |
| Base | `a947ecb` (R5 marketing-operations V1 acceptance; consumed, not merged) |
| HEAD | `1df19ea` — see `git log`; each commit pushed |
| Remote sync | `origin/feature/r6-b-lead-scoring` — HEAD matches exactly |
| Clean status | working tree clean at the report boundary (`git status` clean) |

## COMMITS (accepted, in order)

1. `db48626` docs(r6-b): B0 lead-scoring repository/scoring inventory
2. `827f686` docs(r6-b): B1 canonical lead scoring contract (`lead-scoring/v1`)
3. `96cd254` feat(r6-b): B2/B3/B6 authoritative feature model + rule-first scoring engine + honest confidence
4. `1dad1ae` feat(r6-b): B5 `lead_score_snapshots` schema + provisional migration 0034 (created, not executed)
5. `a6b57ff` feat(r6-b): B7/B8/B9 exact-once scoring store + service + read-only router + connected acceptance suite
6. `ea1d37b` docs(r6-b): B4 AI-extraction verdict + R6-C handoff contract; tsc strictness fixes
7. `1df19ea` test(r6-b): align lead scoring audit taxonomy (additive `lead_score_recorded` list entry)

No upstream branch was merged. R5-D contracts were consumed read-only from the base
ref; R6-A lead identity is isolated behind `api/lib/scoring/lead-identity-seam.ts`
(the single convergence point when R6-A lands — do **not** merge R6-A).

## MODULE (`api/lib/scoring/` + `api/scoring-router.ts`)

- `scoring-contract.ts` — PURE: closed vocabularies (band / confidence / components /
  reason codes), version identities, `Object.freeze`d server-owned `SCORING_WEIGHTS`,
  forbidden-feature list, typed fail-closed error taxonomy, canonical hash helpers.
- `feature-model.ts` — PURE: closed feature catalog (FIT/INTENT/ENGAGEMENT/RECENCY/
  OPPORTUNITY), per-feature provenance, fail-closed on malformed/NaN/out-of-range,
  unknown vocabulary, or forbidden protected-trait/demographic features
  (`assertAllowedFeatureNames`).
- `scoring-engine.ts` — PURE: exact contract §4 formulas; `assertValidWeights` on every
  computation; explicit caller clock (never reads a wall clock); NaN-guard clamp;
  bounded (≤ 8) closed reason codes. No model, no randomness.
- `score-confidence.ts` — PURE: honest bounded ordinal (LOW/MEDIUM/HIGH/UNKNOWN),
  separate from the score value; high score + LOW confidence is a valid state.
- `evidence-snapshot.ts` — PURE: deterministic sorted manifest, sha256 snapshot hash,
  `lss1:`/`lsc1:` identity derivation.
- `lead-identity-seam.ts` — server-side lead existence + tenant ownership re-verified
  from the durable `leads` row every call; forged/cross-tenant `leadId` →
  `LEAD_NOT_FOUND` (no oracle leak); interim evidence scope re-validates
  tenant/business/campaign attribution.
- `scoring-store.ts` — DB-authoritative exact-once (unique convergence key +
  unique `leadScoreId`); insert-only; hash-drift on read → `SCORING_EVIDENCE_TAMPERED`.
- `scoring-service.ts` — orchestration; emits exactly one `lead_score_recorded` audit
  event per durable score record (replays do not re-emit).
- `scoring-router.ts` — `authedQuery` only; clients may supply **only** `leadId`
  (`z.strictObject`); `get`/`listHistory` tenant-scoped reads.

## SCHEMA

- One new append-only table `lead_score_snapshots` (immutable score records; history =
  ordered rows). Unique convergence key `(userId, leadId, evidenceSnapshotHash,
  scoringVersion)` + unique `leadScoreId`; `lss_` index prefix. No enum edits to
  existing tables; no FK constraints (repo convention; enforcement in predicates).
- Distinct from legacy `lead_scores` (audience-intelligence pipeline) — never shared.
- Provisional artefacts: `0034_lead_scoring_foundation.sql` + `meta/0034_snapshot.json`
  + journal idx 34. Execution = **FALSE**. R6-X owns canonical sequencing; 0029–0033
  untouched. See `docs/recovery/r6-b-unexecuted-migrations.md`.

## TESTING (targeted, confirmed this session)

- R6-B scoring suites: `vitest run api/lib/scoring/` → **68/68 pass**
  (feature-model 10 + scoring-engine 29 + acceptance 29).
- Audit taxonomy: `vitest run api/lib/audit/audit-event.test.ts` → **20/20 pass**.
- Upstream + shared-module regression (opportunity, audit, governance, publish,
  workflow): **144 passed / 1 skipped** (11 files) — 1 skip is a pre-existing todo.
- Root router composition (all `api/*.test.ts`, composes the full appRouter incl. the
  new `scoring` registration): **587 passed / 17 skipped / 14 todo** (38 files) — no
  failures.
- Type check: `tsc -b` → **exit 0 (clean)** across the whole repo (incl. tests).
- `git diff --check` → clean.
- Full-suite run + base comparison: see FINAL RESULTS below.

## SECURITY

Rogue-agent / cross-agent addendum — all eight invariants hold **structurally and by
acceptance evidence**:

| # | Invariant | Enforcement | Acceptance evidence |
|---|---|---|---|
| 1 | Cannot bypass server-side authority | Router input is `z.strictObject({ leadId })` — clients supply only `leadId`; identity/evidence/score all server-resolved | cases 18/19 (score/weights/band rejected, `BAD_REQUEST`) |
| 2 | Cannot alter scoring authority | `SCORING_WEIGHTS` frozen; `computeScore` → `assertValidWeights` every call | cases 18/19 engine-level (`INVALID_SCORING_WEIGHTS`) |
| 3 | Cannot self-qualify | No writes to `leads`/`lead_activities`; no qualification/outreach path exists | cases 27 (status stays `new` at VERY_HIGH), 28 |
| 4 | Cannot cross tenant boundaries | `resolveLeadIdentity` WHERE `id AND userId`; evidence scope re-validated; reads scoped by `userId` | cases 15/16/26 |
| 5 | Cannot access secrets | No env/secret reads; audit metadata sanitized; manifest = opaque refs + closed labels, no text/PII | case 28 (no token/password/secret/handle in metadata) |
| 6 | Cannot manipulate billing identity | Deterministic non-billable path; no `agent_runs`/`ai_usage`/`credit_reservations` | case 23 |
| 7 | Cannot execute arbitrary commands/tools | No child_process/exec/eval/fs/network/runAgent in the module | code sweep → none |
| 8 | Cannot force workflow state | Insert-only immutable rows + idempotent replay; no update/delete/transition path | cases 9–14 |

SECURITY_VERDICT=PASS
PRIVACY_MINIMIZATION_VERDICT=PASS
SCORE_IS_EVIDENCE_NOT_QUALIFICATION=PASS
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS
FORBIDDEN_FEATURE_REJECTION_VERDICT=PASS
AUTHORIZATION_REGRESSION_FOUND=False
NEW_SECURITY_DEBT=None

## DOWNSTREAM (R6-C handoff)

- Contract: `docs/contracts/lead-scoring-to-qualification-contract.md`. R6-C consumes
  the read-only projection (`scoring.scoreLead/get/listHistory`); must not overwrite
  scores, alter weights, equate score with qualification, or mutate snapshots.
- Canonical scoring contract: `docs/contracts/lead-scoring-contract.md` (`lead-scoring/v1`).
- Overlap-risk files: `api/router.ts`, `db/schema.ts`,
  `api/lib/audit/audit-event.ts` — additive only.

## EXTERNAL LIMITATIONS

- Confidence/bands are bounded deterministic ordinals, not calibrated probabilities.
- No model in v1 (B4 verdict): deterministic R5 evidence fully covers the v1 feature
  set; AI feature extraction is a documented future seam under standing constraints.
- Campaign-performance aggregates (`analytics`) evaluated and excluded v1 (not per-lead).
- Geography excluded v1 (would need a governance decision).
- R6-A lead identity pending: interim seam binds identity to the durable `leads` row;
  replaced by authoritative R6-A linkage on convergence.

## FINAL RESULTS

- Targeted R6-B + audit suites: **88/88 pass** (68 scoring + 20 audit taxonomy).
- Shared-module + root-router regression: **731 passed** (144 + 587), skips/todos all
  pre-existing; **0 failures**.
- Type check (`tsc -b`): **PASS**. `git diff --check`: clean.
- Full `vitest run` (365 files / 5,769 tests): **5,687 passed / 2 failed / 66
  skipped / 14 todo**. The 3 failing files are **all outside the R6-B changeset**
  (`git diff --name-only a947ecb..HEAD`) and are the pre-existing environmental
  failures recorded at base in the R5-D report:
  - `api/lib/billing/credit-engine.test.ts` + `api/lib/creative/creative-generation-claim.test.ts`
    — the "reports the configured database name without printing credentials" guard
    asserts `expect(dbName).toBeTruthy()`, which is empty because no `DATABASE_URL` is
    configured in this shell.
  - `src/pages/Campaigns.test.tsx` — fails at module load in `src/lib/firebase.ts:14`
    (`getAuth`) because no `VITE_FIREBASE_API_KEY` is set in this shell.
  None of these files or their subject modules are touched by R6-B; the failures are
  environmental, not regressions. Every scoring, audit, opportunity, and root-router
  suite is green.
- Migration execution: **FALSE**. Deploy: not performed. Production: not accessed.
  Live providers/billing: never invoked.

## FINAL VERDICT

**LEAD_SCORING_READY**

Acceptance check:
1. Deterministic evidence-bound scoring over R5 opportunity evidence — engine + cases 1–8.
2. Score is evidence, not qualification — no lead/CRM/outreach writes (cases 27–28).
3. Exact-once / replay / immutable versioning — DB-unique anchors (cases 9–14).
4. Cross-tenant / forged leads fail closed — identity seam (cases 15–16).
5. Honest bounded confidence separate from score value — cases 1, 7, 8.
6. No model, non-billable, injection-resistant — B4 verdict (cases 23–24).
7. Forbidden protected-trait features rejected — feature boundary (case 20).
8. Read-only downstream projection for R6-C — contract + cases 25–26.
9. Server-owned weights/identity; clients supply only `leadId` — router + cases 18–19.
10. Rogue-agent addendum (8/8 invariants) — SECURITY table, all PASS.
11. All accepted commits pushed — origin HEAD matches `1df19ea`.
12. Migration not executed, no deploy, no production access, no live provider/billing.
