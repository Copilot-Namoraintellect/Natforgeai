# R10_A_ET02_INCREMENT_2_IMPLEMENTATION_REPORT

Recommendation: **PARTIAL** overall, with **PASS for the restricted trusted-staging default-stream component** and complete Windows filesystem-security acceptance **BLOCKED**. Production acceptance remains BLOCKED. No release or autonomy authority is granted.

## A. Scope and sources

Exactly three additions: [reader](../../scripts/deployment/payload-integrity-preflight.mjs), [tests](../../scripts/deployment/payload-integrity-preflight.test.mjs), and this report. Initial branch `feature/r10-a-production-platform`, HEAD `3fef5aa53c30aab728b0106d5328df34ce47bda0`, clean index/worktree. No earlier file changed and nothing staged; no commit/push occurred.

Contracts: [A07 packaging sections 3-6](r10-a-a07-deployment-packaging.md), [A07 file-entry schema](r10-a-a07-package-manifest.schema.json), [ET01 acceptance](r10-a-package-inventory-policy-acceptance.md), [Increment 1 acceptance](r10-a-et02-manifest-inventory-preflight-acceptance.md), [ET02 backlog](r10-a-engineering-transition-report.md), [A16 handover](r10-a-a16-final-handover.md). The user's restricted Increment 2 authorization is the implementation authority; this does not complete ET02 or alter A01-A16/D01-D12/Q01.

Verified unchanged source SHA-256:

| Source | SHA-256 |
|---|---|
| ET01 module | `6f6bbd8e9cd422b359bd770183c998b0c5fc815459317833527226585530c140` |
| Increment 1 module | `e10d744261ee7de35f4983f3276c607602512ecd566f8081c48c76d57b6690e0` |
| A07 schema | `e036ffaac5f5978f8b0f95279188e4450c64bad3369b7d0c087b7e3d42fc421c` |

## B. Read-only behavior

`verifyPayloadIntegrity(packageRoot, manifestFiles)` requires an explicit primitive absolute local-root path and a nonempty strict manifest array. Drive-relative, UNC, device, extended-device, volume-root, dot-segment and malformed roots reject. The caller must select a trusted, isolated, quiescent local staging tree; this is not a safe reader for adversarial directories. Mapped-drive locality and ACL protection cannot be certified by this module.

Manifest data descriptors are snapshotted synchronously before the first await, rejecting getters, Proxies, sparse/exotic arrays and nonplain records. Increment 1 validates declarations with an expectation projection. ET01 path/exclusion policy runs before candidate content inspection or directory descent. No credentials are opened to test exclusion rules; fixtures contain synthetic bytes only.

The reader checks detectable linked ancestors, uses lstat/realpath containment checks, independently enumerates hidden/ordinary entries with bounded opendir reads and sorted names, rejects detectable links/nonregular objects/multiple hardlinks, and verifies exact file spelling/set and lengths before content reads. Directory paths are policy-checked too. Empty allowed directories are enumerated and stability-checked but are not manifest file records. No evidence-envelope ignore rules exist.

Each regular file opens read-only, one at a time. BigInt device/inode/link/size/mtime/ctime metadata is checked before/after reading and against path metadata. SHA-256 is computed incrementally from actual handle-read bytes with 256 KiB chunks. Final enumeration compares path sets and file/directory metadata. Hash/length mismatches, detected changes, missing/extra files, unsupported metadata and IO errors fail closed. Handles close in finally blocks, including read failures. Reads can affect filesystem access times; the component performs no explicit payload writes.

The same unchanged Increment 1 API reconciles measured size/hash records. Observed kind=file follows regular-file checks, not manifest class. Its required runtimeWritable=false field is explicitly a declaration adapter; no effective permission observation is inferred. The preliminary name/size reconciliation uses expected digest placeholders only internally and cannot establish byte-comparison PASS. Final reconciliation uses actual calculated digests.

Fixed provisional ceilings: 100,000 files; 200,000 enumerated entries per traversal; depth 128; 2 GiB/file; 20 GiB total actual bytes; one active file read; 256 KiB chunks; 128 findings. ET01 path/segment ceilings remain unchanged. Declared total bytes are checked using BigInt. Actual count/growth checks also stop excess reads. No production capacity decision is implied.

