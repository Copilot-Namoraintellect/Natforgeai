# R10_A_A04_IDENTITY_REPORT

Verdict: **A04_IDENTITY_SPECIFICATION_COMPLETE_WITH_OPEN_EFFECTIVE_ACCESS_GATES**. Documentation accepted within this stage's scope only; no identities/ACLs/services provisioned and no effective access or production containment certified. Stop after A04; A05 has not begun.

## A. Identity and privilege model

Created [identity and permissions specification](r10-a-a04-identity-permissions.md), [A04 source catalog](r10-a-a04-sources.json) and this report. Updated only the A04 row and continuation in [A01 requirements](r10-a-a01-requirements.md). All eleven prior artifacts remain; ten are byte-for-byte unchanged. Earlier A01-A03 acceptance/stop statements remain historical evidence. M4 explicitly supplies A04's identity scope; original build/package obligations remain open.

Eleven role records distinguish infrastructure administrator, dedicated deployment, API runtime, worker runtime, IIS pool, monitoring collector, backup job, proposed scheduler/recovery, migration operator, independent incident/H administrator and the existing administrator-privileged deployer. OS, filesystem, service, DB, Redis, secret and network privileges are specified as target allowlists and explicit restrictions. Proposed labels are not created account names/SIDs.

F governs secret/security classes; G independent backup; E observability; H independent administration and fail-closed stop. A owns platform/process/ACL specification and later authorized provisioning; shared A/X binding and X coordination do not appoint application implementers or replace independent approvals. Backup DB-credential classification and provider-capable scheduler composition require explicit F/G/X reconciliation without widening application broker readers.

## B. Directory ACL matrix

The specification contains a 20-row path-by-identity matrix covering root/staging, sealed releases/SPA, selectors/service configuration, media/uploads, private video scratch, per-role logs/temp/caches, public configuration, runtime/monitor/backup/migration/H credentials, stop control and safe backup facts. Rights are semantic specifications, not executable ACEs. Infrastructure/SYSTEM maintenance and current administrator residual are separately stated.

Broad inherited BUILTIN\Users access is M4's verified risk; exact masks and effective rights are unknown. Proposed inheritance isolation is limited to NatForgeAI scopes, avoids blanket Users denies that could block legitimate service tokens, reviews ownership/CREATOR OWNER/inheritance flags and preserves administrative recovery. Parent deletion/rename/replacement, reparse/move/restore and owner-change risks require later effective-access proof. If parent rights prevent safe subtree protection, no D:\www or Zuto change is authorized; an architecture exception remains open. Backup storage stays outside the application/web root.

## C. IIS, worker, admin and deployment separation

A dedicated NatForgeAI pool SID reads SPA content and proxies to loopback; it does not set the token of separately supervised Node API/worker processes. IUSR/anonymous access and TLS key permissions require review. No generic IIS_IUSRS or Zuto pool content grant is proposed. Loopback alone does not authenticate local callers; application authorization remains required.

The existing local administrator Azure deployer is not a dedicated unprivileged NatForgeAI deployer. Admin capability can bypass ordinary DACL isolation and compromise host/Zuto services. A non-admin child process does not contain its privileged parent. Constrained artifact promotion/service operations, sealed release ownership and a reviewed deployment token chain remain decisions; no current agent/group configuration was changed.

Runtime cannot edit its release/selector/service configuration, replace or clear independent stop, acquire H admin credentials or rewrite immutable audit. Stop-state parents and control service binaries/config must also be protected. Independent stop and safe-mode clearance require H administration and exact approvals; health recovery or service restart does not restore authority. Same-host administrative trust remains a residual limitation, requiring independent offsite protection where applicable.

## D. Outstanding decisions and live verification

Open: service-supervisor/account technology and logon policy; exact account/SID/ACL/inheritance masks and parent effective rights; release publisher/selector ownership; runtime cache/native-tool paths; dedicated deployment containment; per-role DB/Redis operations; secret store/injection/rotation and backup connection credential classification; scheduler provider mediation; separate E collector/writer/human monitoring interfaces; protected backup destinations and retention authority; independent stop mechanism/operator; actual A/X implementers/signatories. D02-D12 record these dependencies; D01/D08 IIS/TLS/cutover constraints remain unchanged.

O01-O12 specify future offline ACL-model checks; L01-L12 specify later effective-token/denied-operation drills with disposable canaries, Zuto preservation, independent stop, backup/restore and constrained deployment. **None was implemented or executed.** Current root inheritance, administrator risk and unresolved application role/health/H integration block any live least-privilege acceptance claim.

## E. Documentation validation and Git status

Initial branch/HEAD verified: `feature/r10-a-production-platform`, `799f6b4cb351ebe969f97da606324605fdf2a07b`; initial status was eleven untracked A01-A03 documentation artifacts. All prior documents read; 23 accepted catalog hashes rechecked plus three additional sibling security/backup sources and seven current repository files. Five official Microsoft references checked Windows semantics; links and access mode are recorded, without claiming webpage content hashes.

Checks: fourteen allowed documentation/JSON artifacts; eleven identity records, twenty path rows, eleven domain-privilege rows, twelve offline and twelve live test specifications; populated matrix columns; retained A01 sixteen requirements/twelve decisions; local links and all source paths/hashes; JSON parsing; ten prior artifact hashes unchanged; branch/HEAD and tracked diff unchanged; `git diff --check` and new-file no-index whitespace checks clean. No application tests or production drills were run. No code, script, dependency, account/group, ACL, directory, service, IIS, DNS, migration, provider/autonomy or Git history operation occurred. Sibling files were read only; direct sibling cleanliness remains unverified under the earlier Git ownership limitation.

## F. Recommended next single action

Have the platform/security decision authority record D05's account-provisioning and effective-access policy, including the permitted way to inspect parent rights and the constrained NatForgeAI deployment boundary, with A/F/X ownership named before any server change. Do not begin A05 as part of this stage.
