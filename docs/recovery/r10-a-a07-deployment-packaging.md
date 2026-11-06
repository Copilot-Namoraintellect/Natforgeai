# R10-A A07 offline deployment packaging and security hygiene

Status: SPECIFICATION ONLY; NO PACKAGE BUILT OR APPROVED. Source baseline `a0bea50a7bac480e7655ff1915532157b8360540`, branch `feature/r10-a-production-platform`, recorded 2026-11-04. A07 is the mission stage; the existing local A01-A16 and D01-D12 planning identifiers retain their meanings. Stop after A07; A08 is not authorized here.

## 1. Authority and evidence

Read with [A01 requirements](r10-a-a01-requirements.md), [decisions](r10-a-a01-decisions.md), [A02 architecture](r10-a-a02-platform-architecture.md), [A03 process ownership](r10-a-a03-process-ownership.md), [A04 identities](r10-a-a04-identity-permissions.md), [A05 secrets](r10-a-a05-secrets-management.md) and [A06 network](r10-a-a06-network-security.md). Exact input hashes, lockfile dependency records and sibling F security authority are in [the source catalog](r10-a-a07-sources.json). [Acceptance report](r10-a-a07-packaging-report.md) distinguishes documentation checks from unexecuted package tests.

R10-F production-security-configuration-contract sections 5-10 govern identity separation, file-only Firebase credentials, secret cleanup/rotation, default-off diagnostics and removal of web-served backup artifacts. F's sibling implementation and acceptance do not establish integration into this A baseline. A owns packaging specification; X coordinates build/application ownership and F integration; F retains security semantics. Implementers and final signatories remain unresolved. No external documentation or current vendor support claim is substituted for repository evidence.

## 2. Artifact and dependency inventory

`package.json` builds Vite into `dist/public`, bundles `api/boot.ts` and `api/worker.ts` as ESM into `dist/boot.js` and `dist/worker.js`, and invokes `scripts/verify-deployment.mjs`. All five external flags are significant: `ffmpeg-static`, `sharp`, `execa`, `playwright`, `playwright-core`. Bundling does not supply these packages, their resource files or native executables. Application version `0.0.0` is not a release identity. Exact versions come from package-lock.json, not semver ranges.

| Component | Source / lock evidence | Required package treatment |
|---|---|---|
| SPA | Vite 7.3.0; React/client dependencies in lock | Approved `dist/public/index.html`, hashed JS/CSS/assets; browser Firebase public config only. No server module/credential/source map by default |
| API / worker | esbuild 0.27.2; boot/worker entry points | Both bundles retained outside IIS static root; ESM package boundary retained; static/dynamic imports and runtime resource reads audited from future build metadata |
| Playwright | `api/lib/creative/premium-v2/html-renderer.ts` imports chromium and calls headless launch; playwright/core 1.61.1 both lock `dev:true` | Mandatory runtime closure despite dev classification. Production-only npm pruning is insufficient. Carry exact core/resources and version-matched Windows x64 Chromium/headless resources required by launch; never rely on developer user cache or installed Chrome |
| sharp | Creative composition, quality, HTML renderer and video imports; 0.34.5 | Carry JS closure plus optional `@img/sharp-win32-x64` 0.34.5 and its shipped native/DLL resources. Lock has no `@img/sharp-libvips-win32-x64` entry; do not invent one. Verify actual payload and DLL loading |
| FFmpeg | `api/lib/video/renderer.ts` imports ffmpeg-static and uses child_process spawn; ffmpeg-static 5.3.0 has install script | Carry wrapper closure and actual Windows x64 ffmpeg.exe at wrapper-resolved path. npm integrity authenticates tarball, not separately downloaded executable. Record binary version/build configuration/source URL/hash/license independently; not yet known |
| execa | Declared ^9.6.1, locked 9.6.1; external build flag; no import found in inspected api/src/scripts | JS/ESM dependency closure, no separate native binary inferred. Conservatively retain until emitted-import/metafile proof permits exclusion. Renderer actually uses Node spawn, not execa |
| Other dependencies | Full lockfile packages, direct runtime declarations and bundled imports | Lockfile is complete exact-version inventory; catalog records every direct dependency with resolved version/integrity and all lock entries via lock hash. Bundled packages still need license/SBOM accounting. Dynamic resources/unbundled modules require closure proof |
| Build-only tooling | Vite/esbuild/TypeScript/CSS tooling, platform build binaries | Isolated Windows builder only; omit from runtime unless emitted closure proves need. Do not ship entire development node_modules to solve Playwright |
| Launcher | npm start uses cross-env 10.1.0, declared dev-only | Proposed supervised direct Node entry point with protected NODE_ENV injection; if npm start is selected later, cross-env and its closure become required runtime dependencies |
| Platform | A02 operator evidence: Windows Server 2022 x64, Node 26.13.0/npm 11.20.0 | Host installation is not application compatibility proof. Inventory exact node.exe distribution/hash, OS build, architecture, native ABI/N-API, browser revision, DLL/VC runtime prerequisites and fonts in later evidence |

