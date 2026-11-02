# R10-C runtime resilience acceptance report

Branch: `feature/r10-c-runtime-resilience`.
Recovery HEAD: `59445d89f9d53e950bec517feedf1e4707b81860`.
Confirmed resume authority: `3a5001f8db905d3d7d96f0056296d9c0e02cd6c4`.
Frozen programme base: `799f6b4cb351ebe969f97da606324605fdf2a07b`.
C0 remains committed. Original work was inspected before editing; recovery
counts and findings are in `r10-c-resume-position.md`. No reset, clean,
discard, history rewrite or sibling merge occurred.

## Implemented scope

| Stage | Implementation and evidence |
|---|---|
| C1 | Canonical contract, strict reference-only boundaries, closed states/errors; trusted server composition |
| C2 | Deterministic worker/job/lease identities, immutable job fingerprints, unique durable anchors |
| C3 | Heartbeat registration/update, late/stale/dead/unknown/version classification; no heartbeat-derived success |
| C4 | MySQL version/state claim CAS, affected-row winner proof, exclusive lease epoch fencing; same-worker and two-worker duplicate tests |
| C5 | Durable DISPATCHING barrier before R9-D; explicit crash truth table; missing receipt/hash never success |
| C6 | Fresh durable job/action/attempt/material reads on every run; R9-D revalidates mission/plan/task/schedule/governance before dispatch |
| C7 | R9-D/F-prepared retry only; exact latest failed attempt, new governance decision, original action scope and parameter hash rechecked |
| C8 | Evidence-first dead letters with authority/attempt/failure/uncertainty/time/diagnostic hash; persistence failure leaves original job visible |
| C9 | Advisory expiry/dead-owner/provider-pending/callback/unchanged detection; never automatic recovery authorization |
| C10 | Synchronous local drain flag plus durable DRAINING; active dispatch remains conservatively classified; stop waits for active runs |
| C11 | Runtime/release mismatch fails closed; no worker-controlled widening |
| C12 | Frozen read-only observability projection and scoped internal durable reader; bounded counts explicitly disclosed |
| C13 | No worker result setter, governance writer, provider/account selector, credential resolver, shell/SQL execution, monitoring/backup switch |
| C14 | Connected runtime acceptance, durable CAS/structural checks, R9 compatibility and offline regressions |

The store retains the recovered worker/job/lease/dead-letter/lifecycle
operations and adds affected-row checks, dispatch fencing and scoped reads.
An editing-script truncation was caught by targeted tests and corrected before
acceptance; the final verification covers the restored store.

## Crash and adversarial evidence

`api/lib/runtime-resilience/runtime-acceptance.test.ts` runs the real runtime
service/store and R9-D/F services against an in-memory Drizzle predicate and
unique-index harness. It proves:

- Duplicate enqueue/delivery convergence, one exclusive winner, stale lease
  fencing, expired-lease barrier/completion rejection, stale-worker rejection.
- No dispatch without a durable R9-D intent; restart does not duplicate intent.
  Barrier-before-R9, during-dispatch and ack-before-local-ack windows remain
  uncertain without a durable receipt; no blind replay. A missing result hash
  cannot establish success. Provider timeout/ambiguity/pending remain honest.
- Restart rereads action/material; stale schedule, policy and revoked approved
  ledger entry deny dispatch through the real R9-F consumption gate. Changed
  parameters and immutable-core tamper fail closed.
- Retries require new exact governance, the latest failed attempt and original
  scope; broadened material is rejected. Runtime owns no retry authorizer.
- Dead-letter evidence retains uncertainty and the latest execution attempt;
  it never rewrites R9-D or mission truth. Failed evidence storage leaves
  the job visible. Conflicting lifecycle identities fail closed.
- Drain rejects new claim calls and preserves in-flight ambiguity. Active runs
  must finish before stop reports drained. Runtime/release drift fails closed.
- Duplicate callback evidence converges; conflicting evidence fails closed.
  Actual callback polling/binding remains R9-D-owned and covered by its
  connected/security suites; workers have no callback/result-write API.
- Cross-tenant/business work, forged outcome/provider/account/secret/retry/
  policy/monitoring/backup fields are rejected. Shell, SQL and injection text
  remains inert diagnostic data. Secret-shaped, oversized/deep diagnostics
  are rejected. Structural checks prohibit dangerous runtime imports.

## Verification results

Verification below was performed after the confirmed second resume.

The first full offline run found two failures, both isolated against the
unchanged recovery HEAD in an ignored archive (no worktree replacement):

1. `terminal-content-replay-executor.test.ts`: identical binding rewrote its
   preparation timestamp and reported a new binding when milliseconds differed.
   Unchanged production code failed with a 5ms gap; the corrected predicate
   binds only an empty slot and exact replays converge via a read. The retained
   regression test includes the gap. Accepted correction: `3a5001f` plus import
   cleanup in the runtime acceptance slice.
