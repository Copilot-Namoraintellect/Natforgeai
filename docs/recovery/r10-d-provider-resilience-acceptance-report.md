# R10-D provider and integration resilience acceptance

Frozen programme base and recovery HEAD:
`799f6b4cb351ebe969f97da606324605fdf2a07b`.
Branch: `feature/r10-d-provider-resilience`.
Worktree: `C:\Users\27768\NatForgeAI-R10-D`.
Validation date: 2026-11-02.

## Recovery and preservation

Inspection preceded edits: short status, unstaged and staged schema diffs,
every file under `api/lib/provider-resilience/`, provisional migration 0038,
contracts and repository instructions. The actual resumed state had progressed
beyond the prompt's helper-only inventory: all 28 legitimate paths were staged.
The earlier recovery inventory is retained, with this recovery appended.

```text
RECOVERY_BASE_HEAD=799f6b4cb351ebe969f97da606324605fdf2a07b
CURRENT_CHANGED_PATH_COUNT=28
CURRENT_UNTRACKED_PATH_COUNT=0
INFERRED_ACTIVE_STAGE=D17 validation and final acceptance report
LEGITIMATE_WORK_PRESERVED=True
SAFE_TO_RESUME=True
```

There were no unmerged paths, no R10-D commit and no remote feature branch.
No reset, clean, discarded recovered work, or sibling merge occurred. R10-B/E/F
were not merged or needed to alter the frozen R9 boundary.

## Implemented stages

| Stage | Delivered artifact and behavior |
| --- | --- |
| D0 | `r10-d-provider-inventory.md`: existing provider/integration surfaces, frozen authority and activation boundaries |
| D1 | Validated, deeply frozen declaration registry; server-owned closed capability/action vocabularies; production adapter contract |
| D2 | Exact tenant/business/provider/account/capability/action/parameter/action-attempt binding; fixed server-selected binding |
| D3 | Canonical deterministic binding/request identities, native key where declared, durable claim before transport, tenant/action/attempt uniqueness |
| D4 | Seven conservative result classes; explicit referenced business success; HTTP 200 alone never succeeds |
| D5 | Deadline-bounded calls; timeout, reset, DNS/transport error, truncation and malformed outcomes remain uncertain |
| D6 | HMAC signature, constant-time comparison, freshness, provider/account/event/request/attempt binding; signed payload detached before awaits |
| D7 | Durable duplicate convergence; contradictory callbacks quarantined and preserved without overwriting terminal truth |
| D8 | Exact request-bound reconciliation, evidence fingerprints, unknown remains uncertain, terminal conflicts retained; crash-held probe reservation settled once |
| D9 | Durable per-tenant provider/account/action windows, conservative token-bucket envelope, visible bounded retry-after; deterministic token helper |
| D10 | Bounded deterministic exponential backoff/jitter, explicit exhaustion; advisory only, no autonomous retry |
| D11 | Persisted CLOSED/OPEN/HALF_OPEN circuit, bounded reserved probes; ordinary stragglers cannot release probes; no fallback authority |
| D12 | Safe pause/pending/attention/reauthorization postures; no active background retry queue or widened scope |
| D13 | Fixed least-privilege callback-key registration; no model secret selectors, env/path lookup or secret diagnostics; dispatch adapters sandbox-only |
| D14 | Frozen 17-key `provider-health/v1` projection, declared-only signals and authority disclaimers; producer must scope/window samples |
| D15 | Enterprise certification gates for future Salesforce/Adobe/SAP/Google/Meta/LinkedIn/CRM/CDP/internal connectors; none activated |
| D16 | Strict bounded JSON, nested authority/secret selector rejection, inert shell/SQL/prompt text, isolated tenant/business/account access, immutable store update allowlists |
| D17 | Connected fake-provider acceptance, persistence query-boundary tests, R9 and integration regressions, offline full-suite attempt, type/build/diff/secret checks |

Production artifacts: `docs/contracts/production-provider-adapter-contract.md`,
`docs/contracts/provider-to-observability-contract.md`, and
`docs/contracts/enterprise-connector-certification-standard.md`.

## Acceptance evidence

The recovered 76 provider cases initially passed. Review then added regression
coverage for signed-payload mutation across awaits, unresolved effects blocking
a new attempt for the same action, exact pending reconciliation evidence,
ordinary stragglers versus half-open probes, immutable persistence fields,
failed CAS, exact human approval and altered approval rejection, and
reconciliation after a probe result-persistence crash.

The provider suite proves declared-provider execution; undeclared provider and
capability rejection; wrong account, tenant and business rejection; stable
request identity; concurrent and restarted duplicate convergence; explicit
success/final/retryable failure; uncertain timeout/reset/truncation/HTTP receipt;
visible rate/auth failure; authentic duplicate callback convergence; forged,
stale, wrong-account/tenant/attempt/reference rejection; conflicting callback
preservation; request-bound reconciliation with and without evidence; bounded
open/half-open circuits; no available-alternative selection; advisory-only
backoff/health; fixed credentials absent from receipts, persistence and logs;
forbidden model credential/URL/tool selectors; inert shell/SQL/prompt text;
storage failure and crash behavior; and sandbox-only composition.

