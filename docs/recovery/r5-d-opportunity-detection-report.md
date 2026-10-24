# R5-D OPPORTUNITY DETECTION — FINAL STREAM REPORT

> **Stream:** WBS-R5 Stream D — Opportunity Detection
> **Authority basis:** R4 `FULL_AUTONOMY_V1_READY`; programme base `integration/r5-marketing-operations`

---

## IDENTITY

| Item | Value |
|---|---|
| Branch | `feature/r5-d-opportunity-detection` |
| Base | `e4493a8` (consumed, not merged) |
| HEAD | see `git log` — committed sequentially, each commit pushed |
| Remote sync | `origin/feature/r5-d-opportunity-detection` — all accepted commits pushed immediately |
| Clean status | working tree clean at every commit boundary |

## COMMITS (accepted, in order)

1. `docs(r5-d): D0 repository/opportunity inventory`
2. `docs(r5-d): D1 canonical opportunity candidate contract`
3. `feat(r5-d): governed opportunity detection engine (D2-D8)` — engine + unit tests + provisional migration 0030
4. `test(r5-d): D9 28-case connected acceptance suite + two lib defect fixes`
5. `docs(r5-d): R6 handoff contract - opportunity-to-lead-autonomy/v1`
6. (this report)

No R5 upstream branch was merged. A/B/E/F contracts were consumed read-only from
frozen refs (`c9a930e`, `b939328`, `c936caa`, `5800626`). R5-C's contract was
unavailable (its branch ref equals the base); D7 implemented as a structural
adapter seam with documented R5-X convergence requirements (contract §13).

## D0 — INVENTORY

`docs/recovery/r5-d-opportunity-detection-inventory.md`. Headline: zero existing
opportunity modules; nearest neighbour is the audience pipeline
(`campaign_interest_signals → lead_scores → outreach_recommendations → optional
leads auto-create`), which must NOT be repurposed as lead authority; "Stream D"
naming collision with R4 post-live contracts flagged (we use "R5-D" everywhere);
migration collision (A/B/E all provisional 0029) documented for R5-X.

## D1 — CANONICAL CANDIDATE CONTRACT

`docs/contracts/opportunity-candidate-contract.md`. One canonical candidate:
deterministic tenant-anchored identity (`opp1:` sha256 over thread coordinates),
closed type/status/confidence vocabularies, immutable hash-verified evidence,
bounded confidence, policy gates, expiry, exact-once R6 handoff, privacy §12.

## D2 — RULE-FIRST DETECTION

`api/lib/opportunity/detection-rules.ts` — `opportunity-detector/v1` table
(R1–R14) over R5-B controlled labels only; no raw text, no keyword sales-intent
matching; pure, explainable (ruleId on every outcome), non-billable (no model,
no runAgent, no reservation, no ai_usage).

## D3 — EVIDENCE AGGREGATION

Thread-history aggregation (same tenant + threadKey, bounded window) feeds R9/
R10 (complaint→recovery, praise→advocacy); candidate state recomputes
deterministically over immutable in-window evidence; single weak signals never
auto-strengthen into strong candidates.

## D4 — IDENTITY / DEDUPLICATION

`opportunity-identity.ts` + DB-authoritative unique keys: `(userId,
opportunityKey)` candidates, `(interpretationId, kind)` + `engagementReceiptId`
evidence, `interpretationId` suppressions, `(userId, opportunityId)` +
`handoffId` handoffs. Proven by cases 9–11, 13–15, 26: replay/concurrency
converge to one row; cross-tenant never collides; versioned rules preserve
history (identity is rules-version-independent); CAS guards reject stale writes.

## D5 — CONFIDENCE / EVIDENCE STRENGTH

`evidence-strength.ts` — closed LOW/MEDIUM/HIGH/UNKNOWN ordinals with an exact
published rule table (contract §6): HIGH needs repeat + explicit; contradictions
cap at LOW; recency cap degrades by age; client/model can never set these.

## D6 — POLICY / SUPPRESSION BOUNDARIES

