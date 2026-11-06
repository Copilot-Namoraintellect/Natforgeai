# R10_A_ENGINEERING_TRANSITION_REPORT

Status: **PLANNING DECISION RECORDED; FIRST TASK SELECTED, NOT IMPLEMENTED**. Recorded 2026-11-04. Branch `feature/r10-a-production-platform`; HEAD remains `a0bea50a7bac480e7655ff1915532157b8360540`. Offline classification remains **PARTIAL**, production acceptance **BLOCKED**. No production authority, credential custody or application implementation appointment is inferred.

Inputs: [A15 verification](r10-a-a15-verification-report.md), [A16 acceptance/backlog](r10-a-a16-final-handover.md), [A15 command evidence](r10-a-a15-verification-evidence.json), [original hash audit](r10-a-a15-hash-audit.json), [A01 decisions](r10-a-a01-decisions.md), [requirements](r10-a-a01-requirements.md), [A07 packaging](r10-a-a07-deployment-packaging.md) and [transition evidence](r10-a-engineering-transition-sources.json). Prior artifacts remain unchanged except authorized append-only A01 planning notes. Existing A01-A16/D01-D12/Q01 identifiers are retained; this is not a new numbered A17 stage.

## 1. Approved D12/Q01 functional engineering responsibility

Authority is the user's explicit **ENGINEERING TRANSITION AND FIRST IMPLEMENTATION SELECTION** decision. This approves planning boundaries, not implementation or operational action. Existing Q01 functional responsibilities are retained and clarified:

| Functional owner | Approved planning responsibility | Limit |
|---|---|---|
| A | Platform preparation, deployment packaging, release configuration and non-executing infrastructure tooling | May plan A tooling; no implementation in this mission, host operation or application ownership inferred |
| F | Security implementation and repository hygiene | A package-path policy is a packaging control, not a replacement for F secret scanning, credential classification or cleanup |
| E | Observability implementation | A prepares platform configuration/evidence interfaces; E owns observability semantics/implementation, not A by adjacency |
| G | Backup/recovery implementation | A prepares platform configuration/handoff; G's Windows backup/recovery implementation planning is not silently reassigned to A |
| X | Cross-stream integration and integrated acceptance | Does not appoint application implementers, issuer custodians or independent deployment/activation approvers |
| Application code without expressly approved implementer | **UNASSIGNED** | Includes role guards, scheduler entry, storage/video/routes, health refactor and C/D/H/F application composition |
| Production operational approvers and credential custodians | **UNASSIGNED** | Q01 approval is no issuer/admin/system-owner appointment or permission to rotate, revoke, deploy or activate |

A still coordinates exposed-credential remediation/platform evidence as Q01 records; actual rotation belongs to authorized issuer/account custodians. Independent revocation verifier, STOP assertion/restoration authority, recovery/key custodians and deployment approver remain UNASSIGNED. D01-D12 operational choices, ENTRY01-ENTRY07, AP01-AP06 and RG01-RG08 remain open. No F reader grant, RPO/RTO, H level, stop latch or R9-F approval is changed.

## 2. Historical evidence reconciliation

Rechecked all 88 A15 current source/report hashes before edits and snapshotted all 41 prior R10-A artifacts. Reconciliation is limited to the three documented non-secret files: current exact bytes, LF/CRLF forms, line-boundary prefixes and every available committed revision from `git log --all --format=%H -- <path>`, then `git show <revision>:<path>`. The available path history still resolves to the aggregate A01-A06 commit. No historical edits were reconstructed, Git objects changed or secret-bearing paths scanned.

Seven reference occurrences represent **six unique expected hashes across three documents**; the repeated A05/A06 expected digest is one historical version referenced twice. Full expected and current SHA-256 plus exact catalog locations and available revisions are retained in transition evidence.

