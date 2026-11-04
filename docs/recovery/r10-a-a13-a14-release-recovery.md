# R10-A consolidated A13-A14 release, rollback and recovery preparation

Status: SPECIFICATION ONLY; NO RELEASE OR RECOVERY APPROVED. Recorded 2026-11-04. Frozen programme R9-X baseline is `799f6b4cb351ebe969f97da606324605fdf2a07b`; observed R10-A working HEAD is `a0bea50a7bac480e7655ff1915532157b8360540`, branch `feature/r10-a-production-platform`. These are different identities: the former anchors inherited contracts, the latter anchors this repository review. Neither is an approved integrated production release. No Git change is performed to make them equal.

Read [source catalog](r10-a-a13-a14-sources.json), [independent acceptance report](r10-a-a13-a14-consolidated-report.md), [A02 architecture](r10-a-a02-platform-architecture.md), [A03 process ownership](r10-a-a03-process-ownership.md), [A04 identities](r10-a-a04-identity-permissions.md), [A05 secrets](r10-a-a05-secrets-management.md), [A07 packaging](r10-a-a07-deployment-packaging.md), [A08-A10 monitoring](r10-a-a08-a10-monitoring-telemetry-security.md) and [A11-A12 stop/lifecycle](r10-a-a11-a12-stop-lifecycle.md).

## 1. Scope and source authority

Mission A13 is release/rollback preparation, primarily elaborating original local A04/A15; mission A14 is backup/recovery handoff, primarily original local A13. Original local A14 independent-stop meaning remains unchanged. All A01-A16/D01-D12 identifiers and historical stage artifacts are retained; only A01 appendices are updated. A08-A12 synthetic and live tests remain NOT RUN, integrated acceptance BLOCKED. Q01 functional approval appoints no issuer, recovery operator or production approver.

Catalogued G-OBJECTIVES/G-ARCHITECTURE/G-ASSETS/G-MONITORING/G-REHEARSAL/G-CHECKLIST/G-REPORT are separate R10-G documents. C-CONTRACT, H-CONTRACT, E-PLATFORM and F-CONTRACT retain runtime, authority, evidence and security semantics. G's local file/fixture readiness is not a real DB restore or Windows implementation. G Linux paths/cron/Node22 harness, same-host MySQL assumption, table/migration counts and rebuild commands are inherited evidence requiring reconciliation, not OneGrid facts. A owns platform preparation; G recovery authority; X canonical migrations and integrated restore/release verification coordination where contracts require. Application/build/Windows adapter implementers and named human signatories remain UNASSIGNED.

## 2. A13 release management and rollback

### A13.1 Immutable identity, manifest and compatibility