Tracked public inputs are favicon.svg, five `templates/previews/*.svg`, test-logo.png, web.config and web.config.bak. Allowlist favicon and the five preview SVGs individually, plus reviewed generated SPA assets and reviewed web.config. Exclude test-logo.png and web.config.bak. Vite's public copy can propagate both into output: validate after build and after archive extraction, not just the source tree. No blanket public/** or dist/** acceptance. Fonts used by HTML/video SVG rendering include Segoe UI/Arial and fallback families; record installed font versions/licenses and deterministic render results, without assuming every fallback exists. Brand/logo filesystem resources and any referenced templates need an exact static-read catalog from build analysis; no user uploads or local fixture logos belong in the immutable release.

MySQL/Redis services, IIS/ARR/Rewrite, certificate tooling, supervisor and protected secret source are external platform prerequisites, not application archive contents. Versions/topology remain D02/D06/D08 decisions. Migration SQL/journal may be supplied as a separately reviewed, hashed, nonexecuted migration attachment with X canonical-chain evidence; no db scripts, admin/reset utilities or automatic migration command in runtime payload.

## 3. Immutable release architecture and provenance

Proposed D03 layout under A02's NatForgeAI-only root: `releases/<commit>-<manifest-digest>/app/` holds dist bundles, dist/public, exact runtime node_modules, scoped package.json and package-lock.json; `browsers/` holds reviewed version-bound browser resources; `evidence/` holds manifest, SBOM, licenses, provenance and validation references. The concrete selector/atomic promotion remains unapproved. IIS sees only app/dist/public. Neither bundles, node_modules, browsers nor evidence are web-served. If package.json is minimized for runtime, preserve original hash, derived hash and exact transformation in provenance; do not silently change lock identity or run npm on the host.

Runtime identities receive read/execute only on releases and browser binaries. Shared finalized media, private video scratch, per-role logs/temp/browser profiles, credential files, backup destinations and independent stop state are external protected roots per A04/A05. No package includes these populated directories or a writable link into them. Browser temporary profiles must be redirected outside the release with role-specific policy. No runtime permission may change the selector, executable, native DLL, manifest or IIS configuration.

Baseline blockers: video renderer writes `dist/public/videos` in production; `api/lib/vite.ts` creates CWD-relative `data/public/generated` and `data/public/uploads`; its static-serving/fallback resolution mixes CWD and import.meta.dirname. A clean package alone cannot repair these behaviors. X must assign absolute media/scratch/static resolution work and prove A03/D04 route/rollback parity before release approval. Do not grant write access to the application tree to make tests pass.

Future build provenance must contain full clean source commit/tree, branch, lock/package/build-config hashes, reviewed patch digest (empty for release source), builder identity, Windows build/x64, exact Node/npm/tool versions and binary hashes, UTC start/end, sanitized build commands and exit results, public build-config digest, dependency/SBOM closure, install-script review, browser/FFmpeg acquisition metadata, outputs and individual SHA-256/size. Never inherit a populated repository .env into Vite. Acquire locked tarballs/native resources on a separately authorized clean builder, verify SRI and approved upstream digests, then assemble a self-contained candidate. No install, download, build, npm script or network resolution occurs on target or during offline validation. Offline package is not a promise that the application operates without its DB/providers.