| Ref | Catalog / exact location | Historical document | Expected SHA-256 prefix | Current reconciliation |
|---|---|---|---|---|
| H01 | A02 `a01Inputs[3].sha256BeforeA02` | A01 requirements | `79ac2a77ea531279` | HISTORICAL_BYTES_UNREPRODUCED |
| H02 | A03 `priorInputs[3].sha256BeforeA03` | A01 requirements | `5c2bc4791b736ad9` | HISTORICAL_BYTES_UNREPRODUCED |
| H03 | A03 `priorInputs[5].sha256BeforeA03` | A02 implementation report | `6f9b6c612ff14857` | HISTORICAL_BYTES_UNREPRODUCED |
| H04 | A03 `priorInputs[6].sha256BeforeA03` | A02 platform architecture | `11409f7f6d769d7a` | HISTORICAL_BYTES_UNREPRODUCED |
| H05 | A04 `priorInputs[3].sha256BeforeA04` | A01 requirements | `41b1e94bf73b6257` | HISTORICAL_BYTES_UNREPRODUCED |
| H06 | A05 `sourceReferences[39].sha256` | A01 requirements | `3dbda4fa8497eaf1` | HISTORICAL_BYTES_UNREPRODUCED |
| H07 | A06 `historicalInputs[0].sha256` | A01 requirements | `3dbda4fa8497eaf1` | HISTORICAL_BYTES_UNREPRODUCED |

Clarification to A15's abbreviated table: A06's unresolved reference is **historicalInputs[0]**, not sourceReferences[39]. The latter's `d90584...` expected hash was reproducible from committed HEAD. This clarifies provenance without changing the historical A15 audit/report. No newly verified historical occurrence is claimed, and current hashes do not substitute for expected historical hashes.

Disposition remains OPEN: obtain exact original revision bytes from an authorized documentary custodian, or a named authority's explicit historical-evidence exception identifying scope and rationale. No such custodian/exception approver has been appointed and this mission grants no waiver. The prior audit's 506/488/11/7 counts are a pre-A15-appendix snapshot, not the count of mismatches after subsequent authorized A01 appendices. PARTIAL and the production block remain. The gap prevents a complete historical-provenance claim; it does not create a dependency on historical document contents for a pure synthetic packaging-policy unit test.

## 3. Ranked A-owned engineering deliverables and dependencies

The table decomposes A16 ENG01-ENG13 into missing executable tooling/configuration outputs. Existing legacy scripts are evidence, not accepted deliverables. Rank is development sequence: security-critical sibling remediation proceeds through its owner in parallel and is never deferred until low-risk tooling finishes. No row is implemented or operationally authorized here.

