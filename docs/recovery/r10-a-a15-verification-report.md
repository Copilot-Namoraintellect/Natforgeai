# R10-A A15 offline verification evidence

Assessment: **PARTIAL**. Documentation stages A01-A14 exist and were reviewed; production implementation and integrated/live acceptance are **BLOCKED**. This is not a production or autonomy readiness verdict. Recorded 2026-11-04; branch `feature/r10-a-production-platform`, HEAD `a0bea50a7bac480e7655ff1915532157b8360540`. Final acceptance/backlog is [A16 handover](r10-a-a16-final-handover.md); machine-readable [execution evidence](r10-a-a15-verification-evidence.json), [historical hash audit](r10-a-a15-hash-audit.json) and [current sources](r10-a-a15-a16-sources.json) retain limits.

## 1. Repository and preservation

`git branch --show-current` and `git rev-parse HEAD` returned the expected branch and exact committed baseline (exit 0). `git rev-parse origin/feature/r10-a-production-platform` returned the same SHA (exit 0): this is a local remote-tracking ref, not a network/push verification. `git log -1 --oneline` identifies the A01-A06 documentation commit. Frozen R9-X baseline remains `799f6b4cb351ebe969f97da606324605fdf2a07b`, not the current A release commit.

Starting `git status --porcelain=v1 --untracked-files=all` showed two tracked A01 modifications and sixteen untracked A07-A14 artifacts. All 36 A01-A14 Markdown/JSON artifacts were individually snapshotted before this mission's appendices. No earlier artifact is rewritten except authorized append-only A01 requirements/decision notes; the source catalog retains pre-mission bytes/digests. Prior reports remain historical, including stage-specific counts and “next stage not begun” statements. Original local planning IDs are not the same as later mission stage labels; A16 explicitly maps both.

## 2. Source-hash audit and limits

All 58 references in the latest A13-A14 current source/specification catalog matched before editing. The broader audit of **all ten earlier catalogs** examined 506 primary path/hash occurrences, including sha256Before-stage references. At this pre-A15-appendix snapshot: 488 match current bytes, 18 do not. Eleven mismatches match exact current-file historical prefixes or HEAD blob/CRLF worktree forms; these are explicitly identified historical-byte matches, not silently treated as current files. Seven references covering three unique documents remain unreproduced:

| Historical document | Referencing catalogs / expected revision |
|---|---|
| A01 requirements | A02 pre-A02, A03 pre-A03, A04 pre-A04, A05 source and A06 source |
| A02 implementation report | A03 pre-A03 |
| A02 platform architecture | A03 pre-A03 |

Available Git path history contains the A01-A06 aggregate commit; earlier exact revision bytes are not available there. A prior catalog claiming a hash was checked is not independent reproduction of that file. The seven references are **HISTORICAL_BYTES_UNREPRODUCED**, not proven malicious drift and not a PASS. Recover exact original bytes/approved provenance or record an authorized evidence disposition; do not rewrite old catalogs or manufacture an earlier document. Current versions are fully hashed in the new catalog. Appending A15/A16 traceability intentionally makes older A01 snapshots historical again; final preservation verifies their pre-mission prefixes rather than claiming every old catalog matches current A01.

No credential/env/backup-payload files were opened or hashed. Names-only Git enumeration still identifies `.env.production`, `.env.backup-20260623-181231`, `.env.example` and `public/web.config.bak` as tracked. F's sibling cleanup does not clean this A tree or revoke historical credentials. This remains a critical production-entry blocker.

Final current-document validation: 88 source/report hashes matched, 34 earlier artifacts unchanged and both A01 pre-mission prefixes preserved; 165 local Markdown links resolve, 13 external URLs have valid format only, all 15 JSON files parse, 16 acceptance rows and 12 original decision rows are retained. The 17-surface monitoring map and 72 consolidated M/T/S/ES/LC/RL/BK specifications retain NOT_RUN. These counts exclude actual execution of those scenarios and do not clear the seven historical limitations. Exact command, recipe, output and exit are retained in the execution evidence.

## 3. Executed static checks and skipped test commands