Sort manifest entries by normalized relative path. Hash every regular payload file; sign canonical manifest bytes with a separately protected release authority. Put archive SHA-256, manifest SHA-256 and detached signature in an external delivery attestation to avoid self-reference; trust key comes out of band, never solely from the archive. Signatures, hashes and clean source identity must match after extraction and on later promotion/rollback. No source secret hashes enter the catalog or manifest. Reproducibility requires a second clean build comparison or an explicitly reviewed explanation of nondeterministic differences, never a claim based on timestamps alone.

## 4. Security exclusions and F cleanup gate

Path-only tracked legacy exposure at this baseline: `.env.production`, `.env.backup-20260623-181231`. `.env.example` is tracked but was not opened or certified sanitized; exclude it from production payload by default. `public/web.config.bak` is tracked backup configuration, contents not inspected. No tracked Firebase credential JSON path was identified by names-only Git enumeration; this does not certify absent untracked files or history. Never open, copy, print or hash suspected credential files to complete this inventory. No credential values were inspected for A07.

Future packaging deny rules apply case-insensitively at every depth, including inside dependencies, static output and nested archives:

| Deny category | Mandatory examples / handling |
|---|---|
| Environment | Every `.env` and `.env.*`, populated or otherwise; only separately reviewed names-only documentation outside payload may describe injection |
| Credentials / secrets | Firebase/service-account JSON regardless of filename, ADC/Google credentials, private keys, PEM/PFX/P12/key files, tokens, vault exports, signing/deployment/backup/break-glass material; semantic scan supplements path denial |
| Backup/configuration residue | web.config.bak at every path (including dist/public), *.bak, *.backup*, editor swap/old/orig files, backup config, DB dumps, archives of working trees and backup manifests carrying private paths/configuration |
| Local state | logs, crash dumps, reports with business data, caches, .npm, .cache, user Playwright cache, profiles, temp/scratch, uploads, generated media, data/, backup/ and node_modules copied from developer workstation |
| Development / tests | .git/.agents/.codex, CI credentials, tests/__tests__/fixtures/__fixtures__, *.test.*, *.spec.*, fixture-logo/test-logo assets, coverage, source maps, source trees/admin scripts/build/deploy scripts unless individually justified as runtime resources |

Reject unexpected files rather than silently deleting them and approving the remainder. Dependency distributions containing tests/examples require an explicit resource-closure exclusion review; a required resource with a denied path is a blocker needing policy resolution, not a blanket exception. Nested archives are rejected unless separately enumerated/scanned by an approved parser with bounded extraction. A maliciously renamed credential must fail content scan. Scanner diagnostics report finding ID/path/rule only, no line excerpts, values or secret-derived hashes. Quarantine and restrict suspect candidate output.

F's untracking occurred in the sibling F tree, not this A source baseline. Before any production packaging, require recorded F/X integration of tracking cleanup and ignore/secret-scan regression controls in the selected release source, a names-only tracked-path rescan, and issuer-backed rotation/revocation evidence for every affected historical credential class. Untracking/history rewriting does not revoke secrets. Use A05's issue-replace-bind-verify-revoke procedure, coordinate session invalidation and encrypted-token key migration, and confirm old credentials fail. Evidence contains names/classes, opaque version IDs, owner/timestamps and restricted evidence references only. History treatment requires its own authorized process; none performed here. F file-only Firebase/broker/redaction integration, raw-console/diagnostic/SSRF debt disposition and default-off flags must be reviewed before approval. No secret is embedded in bundles, public build config, manifest, SBOM, logs, screenshots or signature metadata. Cleanup and rotation remain NOT PERFORMED.

## 5. Offline manifest contract and dry run

The nonexecuting [manifest schema](r10-a-a07-package-manifest.schema.json) defines a candidate, never production approval. Required fields include exact source/toolchain, provenance/evidence hashes, packages and native resources, path/hash/size/class/writability entries, externally provisioned mutable roots, cleanup evidence and checks. Schema validity alone cannot prove completeness, path safety, SRI, signatures, provenance truth or secret absence. Real candidates must reject placeholders, duplicate package paths, missing closure and unverified evidence. No fake package instance with invented output hashes is supplied.

Future dry-run procedure (NOT RUN; no scripts modified):

