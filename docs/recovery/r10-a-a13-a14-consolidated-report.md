# R10_A_A13_A14_CONSOLIDATED_REPORT

Verdict: **A13_A14_DOCUMENTATION_COMPLETE; RELEASE_AND_RECOVERY_ACCEPTANCE_BLOCKED**. Recorded 2026-11-04. No builds, deployment scripts, dry-run harnesses, release switches, backups or restores executed. A15 has not begun.

## Documents and provenance

Created [release/recovery specification](r10-a-a13-a14-release-recovery.md), [source catalog](r10-a-a13-a14-sources.json) and this report. Appended necessary traceability/approval inputs to [A01 requirements](r10-a-a01-requirements.md) and [existing decision register](r10-a-a01-decisions.md). All other A01-A12 artifacts remain unchanged. Previous test results remain NOT RUN; no prior operational gate was closed.

Verified frozen R9-X programme base `799f6b4cb351ebe969f97da606324605fdf2a07b` separately from current R10-A HEAD `a0bea50a7bac480e7655ff1915532157b8360540` on `feature/r10-a-production-platform`. Neither is asserted to be the approved integrated production release. Forty-four preceding A11-A12 source/spec hashes matched before edits. Sibling working-file evidence does not prove clean trees, merged implementations or current live behavior.

Mission A13 release/rollback maps primarily to original local A04/A15; mission A14 backup/recovery maps to original local A13. Original local A14 independent stop, all other A01-A16 requirements and D01-D12 decisions retain identifiers and meanings.

## A13 release and rollback design

Proposed immutable release layout and exact source/lock/dependency/native/build provenance follow A07. Integrity requires individually hashed payload and independently authenticated manifest/delivery trust; local hashes alone do not authenticate a substituted package. Compatibility covers exact Node/native resources, source/contracts, actual schema, role/config, shared media formats and older package support. Current host Node26/npm11.20 installation is inherited operator evidence, not tested application compatibility.

A controlled quiesced switch is specified because atomic switching across IIS and multiple processes is unproven. Desired selection generation, actual absolute script path/CWD/node/role/release identity and IIS static root must agree, including supervisor reboot persistence and narrowly injected environment. No complete switch is claimed from a directory link or restart-by-name. Interrupted or partial switching remains stopped pending explicit reconciliation. First deployment may have no prior valid release: abort safely rather than invent a last-known-good package.

Rollback requires a named approver, compatible verified previous manifest, stop/drain and safe evidence. It never automatically restores DB/Redis/shared media/secrets, revives approvals/H authority/canary capacity or replays uncertain effects. Incompatible schema/data changes block code rollback; any disaster restore is a separate authority and sequence. Noninteractive operations require independently verified exact-scope approval, not an Execute flag or comment claiming an interactive operator.

Legacy gaps are documented: Node20-only verifier/old branch/27 migrations/root .env; start script reads .env and can double-start queue roles; rollback's failed start falls back to PM2 restart-by-name without proving script/CWD/env rebind; IIS repoint is manual output; readiness accepts HTTP200; scheduler/stop/drain compatibility is absent. String-built Invoke-Expression and Linux packaging/env-copy assumptions need later reviewed replacement. No script was modified or invoked, even in dry-run mode.

| A13 independent acceptance dimension | Result |
|---|---|
| Immutable identity/integrity, package and compatibility boundaries | Documentation PASS; actual integrated/native/schema proof BLOCKED |
| Controlled selection, IIS/process/CWD/env/reboot consistency | Documentation PASS; selector/supervisor implementation unselected, live switching NOT RUN |
| Authorized rollback, no replay/authority increase/shared-state change | Documentation PASS; human authority/express implementers UNASSIGNED, enforcement NOT RUN |
| Deterministic dry-run scenarios RL01-RL10 | Specified; NOT RUN |
| Integrated/live release and rollback acceptance | BLOCKED; Windows switch/interruption/readiness/Zuto/stop drills NOT RUN |

RL01-RL10 cover tampered/wrong-source packages, compatibility mismatch, stale script/CWD/static binding, interrupted selection, invalid noninteractive approval, undrained/uncertain work, no previous release, unchanged shared/control state, stale reboot binding and failed/untrusted rollback. Fakes are specifications only, not executed evidence.

## A14 backup and recovery design

Independent BKP/restore/key/offsite administration duties are separated from runtime/deployment/MON. Protected roots remain outside the app/web trees. Capture covers full authority/business DB and applied migration truth, coherent shared media, optional nonauthoritative Redis, redacted configuration and authenticated release references. Secrets are independently recovered from an approved source, never raw .env/Firebase/private-key archives; required encrypted token/key-version recovery is explicitly gated. Release rollback does not restore these data assets.

DB transactional dump alone does not prove media consistency. The proposed checkpoint closes write/effect admissions, drains/fences producers, captures DB snapshot and media watermark/inventory and defers deletion. Missing blobs or live-write inconsistencies fail the set; no paid provider rerender or destructive row redaction to conceal loss. Optional Redis persistence cannot authorize replay across C's dispatch barrier or erase uncertainty. Current CWD/video storage defects and unassigned application storage changes remain blockers.

G proposes AES-256-GCM/scrypt/per-set salt, job-only key delivery, 14 daily/8 weekly/12 monthly retention, nightly 02:00 local and independently protected immutable offsite acknowledgement. All require approved Windows tools, capacity/hold/key lifecycle and real provider enforcement. Keys cannot be co-located with ciphertext or lost with the sole host. Partial/failed/unacknowledged/unverified sets never establish recovery success. E consumes redacted run facts; missing telemetry is UNKNOWN and failed delivery visible. E/G threshold mismatch and routes remain open.

