# R10-A A01 decision and ownership register

Recorded 2026-11-04. M is the original mission; R is the final reconciliation mission. Source IDs resolve in [the catalog](r10-a-a01-sources.json). D01-D12 are retained local planning identifiers under R, not historical contract IDs. A standalone provisional charter text was not supplied or located; its contents and any additional assignments remain unverified. `DIRECTION_RECORDED` records M's direction only. `OPEN` requires a named decision authority and recorded approval; no missing approval is inferred. The coordination column identifies required participants, not appointed approval authorities.

| ID | Decision / current direction | Evidence | Decision authority / required coordination | State and closure evidence |
|---|---|---|---|---|
| D01 | Windows/IIS coexistence, isolated NatForgeAI site; API loopback 3001 | M; boot/web.config; F 8 generic 3000 variance | A architecture with F/X | DIRECTION_RECORDED; exact site/bindings and F port variance reconciliation OPEN |
| D02 | API and worker separately supervised; choose Windows service wrapper/supervisor, reboot/restart limits | M; C C8-C11 | A operations with C/F/X | OPEN; product, support/version and drain/signal design approval |
| D03 | Isolated releases; choose directory naming, release selector and atomic rollback approach | M; C release compatibility | A with X | DIRECTION_RECORDED; concrete layout and rollback semantics OPEN |
| D04 | Absolute shared media roots; reader/writer/serve parity; decide scratch/import policy | M; storage inventory; G checklist | A paths/ACLs; X assigns application implementer; G coverage | DIRECTION_RECORDED; exact roots/config contract and application owner OPEN |
| D05 | Dedicated unprivileged runtime; choose API/worker/scheduler identity granularity and DB grants | M; F 5,8; H trust | A provisions; F security review; X runtime binding | DIRECTION_RECORDED; accounts/ACL matrix and independent admin authority OPEN |
| D06 | Select private MySQL 8 / Redis topology, versions, credentials and disposable rehearsal target | B report; F 8; G assumptions | A infrastructure with B/C/F/G/X | OPEN; do not treat G same-host DB assumption as approval |
| D07 | Select secret store/injection/rotation and deployment trust boundary | F 6-10; R9 handoff 2.4 | A with F and security authority | OPEN; rotation proof required for historically exposed material; values excluded |
| D08 | Select TLS certificate/renewal and eventual domain cutover procedure | M; F 8; E platform 2.10 | Domain/host operator with A/F/X | OPEN; DNS unchanged; certificate and cutover approval absent |
| D09 | Select collectors, thresholds, retention, alert channel and operational escalation roles | E platform 2-4; G monitoring | A/E/G with X | OPEN; all 17 capabilities mapped, missing evidence UNKNOWN, delivery failure observable |
| D10 | Select Windows backup scheduler/tooling, protected destinations, immutability and recovery objectives | G objectives/checklist/monitoring | A/G with X and recovery authority | OPEN; Linux examples not portable approval; RPO/RTO remain provisional until drill |
| D11 | Select independent stop mechanism, authorized incident operator and H/C/D wiring | H kill/suspension; R9 handoff 2.14 | A mechanism; F independent identity; X composition; H/C/D review | OPEN; inaccessible to runtime; missing reader denies; physical drill required |
| D12 | Retain local A01-A16/D01-D12 IDs; reconcile any additional charter scope, implementation owners and acceptance signatories | M; R; C-CONTRACT; E-PLATFORM; F-CONTRACT; H-CONTRACT | Programme scope owner with A/X and B-H; actual signatories unresolved | LOCAL_ID_CLASSIFICATION_RECONCILED; additional charter evidence, application assignments and signatories OPEN |

## A/X ownership boundary

A owns platform specifications and, only in separately authorized later stages, host layout, IIS/proxy/TLS, process supervision, OS identities/ACLs, secret provisioning, network access, collector infrastructure and independent stop infrastructure. A01 implements documentation only. A does not alter R9 authority or implement business/runtime composition by treating deployment privilege as application authority.