| Rank / ID | Missing A-owned executable or configuration deliverable | Dependency / risk | Local testability |
|---|---|---|---|
| 0 / ET00 | Engineering/evidence decision and scope records supporting tooling inputs | Recover/dispose H01-H07; name build/publisher/tool leads; issuer/operational appointments still open | Documentary checks only; no runtime grant |
| 1 / ET01 | **Pure package-inventory path/metadata rejection policy** | No sibling/host/credentials/dependencies; high-value packaging guard, low execution risk | Node built-in unit tests on synthetic records; selected first |
| 2 / ET02 | Complete candidate manifest/allowlist/integrity/source/dependency closure verifier | ET01; A07 exact schema/lock policy, trusted release identity, F-approved scan interface | Synthetic file/manifest fixtures initially; no real sensitive-file reads |
| 3 / ET03 | Node26/toolchain/native-resource preflight and approved offline build/package recipe | ET02; actual source/compiler/build/native environment and license/browser/FFmpeg decisions | Offline fixtures first, then separately approved clean builder; no install in this mission |
| 4 / ET04 | Typed release/role/script/CWD/environment/static-root compatibility validator | A13 selector contract, immutable paths; actual scheduler entry/app guard prerequisites UNASSIGNED | Pure desired/observed configuration records; does not start services |
| 5 / ET05 | Host prerequisite and storage-map/capacity planning validator | D01/D03/D04/D06; Windows/IIS/absolute media/scratch/backup namespaces | Fixture inventory first; later authorized host collection |
| 6 / ET06 | Identity/ACL/secret-source desired-state validation and safe provisioning plan | F policy, D05/D07 and named custodian; privileged-agent residual | Synthetic grants/names-only config; no secrets or real ACL writes |
| 7 / ET07 | Supported supervisor API/worker/future scheduler release configurations and lifecycle plan | ET04/ET06, approved wrapper, AP owners must implement inert roles/health/drain/entry | Validate config/stop plans locally; real SCM/reboot proof separately gated |
| 8 / ET08 | NatForgeAI-only IIS/proxy/TLS/firewall/egress/administration desired configuration and validation | D01/D08, F security, exact hostname/port/forwarding and Zuto boundaries | Static fixtures/plans; live rules/cert/DNS require separate authority |
| 9 / ET09 | Private DB/Redis endpoint/namespace/version/connectivity configuration and disposable-target plan | D06/F/B/C; X owns migration convergence; no SQL grants inferred | Synthetic endpoint/config checks; connectivity/DB drills later authorized |
| 10 / ET10 | Signed/authenticated candidate release-selection and rollback plan validator/dry-run tool | ET02/ET04/ET07, compatible schema/media and preserved stop/uncertainty | Fake supervisor/IIS/journal transition tests; no switching commands in first tooling |
| 11 / ET11 | Independent stop-source platform configuration/reader trust/lifecycle/propagation plan and later authorized mechanism | H/F/X semantics, D11 human authority/bounds and AP06 implementer | Fake source and propagation tests; actual source/reader integration needs explicit scope/authority |
| 12 / ET12 | Platform collector/source/time/retention/notification configuration and interface validation | E owns implementation; all 17 surfaces and D09 policy/identity choices unresolved | Synthetic host-export/config fixtures; no E implementation or live collector assumed |
| 13 / ET13 | Protected backup schedule/storage/restore-target/offsite/key-source platform configuration | G implements backup/recovery; F/G DB reader conflict and D10 policy first | Nonexecuting config/namespace/permission fixtures; G harness/live restore separate |
| 14 / ET14 | Complete platform readiness/evidence/denied-operation/reboot/Zuto/stop/rollback/restore verification tooling and runbooks | Prior rows, explicit operational actors, X integrated acceptance | Fake test plans first; real evidence only through authorized OneGrid/disposable drills |

ET02/ET03 include replacing the Node20-only verifier and unsafe legacy package assumptions; ET04/ET07/ET10 cover stale script/CWD/env, partial IIS switching and noninteractive exact-scope approval. ET05 covers storage-reference compatibility at the platform contract level, not implementing media/video application changes. ET06 includes secret-injection configuration but not F broker implementation or credential issuance. ET12 and ET13 implement A platform configuration/handoff scope, not transfer E/G application implementation to A. Applying these desired states is outside the present non-executing tooling authorization.

The above covers A16's host prerequisites, namespace/storage, identity/deployer separation, secret-source/remediation coordination, controlled build/package, supervisor/roles, IIS/network/TLS, DB/Redis, collector bindings, stop, release/rollback, backup platform and operational handover deliverables. Actual host provisioning remains missing and requires a later explicit mission. Application role split/guards/scheduler/health/storage/effect/lifecycle code remains UNASSIGNED; X owns integration/acceptance, not those code changes by default.

## 4. Selected first single task: ET01 package-inventory policy core

**Selection only; NOT AUTHORIZED TO IMPLEMENT IN THIS MISSION.** Functional planning owner A. A later explicit bounded implementation mission is required; no production operator or credential custodian is needed to test this pure component. This targets A07 package exclusion requirements and A16 P1-PACK/ENG05, without waiting for sibling integration or missing TypeScript/Vitest dependencies.

### Exact future file scope