1. Work on a separately authorized candidate copy in isolated disposable Windows x64 validation storage with no secrets, application configuration, production DB routes or provider egress. Verify attestation/signature via independent trust anchor before accepting extraction. Enumerate archive entries without executing lifecycle hooks; enforce file-count/size/expansion limits.
2. Normalize slash/case/Unicode paths; reject absolute/UNC/drive paths, traversal, ADS/colon, reserved device names, trailing-dot/space collisions, duplicate case-folded entries, symlinks/junctions/reparse points and hardlink escapes. Resolve every extracted path within the validation root; no overwrite or extraction into an existing application tree.
3. Compare exact manifest file set to extracted files, excluding only the explicitly described evidence-envelope files; verify lengths, SHA-256, lock SRI/acquisition metadata, dependency closure and binary architecture. Tamper, missing/extra files or unknown provenance fails closed. Validate signed evidence envelope separately; all evidence files must be authenticated without self-hash cycles.
4. Run path deny rules before content inspection; never open excluded credential candidates. Reject them immediately. A restricted redacting scanner then checks allowed files, bundles/assets and native resource metadata for embedded secrets. Reports remain paths/rules only. Review licenses and an offline vulnerability advisory snapshot with date/hash; unknown/stale coverage requires security disposition, not an online audit fallback.
5. Check runtime import/resource closure using build metadata and emitted imports without importing boot/worker. Compare exact package versions, transitive resources, Node engines, OS/CPU and browser revision. Missing native payload or unexpected executable fails. Assert mutable roots are external declarations only; no writable application path or state payload.
6. Record each check PASS/FAIL/NOT_RUN with evidence digest and reviewer; aggregate offline pass requires every mandatory check PASS. Then require separately authorized disposable compatibility tests in section 6 and future A04 effective-access/live readiness gates. Offline pass never authorizes deployment, DNS, migrations, provider calls or autonomy.

## 6. Acceptance tests and Windows compatibility gates

All P01-P12 package tests below are specifications, NOT RUN. Documentation checks in the report have a separate result.

| ID | Required proof / negative control |
|---|---|
| P01 | Reject each prohibited env/credential/backup/test/log/cache path, including mixed-case and nested dist/public/web.config.bak; reject renamed synthetic private-key/service-account content in allowed JS/JSON. Use synthetic markers only |
| P02 | Reject missing/extra/modified/truncated payload, substituted manifest/signature/key and mismatched source/lock; verify trusted signature and archive digest |
| P03 | Reject traversal/UNC/ADS/device names, case collisions, links/reparse points, oversized/nested archives and extraction outside root |
| P04 | Enumerate all emitted external imports/resources; reject missing Playwright/core, transitive resources, sharp native module or FFmpeg executable; validate exact runtime closure against lock; no accidental dev tool closure |
| P05 | On disposable Windows Server 2022 x64 with exact Node 26.13.0/npm 11.20.0, verify engines, native machine type and DLL prerequisites, record Node ABI/N-API. Numeric engine acceptance alone is insufficient; no claim Node 26 support is proven |
| P06 | In later authorized dependency-only harness, resolve chromium to packaged browser root; verify package/core/browser revision, hash, headless binary/resource closure; render local synthetic HTML screenshot offline using service-like unprivileged identity. No user-cache/download/PATH fallback; fail when packaged browser is removed |
| P07 | Load sharp 0.34.5 and Windows x64 binding; render synthetic SVG/PNG resize/composite; record libvips/font output and DLL closure. Remove binding/DLL to prove failure; no source compilation or network fallback |
| P08 | Resolve ffmpeg-static to packaged win32-x64 executable, verify hash and independently captured version/build/license; later invoke version and synthetic encode/probe fixture offline with fixed arguments/time bounds. Prove required codecs/filters; remove binary to demonstrate no system FFmpeg fallback. ffprobe is not inferred to exist |
| P09 | Verify execa ESM import/subprocess behavior only if retained/reachable using fixed benign command and bounded execution; test direct Node launcher or include cross-env closure if npm start is approved |
| P10 | Run dependency tests from a nonrelease CWD with external temp/profile roots; releases read-only. Attempt write/create/delete in bundles/node_modules/browser/static/evidence roots must deny; required writes occur only in role-specific external roots. Baseline video/media behavior currently blocks this gate |
| P11 | Scan final static output for server secrets/config/source maps/test assets, verify reviewed web.config rules and API/media/static route parity; no backup configuration or executable dependency web exposure |
| P12 | Repeat candidate verification disconnected from package/browser download endpoints and developer caches, verify no install hooks; record cleanup/rotation evidence, role ACL matrix, Zuto isolation, schema compatibility and final signatories as separate mandatory promotion gates |