Frozen results contain only scope/status, aggregate bytesRead/filesRead, verification flags and bounded fixed-code/index findings. No absolute paths, content, supplied/observed hashes or exception messages are returned. Failure counts can represent work completed before failure. Status/defaultStreamComparison PASS means restricted default-stream comparison only. Every outcome retains productionApproved=false, windowsFilesystemSecurity=BLOCKED, and runtimeWritableProvenance=DECLARATION_ONLY_NOT_VERIFIED.

## C. Capability boundaries

ACL, exhaustive reparse/ADS inspection, race-resistant containment, source trust, signed provenance, allowlisting and dependency closure flags are always false. Node checks do not establish a snapshot, inspect all reparse tags, enumerate named streams, verify drive locality or prevent swaps between checks. Same-handle reads and metadata comparisons detect some concurrent mutations; a hostile writer may evade them. No O_NOFOLLOW guarantee is assumed on Windows. Named-stream or Windows security completeness is never promoted from default-stream PASS. Trusted staging and protected local filesystem state are caller prerequisites, not facts proved by the API.

No subprocess, PowerShell, native addon, app import, CLI, signing, copying, packaging, network/provider operation or configuration modification exists in the reader. Tests alone create/delete their own temporary synthetic directories; no installed release or production directory was scanned.

## D. Test and static evidence

Existing Node v26.13.0 on Windows; no dependencies installed. Commands from the specified worktree:

| Exact command | Exit | Result |
|---|---|---|
| `node --check scripts/deployment/payload-integrity-preflight.mjs` | 0 | PASS |
| `node --check scripts/deployment/payload-integrity-preflight.test.mjs` | 0 | PASS |
| `node --test scripts/deployment/package-inventory-policy.test.mjs scripts/deployment/manifest-inventory-preflight.test.mjs scripts/deployment/payload-integrity-preflight.test.mjs` | 0 | 50 groups: 48 PASS, 0 FAIL, 0 cancelled, 2 skipped, 0 todo |
| `git diff --exit-code` | 0 | No tracked changes |
| `git diff --cached --exit-code` | 0 | Index empty |
| `git diff --check` | 0 | Tracked whitespace PASS |

All 29 earlier ET01/Increment 1 groups pass unchanged. New suite: 21 groups, 19 passing, two explicit limitations. I2-T07 is **NOT_RUN** because local permission/capability prevented creation of a file symlink. I2-T08 Windows junction rejection and I2-T06 hardlink rejection passed using temporary synthetic trees. I2-T16 is deliberately **BLOCKED**, represented as a skipped test, for exhaustive Windows ADS/reparse and race-proof containment; it is not a successful security test.

Passing new groups cover known literal SHA-256 vectors, empty/binary/hidden files, reorder, input/root rejection before IO, exact names/set, prohibited paths without opening, truncation/same-size substitution, IO redaction, deterministic append/delete/substitution, handle closure after injected read error, input snapshot/nonmutation, metadata unsupported/escape checks, depth/entry overflow, sparse oversized file and declared aggregate limit, bounded findings, and nonapproval. Controlled fault tests use node:test mocks of filesystem boundaries; these establish error handling, not adversarial NTFS race resistance. Symlink, exhaustive Windows cases and any live/protected permission tests are not counted as passed.

The first suite run passed 43/45 groups with the same two skips. After five additional targeted groups, final result is 48/50. No failing execution was hidden or existing test weakened. Actual 100,000-file and 20 GiB streamed-payload boundary workloads were not materialized; limits have targeted synthetic/declared coverage rather than exhaustive capacity proof. A final read-only stdin validation (`node --input-type=module`) checks exact untracked scope, report links, source hashes and whitespace/NUL in the three additions, because git diff does not inspect untracked contents.

## E. Remaining dependencies and delivery

Full ET02 root-manifest/provenance authentication, trusted allowlisting, F redacted content scanning and cleanup/rotation evidence, native/browser/FFmpeg closure, source/lock trust and X integrated acceptance remain outstanding. Seven historical source-hash references remain unresolved/unwaived. No new policy for .cab/.jar/.swn/.p8 is introduced. Operational approvers, credential custodians and unassigned app implementers remain UNASSIGNED; sibling F/E/G/X scopes are unchanged.

All earlier tracked files, including protected artifacts, remain unchanged against the committed baseline. Final Git scope is precisely these three untracked additions, no staged changes. Recommendation: independent review of the restricted reader and its capability disclosures before any checkpoint authorization. Stop after Increment 2; no Increment 3 work performed.