| Proposed file | Allowed future change |
|---|---|
| `scripts/deployment/package-inventory-policy.mjs` | New dependency-free ESM module exporting `validatePackageInventory(entries)` and frozen reason-code vocabulary; no CLI actions or side effects on import |
| `scripts/deployment/package-inventory-policy.test.mjs` | New Node built-in `node:test`/`node:assert/strict` suite using synthetic records only; no application imports or filesystem/provider fixtures |
| `docs/recovery/r10-a-package-inventory-policy-acceptance.md` | New implementation report with exact commands/exits, task scope and remaining full-package gates |

All three paths are currently absent. Do not change package.json/package-lock, existing release/deploy/start/rollback scripts, manifest schema, source app files, existing A01-A16 artifacts or sibling worktrees as part of ET01. If implementation requires more scope, record the dependency rather than expand it silently.

### Pure contract and limits

Input is a nonempty array of strict JSON-like records with exactly `path`, `kind`, `size`, `sha256`, `runtimeWritable`. Require kind=file, nonnegative safe-integer size, lowercase 64-hex SHA-256 syntax and runtimeWritable=false; reject unsupported kinds/extra or malformed fields. Do not claim supplied hashes authenticate bytes or descriptors prove an actual file is not a link. This module never opens a candidate or archive and cannot validate NTFS/ACL state.

Use a deliberately strict portable first-task path profile: printable ASCII canonical relative forward-slash paths only. Reject absolute/UNC/drive forms, backslashes, colon/ADS, percent escapes, control/NUL/non-ASCII, Windows-invalid characters, empty/dot/dot-dot segments, trailing space/dot segments, and Windows reserved device segments including extensions and CONIN$/CONOUT$. Reject duplicates after canonical case-folding. Broader Unicode/platform filename support is a future reviewed extension, not silent normalization/decoding. This conservative rejection may block legitimate dependency filenames; report that incompatibility for later packaging review rather than weaken the rule automatically.

Apply A07 case-insensitive denied-path rules at every depth: .env and .env.*, web.config.bak, private-key/container suffixes, backup/editor residue, tests/fixtures/test/spec/source-map assets, public test-logo/fixture-logo assets, logs/dumps, credential-source/cache directories, .git/.agents/.codex, temp/profile/cache/backup/data/uploads/generated-state directories. Encode the selected rules and exact test cases explicitly; no .env.example exception. Arbitrarily named/embedded credentials cannot be detected by filename policy and remain F scanner/full-package gates. Legitimate distribution files matching denied names are blockers for a later resource-closure decision, not automatic exceptions.

Return a deterministic bounded result such as `{schemaVersion:1, scope:'INVENTORY_POLICY_ONLY', status:'PASS'|'FAIL', productionApproved:false, findings:[{entryIndex,code}]}`. Fixed reason codes, stable entry-index/rule order, no invalid value/content echoes, secret fragments or value hashes. Do not mutate inputs or depend on locale/clock/randomness/platform environment. Reject untrusted record shapes without stringifying arbitrary objects or invoking caller-supplied conversion functions. PASS means only the synthetic inventory satisfies this component's policy; it is not package, secret, closure, signature, native or production approval. This is a rejection-policy component, not the full manifest allowlist or an approved packager.

### Required local tests and success criteria

The following fourteen groups are **PROPOSED / NOT_RUN**, distinct from historical stage test IDs:

| ID | Meaningful assertion |
|---|---|
| ET01-T01 | Minimal safe file metadata and reviewed synthetic app/browser/dependency paths pass without any real files |
| ET01-T02 | Empty/non-array input, missing/extra fields, wrong field types, unsafe sizes and malformed digest reject deterministically |
| ET01-T03 | Absolute drive/UNC/rooted/backslash/ADS paths reject; no OS-specific path resolution needed |
| ET01-T04 | Traversal, dot/empty segments, percent escapes and mixed separators reject rather than decode/normalize into acceptance |
| ET01-T05 | Reserved devices with extension/case variations, trailing dots/spaces, invalid Windows characters/control/non-ASCII reject |
| ET01-T06 | Same-path and case-fold collisions reject; no duplicate file silently overwrites another |
| ET01-T07 | Nested/mixed-case .env, .env.production and .env.example reject |
| ET01-T08 | Nested dist/public/web.config.bak, backup/editor residue and key/container suffixes reject |
| ET01-T09 | Fixture/test/spec/test-logo/source-map payload and local caches/logs/profiles/data/credential-cache directories reject |
| ET01-T10 | Link/junction/directory/unknown kind and writable payload reject based on descriptors, without claiming filesystem inspection |
| ET01-T11 | Multiple violations yield fixed ordered reason codes and repeatable output; no clock/random platform-dependent change |
| ET01-T12 | Deep-frozen input remains unchanged; invalid fields do not trigger unsafe stringification or leak supplied marker values in diagnostics |
| ET01-T13 | Import and validation do not load app/sibling/SDK modules, read env/config, use filesystem/network/process/subprocess APIs or start services |
| ET01-T14 | PASS still returns productionApproved=false; unknown runtime resource/secret contents/real-file integrity remain explicitly outside the result |

Exact future commands from the worktree root: `node --check scripts/deployment/package-inventory-policy.mjs`; `node --check scripts/deployment/package-inventory-policy.test.mjs`; `node --test scripts/deployment/package-inventory-policy.test.mjs`; `git diff --check`. Required exits all 0, zero skipped/todo expected cases, all negative cases fail the policy as expected, and only the three approved new files changed. Node26 is already available; built-in runner requires no npm install/TypeScript/Vitest/build. A source import/capability review must confirm no production entrypoint or side-effect imports; no application runtime is started to test that property. No tests run or task files created now.

Excluded: packaging/copy/extraction/download/build, scanning credential contents/history, actual file hashing, cryptographic signature trust, schema-engine installation, full dependency closure/native compatibility, archive/NTFS link inspection, service/IIS/supervisor changes, selector/rollback execution, F cleanup, credential operations, E/G implementation, X merge/migrations and provider/autonomy activity. The first task cannot close P0 security or production-entry gates.

## 5. Remaining blockers and final disposition

P0 historical credential remediation and F hygiene, unmerged C/D/H default-deny/independent stop, F/G backup credential/key conflict and real recoverability remain highest production risks. Application construction/scheduler/storage/health/lifecycle changes have no expressly authorized implementer. Node26/browser/sharp/FFmpeg, package trust, selected supervisor/identities/IIS/private DB/Redis, all 17 live collectors, snapshot/backup/rollback and measured recovery remain unverified. RPO/RTO PROVISIONAL; no deployment, STOP, recovery or activation approver appointed. X integration/acceptance has not occurred; no accepted release commit/manifest exists.

Validation results and preservation are recorded in transition evidence. This mission creates this report and one non-executing JSON evidence catalog, appending only A01 decisions/traceability. All 41 prior artifacts are preserved except those two appendices, verified against pre-mission hashes/prefixes. Original 12 decision rows and all requirement IDs retained. Branch/HEAD unchanged; existing uncommitted documentation remains. No selected implementation file created, source/history/sibling changed, dependencies installed, tests executed, credentials accessed, server connected or operational action performed.

Static validation PASS (exit 0): 42 current document hashes, 39 unchanged earlier artifacts plus two preserved A01 prefixes, 16 JSON parses, 177 local links, all 12 original decision rows and 14 proposed tests still NOT_RUN. All three selected implementation paths are absent. git diff --check passed (exit 0). Git scope is two modified tracked A01 documents and 23 untracked Markdown/JSON files, 25 changed files total; this turn adds two artifacts and appends the same two A01 files. No commit or push occurred. Seven historical references remain unreproduced; these static results do not alter PARTIAL/BLOCKED classifications.

Recommended next single action: authorize the bounded **ET01 package-inventory policy core** implementation using exactly the files, constraints, Node built-in tests and success criteria above. That future authorization is separate from this planning decision and grants no production access. Stop after this report; implementation has not begun.