No production adapter is registered. The mandatory server authority resolver
has no default grant. R9 canonical parameter hashing and the actual frozen R9-F
consumption gate are called by the connected service; the tests supply scoped
server fixtures, not a replacement consumption gate.

### Validation results

- Initial R9-D/R9-E/R9-F/R9-X compatibility: 8 files, 276 tests passed.
- Final offline connected/provider/integration run: **20 files, 463 tests passed**:
  87 provider/persistence cases, 276 R9-D/E/F/X cases, and 100 existing mocked
  integration cases. Command: the guarded Vitest invocation below, filtered to
  `api/lib/provider-resilience`, the eight R9 files named in the testing request,
  and `api/lib/integrations`.
- `npm.cmd run check` (`tsc -b`): passed after the final implementation changes.
- Backend esbuild bundle of `api/boot.ts` and `api/worker.ts`: passed after the
  final implementation changes. Build artifacts only; neither was executed.
- `git diff --check` and staged diff check: passed.
- Changed-file secret signature scan: passed for private-key PEM, AWS access
  key, OpenAI key and GitHub token patterns. The only callback-key literal is
  explicitly synthetic test material. This is a scoped scan, not a claim of
  provider credential certification.
- Static review found no network transport, shell execution, environment secret
  lookup or console logging in the non-test provider modules. The dormant MySQL
  repository is not constructed or invoked by acceptance.

The full offline run used:

```text
node --require ./scripts/r10-d-offline-network-guard.cjs ./node_modules/vitest/vitest.mjs run
```

Result: **453 passed files, 2 failed files, 1 skipped file**; **7,729 passed
tests, 1 failed test, 68 skipped, 14 todo** (7,812 collected). This broad run
preceded the final additional provider/persistence cases; those affected paths
were rechecked in the final focused run. Full-suite failures were investigated:

1. `src/pages/Campaigns.test.tsx`: imports Firebase Auth without a configured
   test API key and fails at initialization (`auth/invalid-api-key`). The same
   failure reproduces from an isolated archive of frozen HEAD.
2. `api/lib/queue/terminal-content-replay-executor.test.ts`, case 20: expects the
   second exact binding to report `bound=false`. Frozen `terminal-replay.ts`
   rewrites `contentRecoveryPreparedAt` with `new Date()` on replay; the fake
   database reports a changed row when calls cross a millisecond boundary.
   The unchanged frozen suite passed an isolated rerun. Adding a 5 ms delay
   only between those calls in the temporary baseline test reproduces the
   exact full-suite assertion failure against unchanged frozen implementation.
   Neither queue implementation nor its worktree test was modified by R10-D.

These are disclosed baseline/environment failures, not a green full-suite claim.
The baseline archive and timing diagnostic were created under the OS temporary
directory; no baseline checkout/reset changed this worktree.

The offline preload denies TCP/TLS/HTTP/UDP and DNS access, with a synthetic
localhost lookup solely for Vite startup. It is never imported by application
boot. Initial sandbox test/build attempts could not resolve local files;
reruns with filesystem access passed. The first offline preload attempt stopped
at Vite's localhost lookup; synthetic resolution fixed startup without network.

## Persistence and production limits

The five new tables and provisional `0038_r10_d_provider_resilience.sql` remain
artifacts only. R10-X owns migration convergence and execution. The MySQL
repository uses a tenant transaction lock, unique anchors, versioned updates
and commit-before-transport ordering. Sandbox transactions and query-boundary
mocks validate the orchestration; real-MySQL concurrency, crashes, deadlocks,
collation and driver affected-row behavior remain explicit activation gates.

Local claims guarantee at-most-one transport invocation per action/attempt,
not provider-side exactly-once effects when native idempotency is unavailable.
Cross-action recovery lineage and fresh upstream readiness remain the mandatory
server authority resolver's responsibility. An unresolved prior receipt blocks
another attempt for the same action even if another provider is available.
No service fabricates provider evidence, selects fallback accounts, mints
governance decisions, or writes upstream R9 execution/recovery/governance rows.

Production endpoints, webhook formats, phase timeout enforcement, least-privilege
dispatch credentials, global quota allocation and real connector behavior must
pass enterprise certification before activation. READY covers the sandbox-safe
resilience layer and contracts, not activation of production integrations.

```text
LIVE_PROVIDER_CALLS=False
ONEGRID_ACCESSED=False
PRODUCTION_MUTATION=False
DEPLOYMENT_EXECUTED=False
MIGRATION_EXECUTION=False
```

## Verdict

PROVIDER_RESILIENCE_READY