X owns canonical R10 migration convergence (C-CONTRACT C12-C14, D-CONTRACT persistence, E-CONTRACT persistence, H-CONTRACT persistence) and coordinates required production composition (C-CONTRACT C12-C14; H-CONTRACT additional gate) and restore acceptance (G-OBJECTIVES section 6). R explicitly keeps unassigned application work coordinated through X. This does not appoint X as its implementer or sole activation approver. B-H retain their contract semantics. Final release/activation signatories remain unresolved; independent administration and R9-F approval cannot be replaced by an A/X sign-off.

| Classification | Supported responsibility | Evidence / limit |
|---|---|---|
| A-owned | Platform planning, deployment packaging, OS accounts, secret injection/rotation, network enforcement | M; F-CONTRACT sections 1,5,7,8,10; later implementation requires separate authorization |
| Shared A/X | Telemetry infrastructure binding and verification; rapid independent stop and process wiring | E-PLATFORM sections 2-4; H-CONTRACT kill switch; H-OBSERVABILITY; detailed implementers unresolved |
| X-owned | Canonical migration convergence and coordination of production composition / unassigned application work | C/D/E/H persistence clauses; H-CONTRACT additional gate; R; coordination does not assign code ownership |
| Other-stream-owned | B concurrency proof; C runtime semantics; D provider semantics; E telemetry/alerts; F security policy; G backup authority; H autonomy mechanism | B-REPORT; C-CONTRACT; D-CONTRACT; E-CONTRACT ownership table; F-CONTRACT; G-MONITORING; H-CONTRACT |
| Unresolved | Application implementers, exact shared-infrastructure split, operational approval authorities and any unsupplied charter detail | R; no explicit implementation appointment found in cited sources |

## Application work awaiting X assignment (not implemented)

| Gap | Source | Requested coordination / acceptance |
|---|---|---|
| Application media resolver and absolute media roots / consumers | R; baseline storage inventory | UNRESOLVED implementer; X coordination; A specifies platform paths/ACLs only; review A03/D04 parity, traversal, rollback and restore proofs |
| Application video renderer modifications | R; F-CONTRACT section 10 describes bounded ffmpeg, not an implementation assignment | UNRESOLVED implementer; X coordination; no renderer changes authorized by platform ownership |
| Application metadata modifications | R; no explicit assignment found in cited contracts | UNRESOLVED implementer and detailed scope; X coordination; do not infer ownership from media storage |
| Application runtime-route modifications | R; frozen boot/vite/web.config establish current behavior, not future code ownership | UNRESOLVED implementer; X coordination; distinguish A-owned IIS configuration from application route code |
| Build/configuration compatibility and exclusion of web-served backup artifacts | R9 report regression; F 10 | Assign build/package owner; validate Node 26 and standard packaging; no inherited build pass assumed |
| C controller startup, heartbeat, signal, scheduler and durable parameter composition | C contract/report | Assign composition owner with C; authentic identity and release fencing; no blind redispatch |
| D durable repository, exact current authority/provider-account resolver and transport/callback integration | D contract/report | Assign owner with D/F; certificate/native transport certification and unresolved-effect blocking |
| E actual collectors, release identity, metrics/alerts and H health composition | E platform contract; H contract | Assign owner with E/H; absent evidence UNKNOWN; observability has no execution authority |
| H durable SQL control plane, independent administrator, immediate provider-boundary gate and external stop reader | H contract/report | Assign owner with H/C/D/F; default denial until complete; cover legacy external-effect surfaces |
| R10 migration convergence and real-DB semantics | B/C/D/E/H reports | X owns canonical convergence; separate disposable rehearsal and privileged migration identity |
| Security hygiene debt | F-CONTRACT section 10 | X-owned coordination for raw console redaction, public diagnostic minimization and explicit SSRF guard; implementers unresolved. A-owned packaging exclusion of web-served backup artifacts; separate from application changes |
| Windows adaptation of G harness and E/G backup fact ingestion | G checklist/monitoring; E platform | Assign G/A/E implementers; preserve encryption, isolation, manifest integrity and measured restore gates |

