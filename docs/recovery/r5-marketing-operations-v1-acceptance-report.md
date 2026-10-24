# R5 Marketing Operations V1 — Acceptance Report (R5-X9)

> **Verdict:** `MARKETING_OPERATIONS_V1_READY`
> **Date:** 2026-10-24
> **Integration branch:** `integration/r5-marketing-operations`
> **Base:** `e4493a8` (R4 authority, `FULL_AUTONOMY_V1_READY`)
> **HEAD:** `1dfd317` (converge(x7), pushed)
> **Scope rule honoured:** no migrations executed, no deployment, no production
> access, no live providers, no billing authority invoked — evidence only.

---

## 1. Identity

| | |
|---|---|
| Branch | `integration/r5-marketing-operations` |
| HEAD | `1dfd3176db9dd9a641ee16f7f4fd1a89fbba078a` |
| Remote sync | every accepted commit pushed immediately (`d53478d` → `1dfd317`); branch matches origin at report time |
| Working tree | clean at the report commit boundary |
| Stream worktrees | A/B/C/D/E/F untouched (separate worktrees, frozen heads intact) |

## 2. Convergence commit stack (chronological, all pushed)

| Commit | Slice | Content |
|---|---|---|
| `d53478d` | merge(stream-a) | WBS-R5-A social listening authority |
| `5024584` | merge(stream-b) | WBS-R5-B intent & sentiment intelligence authority |
| `dc4602c` | merge(stream-e) | WBS-R5-E policy, safety & cost control authority |
| `088fcc0` | merge(stream-c) | WBS-R5-C autonomous engagement authority |
| `5e84a31` | merge(stream-d) | WBS-R5-D opportunity detection authority |
| `5bb49e8` | merge(stream-f) | WBS-R5-F operations governance authority |
| `d1ab3e6` | converge(x3.1) | R5-B canonical signal bound to integrated R5-A authority |
| `ea2da47` | converge(x3.3) | R5-C engagement receipts bound into R5-D evidence seam (server-side) |
| `60dac3d` | converge(x3.4) | Integrated R5-B/R5-D evidence registered into R5-F projection |
| `d4a10e3` | converge(x4) | Canonical migration chain verified drift-clean + convergence doc |
| `b10951f` | converge(x5) | One truthful integrated provider capability view + eligibility rule |
| `60e6619` | converge(x6) | Cross-stream security boundary acceptance (router authz) |
| `1dfd317` | converge(x7) | Connected end-to-end marketing-operations harness + continuation resume fix |

## 3. X7 — connected end-to-end harness

**Artefact:** `api/r5-x-e2e-harness.test.ts` (new authority, committed in `1dfd317`).
`api/r5-x-debug.test.ts` (untracked checkpoint scratch) was removed: it did not
parse (`Cannot use "&&" with "??" without parentheses`), its `describe("debug B")`
assertions are a strict subset of scenario B + frozen C9.28, and its only useful
mechanism (the hoisted-deps continuation mock) already exists in the canonical
harness. Removed only after the canonical harness went green without it.

**Method.** ONE shared in-memory fake database carries the whole loop; every hop
runs its REAL store/planning/execution/projection module on it. Fakes exist only
at the external boundaries: scripted provider gateway, scripted governed model
runner, vi.mocked R5-E authority snapshots (same seam as the frozen C9 suite),
and a text-dispatched `db.execute` bridge for R5-F's information_schema-guarded
readers. No real database, no live provider, no live model, no wall-clock-dependent
assertions.

**Scenario coverage (12 green):** core happy chain (A/U/Z: binding → R5-A ingest →
R5-B interpretation → R5-E decision → R5-C plan/execute/receipt → R5-D candidate →
exact-once R6 handoff → R5-F projection), B (medium-risk approval path:
gate-blocked early, operator approval resumes through the real continuation), D
(DENY never executes, non-billable), E (NO_ACTION + deterministic RULE path,
non-billable, no candidate), F (duplicate webhook collapses at A), G (duplicate
interpretation converges at B), I (duplicate/concurrent execution converges to one
provider effect, one receipt, one settle), J (restart after signal persistence
reproduces identities with no duplicates), S1/S2 (prompt-injection containment in
B's untrusted block; policy escalation can only reduce autonomy), Y (forged /
cross-business engagement receipt fails closed at the D seam), AA (operator
blocker visibility without SQL or source; no secrets in the serialized
projection). Fourteen further letters (C, H, K–R, T, V–X) are cross-referenced to
the frozen per-stream suites via `it.todo` — reimplementing them would add no new
signal.

**Result:** `12 passed | 14 todo (26)`.

### Genuine integration defects found by the harness and fixed

1. **Approval continuation dead-end (product fix, `api/lib/engagement/continuation.ts`).**
   An execution attempted while its approval was pending was gate-marked
   `blocked` (non-permanent `APPROVAL_PENDING`), after which the disposition
   resolver's terminal treatment of `blocked` dead-ended the continuation: an
   approved action whose execution had raced ahead of the human could never
   resume. `resumeEngagementContinuationForApproval` and the boot sweep now
   re-queue `governance`-class blocked executions to `pending_claim` and re-run
   the full gated path; the R5-E gate re-asserts policy version, approval
   binding, context and expiry at execution time, so a still-unauthorized action
   simply re-blocks with the current reason. Capability (`unsupported`) blocks
   are not approval-recoverable and stay terminal. No policy rule was added to
   the execution engine. This is the defect the removed debug file was chasing.