| Exact command / check | Exit/result | Scope |
|---|---|---|
| `node --version` | 0; v26.13.0 | Local tool executable only; no application/native compatibility proof |
| `npm.cmd --version` | 0; 11.20.0 | Local npm version only; no install/network |
| `node --check scripts/verify-deployment.mjs` | 0 | Parser only; script not executed, imports/HTTP/build output not evaluated |
| PowerShell Parser::ParseFile for verify-release/start-runtime/rollback | 0; all three PARSE_PASS | Complete exact command retained in execution evidence; syntax only, not invoking scripts or reading their referenced .env |
| Stdin-based Node documentary hash/link/JSON/crosswalk/preservation validator | See final execution evidence, exit 0 required for static PASS | Exact recipe/command retained; no boot/worker import, no scanner/provider/test-suite execution; unreproduced historical hashes remain a separate PARTIAL result |
| `git diff --check` | 0 at preliminary and final checks | Tracked diff whitespace; new artifacts receive explicit whitespace validation separately. CRLF warnings are informational |
| `npm.cmd run check` | NOT_RUN; no exit code | node_modules and local/global tsc absent. Existing tsc -b may write build-info; no dependency install or files changed to obtain a pass |
| `npm.cmd test` | NOT_RUN; no exit code | Vitest/local/global runner absent, so established offline suites unsupported in this checkout. Do not substitute npx/download or report zero passing tests |
| `npm.cmd run build`, package/deploy/start/verify scripts and all ES/LC/RL/BK/M/T/S proposed tests | NOT_RUN; no exit code | Build/app/script side effects, optional HTTP, secrets or unimplemented harnesses; none invoked |

`Test-Path node_modules`, `Test-Path node_modules/.bin/tsc.cmd` and `Test-Path node_modules/.bin/vitest.cmd` all returned false; command discovery found no tsc/vitest. No dependencies were installed. Parsing JSON and a schema's structural consistency is not JSON Schema engine/candidate-instance validation. External reference URLs are preserved and syntax-checked only, not fetched during this offline assessment. Historical sibling test/build verdicts remain attributed to their own reports; none is a current-run A15 test pass.

## 4. Mechanism inspection and observed gaps

Source-only inspection confirms: build bundles API/worker and externalizes sharp/FFmpeg/execa/Playwright/core; Playwright is dev-only despite runtime chromium import, cross-env is dev-only for npm start, and no scheduler build entry exists. Exact locked dependency/source hashes remain A07 authority; browser/FFmpeg binary revisions, Windows DLL prerequisites, licenses and Node26 compatibility are not certified.

API boot can create queue consumers as well as timers and sweeps; standalone worker also starts both queues. Stored BullMQ handles are not construction guards. Existing shutdown is not full Windows/C/H lifecycle composition. C/H/E/F modules and G scripts are absent from this A baseline at the inspected integration paths; independent sibling implementations do not establish a live binding here. Media remains CWD-dependent; renderer writes dist/public/videos, conflicting with immutable releases and shared-storage recovery. Existing health queries can write alerts and HTTP200 is not readiness.

Legacy release verifier enforces Node20/old branch/27 migrations/root .env; package/deploy scripts use broad/source/env-copy or Linux setup assumptions; start/rollback use string-built commands, restart-by-name without proven script/CWD/env replacement and manual IIS path instructions. No approved controlled offline Windows packager, selected supervisor, true stop source, collector bindings, protected backup facility or measured recovery exists in this evidence. No script was run to discover these gaps.

## 5. Current-run classification

Documentation scope and handover can be delivered, but fully verified offline preparation cannot be claimed: seven historical hashes cannot be reproduced; compiler, application suites and all specified platform acceptance scenarios are NOT_RUN; implementation/authority decisions remain open. Overall **PARTIAL**, with production **BLOCKED** and live verification **NOT_RUN**. Current static PASS results do not change that classification. Do not emit PRODUCTION_READY or AUTONOMY_READY.

Next action is the ownership/evidence-resolution decision specified in A16. Stop after assessment; implement, deploy, commit and push remain prohibited.