No application implementer is appointed by this document. Assignment requires X's recorded ownership decision. Frozen R9-F remains the single governance authority: plan/schedule != execution authorization; dispatch != success; uncertainty != success; retry != new authority; recovery proposal != recovery authorization. Restart, healthy telemetry, available credentials and deployment approval grant none of these authorities.

A02 continuation: [architecture specification](r10-a-a02-platform-architecture.md) section 8 records current D01-D12 dispositions. M2 approves storage-remediation design direction (absolute shared media, private video scratch, stable references, immutable releases), not application implementation ownership. The embedded-versus-standalone worker conflict remains OPEN under D02/D12; no decision is closed by the architecture document.

## A07 Q01 functional security ownership decision

Recorded 2026-11-04. Q01 is the existing A07 closure-gate identifier under local D07/D12, not a replacement for D01-D12 or a new D13. Authority: the user's explicit mission, **R10-A ? A07 Q01 SECURITY OWNERSHIP DECISION RECORD**, approving the functional framework only. No named system-owner or operational appointment is inferred from that approval. See [Q01 report](r10-a-a07-q01-decision-report.md) and [security closure matrix](r10-a-a07-security-closure-report.md).

State: **FUNCTIONAL_FRAMEWORK_APPROVED; OPERATIONAL_ASSIGNMENTS_OPEN**.

| Responsibility | Approved functional owner / boundary | Operational state |
|---|---|---|
| Exposed-credential rotation coordination and platform evidence | R10-A coordinates; consistent with F inventory section 10, F contract sections 5/7/8/10 and A05 | OPEN; coordination appoints no issuer/account custodian or server administrator |
| Existing security-hardening and repository-cleanup implementation scope | R10-F owns its existing scope; F contract sections 6/7/10 and F inventory sections 0/10 | OPEN for integration/verification in A; no cleanup execution or new application scope authorized |
| Cross-stream integration and integrated verification coordination | R10-X coordinates; A01 A/X boundary and this explicit decision | OPEN; integration executor, reviewer and merge approver UNASSIGNED; no merge authorized |
| Actual credential rotation | Authorized issuer/account custodian | UNASSIGNED; OPEN; no credential issuance/binding/revocation authorization |
| Independent revocation verification | Independent authorized verifier | UNASSIGNED; OPEN; replacement does not prove old authority revoked |
| Production deployment approval | Authorized system-owner-designated approver | UNASSIGNED; OPEN pending authorized system-owner designation |

Q01 approves functional responsibilities only. Issuer custodians, revocation executor/verifier, rotation-window/security approvers, operational identities, F integration execution/acceptance and production checks remain OPEN. Application broker/Firebase code implementers remain UNASSIGNED pending approved scope assignment; F's existing implementation ownership does not absorb those gaps. D02/D05/D07/D12 operational choices and all previous planning identifiers/decisions remain in force. Q01 as a complete operational prerequisite is not closed; Q02-Q07 remain OPEN. No security evidence row is promoted, no deployment/activation approval is granted, and A08 is not started.

## Consolidated A08-A10 monitoring decision dependencies

Recorded 2026-11-04 under the explicit documentation-only consolidated mission. This adds proposed approval inputs to existing D01-D12; it approves no collector, threshold, retention, notification route, identity or implementation. Q01 functional framework remains approved with operational appointments OPEN. Source E-PLATFORM section 2 enumerates 17 surfaces, section 3 requires evidence honesty, delivery visibility and clock discipline; E-CONTRACT governs health/dedup/suppression, F/H/G retain security/stop/backup authority. See [specification](r10-a-a08-a10-monitoring-telemetry-security.md), [source hashes](r10-a-a08-a10-sources.json) and [report](r10-a-a08-a10-consolidated-report.md).