Proposed layout follows A07: NatForgeAI-only `D:\www\natforgeai\releases\<commit>-<manifest-digest>\app\` contains bundles, exact dependency closure and approved static payload; sibling release browser/evidence directories are read-only. Only the root's existence was operator-observed in A02; this creates no directory. Final root/selector names and publisher privileges remain D03/D05 choices. Shared finalized media/uploads, private scratch, per-role logs/temp, secret source, backup storage and independent stop are outside releases. A rollback changes selected code, never overwrites/copies/deletes these shared state roots.

Release identity must bind full clean source commit/tree and reviewed integration lineage, original/derived package manifests and lock SHA-256, individual normalized file SHA-256/size, npm tarball SRI, exact resolved versions, builder OS/x64, Node/npm/binary hashes, tools, sanitized commands/results, public build config digest, build timestamps, SBOM/licenses and native browser/FFmpeg acquisition hashes. A07 is the detailed closure/exclusion/schema authority; no blank or illustrative hash is a pass. Version `0.0.0`, short Git SHA or directory name alone is insufficient. Archive/manifest digests and detached signing evidence use an independent trust anchor/delivery attestation, avoiding self-hash cycles. Hash-only integrity needs a separately authenticated expected digest/channel; an attacker replacing payload plus its local hashes must not pass. Signing key custody and release approval are separate from runtime/deployer access and remain OPEN.

Compatibility evidence must explicitly bind both candidate and previous release to: Node 26.13.0/npm 11.20.0 operator baseline with unproven application/native execution; Playwright/core 1.61.1 and browser revision; sharp 0.34.5 Windows x64 resources; ffmpeg-static 5.3.0 wrapper plus actual binary; execa 9.6.1 where retained; C/H/D/E contracts, exact schema/journal state, role/job config and safe per-role secret references, shared-media/metadata formats, API/SPA compatibility and control-source readers. All runtime and transitive versions are fixed by reviewed lock/package hashes, not semver ranges. No install/build on target; prebuilt self-contained candidate is validated offline. G's historical restore-by-build steps require an approved alternate recovery process or reconciliation with this offline package approach before measured acceptance.

X must certify integrated migration sequence and backward readability/writability; canonical R9 0037 history remains intact and sibling provisional 0038 artifacts are not automatically executable. No automatic down migration or production DB restore is part of code rollback. An irreversible schema/data/control-contract change may make previous code incompatible: block rollback and use separately authorized forward repair or recovery, never guess. C job/runtime/release must match the worker unless explicit certified adoption binding exists. Older H policy/release/expiry is not revived by code selection; absent exact current binding denies. Keep older packages only as retention-approved verified rollback candidates, not perpetual supported releases.

### A13.2 Controlled selection and exact process/static binding

Proposed default is a **controlled quiesced switch**, since no atomic multi-component mechanism is certified. One protected selection record identifies intended release, source/manifest digest, selection generation, role entry paths/CWD, expected IIS static-root and prior verified generation. A trusted publisher/host operation owns writes; runtime/MON/normal pipeline cannot rewrite it. Atomic replacement of an individual record/link may be an implementation option only after Windows filesystem/supervisor/IIS proof; it cannot make IIS and three process configurations one atomic transaction. No junction/symlink product or command is selected here.

Approved future switch sequence:

1. Validate signed/hashed package, all A07 security/rotation/identity evidence, named approval/target and compatible prior/candidate manifests. Capture existing exact process/static/selection evidence and prior receipt/uncertainty state, with no environment values.
2. Assert authorized independent stop and drain API effects, queue consumers and scheduler/recovery passes per A11-A12. Stop new admissions, maintain safe receipt/accounting, record unresolved in-flight references. Verify bounded stop coverage or remain denied; do not rely only on global queue pause or HTTP200.
3. Stage verified immutable payload separately under protected promotion scope, without copying working-tree state. Under the later authorized publisher boundary, validate normalized paths stay within NatForgeAI, deny unexpected links/case collisions and preserve Zuto/parent ACLs. No target extraction or staging occurs in this mission.
4. With traffic/effects quiesced, update intended selection journal and explicit per-role binding: absolute node executable, absolute API/worker entry script, exact CWD at that release's app root, role, release/GIT_SHA, NODE_ENV, safe config version and independently injected per-role secret references. Scheduler path is unavailable until assigned entry/build work exists. IIS physical path must match that release's `app/dist/public` only; no bundles/dependencies/backup paths web-served.
5. Stop/recreate/rebind through selected supported supervisor as needed; do not assume restart-by-name changes script/CWD/environment. Query actual process image/script/CWD/generation and safe environment **names/approved nonsecret identifiers only**, then compare to desired record. Do not dump environment or command lines that could carry secrets. Verify supervisor reboot-persistence config matches, with no broad inherited deployment environment.
6. Start only explicitly approved inert/role-safe composition, collect semantic readiness for API, remote worker heartbeat and per-job scheduler state, schema/contract/version and shared asset route checks. E releaseVersion must match trusted manifest/process association, UNKNOWN on absent identity. Liveness/HTTP200 or version match alone cannot satisfy readiness. Historical boot side effects block this sequence until assigned remediation is proved.
7. Verify selector, actual processes, static assets and persisted supervisor intent all agree; attach evidence of partial-failure handling. Only an independently authorized release decision may reopen approved traffic. Independent stop/H authority restoration and any provider/autonomy authorization are separate gates, never automatic consequences of successful release. Current mission permits neither.

On power loss, partial update or evidence mismatch at any step, maintain stop/quiescence and report incomplete switch, do not serve mismatched SPA/API or start uncontrolled duplicate workers. Recovery reconciles authoritative journal plus observed actual bindings, not directory recency or process name. Test both interruption before commit and after one component changes. No zero-downtime/atomicity assertion is made without live proof.

Current CWD/route blockers remain A03/A07: media creation uses CWD-relative data, video writes `dist/public/videos`, and static fallback mixes import location/CWD. These cannot be solved by copying user assets into old releases or granting runtime writes to releases. Absolute shared-storage/metadata/static resolution and test parity require explicitly assigned application work. Retain a frozen shared storage contract across forward/backward code selection.

### A13.3 Rollback triggers, authority and legacy limitations

Rollback candidates: rejected/tampered package, semantic readiness failure, release/CWD/static mismatch, native/module failure, role/worker drift, resource regression, evidence/security failure or incompatible service behavior. Detection may recommend stop/rollback; monitoring and health cannot execute it. Suspected compromise requires F/incident investigation and known-trust candidate, not automatically return to potentially compromised code. If no previous verified production release exists (first deployment), abort to stopped/unselected state; do not invent a “last good” version or deploy frozen R9-X simply because it is the programme base.

Named system-owner deployment/rollback approver and constrained executor are UNASSIGNED. Emergency stop assertion may have its own human authority; rollback permission does not clear stop, raise H level, authorize data restore or reexecute. Future noninteractive pipeline must present preapproved exact release/target/change/validity/authority references verified by a trusted approval gate. Missing/expired/wrong-scope approval denies; an `-Execute` switch, CI context, self-declared actor or interactive comment is not approval. Human actions stay attributable without embedding credentials in commands/logs. No script is run even in legacy dry-run mode here.

Authorize and verify explicit previous compatible manifest; capture failing/previous source, package/selection generation, process/role/CWD/schema/config versions, safe diagnostic/incident reference, timestamps/clock quality, stop/drain evidence, active leases/barriers and immutable receipt references. Drain, preserve uncertainty, rebind static/process/environment as a controlled switch, then verify readiness/actual binding and persisted supervisor intent. Code rollback never restores application DB, Redis, media, secret versions, canary volume, consumed approvals, H policy or independent stop generation. A former result remains immutable; uncertain work stays uncertain until governed reconciliation. Rollback failure remains stopped and escalates, no blind loop between releases.

| Legacy evidence | Limitation / required later remediation |
|---|---|
| `scripts/deployment/verify-release.ps1` | Requires Node major20, npm>=10, PM2, old default branch, 27 migrations and populated root .env; optional exact commit skip. Conflicts with Node26/npm11.20 baseline, X schema authority and external-secret model. Replace under approved owner; no bypass by falsely reporting Node20 |
| `start-runtime.ps1` | Comment says interactive execution, but no independent approval verification is implemented. Reads .env even outside execution branch; starts API then worker and saves PM2, exposing duplicate boot consumers. Unsupported no-Redis fallback note, HTTP200-only readiness and optional HTTP smoke. Not approved Windows composition/injection |
| `rollback.ps1` | Push-Location affects invoking shell; `pm2 start` failure falls back to restart-by-name without proving prior script/CWD/env changed. IIS only prints manual repoint instruction. Worker bundle optional, no scheduler binding, no stop/drain/schema/authority gate, HTTP200-only check; “ROLLBACK COMPLETED” also prints on dry-run. No actual atomic rebind proved |
| Both legacy orchestration scripts | String-built Invoke-Expression needs later path/input/argument safety review. No inference that operator comment/parameter validates authorization; script presence is not a supported Windows supervisor choice |
| `deploy-local.sh`, `package-for-upload.sh`, `deploy.sh`, `deploy-vps.sh` | Broad source/dist copies, populated env/Firebase copy path in deploy-local, Linux package/install/setup and Node20 assumptions. Not approved OneGrid packaging/deploy path. A07 exclusions prevail; contents inspected as source only |

### A13.4 Deterministic validation and future live drills

RL01-RL10 below are dry-run **specifications, NOT RUN**, implemented later with an in-memory filesystem/selection journal, fake supervisor/IIS adapter, fixed T0=2026-11-04T00:00:00Z, synthetic manifests/receipts and no real OS/app imports. No legacy script invocation.

| ID | Scenario / expected assertion |
|---|---|
| RL01 | Missing/modified file, substituted manifest/key/digest, unclean or wrong source/lock -> reject before selection. Exact dependency/native provenance required, no download/build fallback |
| RL02 | Model valid candidate/previous compatibility plus schema/contract/media/Node mismatch variants -> deny incompatible rollback; no down migration/DB restore |
| RL03 | Fake selector and API/worker/IIS CWD/script/static roots differ or restart-by-name retains old binding -> reject readiness; no traffic reopening or duplicate consumer |
| RL04 | Interrupt switch before/after each journal/component step -> remain stopped, detect partial generation, require explicit reconciliation; no atomic multi-component claim |
| RL05 | Expired/absent/mismatched noninteractive authority or forged executor -> no selection/update; evidence-only dry-run must make zero fake live mutation calls |
| RL06 | Stop unavailable/drain unfinished or authoritative receipt absent after fake send -> preserve UNCERTAIN, zero resend; release health does not raise H/clear stop |
| RL07 | First deployment has no verified previous manifest -> abort to stopped baseline, no invented last-good release or “newest folder” selection |
| RL08 | Rollback with shared media hashes/refs and external stop/secret generations -> unchanged shared state; source/native/script/CWD changes only as approved; no secret values captured |
| RL09 | Startup/reboot persisted supervisor record points to stale script/env or uncontrolled scheduler -> deny. Verify actual release role/heartbeat separately from HTTP200 and E UNKNOWN |
| RL10 | Rollback candidate compromised, failure during rollback or receipt conflict -> stop/escalate with safe evidence, no automatic alternate provider/loop/authority downgrade bypass |

Separately authorized live drills must prove Windows selection/update crash semantics, real script/CWD/env identity, exact IIS static association, reboot persistence, drain/stop coverage and timing, compatible schema access, native/runtime readiness, unchanged media and Zuto isolation, failed-switch recovery and no duplicate effects under inert transports. Signatures/digests, effective ACLs and independent authorization must be validated on that exact integrated release. None is executed here.

## 3. A14 backup and recovery handoff

### A14.1 Protected capture and identity boundaries

Backup storage is outside all application roots/web paths and separately protected from API/WRK/SCH/POOL/MON/ND tokens; independent BKP is a logical role, not an account already provisioned. Backup/recovery/key/retention/offsite administration are distinct duties even if G examples use one operator. A04 denies default OS-wide backup/restore privileges; authorize only required scope. Local administrator/compromised privileged deployer residual cannot be solved by folder ACL claims alone. Never let one runtime credential both execute the app and destroy every recovery copy.

| Asset | Capture/recovery boundary and evidence |
|---|---|
| MySQL authority and business data | Version-compatible consistent dump/snapshot including identities, approvals, execution/barriers/receipts, audit, billing and applied migration state. G's 118-table/journal inventory is historical, not selected integrated schema count. Full expected table/constraint/sequence inventory must be derived from X-approved source and actual applied state |
| Shared finalized media/uploads | Capture immutable finalized blobs and stable DB references at common checkpoint, including external-object references where relevant. Source roots absolute and explicit; no CWD-dependent omission. Validate lengths/hashes and every required row-to-blob reference; preview SVG/code assets come from immutable release |
| Redis | Optional protected AOF/snapshot for warm recovery only after approved topology/version/quiesce policy; not dispatch/authority truth. Record checkpoint/queue roles safely. Restore must quarantine stale jobs/locks; rederive work from DB under C/H gates with no automatic uncertain replay |
| Configuration | Names-only/redacted structure, approved non-secret values, role/release/schema and protected safe IIS/supervisor config references. Do not export PM2 state/env blocks that may contain secrets. Restore role-specific injection from approved source, no raw .env/service-account/PFX/private-key inclusion |
| Release | Backup captures authenticated release/lock/provenance manifest and pointer to independently retained vetted package/source. G excludes dist/node_modules as rebuildable; recovery still needs an accessible verified package and dependency/native resources. Git source alone does not guarantee offline runtime recovery |
| Secrets / cryptographic dependencies | Kept at independently recoverable protected secret authority, not archive. Record opaque approved key-version recovery references only, no values or secret-derived hashes. DB token encryption may need historical decryption-key custody; require A05 versioned migration/retirement design. Raw Firebase/backup/signing credentials excluded |
| Independent stop/H and audit | Preserve DB H/audit truth plus latest independent stop outside app rollback/restore domain. Restoring older H rows never raises authority; require revalidation/current deny override and append-only audit continuity. Never overwrite newer stop generation from application backup |
| Scratch/logs/caches | Not substitutes for finalized media or audit. Exclude temporary/partial renders, developer fixtures, local diagnostics and credential caches. Independent redacted audit/operational exports follow approved retention; logs are not DB authority |

F/G credential conflict is a **blocking security decision**, not a grant: F class DATABASE_SECRET permits API/worker/scheduler/migration-admin, not BKP; F service table says backup reads BACKUP only and explicitly denies application classes. G `backup-database.sh` accepts DATABASE_URL/MYSQL_* or an option file; its README example says read app env. A05 requires dedicated backup DB principal/source, but exact classification/name/grants are unassigned. Neither a new variable spelling nor granting broad migration-admin credentials to BKP resolves F reader restrictions. F/G/X must approve a separate narrow backup DB credential/interface/class binding and least dump permissions for selected MySQL/tool/version; A provisions only after that authority exists. No SQL grants are invented/executed.

Other conflicts/assignments: G checklist Put/Get/List+hold is broader than architecture's push/append-oriented compromise resistance; separate routine writer from restore reader and immutable-policy/deletion administrator, prove no runtime/key can delete locked copies. G BACKUP_OFFSITE_*/BACKUP_PASSPHRASE_REF names must be reconciled to F BACKUP_SECRET/approved source, never fall into unknown-class privilege expansion. G says passphrase not on app host filesystem; A05's general protected-file fallback does not approve a BKP key file. D07/D10 must resolve protected job-only secret delivery without key persistence beside archive. Restore DB write privilege and secret-source recovery operator also require separate explicit authorization; do not reuse the runtime, backup-dump or migration identity by assumption. All custodians UNASSIGNED.

### A14.2 Consistency, retention, encryption and telemetry

G's transactional DB dump alone does not make a live media tar consistent. Proposed controlled checkpoint closes write/effect admissions, drains/fences producer passes and accounts for inbound receipts, then records DB snapshot boundary plus media inventory/watermark and safe copy window. Alternative online snapshot/versioned-blob policy requires proven atomic reference semantics. Keep finalized blobs immutable and defer deletion/GC until snapshot completion; track incomplete/unreferenced blobs separately. Snapshot coordination across DB/Redis/blob store is unimplemented; if writes cannot be bounded consistently, mark set partial/untrusted. Do not delete authority rows or silently redact token columns to make scanning pass.

Encrypted DB backups can inherently contain sensitive business data/password hashes/encrypted OAuth material. G's “no raw credentials in config payload” does not make DB data public or authorize stripping required authority. Its scanner may abort on embedded secrets; F/G must reconcile legitimate stored encrypted data, redaction rules and restricted backup processing without permitting unencrypted exports or losing required restore data. Until that policy/grant/verification exists, capture acceptance is BLOCKED. No payload is opened/scanned here. Secret scan findings remain rule/path only, no credential fragments or value-derived hashes in reports.

Set success requires complete checkpoint manifest, version/sourceSnapshotAt, per-file bytes/integrity, encrypted payload authentication, dump sanity, required DB/media completeness, verification and independently protected offsite acknowledgement. Partial/failed copy/dump/encryption/hash/scan/offsite acknowledgement is not success. Include exact serializer/encryption format/key-version references and source DB/schema/tool version, not actual account/host-sensitive connection data. Authenticate expected manifest through separate signing/trust channel; archive-supplied SHA alone cannot resist manifest+payload substitution. Verify sealed digests before transfer/extraction and after restore; bound extraction/path/link hazards under A07. Retain controlled recovery plaintext only in isolated encrypted/restricted scratch and erase under approved procedure after evidence; no dump appears in logs/web roots.

G design encryption is AES-256-GCM with per-set salt/scrypt derivation and job-only secret-source passphrase. This is source design evidence, not verified Windows implementation. Approve cipher/format compatibility, key rotation/re-encryption or versioned retention, authenticated tag failure behavior, access audit and independently recoverable key custody. Offsite ciphertext is useless if the only key is lost with the host; placing key beside it defeats isolation. Key destroy/retirement requires proof no retained set still depends on it, separate authority and measured recovery. Do not put secrets in command-line arguments/option-file dumps/manifests/docs.

Retention defaults 14 daily/8 weekly/12 monthly and nightly 02:00 local are G proposals, not approved OneGrid policy. D10 must approve recovery-point coverage, overlap/dedup rules, clock/timezone, capacity, legal holds and key longevity. Never prune the last verified usable recovery chain or a held/needed set; protect against clock jumps and malicious delete plans. Local retention changes and deletion require independent audited job/admin authority; offsite versioning plus object-lock/immutability requires tested provider enforcement through required window. A lifecycle policy/secondary disk label alone is not proof of immutability or separate failure domain. If offsite lock/capacity capability is absent, mark missing protection and block acceptance; no silent waiver. No backup schedule or retention operation runs here.

Backup facts go via independent redacted G export to E, not raw backup manifests containing DB names/private paths. Required facts: success/partial/failure stage, last verified snapshot age, size trend, verification, offsite ack and lock state, retention coverage, restore-rehearsal age and ingest heartbeat. G's provisional conditions: success age>26h page, snapshot age>24h RPO risk, size change>50% from 14d median, verify failure immediate, offsite ack>6h, rehearsal>90d, missing fact by 04:00 local, partial/failed immediate. E's 7d backup-at-risk default differs; D09/D10 E/G/X reconciliation remains OPEN. Missing source/collector UNKNOWN and silence alert; transport delivery failure visible. Runtime cannot silence/ack/reroute backup alerts, change retention or disable backup jobs. E alert rules/routes/recipient/timezone and Windows facts adapter remain unassigned/inactive.

### A14.3 Recovery objectives and authorized sequence

| G recovery class | Inherited provisional RPO | Inherited provisional RTO | Qualification before approval |
|---|---|---|---|
| DB_RECOVERY | <=24h standard; <=1h stretch | <=4h | Stretch requires confirmed PITR/binlog capability; consistent verified snapshot plus matching DB version/schema; no provider assumption |
| APP_SERVICE_RECOVERY | 0 for stateless code only | <=1h | Does not mean zero DB/media loss; G build-from-source path must reconcile with prebuilt offline package/native resources |
| WORKER_RECOVERY | <=5min of in-flight queue work | <=30min | G replay/expired-lease language cannot override C/H durable barrier, fresh authority or UNCERTAIN. Redelivery/rederive only where safe and governed |
| FULL_PLATFORM_RECOVERY | <=24h Tier A/B | <=8h target; <=24h cold worst case | Capacity/provisioning/secrets/package/media/DB/verification/process readiness chain unmeasured; same-host topology unapproved |

All values remain **PROVISIONAL**, no current COMMITTED SLA. G lifecycle PROVISIONAL -> DRILL_MEASURED -> COMMITTED requires X-coordinated measured real disposable restore and explicit acceptance; ownership/signatories and change-control record still needed. RPO is failure time minus verified snapshot sourceSnapshotAt, not backup job finish/file mtime. RTO is declared-disaster to service-verified/accepting approved traffic, including validation; G excludes external DNS/TTL propagation, which must be recorded separately with user-impact time, not concealed. Operator/provider provisioning delays and prerequisite availability must be recorded rather than excluded opportunistically. Repeated measured passes/rebaseline reasons preserved; no nominal “backup successful” shortcut.

Proposed later restore sequence (not executed):

1. Named recovery authority declares scope/incident, authorizes target/set/key use, keeps production stop/uncertain effects preserved. Isolate replacement/rehearsal environment with distinct DB/Redis/storage/secret namespaces; assert independent stopped/default-deny control, block provider egress. Production target needs separately authorized declared-disaster procedure; a role string/flag alone cannot grant it.
2. Select complete verified offsite-acknowledged protected set and compatible package. Independently authenticate manifest/digests/signature/retention/key access and target identity before writes/decrypt/extraction. Reject tampered/unverified/partial/wrong-target set; decrypt/tag/hash failure denies. No raw secrets in evidence.
3. Restore DB before any API boot/worker/scheduler side effect; verify applied journal/canonical 0037 plus X-approved later migrations, identity/constraint/row counts and schema fingerprint. No automatic migration simply to force candidate compatibility. Do not equate historical table count or contiguous audit IDs with proof: compare captured authoritative baseline, uniqueness/order/continuity and justified gaps rather than fabricate missing audit facts.
4. Restore coherent finalized media to stable external roots matched to DB checkpoint, verify reference/hashes/ownership and no published partials. Never rerender via paid providers to conceal missing media. Recover Redis only under reviewed optional policy; quarantine stale jobs/leases and reconstruct from DB with no automatic dispatch.
5. Verify Tier A identities/lifecycle and exact approvals/parameter bindings, execution action/attempt results, uncertainty and audit fingerprints/order; preserve historical facts. Re-derive R9-E state via approved authority rules in isolated guarded composition and compare, never trust restored derived rows as live authority or edit immutable history. Compare newer independent stop/H/current policy to prevent authority rollback.
6. Bind approved per-role secrets from independent source with restored token-key compatibility, never raw .env backups or G scratch inline credentials. Configure verified package/process/script/CWD/IIS static mapping and protected storage under future authorized host plan; no builds/downloads on production target by assumption. Role-inert app and observation startup only after integrity/readiness gates; existing boot timers/sweeps block this until assigned remediation.
7. Start only approved fake-backed worker/scheduler test composition after verifier pass. Run X definitive connected Mission Control restore subset against isolated DB, using inert certified adapters; fresh current exact governance still required. Assert no second external effect for restored action/attempt, no APPROVAL/UNCERTAIN weakening, audit exactly-once and bounded fleet evidence. Rehearsal success is not authorization for real providers/autonomy or production traffic.
8. Measure per-step UTC/monotonic timings, source snapshot gap, failure and acceptance times, verified data/media completeness, hash/integrity/subset results, denied-operation evidence and residual uncertainty. Append sanitized restore-run evidence, operator/approval references and target/package/set identity. Recovery-ready approval requires named authority; no automatic H stop clear. Tear down only under separate scoped approval and preserve audit/held evidence; no teardown here.

### A14.4 Offline checklist tests and separate live proof

BK01-BK12 are **specifications, NOT RUN**, using fixed fake T0, synthetic DB/media facts, fake object-store/secret-source/permission/clock adapters and no real backup files, keys, target or commands.

| ID | Checklist/fault / expected assertion |
|---|---|
| BK01 | Capture inventory omits authority table/applied journal/media root -> incomplete set, fail; version counts derived from selected baseline not 118/27 constants |
| BK02 | App/worker/MON/ND asks read/delete backup/key/offsite lock or disable job/alerts -> deny; BKP asks app DATABASE_SECRET -> deny pending approved F/G binding, no credential reuse fallback |
| BK03 | DB snapshot and media watermark mismatch, missing referenced blob/partial video or GC during window -> untrusted set; no provider rerender or authority-row redaction |
| BK04 | Tamper ciphertext/manifest/tag, wrong/missing key/version or forged expected digest -> verify/restore deny before trusted target writes; synthetic secrets absent from emitted evidence |
| BK05 | Offsite ack absent or lock/versioning unavailable; local success alone -> not accepted. Writer cannot delete locked copy or act as restore/key administrator |
| BK06 | Retention plan selects held/last-good chain, clock jump or key retirement before dependent set expiry -> reject, preserve recovery coverage and audit |
| BK07 | Production/wrong recovery DB/Redis/storage namespace or self-declared DR flag without authority -> no restore operation; source and target identity differ |
| BK08 | DB integrity/schema/approval/audit mismatch or media inconsistency -> no API side-effect boot/worker/scheduler start; newer stop cannot be overwritten |
| BK09 | Redis stale queue/redelivery, missing callback/expired lease or restored canary volume -> zero unauthorized replay, retain UNCERTAIN/PENDING_EXTERNAL and immutable results |
| BK10 | Missing/partial/stale/unknown-schema backup facts or alert-delivery failure -> UNKNOWN/failure evidence, never healthy; runtime suppression denied; provisional E/G threshold mismatch remains visible |
| BK11 | Fixture sourceSnapshotAt/failure/declaration/end times -> exact RPO/RTO including validation, DNS delay separately recorded; invalid/future/skewed times fail measurement. Objective remains provisional absent real measured gate |
| BK12 | Simulated full restore ordered chain with fake connected governance/idempotency subset; preserve identities/unique anchors/no extra send, audit facts retained. Missing step/key/package/media/approver => acceptance BLOCKED |

Separately authorized live proof: real disposable MySQL dump/restore/version/constraints and row/media snapshot consistency, protected backup effective-access and denied runtime/offsite deletion tests, actual encryption/key recovery without host dependency, immutable offsite provider enforcement, retention/hold failures, DB/Redis namespace guards, verified package start on Windows with no provider traffic, real C/H/stop/worker drains, connected X subset, zero duplicate effects, timed RPO/RTO and safe Zuto isolation. Fakes/hashes do not prove any of these. Credentials and payloads stay in authorized restricted custody, never in Codex output.

## 4. Exact outstanding decisions and ownership

| Gate | Required decision / supported responsibility / state |
|---|---|
| RG01 architecture (D01/D02/D03) | NatForgeAI static/role layout, selector/journal generation, controlled downtime versus certified interlock, chosen supervisor and actual script/CWD/environment/reboot proof. A platform design; application/tool executor and approver UNASSIGNED; OPEN |
| RG02 release compatibility (D03/D06/D12) | Exact integrated source/dependencies/native runtime, previous supported manifest, schema/media/control contracts and no-downgrade boundary. X integration/migration coordination; build/application owners and release signatories UNASSIGNED; OPEN |
| RG03 identities (D05/D07) | Publisher versus deployer/runtime/MON, BKP/restore/key/offsite/admin grants, privileged-agent residual, noninteractive approval authority. F security semantics, A platform binding, X coordination; named humans UNASSIGNED; OPEN |
| RG04 storage (D04/D06/D10) | Absolute media/scratch/backup/offsite roots, DB/media checkpoint protocol, stable URLs/metadata and Redis persistence versus rederive. A platform, G backup, B/C integrity, application implementers UNASSIGNED; OPEN |
| RG05 security contradiction (D07/D10/D12) | F backup-only class versus G application DATABASE_URL/DB read needs; separate approved source/grant, legitimate encrypted DB data scan policy, passphrase-file prohibition and offsite writer/read/admin split. F/G/X agreement required, no reader expansion inferred; OPEN |
| RG06 recovery policy (D09/D10) | Approve 14/8/12 retention/lock/hold/capacity/key lifecycle, schedule/timezone, E/G threshold reconciliation, real protected copies, recovery objectives and independent custody. G semantics, E telemetry, A platform, X rehearsal; approvers UNASSIGNED; OPEN |
| RG07 stop/uncertainty (D02/D11/D12) | Drain/signal/resource/propagation bound, independent stop persistence across restore and authorized restoration; no code rollback may raise H/replay. A/H/C/X supported wiring; AP owners/STOP human UNASSIGNED; OPEN |
| RG08 measured acceptance (D10/D12) | Recovery declaration/operator/DR-target approval, exact X subset and measured real DB/media/Windows/immutable-key/denial evidence, deployment and recovery signatories. X integrated verification coordinator; independent authorities UNASSIGNED; OPEN |

No blanket assignment of application code or backup administration to A/X follows from coordination. G's own harness scope remains G; Windows adaptation, snapshot coordinator, selector/tool replacement and application storage/entry changes need express implementation authorization. All prior AP/Q01/ES/LC and A07 rotation/security gates remain open; no release, backup facility or recovery objective is accepted operationally.

## 5. Retained planning crosswalk

| Identifier | A13-A14 contribution / retained limit |
|---|---|
| A01 | Provenance/catalog/preservation and separate stage decisions |
| A02 | Windows/Zuto/coexistence architecture; G same-host DB assumption unconfirmed |
| A03 | Immutable release/external media, roles/boot/lifecycle obligations retained |
| A04 | Original artifact identity/manifest/security and dependency closure |
| A05 | Exact IIS static-root/supervisor target only; no TLS/DNS changes |
| A06 | Backup/publisher/runtime separation, no identity provisioning |
| A07 | External secret recovery, mandatory cleanup/rotation/custodian gates |
| A08 | Original API readiness/rebind/drain gate remains NOT RUN |
| A09 | Original worker/scheduler ownership/fencing/restart gate remains NOT RUN |
| A10 | Original DB/Redis/migration compatibility, X canonical sequencing |
| A11 | Original provider boundary no calls, no replay from code/data recovery |
| A12 | Original release/backup telemetry keeps UNKNOWN/dedup/audit semantics |
| A13 | Original backup/recovery plan elaborated by mission A14; real restore gate OPEN |
| A14 | Original independent-stop truth cannot be reverted by restore/rollback |
| A15 | Original deployment/rollback plan elaborated by mission A13; no deployment approval |
| A16 | Independent evidence/signatories and R9-F/H activation boundary retained |
| D01 | Site/process/static association, Zuto isolation OPEN |
| D02 | Supervisor/noninteractive lifecycle/actual process binding OPEN |
| D03 | Selector/manifests/previous release/compatibility OPEN |
| D04 | Shared media/scratch/backup snapshot consistency OPEN |
| D05 | Exact publisher/BKP/restore/admin tokens and grants OPEN |
| D06 | DB/Redis version/topology/private namespace/PITR OPEN |
| D07 | Credential-class conflict, job key/source/custodian and no values OPEN |
| D08 | Existing certificate/DNS authority unchanged; recovery timing records external DNS separately |
| D09 | Backup/release evidence, windows/routes/clock/retention telemetry OPEN |
| D10 | Retention/immutability/key custody/recovery objectives/measured gate OPEN |
| D11 | Independent stop/drain/restoration/propagation proof OPEN |
| D12 | Express implementers, F/G policy resolution, X integrated proofs and signatories OPEN |

A13 documentation PASS, RL01-RL10 NOT RUN, operational switching/rollback BLOCKED. A14 documentation PASS, BK01-BK12 NOT RUN, backup/recovery/committed objectives BLOCKED. No filesystem/server/configuration/state operation is authorized by this document. Stop after A14; do not begin A15.
