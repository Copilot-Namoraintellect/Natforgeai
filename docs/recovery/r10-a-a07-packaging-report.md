# R10_A_A07_PACKAGING_REPORT

Verdict: **A07_SPECIFICATION_COMPLETE_WITH_OPEN_SECURITY_AND_COMPATIBILITY_GATES**. Documentation acceptance only. No candidate package exists or is production-approved. A08 has not begun.

## A. Documents created/updated

Created [packaging specification](r10-a-a07-deployment-packaging.md), [source catalog](r10-a-a07-sources.json), [nonexecuting manifest schema](r10-a-a07-package-manifest.schema.json) and this acceptance report. Updated only the local A04 build/release row and A07 continuation in [A01 traceability](r10-a-a01-requirements.md). Earlier reports remain historical. Existing local A01-A16 and D01-D12 numbering is retained with all 28 identifiers cross-referenced.

## B. Packaging architecture and dependency inventory

The target is an immutable, individually hashed Windows x64 release containing server bundles, a reviewed static allowlist, exact external dependency closure, browser resources and authenticated provenance/SBOM/license evidence. Writable media/scratch/logs/temp/profiles, secret source, backup and independent stop state remain outside the release. IIS serves only reviewed static files. No server-side dependency install or build is allowed by the target design.

Source/lock evidence establishes Playwright/core 1.61.1 (runtime chromium import despite dev-only declaration), sharp 0.34.5 with @img/sharp-win32-x64 0.34.5, ffmpeg-static 5.3.0 with a separately acquired executable, and execa 9.6.1 (declared/externalized, no application import found in inspected api/src/scripts). Vite 7.3.0/esbuild 0.27.2 are build tooling. The catalog resolves all 102 direct declarations and preserves the hash of the complete transitive lockfile; native records retain SRI/engines/install-script/platform evidence. Exact browser revision, FFmpeg binary version/hash and Windows DLL prerequisites remain unknown. No binary compatibility was inferred from semver or engine ranges.

## C. Sensitive-file exclusions and security controls

Tracked legacy sensitive paths, identified without content reads: `.env.production`, `.env.backup-20260623-181231`. Tracked backup configuration: `public/web.config.bak`, also uninspected. `.env.example` is excluded pending sanitation review. No tracked Firebase credential JSON filename was found by names-only enumeration; absence of untracked/history credentials is unproven.

Mandatory exclusions cover all .env files, Firebase/private credentials, backup configuration, secrets, local state/logs/caches/dumps, test fixtures and public/test-logo.png, with case-insensitive checks at source, built-output and extracted-package boundaries. Allowed files require redacting content scans to catch renamed/embedded secrets. Reports contain paths/rules only. F cleanup integration and issuer-backed credential rotation/revocation evidence must precede production packaging; sibling F untracking does not clean this A baseline. Neither cleanup nor rotation was performed here. Runtime releases/browser executables must be read-only under service identities; credentials and signing authority stay external.

## D. Offline acceptance criteria and unresolved issues

P01-P12 specify synthetic negative controls for forbidden paths/content, archive traversal/links/collisions, tampering/signatures, exact dependency closure, Windows-native loading, Chromium rendering, sharp image processing, FFmpeg encoding, execa/launcher behavior, denied release writes, static exposure and disconnected validation. All package/native/application/live tests are **NOT RUN**. JSON Schema structural validity does not prove security or package approval.

Blocking issues include dev-only Playwright/cross-env runtime placement; unknown browser/FFmpeg/DLL payload and redistribution requirements; full emitted import/resource closure; Node 26 execution compatibility; F secret cleanup/rotation/integration; read-only runtime/media remediation; canonical migration compatibility; supervisor/selector decisions and named signatories. Current video output targets dist/public/videos and media paths depend on CWD. These cannot be fixed by packaging or permissive ACLs. X must coordinate explicit application/build owners with F and A.

The legacy release verifier requires Node major 20, PM2, populated .env, an old branch and 27 migrations. It conflicts with the operator-verified Node 26.13.0/npm 11.20.0 baseline and current security/source model. It was inspected, not run or modified. The rewrite verifier is too narrow and optionally performs HTTP; existing Linux packaging/deploy scripts are not approved Windows tooling. In particular, deploy-local.sh copies environment/Firebase material. No existing script was invoked.

## E. Validation results and Git status

Initial branch and HEAD matched `feature/r10-a-production-platform` and `a0bea50a7bac480e7655ff1915532157b8360540`; starting tree was clean. All 51 A06 catalog source hashes matched before editing. The A07 catalog has 72 source references plus specification/schema artifact hashes. Its changed A01 traceability reference preserves the original baseline hash and labels the authorized update. Sensitive file contents and hashes are absent from the source catalog.

Final checks: source/artifact SHA-256 comparison, JSON parsing, closed-object/required-field/regex schema consistency, local Markdown link existence, 16 requirement plus 12 decision crosswalks, twelve package-test identifiers and git diff --check PASS. This is static schema inspection, not an installed JSON Schema engine or candidate-instance validation. An intermediate link check correctly detected this report had not yet been created; final checks were rerun after creation. The catalog authenticates inputs/spec/schema; this report and catalog do not recursively hash themselves. Prior source catalogs remain historical and unchanged.

Final scope: one tracked documentation modification (A01 requirements) and four new A07 documentation/JSON files, no executable application/config/script changes. HEAD unchanged; no commits or pushes. No installs, builds, startup, server/ACL/IIS/DNS changes, migrations, provider calls or activation occurred. Host facts remain inherited operator evidence; no server connection occurred.

## F. Recommended next single action

Obtain a recorded F/X security-cleanup ownership decision and names-only rotation/revocation evidence plan for the historically exposed credentials before authorizing any production packaging implementation. Stop after A07; do not begin A08.

## A07 security reconciliation addendum

The subsequent [security closure report](r10-a-a07-security-closure-report.md) reconciles F ownership and required issuer evidence; its [register example](r10-a-a07-security-evidence-register.example.json) contains templates only. F assigns exposed-credential rotation to A; broker composition delivery is labeled A in F, with application implementer UNASSIGNED pending approved A/F/X scope assignment. Cleanup, history assessment, replacement, revocation, package exclusion and live verification are separate open gates. This supplements the original stage acceptance; no production security closure or operational action is claimed. Current reconciliation Git scope is six new A07 files plus A01 requirements; original stage counts above are historical. A08 has not begun.