| Existing ID | Additional approval evidence required / state |
|---|---|
| D01 | Exact NatForgeAI site/pool/API observation target and Zuto isolation; OPEN |
| D02 | Supervisor/process generation, heartbeat exports, readiness scope and collection cadence/overhead; OPEN |
| D03 | Trusted manifest-to-service release association and rollback evidence; OPEN |
| D04 | Observed volume/media/scratch/spool roots and no content access; OPEN |
| D05 | Separate limited MON, trusted E writer, notification sender and human admin/STOP duties; actual principals/ACL proof UNASSIGNED/OPEN |
| D06 | Private DB/Redis metrics export without broad runtime credentials or admin queries; OPEN |
| D07 | Source authentication, notification credential class/reader and issuer custody; UNASSIGNED/OPEN; no F reader expansion |
| D08 | Certificate expiry/renewal observation and warning/page windows; OPEN |
| D09 | Exact 17-surface collector/interface coverage, freshness/clock/threshold/windows, log/event/spool/receipt retention, bounded delivery/retry/fallback, recipients/routes and suppression audit/expiry; all choices OPEN, approver UNASSIGNED |
| D10 | E/G backup threshold mismatch, redacted Windows facts adapter, silence deadline/timezone and restore/retention agreement; OPEN |
| D11 | H exact-scope combined stop observation and missing-reader denial; independent control/drain/recovery proof OPEN |
| D12 | A proposes platform bindings, E semantics, F existing hardening, G backup authority, H controls and X integrated coordination; collector/adapter/outbox/extension implementers, monitoring administrator and approval signatories UNASSIGNED/OPEN |

The 17 infrastructure surfaces are not the 12 E health dimensions. CPU/IIS/certificate/disk/Redis additions require approved E/X adapter/schema work; no new supported enum is asserted. E's backup at-risk age default (7d) is not G's proposed 24h RPO risk condition; no threshold choice is silently approved. Scoped alert-fold isolation and scanner redaction/output require integrated proof. Synthetic acceptance specifications grant no deployment or autonomy approval. Prior D01-D12 rows and Q01 decision are preserved; original local A08/A09/A10 supervision/data obligations remain OPEN.

## Consolidated A11-A12 stop and lifecycle decision dependencies

Recorded 2026-11-04 under documentation-only mission authority. See [specification](r10-a-a11-a12-stop-lifecycle.md), [catalog](r10-a-a11-a12-sources.json) and [report](r10-a-a11-a12-consolidated-report.md). This records required decisions, not approval of a mechanism, role, timing, product, signal or application implementation. Existing D01-D12 rows, Q01 functional framework and A08-A10 approval dependencies remain intact.

| Existing ID | Additional approval evidence / current disposition |
|---|---|
| D01 | Exact NatForgeAI API/IIS/process targets; stop excludes Zuto/whole-host scope; OPEN |
| D02 | Wrapper/SCM-to-app stop adapter, role/job desired-state manifest, construction guards, drain accounting, backoff/restart/grace/force termination and concurrency budgets; OPEN |
| D03 | Current instance/release/runtime/schema compatibility and rollback preserve durable authority/uncertainty; OPEN |
| D04 | Renderer child lifetime, partial outputs/private scratch/cleanup evidence; OPEN |
| D05 | Independent human STOP versus runtime/MON/deployment tokens, protected source/ancestors and legacy administrator containment residual; UNASSIGNED/OPEN |
| D06 | Durable job claim/fence/receipt and Redis/DB failure recovery; no replay authorization from lease expiry; OPEN |
| D07 | Source authentication/integrity/generation/freshness, credential/reader custody and no broader environment inheritance; UNASSIGNED/OPEN |
| D08 | Existing certificate/DNS boundaries unchanged; no new approval |
| D09 | Clock/stop-generation observation, role acknowledgements, independent source silence, C 15/60/300-second liveness versus E observer defaults; approved windows/alert route OPEN |
| D10 | App restore/rollback cannot overwrite newer independent stop state; later persistence/recovery proof OPEN, no backup stage begun |
| D11 | Choose out-of-process durable mechanism, exact global-deny-to-H-scope mapping, assert/clear human authority, reader failure behavior, propagation/admission-transport race bound/interlock and restoration evidence; all UNASSIGNED/OPEN |
| D12 | A platform preparation; C/F/H contract semantics; X integrated composition/verification coordination where contracts require; AP01-AP06 application/reader/tool implementers need express authorization and remain UNASSIGNED; signatories OPEN |