`policy-gates.ts` — safety flags → SAFETY_ESCALATION (live thread candidates
escalated), gating risk flags → RISK_GATED, explicit R5-E suppression →
POLICY_SUPPRESSED, volume guard → FLOOD_GUARDED. Detection is observational:
candidate existence ≠ outreach permission; DENY/ESCALATE engagement decisions
are never treated as contact authority (case 21–22).

## D7 — ENGAGEMENT EVIDENCE

`engagement-evidence-seam.ts` — strict validated receipt shape, hash-verified
(forged receipts fail closed, case 20), binding-checked against candidate
evidence; optional enrichment only — detection works from A+B alone (cases 19).

## D8 — EXPIRY / SUPPRESSION / HANDOFF

Lifecycle transition table (pure, closed); deterministic expiry sweep (cases
23); durable suppressions; exactly-once handoff envelopes with `oph1:` identity
and unique `(userId, opportunityId)` anchor (cases 25–26). R5 never creates the
R6 lead.

## D9 — ACCEPTANCE

`api/lib/opportunity/r5-d-acceptance.test.ts` — 30 tests covering all 28
required cases on a fake-drizzle executor harness with DB-authoritative unique
keys and explicit clocks. The suite surfaced and we fixed two real lib defects
(initialStrength baseline; evidence uniqueness for receipts).

## TESTING

- Targeted: `npx vitest run api/lib/opportunity/` → **66/66 pass** (30 acceptance + 36 unit); audit taxonomy suite 20/20.
- Regressions: full `npx vitest run` → **4,979 passed**; 7 file-level failures on first run, of which 2 were environmental flakes that pass on rerun (premium-v2 html-renderer timeout, R4 X6 E2E hook timeout). The remaining 5 were reduced to 1 genuine regression (audit taxonomy list assertion) — **fixed in this stream** (`audit-event.test.ts` updated additively, same pattern as the R4-F `admin_mutation` addition). The other 4 (`credit-engine`, `creative-generation-claim`, `publishing-router` flake, `Campaigns.test.tsx`) fail **identically on base `e4493a8`** — pre-existing/environmental, not caused by R5-D.
- Full suite after fix: audit-event + opportunity suites green (86/86); see committed run logs.
- tsc: `npx tsc -b` → clean.
- Build: `npm run build` → see FINAL RESULTS.
- `git diff --check` → clean at every commit.

## SCHEMA

- Changed: four new tables (candidates / evidence / suppressions / handoffs),
  append-only; no enum edits to existing tables; no FK constraints.
- Provisional artefacts: `0030_opportunity_detection_foundation.sql` +
  `meta/0030_snapshot.json` + journal idx 30.
- Execution = **FALSE** (never executed, never deployed).
- Collision documented for R5-X: A/B/E provisional 0029s untouched; R5-D
  deliberately skipped to provisional 0030; R5-X owns canonical renumbering.

## SECURITY

SECURITY_VERDICT=PASS
PRIVACY_MINIMIZATION_VERDICT=PASS
OPPORTUNITY_EVIDENCE_VERDICT=PASS
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS
SENSITIVE_DATA_EXPOSURE_FOUND=False
AUTHORIZATION_REGRESSION_FOUND=False
NEW_SECURITY_DEBT=None

Evidence:
- Adversarial acceptance cases all green: forged businessId (12), cross-business
  (12–13), forged evidence (20), duplicate replay (9–10), concurrency (11),
  cross-tenant actor (13), tampered signal/interpretation (14–15), injection
  text (16), client-forced confidence/type (17–18), flood guard (§9.4),
  stale writes (CAS, 24), policy suppression (21), safety escalation (22),
  PII minimization (27), no lead/CRM creation (28).
- Secrets scan over all 24 changed files: no tokens/credentials/keys; only
  hits are the pre-existing sanitizer regex, pre-existing schema column names
  inside the generated snapshot, and contract prose.
- Authorization: every surface `authedQuery` (sweep is `adminQuery`);
  ownership re-derived from durable rows per request; strict schemas reject
  client-supplied identity/ownership/confidence/status; the one regression
  candidate (audit taxonomy assertion) was a test-list expectation, updated
  additively — no authorization behavior changed (identical results vs base
  on every unrelated suite).