The F/G grants conflict is explicit: F's BKP reader has BACKUP only and denies application classes, while G's dump harness accepts DATABASE_URL/MYSQL_* and README suggests app-env access. A dedicated DB principal still needs approved F class/interface/grant reconciliation; a renamed variable or migration credential is not permission. Also unresolved: G append-oriented offsite writer versus checklist Get/List grants, separate restore/delete/lock administration, G no-host-key-file rule versus general protected-file fallback, and scanner handling of required sensitive/encrypted DB contents. F/G/X must resolve policy without exposing credentials or stripping authority data. No grants were issued or credential files inspected.

| A14 independent acceptance dimension | Result |
|---|---|
| Capture/identity/key/offsite/retention boundaries | Documentation PASS; F/G reader/custody/provider/Windows enforcement BLOCKED |
| DB/media/Redis/reference consistency and stop preservation | Documentation PASS; actual snapshot/recovery integrity and C/H composition NOT RUN |
| RPO/RTO classification and measured recovery gate | Documentation PASS; all G objectives PROVISIONAL, no measured or COMMITTED recovery objective |
| Offline checklist scenarios BK01-BK12 | Specified; NOT RUN |
| Real restoration and denied-operation drills | BLOCKED; real DB/media/key/offsite/Windows/X connected subset and permission tests NOT RUN |

G targets remain provisional: DB RPO<=24h (<=1h stretch only with verified PITR), RTO<=4h; stateless app-code RPO0/RTO<=1h; worker in-flight RPO<=5min/RTO<=30min; full-platform Tier A/B RPO<=24h/RTO<=8h target (<=24h cold worst case). These are inherited targets, not approved OneGrid guarantees. G rebuild/replay/host assumptions require reconciliation with prebuilt offline recovery and C/H authority restrictions. RPO uses verified sourceSnapshotAt; RTO includes validation to approved readiness, with excluded external DNS propagation separately recorded.

Proposed restore order: independent recovery authorization and isolated stopped target; authenticate set/key/package/target; DB restore/schema/Tier A integrity; coherent media/Redis quarantine; approvals/audit/uncertainty/current stop validation and governed derived-state comparison; role-specific secret rebind; inert package/readiness startup; fake-backed connected X subset with no duplicate effects; measured timings and append-only sanitized evidence before any separate traffic/authority restoration decision. No production-target flag alone grants restore authority. G's historical Linux/fixture readiness is not the required real disposable MySQL/Windows rehearsal.

BK01-BK12 cover missing assets/schema, forbidden runtime/BKP grants, inconsistent snapshots, tamper/key failure, offsite/lock absence, unsafe retention/key retirement, wrong-target restore, integrity/order failure, stale Redis/replay, missing telemetry/suppression, deterministic measurement and full-chain acceptance. None ran.

## Exact open decisions and ownership

RG01 architecture/supervisor/selector; RG02 exact release/native/schema/previous compatibility; RG03 distinct identities and noninteractive approval/custody; RG04 absolute storage and checkpoint/Redis policy; RG05 F/G credential/scan/key/offsite grant reconciliation; RG06 retention/immutability/key recovery/threshold/RPO/RTO policy; RG07 stop/drain/authority and uncertainty preservation; RG08 measured X integrated rehearsal and independent signatories. All OPEN, with named implementers and authorities UNASSIGNED.

A owns platform specifications and later authorized provisioning. G owns recovery semantics and its harness; F security classification, E telemetry, C runtime and H authority retain their contracts. X owns canonical migration convergence and coordinates integrated verification/restore gate; it is not automatically application coder, issuer, recovery operator or sole release approver. Windows backup adapters, snapshot coordinator, release tool replacement, scheduler/storage fixes and key/restore custody require express assignment. A07 cleanup/rotation/revocation and A11-A12 stop/lifecycle gates remain open. No production autonomy or live provider execution is authorized.

## Validation and Git status

Final static validation covers catalogued source/specification hashes, preservation of prior artifacts and A01 pre-mission prefixes, local links, JSON, RL/BK/RG coverage and independent matrices, retained 28 planning crosswalks, original D01-D12 decision rows, exact baseline distinction and git diff --check. Historical source catalogs remain unchanged; their older A01 hashes refer to earlier revisions. The new catalog preserves pre-mission A01 digests and current append-only digests. Catalog/report avoid recursive self-hashes; no credential/environment/backup payload hashes collected.

Results: PASS for 58 source/specification hashes, 31 unchanged earlier artifacts, two preserved A01 prefixes, 48 local links, 12 JSON parses, two independent acceptance matrices, 22 tests explicitly NOT RUN, eight OPEN decision groups, four PROVISIONAL recovery classes, 28 planning crosswalks, all 12 original decision rows and the full baseline/HEAD distinction. git diff --check passed. These are documentation validation results only.

This mission adds three Markdown/JSON files and appends two existing A01 documents. Combined Git scope: two tracked A01 modifications, thirteen prior untracked A07/A08-A10/A11-A12 files and three new A13-A14 files. Branch/HEAD unchanged. No executable/source/configuration/ACL/directory/server/database/secret changes, installs/builds/server connections/switches/restore/migrations/provider calls/activation or commit/push/merge/rebase occurred. Documentation acceptance does not establish synthetic, integrated or live compliance.

## Recommended next action

Obtain a documented D03/D05/D07/D10/D12 release-and-recovery ownership decision resolving RG01-RG08, particularly the F/G backup DB credential conflict, named publisher/recovery/key custodians and system-owner approvers, before authorizing implementation or a disposable rehearsal. Stop after A14; do not begin A15.