C-CONTRACT C8-C14 and H-CONTRACT safe-mode/kill-switch clauses support A/X platform/process wiring and X production integration gates. They do not appoint A or X as every application-code implementer. Approved Q01 functional ownership remains separate from human credential custody and system-owner deployment approval. The mandatory independent stop reader is checked at entry and after evidence loading; immediately-before-effect coverage across direct API/SDK paths and a certified propagation bound remain implementation/verification gates. No stop activation, resume, restart command or provider execution is authorized. Original A11/A12 provider/telemetry planning labels remain unchanged; stop after mission A12.

## Consolidated A13-A14 release and recovery decision dependencies

Recorded 2026-11-04 under documentation-only mission authority. See [specification](r10-a-a13-a14-release-recovery.md), [source catalog](r10-a-a13-a14-sources.json) and [separate acceptance report](r10-a-a13-a14-consolidated-report.md). No release selector, supervisor, backup identity/storage, retention, key, RPO/RTO or recovery authority is approved by this appendix. All previous decisions and Q01 functional-only framework remain intact; operational custodians/signatories UNASSIGNED. Mission numbering does not rename original planning A13 backup/A14 stop/A15 rollback requirements.

| Existing ID | Additional decision inputs / state |
|---|---|
| D01 | Exact NatForgeAI static-root/API/process association and no Zuto/whole-host changes; OPEN |
| D02 | Supported supervisor with absolute script/CWD/env/role/reboot evidence, inert startup/drain and noninteractive trusted operator approval; OPEN |
| D03 | Controlled quiesced switch versus certified selector/interlock, journal/generation, previous verified release and explicit compatibility matrix; OPEN. No previous release may exist at first deployment |
| D04 | Stable shared media/metadata references, scratch exclusion, backup-root separation and coordinated DB/blob checkpoint; OPEN |
| D05 | Publisher/deployer/runtime/MON/BKP/restore/key/offsite admin separation and privileged-agent residual; grants/principals UNASSIGNED/OPEN |
| D06 | Private DB/Redis topology/version/PITR, source/restore namespace guards, applied schema versus release compatibility; OPEN |
| D07 | F backup-only class excludes DATABASE_SECRET while G harness accepts DATABASE_URL/app env; separate dump credential/class/interface approval required F/G/X. G passphrase not-on-host-filesystem versus generic protected-file fallback, offsite/key/source custody and token-decryption recovery policy OPEN |
| D08 | Existing certificate/DNS choices unchanged; RTO exclusion of external DNS delay must be separately visible; no DNS action |
| D09 | Release/process attribution and backup status/verification/offsite/retention/silence signals; G 24h/26h versus E 7d risk mismatch, notification/timezone/routes OPEN |
| D10 | G proposed 14 daily/8 weekly/12 monthly retention, independent immutable offsite copies, key longevity/holds, coherent media/DB, provisional RPO/RTO and X measured real restore gate; all OPEN |
| D11 | Rollback/restore preserve newer independent stop/suspension/canary/uncertainty; no automatic authority restoration/replay; human clear and propagation/drain proof OPEN |
| D12 | RG01-RG08 assignment/approval: A platform, G recovery semantics/harness, E observation, F security, C/H runtime/authority, X integration/migration/measured verification coordination; explicit application/build/Windows adapter implementers and independent recovery/deployment signatories UNASSIGNED |

Legacy start/rollback scripts use restart-by-name without proving actual script/CWD/env rebind, rollback prints manual IIS selection and accepts HTTP200, release verifier requires Node20/27 migrations/root .env. They are read-only evidence, not approved OneGrid procedures. G build-from-source/queue replay/DB credential assumptions require reconciliation with A07 prebuilt offline packages, C/H no-uncertain-replay and F reader grants; no source contract is silently weakened. Full exact frozen programme base and current A HEAD are catalogued separately. No release switch, rollback, dump, restore, migration or credential operation occurs; stop after mission A14.

## A15-A16 final offline evidence and handover disposition