No dependency-only harness may import boot/worker: A03 documents startup jobs/provider effects even without deliberate activation. Actual host ACL, IIS, restore, stop, queue, readiness and Zuto regression evidence remain future live gates. Browser/FFmpeg binary versions/digests, Windows DLL/runtime minimums, license redistribution obligations, complete resource closure, Node 26 execution and security disposition remain unresolved. Obtain primary vendor support documentation in the later compatibility review before declaring supported; A07 makes no current support assertion.

Legacy `scripts/deployment/verify-release.ps1` requires Node major exactly 20, npm >=10, PM2, old default branch, 27 migrations and populated root .env. It conflicts with A02's verified host Node 26.13.0/npm 11.20.0, current branch/migration authority and external-secret model. Do not run or weaken it here. `scripts/verify-deployment.mjs` checks rewrite rules and optionally performs HTTP via NATFORGE_SMOKE_URL; it proves neither secret exclusion nor runtime closure/native compatibility. `deploy-local.sh` copies .env.production to deploy/.env and conditionally copies Firebase material; `package-for-upload.sh` copies broad source/db/dist; deploy.sh/deploy-vps.sh target Linux/Node20 and perform installation/setup. None is the approved Windows offline packager. Future replacement requires separately authorized implementation/review, not bypassing failed gates.

## 7. Retained local planning crosswalk

| Planning ID | A07 contribution; no gate closed |
|---|---|
| A01 | Source identity/catalog, links and traceability |
| A02 | Windows x64 toolchain and prerequisite evidence |
| A03 | Immutable release versus external media/scratch |
| A04 | Build/release artifact obligations: sections 2-6 |
| A05 | IIS static allowlist and backup exclusion; A06 network retained |
| A06 | Release read-only identity/effective-access gate |
| A07 | F cleanup/rotation, external injection; A05 secrets retained |
| A08 | API entrypoint artifact only; supervision not implemented |
| A09 | Worker entrypoint artifact; A03 ownership gaps retained |
| A10 | Nonexecuting migration attachment/X convergence; no migration |
| A11 | Offline egress denial; providers remain disabled |
| A12 | Redacted package/provenance evidence; collector gates remain |
| A13 | No backup secrets/state; G restore evidence required later |
| A14 | Stop state excluded and independent; no clear/resume |
| A15 | Immutable integrity/rollback prerequisites; no deployment |
| A16 | Candidate status, independent signatories/activation boundary |
| D01 | Reviewed IIS/static/API boundary; port decision retained |
| D02 | Launcher/supervisor/native child process gates OPEN |
| D03 | Proposed layout and integrity; selector approval OPEN |
| D04 | Absolute media/static/scratch application work OPEN |
| D05 | Runtime read-only ACL/role tests NOT RUN |
| D06 | DB/Redis prerequisite versions/topology OPEN |
| D07 | Cleanup, rotation and injection evidence OPEN |
| D08 | Certificate/DNS configuration excluded; decision OPEN |
| D09 | Evidence redaction/retention and collectors OPEN |
| D10 | Backup configuration/credentials excluded; restore OPEN |
| D11 | Independent stop boundary remains mandatory and OPEN |
| D12 | X implementation coordination/F review/signatories OPEN |

## 8. Security ownership and evidence reconciliation

See [security closure report](r10-a-a07-security-closure-report.md) and [non-secret evidence-register template](r10-a-a07-security-evidence-register.example.json) for source-supported ownership, distinct cleanup/history-assessment/rotation/revocation/exclusion/production controls and Q01-Q07 ordering. F explicitly assigns exposed-credential rotation to A and labels broker composition delivery R10-A; the application code implementer remains UNASSIGNED pending approved A/F/X reconciliation. All issuer custodians and approval authorities remain UNASSIGNED. No credential operation, cleanup or F integration occurred; production packaging and deployment remain blocked. The stricter A07 no-.env payload rule supersedes any optional A05 example-file packaging allowance. Original P01-P12 and local A01-A16/D01-D12 numbering remain unchanged.