## HANDOFF

- Contract: `docs/contracts/opportunity-to-lead-autonomy-contract.md`
  (`opportunity-to-lead-autonomy/v1`).
- R6 dependencies: provisional migration 0030 tables (R5-X sequencing);
  R6 derives its own lead identity, score, qualification, CRM.
- Overlap-risk files: `api/router.ts`, `db/schema.ts`,
  `api/lib/audit/audit-event.ts` (additive only); audience/engagement modules
  read-only; `financial-reliability-contract.md` untouched (non-billable).

## EXTERNAL LIMITATIONS

- Identity resolution deliberately not attempted: actors are opaque hashes
  (`actorKey`); same actor across tenants is never correlated; same actor across
  platforms/providers is a distinct actorKey by construction.
- Unsupported provider/actor evidence: only R5-A/B contract fields are consumed;
  providers/platforms outside the frozen vocabularies fail closed at the seam.
- Confidence calibration limitations: confidence/evidence classes are bounded
  deterministic ordinals, not statistical probabilities; no calibration claim.
- R5-C engagement evidence unavailable at implementation time (branch ref ==
  base); consumed via structural seam with explicit R5-X convergence reqs.

## FINAL RESULTS

- Full suite on branch (final, post-fix): **4,984 passed / 2 failed** — the 2
  failures are the pre-existing `credit-engine` and `creative-generation-claim`
  "database name" tests that fail identically on base `e4493a8`
  (environmental; no DATABASE_URL configured in this shell). All R5-D and audit
  suites green.
- First full run: 4,979 passed / 7 file failures → 2 environmental flakes (pass on
  rerun), 1 genuine regression found + fixed (audit taxonomy), 4 pre-existing on
  base (verified by running the exact files at `e4493a8`).
- Failing files vs base comparison: identical failures at base → not R5-D caused.
- Build: `npm run build` → **PASS** (vite built in 29s; `dist/boot.js` +
  `dist/worker.js` bundled; deployment verification passed).
- tsc: **PASS**. Targeted suites: **PASS** (86/86 audit+opportunity).
- Migration execution: FALSE. Deploy: not performed. Production: not accessed.
  Live providers/billing: never invoked.

## FINAL VERDICT

**OPPORTUNITY_DETECTION_READY**

Acceptance check (all 12 required):

1. Evidence-backed opportunities detected automatically — `opportunity.evaluate`
   runs the governed rule engine over R5-B interpretations (cases 1–3, 8).
2. Opportunity ≠ lead — pre-lead statuses only; R5 creates no lead/CRM rows
   (case 28; contract §2/§4).
3. Duplicate/replayed evidence does not duplicate candidates — DB-unique
   anchors + replay semantics (cases 9–11).
4. Cross-tenant evidence never combines — tenant-anchored identity + ownership
   re-validation (cases 12–13).
5. Confidence bounded and honest — closed LOW/MEDIUM/HIGH/UNKNOWN with a
   published deterministic rule table (§6; cases 7, 17).
6. Weak evidence never becomes high-confidence — contradictions cap at LOW;
   single weak signals stay weak (case 7).
7. Engagement evidence enriches but is not required — R5-C receipt seam,
   validated and optional (case 19; D7).
8. Policy suppression is not outreach permission — observational detection;
   DENY/ESCALATE never become contact authority (cases 21–22; D6).
9. Privacy minimized — hash-only actor identity, no raw PII/payloads/tokens
   (case 27; §12).
10. R6 receives a stable exact-once handoff contract —
    `opportunity-to-lead-autonomy/v1`, unique `(userId, opportunityId)`
    (cases 25–26; handoff contract).
11. No lead/CRM/outreach action occurs — no code paths exist; verified (case 28).
12. All accepted commits pushed — every commit above pushed to
    `origin/feature/r5-d-opportunity-detection` immediately.

Explicitly not done (per authority): no deploy, no migration execution, no
production access, no live provider/billing invocation, no merge of any R5
branch, no merge to integration.