Recorded 2026-11-04 under the verification/handover mission, not an implementation approval. See [A15 evidence](r10-a-a15-verification-report.md), [hash audit](r10-a-a15-hash-audit.json), [execution record](r10-a-a15-verification-evidence.json) and [A16 acceptance/backlog](r10-a-a16-final-handover.md). PARTIAL offline preparation; production BLOCKED. Current branch/HEAD match expected a0bea50a7bac480e7655ff1915532157b8360540; frozen programme base 799f6b4cb351ebe969f97da606324605fdf2a07b remains distinct. No approved integrated release pin/manifest or named operational approver exists.

All D01-D12 decisions and Q01 functional ownership remain preserved. D01/D08 exact isolated site/TLS/DNS targets; D02 supervisor/role/scheduler/drain/stop lifecycle; D03 source/package/selector/script/CWD/rollback compatibility; D04 absolute shared media/checkpoint; D05 identities/legacy administrator risk; D06 private DB/Redis and X migration convergence; D07 issuer/source/rotation/revocation and F/G backup-only versus DATABASE_SECRET conflict; D09 all 17 collectors/clock/retention/notification routes; D10 protected copies/key custody/measured restore and provisional objectives; D11 human independent stop/propagation/restoration; D12 explicit application/build/Windows owners, evidence custody, X integrated verification and independent signatories remain OPEN to their recorded extents.

Evidence disposition remains OPEN: 506 pre-appendix historic hash references yielded 488 current-byte matches, 11 exact historical-byte matches and seven unreproduced references across A01 requirements/A02 report/A02 architecture. No historical hash is changed or silently accepted. Missing compiler/Vitest dependencies mean check/test commands NOT_RUN, not passed. Named evidence custodian must recover exact earlier bytes or obtain an authorized non-production evidence disposition. Source-supported A work ENG01-ENG13 is separated from sibling B-H semantics, X integration/migration proofs and UNASSIGNED AP/C01-C10 application implementers. No provider/autonomy permission, F reader grant or recovery objective is raised. ENTRY01-ENTRY07 remain BLOCKED/NOT_RUN until independently evidenced. Stop after A16 assessment; no deployment/implementation/commit/push.

## D12/Q01 engineering transition functional ownership decision

Recorded 2026-11-04 from the user's explicit ENGINEERING TRANSITION AND FIRST IMPLEMENTATION SELECTION decision. State FUNCTIONAL_PLANNING_BOUNDARIES_APPROVED; IMPLEMENTATION_NOT_AUTHORIZED; OPERATIONAL_ASSIGNMENTS_OPEN. This supplements existing D12/Q01 without renumbering or replacing D01-D12. See [transition report](r10-a-engineering-transition-report.md) and [evidence](r10-a-engineering-transition-sources.json).

| Functional owner | Approved planning responsibility |
|---|---|
| A | Platform preparation, deployment packaging, release configuration and non-executing infrastructure tooling |
| F | Security implementation and repository hygiene |
| E | Observability implementation |
| G | Backup/recovery implementation |
| X | Cross-stream integration and integrated acceptance |
| Unapproved application-code implementer | UNASSIGNED; no A/X assignment inferred |
| Production operational approvers and credential custodians | UNASSIGNED; no operational authorization |

Q01 A coordination of exposed-credential rotation/platform evidence remains; actual issuer/account custodian, independent revocation verifier, STOP/recovery/key/release/activation authorities remain UNASSIGNED. Existing C/D/H/B semantics and F/G reader conflict are retained. ET01 is selected as the first bounded A engineering task: a pure dependency-free inventory path/metadata rejection policy with Node built-in tests. Selection is not implementation authorization; no task file is created now. ET02-ET14 and A16 ENG01-ENG13 require dependency/scope decisions as documented; all production gates remain OPEN/BLOCKED.

Historical reconciliation remains PARTIAL: H01-H07 are seven occurrences/six distinct expected digests across three documents, still HISTORICAL_BYTES_UNREPRODUCED after current/prefix/EOL/all available path-revision checks. A06 unresolved location is historicalInputs[0], not its reproducible current-source entry. No original hash/history changed or waiver granted. Named documentary custodian/disposition approver is UNASSIGNED. Offline unit development of an isolated synthetic component may be authorized separately while these production/provenance gates remain open. Stop after planning report; no implementation/deployment/installation/merge/commit/push/secret/provider action.