2. `src/pages/Campaigns.test.tsx`: Firebase `auth/invalid-api-key` during import,
   reproduced on unchanged HEAD. A process-local, non-secret
   `VITE_FIREBASE_API_KEY=offline-test-placeholder` makes all three tests pass.
   The final full suite uses that test setting. No application configuration,
   real key or Firebase sign-in/provider call was introduced.

Historical full run from the interrupted session: 453 files passed, 2 failed, 1 skipped; 7,702 tests passed,
1 failed, 68 skipped, 14 todo. Initial compatibility run: 559 passed, 1 skipped
across 20 files. Intermediate runtime/queue run after restoration: 283 passed
across 11 files (59 runtime cases). These are historical results; final results
below control acceptance. Historical isolation results above are the preserved
session record; no failures are waived in the current final runs.

Current confirmed-resume verification:

- Runtime/queue/R9-F/R9-X targeted run: 417 passed across 15 files.
- Final R10-C plus R9-D/E acceptance/security run: 202 passed across five
  files, including 60 R10-C tests. Covers the dead-letter receipt correction
  and successful exact governed retry after changed-material rejection.
- Full offline suite: 455 files passed, one skipped; 7,710 tests passed,
  68 skipped, 14 todo. Uses only the non-secret process-local Firebase
  placeholder described above. Exit 0; no unresolved failures.
- Final verbose full-suite run: 455 files passed, one skipped; 7,711 tests
  passed, 68 skipped, 14 todo (500.73s). The additional passed case is the
  dead-letter receipt regression. All test results passed, but PowerShell's
  redirected native stderr yielded wrapper exit 1. An isolated Node process
  that only writes `probe` to stderr reproduced wrapper exit 1 despite native
  exit 0; explicitly propagating LASTEXITCODE returned 0. No test failure was
  dismissed. Final explicit-native-exit full-suite result: 455 files passed,
  one skipped; 7,711 tests passed, 68 skipped, 14 todo (238.32s),
  `VITEST_NATIVE_EXIT=0`. Command: `npm test -- --maxWorkers=4` with the
  process-local Firebase placeholder; LASTEXITCODE explicitly propagated.
  Existing skips/todos were not widened by this stream.
- `npm run check` (`tsc -b`): passed twice, including after the final code
  correction (exit 0).
- Backend esbuild bundle of `api/boot.ts` and `api/worker.ts`: passed after
  the final implementation correction. Neither bundle was executed.
- `git diff --check`: passed; staged whitespace check recorded at commit.
- Credential-pattern scan of all 20 R10-C changed/new files since the frozen
  base: zero matching files (private-key headers, AWS access IDs, Google API
  keys, GitHub tokens, long OpenAI-style keys); no secret values printed.
- Canonical R9 migration 0037 and migration journal: unchanged from frozen base.

Accepted implementation slice: `2ed9314` (16 files, connected code/tests,
contracts and unexecuted migration). Reviewed staged diff and staged
`git diff --check` passed before commit. Pushed with normal `git push -u
origin feature/r10-c-runtime-resilience`; no force push or history rewrite.

The filesystem sandbox initially denied esbuild's configuration-directory
read before tests started. The identical targeted command passed outside the
sandbox. This startup failure is isolated from test behavior; it is not a
waived test failure.

## Schema and production boundaries

Five runtime tables and provisional `0038_r10_c_runtime_resilience.sql` remain
artifacts only. SQL primary keys now match schema definitions. No journal or
canonical R9 0037 change; R10-X owns migration convergence. No migration ran.

Repository readiness is for later production binding. This module is not
activated by `api/worker.ts` or `api/boot.ts`; existing queue workers retain
their separate authorities and are compatibility-tested, not certified as
production-bound R10-C workers. R10-X must bind authenticated worker processes,
least-privilege credentials, scheduler/supervisor signals, heartbeat scheduling,
parameter sources, provider/account registries and queue delivery to the
trusted controller. Real MySQL contention, live crash/restart supervision and
OneGrid runtime behavior have not been tested. A fixed 60s lease deliberately
limits dispatch eligibility; long work reconciles durable receipts, never
blindly redispatches. Observability counts are bounded snapshots, not global
queue totals. Runtime results are snapshots; R9-D/E retain callback/outcome
truth. Already-entered async claims may finish fencing after drain, but must
recheck eligibility before dispatch. These limits are explicit in the contracts.

ONEGRID_ACCESSED=False
PRODUCTION_WORKERS_EXECUTED=False
DEPLOYMENT_EXECUTED=False
LIVE_PROVIDER_CALLS=False
MIGRATION_EXECUTION=False

RUNTIME_RESILIENCE_READY

This verdict certifies repository/runtime resilience for later production
binding only. It does not certify OneGrid or live runtime behavior.
The final documentation slice is published by normal fast-forward push;
completion requires a clean working tree and local HEAD equal to the remote
feature-branch HEAD, verified after that push.