2. **Harness B→D double adaptation (harness fix).** The harness fed
   `adaptSocialInterpretation`'s canonical READ shape (carrying the output-only
   `interpretationContractVersion` marker) into `evaluateOpportunity`, which
   strict-validates the raw R5-B-facing INPUT field set by design (frozen D
   contract; unknown keys fail closed). The helper now strips the marker at the
   seam, mirroring the production router contract.

3. **Harness fake-DB fidelity (harness fix).** The fake now supplies the schema's
   `createdAt .defaultNow().notNull()` on insert (C's receipt store deliberately
   relies on the DB default), serves the per-binding `GROUP BY integrationId`
   rollup shape R5-F actually issues, binds tenant coordinates from numeric
   params (the window Date's position varies per reader), and corrects three
   fixture expectations to the frozen contracts (spam RULE record carries the
   `spam_or_scam` gating flag → `RISK_GATED`; foreign receipt fixture uses the
   ISO `executedAt` string the seam requires; `areasUnavailable` is internal to
   the evidence collector, not part of the projection contract). One pre-existing
   type error in the untracked harness was fixed so `tsc -b` is clean.

## 4. X8 — broad regression / baseline comparison

**Method.** Full suite (`vitest run`, 361 files at baseline) executed twice at
HEAD `1dfd317` and once at baseline `60e6619` (pre-X7, via detached worktree with
a `node_modules` junction, same command, no `.env`). Every file failing at HEAD
was additionally run in isolation at both revisions to separate deterministic
failures from under-load flakes.

| Suite | Files | Failed files | Failed tests | Passed |
|---|---|---|---|---|
| Baseline `60e6619` (full) | 361 | 4 | 3 | 5,606 |
| HEAD `1dfd317` run 1 (full) | 362 | 5 | 4 | 5,617 |
| HEAD `1dfd317` run 2 (full) | 362 | 4 | 3 | 5,618 |

HEAD adds exactly one file (the X7 harness: +12 passed, +14 todo). The failing
set at HEAD run 2 is **byte-identical to baseline**:

| Failing file | Baseline | HEAD | Nature |
|---|---|---|---|
| `api/lib/audit/audit-event.test.ts` — "covers the required canonical material-event types" | ✗ identical test | ✗ identical test | pre-existing |
| `api/lib/billing/credit-engine.test.ts` — "reports the configured database name without printing credentials" | ✗ identical test | ✗ identical test | pre-existing, env-dependent (no `DATABASE_URL` in test env) |
| `api/lib/creative/creative-generation-claim.test.ts` — same DB-name guard | ✗ identical test | ✗ identical test | pre-existing, env-dependent |
| `src/pages/Campaigns.test.tsx` — suite fails at import | ✗ `auth/invalid-api-key` | ✗ `auth/invalid-api-key` | pre-existing, env-dependent (no `VITE_FIREBASE_*` in test env) |

`api/lib/queue/terminal-content-replay-executor.test.ts` failed once under
full-suite worker load at HEAD (in-memory claim-binding race) and passed in the
second full run and in isolation at **both** revisions; it has no dependency on
the X7 change and is recorded as a known under-load flake.

**Verdict: zero regressions.** Every deterministic failure is present,
byte-for-byte, at the pre-X7 baseline.

**Affected-area regression (targeted, all green at HEAD):** R5-C acceptance
`api/r5-c-acceptance.test.ts` (29 tests), D opportunity suites
(`api/lib/opportunity/**`), E policy suites (`api/policy-acceptance.test.ts`,
`api/lib/policy/**`), A listening (`api/lib/social-listening/**`), B intelligence
(`api/lib/intelligence/**`), F governance (`api/lib/governance/**`), X5/X6
(`api/r5-x-provider-capability`, `api/r5-x-security-acceptance`), X7 harness,
approval/admin router suites — 766+ tests across 49 files, all passing.
Type check `tsc -b` clean at HEAD.

## 5. Hygiene evidence

- `git diff --check`: clean.
- Change boundary (X7 commit): exactly two paths — `api/lib/engagement/continuation.ts`
  (+41 lines, resume fix only) and `api/r5-x-e2e-harness.test.ts` (new). No other
  tracked file touched; the six stream worktrees untouched.
- Secret/sensitive-data scan over the change boundary: no key material, no
  credential patterns. The harness's `TEST_SECRET_TOKEN` is a canary string
  proving the projection never leaks tokens (asserted absent from all serialized
  output), the same idiom as the frozen C9 suite.
- No migrations generated or executed; `db/migrations/**` untouched by this
  slice; no deployment; no production access; no live provider or billing calls.

## 6. Final verdict

**`MARKETING_OPERATIONS_V1_READY`**

All six stream authorities are merged and bound at their designed seams
(X3.1/X3.3/X3.4/X4/X5/X6), the connected end-to-end loop is proven on real
modules with one shared database (X7), the only product defect the connected
sequencing surfaced is fixed at the resume authority with fail-closed re-validation,
and the broad regression comparison against the pre-X7 baseline shows zero
regressions. The four remaining red files are pre-existing, environment-dependent
failures identical at baseline, outside the R5 surface, and out of scope for this
programme slice.
