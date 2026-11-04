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
