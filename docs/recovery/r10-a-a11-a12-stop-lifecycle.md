# R10-A consolidated A11-A12 emergency stop and runtime lifecycle specification

Status: OFFLINE SPECIFICATION ONLY. Baseline `a0bea50a7bac480e7655ff1915532157b8360540`, branch `feature/r10-a-production-platform`, recorded 2026-11-04. [Sources](r10-a-a11-a12-sources.json), [separate stage acceptance](r10-a-a11-a12-consolidated-report.md), [A03 process inventory](r10-a-a03-process-ownership.md), [monitoring specification](r10-a-a08-a10-monitoring-telemetry-security.md), [A01 requirements](r10-a-a01-requirements.md) and [decisions](r10-a-a01-decisions.md) define the evidence boundary.

## 1. Scope, authority and retained numbering

Mission A11 means independent emergency stop; mission A12 means drain/suspension/restart. These primarily elaborate original local A14 (independent controls) and A08/A09 (API/worker/scheduler supervision). Original local A11 provider boundary and A12 telemetry remain unchanged, with all local A01-A16 and D01-D12 identifiers retained. No A13 work is authorized.

C-CONTRACT is sibling `runtime-resilience/v1`; C-OBS is `runtime-to-observability/v1`; H-CONTRACT is `controlled-autonomy/v1`; H-OBS is `autonomy-observability/v1`; F-CONTRACT is production-security-configuration-contract. Source modules and all earlier local artifacts are hashed in the catalog. Forty prior A08-A10 source/spec hashes matched before edits. A07 Q01 functional framework is retained: A coordinates platform evidence/rotation, F owns existing hardening/cleanup implementation scope, X coordinates cross-stream integration/integrated verification. Actual issuer custodians, independent revocation verification and production approval remain UNASSIGNED. A08-A10 collectors are UNKNOWN; their acceptance tests have NOT RUN.

No executable implementation is supplied. A owns platform preparation and later authorized host/process wiring; C/F/H retain contract semantics. X coordinates C/H production composition and required integrated verification, including real DB/process proofs; it is not automatically the code implementer or independent human approver. Every application change in section 4 needs an expressly authorized owner, currently UNASSIGNED. No deployment privilege, service role, queue lock, successful heartbeat, release version or monitoring verdict replaces R9-F/H authority.

## 2. A11 independent emergency stop

### A11.1 Proposed protected control architecture

Use an independently administered, out-of-process **durable stop authority** outside API, worker, scheduler, application release tree and runtime-writable data. An independently authenticated human STOP administrator can assert it through a protected administrative channel, including when the app is down. Runtime, MON, deployment agents and model tools receive only a narrowly bound reader; none may create/replace/delete/clear the authority or change its parent/source policy. A04 provides identity/ACL requirements, not provisioned tokens. The existing administrator-privileged Azure deployer is an explicit containment residual: ordinary DACL separation cannot certify isolation from a local administrator. D05/D07/D11 must approve its trust/administration boundary.

Proposed implementation choices requiring decision: an independently supervised control service with durable latch and authenticated read-only status, or an administrator-owned durable local object with authenticated/versioned read semantics and protected parents. No particular product, filename, endpoint, Windows service or registry key is selected. A local object is acceptable only after proving crash-safe atomic replacement, corruption/replay detection and no runtime-writable ancestor/link path. A control service must prove durable restart behavior and independent availability. Neither an in-process boolean, environment variable, Redis queue pause, release file nor application DB row alone qualifies as the independent authority. No network or filesystem mechanism is installed here.

Proposed stop record is non-secret: contract version, target/environment identity, monotonic generation, latched STOPPED or explicitly authorized CLEAR, bounded reason/reference, authorized actor class/reference and UTC assertion time plus protected integrity/audit references. No default clear on missing state. Global NatForgeAI stop is a platform deny override mapped by trusted composition to every affected exact H scope, not an invented wildcard H policy. Per-scope H suspension remains separate. Unknown target mapping or a newly started service without registration denies. Zuto is outside this stop target; no whole-host/IIS-wide control is authorized.

H independently combines its local kill latch OR `emergencyStopped(exactScope)`. A runtime handle has only gate/downgrade/enterSafeMode; H administration requires independent authorization on every call. Local latch clearance cannot defeat the external stop, and external clearance cannot erase local latch/suspension/safe mode. H observer exposes combined stop read-only with actualExecution=false. Scope verification must precede any read. Missing/unavailable/throwing reader must deny visibly; unconfigured H production composition already denies. A boolean H port is not authentication: trusted adapter must authenticate source, target, generation and freshness before returning false.

### A11.2 Persistence, failure and restoration

| Condition | Required behavior / evidence |
|---|---|
| Stop asserted | Persist latch independently; block new effect admissions and final dispatch gates; record authority generation/UTC and acknowledgement from each consumer role. Acknowledgement is observation of stop, not proof of zero external effects |
| Reader absent, null/malformed reply, error, timeout, permission denied or corrupt state | Fail stopped/deny, expose bounded unavailable diagnostic; never use cached CLEAR or development fallback. The trusted wrapper maps failures to stopped or propagates an error that cannot dispatch |
| Reader appears responsive but status stale/wrong target/replayed generation | Reject as unavailable/stopped. Required freshness/timeout and monotonic-restart policy are D11/D09 approval gates; no indefinite last-known-clear cache |
| App, wrapper, control-service or host restart | Durable stop remains authoritative. Bootstrap before traffic/queue/timer/sweep admission reads current independent state; missing/uninitialized state defaults stopped. Restart cannot recreate a clear record, clear H state or select a different reader |
| Stop during asynchronous action evidence loading | H re-reads after loading and before eligibility/transport; false at entry does not survive later true. No queued/replayed H grant or client boolean may bypass fresh checks |
| Stop/audit/source storage failure | Maintain deny/stopped safety posture and preserve restricted failure evidence; do not report durable assertion unless durability is proven. Proposed independent emergency assertion must not become CLEAR because audit sink fails. Define protected failure spool/operator escalation later. H local administrative changes retain their own transactional audit rollback semantics; this proposal does not alter H |
| Human requests restoration | Require separately authorized STOP/system-owner procedure, verified source/generation, exact scope, incident disposition, durable audit and operator evidence. Named human and approval authority UNASSIGNED. Audit unavailable => restoration denied; no automatic resume on health recovery, lease expiry, reboot or deployment |
| Stop cleared at independent authority | H local latch/safe mode/suspension may still block. Separately authorized H restoration is required; each subsequent action reloads exact present R9-A/B/C/F and C/D/H evidence. CLEAR never means execute or retry |

Stop authority must be outside mutable backups/release rollback state: restoration of application files/DB cannot overwrite a newer independent stop generation. Restore/control-store recovery policy and bootstrap of a lost stop source require independent approval and deny-by-default. A11 specifies this requirement; no backup/restore implementation or A13 stage is begun.

### A11.3 Effect boundaries and propagation

Required rechecks: before new API effect request admission, queue enqueue where it can trigger effects, worker claim/run, scheduler pass/recovery admission, before R9-D dispatch reservation, after asynchronous evidence loading and immediately before actual provider/SDK/subprocess/business-effect boundary. A11's global safety policy must explicitly classify each A03 E01-E09 path; production deployment remains blocked until coverage is proved. A server-only gate reference and exact durable material are loaded fresh; clients/jobs/models cannot supply stop flags, provider accounts or policy dependencies. A paused queue cannot block a direct API provider call.

| A03 coverage | Stop/lifecycle requirement |
|---|---|
| E01 publishing / E02 content-agent-strategy | Queue and direct routes both denied at new effect boundary; preserve durable approval/barrier/result evidence and accounting |
| E03 video/render/download | Block new provider/download/renderer launches; contain child/scratch lifecycle and unpublished partial outputs; completed remote or in-flight process effects remain evidence, not rollback promises |
| E04 engagement/nurture | Execution and reconciliation paths classified separately; P10 reconciliation may send, so it is not automatically allowed during stop |
| E05 observation/listening | Remote provider reads and ingest/lifecycle mutations are effects, not unrestricted read-only monitoring. Permit only expressly reviewed safety observations; absent classification denies effectful work |
| E06 approval/communication | SMTP/OTP/OAuth/token exchange/revocation cannot bypass stop through a “control” label. Define independently authorized human access/communications continuity outside runtime; any required exception needs exact approved safe scope, no arbitrary outbound capability |
| E07 billing/business/request integrations | Stop guards provider/financial/business mutations according to reviewed policy; no claim every DB write calls a provider. Inbound/outcome receipt processing may preserve authoritative facts only under a reviewed non-dispatch path |
| E08 mission/recovery | H hooks at C/R9 dispatch entry and D provider boundary; new retry requires fresh exact R9-F authority and latest attempt; safe evidence reconciliation cannot resend |
| E09 operations/health/deployment | Probe/read-only observation cannot start/repair/requeue; deployment tooling cannot clear stop. Separate independent admin channel may stop/drain under authorization, never inferred from MON privileges |

All P01-P13 consumers/timers/boot sweeps must stop new admissions; retain P12 active-operation fencing/heartbeats/deadlines as needed to finish evidence safely. Safely authenticated inbound receipts may be preserved in deny posture, but receipt ingestion cannot launch continuations without new authority. Every legacy SDK, SMTP, Firebase/storage path and future adapter requires the X-coordinated effect audit; A03's lexical inventory is not exhaustive transitive proof. If selective stop exceptions cannot be enforced, leave affected runtime effects disabled rather than assume a universal existing gate.

Propagation evidence must distinguish: human assertion accepted, durable generation committed, reader visibility, each process observation, last allowed admission, final transport gate, in-flight receipt and drain completion. Use trusted UTC/monotonic elapsed measurements with clock uncertainty; do not derive zero latency from identical timestamps. Poll intervals, read timeout, admission-to-boundary windows and maximum propagation/drain budgets remain UNASSIGNED approval gates. No real propagation time is asserted.

The final read still has a race with a subsequent stop assertion/transport submission. Required design must define the transport linearization point and approved upper bound or a supported independently enforced admission interlock. H's two reads alone do not prove instantaneous revocation across a network boundary. Already-submitted transport cannot be recalled; terminate/contain only under approved incident policy, preserve UNCERTAIN/PENDING_EXTERNAL and reconcile via R9-D/E/F. Never log “all stopped” solely because a service has exited. If the bound/interlock cannot be certified, external effects remain disabled.

### A11.4 Fake-backed acceptance matrix

All ES01-ES10 are specifications, **NOT RUN**. Later approved harness uses fixed T0=2026-11-04T00:00:00Z, injected clock, scripted independent reader, fake immutable action/store, deferred evidence-loader promises, fake audit sink and spy provider/subprocess/control interfaces. A valid fake action and admin authorizer are test dependencies only; no real credentials, boot/worker import or real stop commands. Repeat sequences must produce the same semantic results/evidence, not random instance IDs; deterministic nonce source is injected solely in tests.

| ID | Script / assertions |
|---|---|
| ES01 | Reader true at entry with otherwise eligible fake action -> denied, no transport/reservation attributable to this gate, explicit stopped reason, no cleared latch/history |
| ES02 | Reader dependency absent, timed out, permission denied or malformed -> fail stopped/error that prevents dispatch, no cached false fallback; unavailable diagnostic safe and visible |
| ES03 | Reader throws at first read and separately at second read -> deny, transport count zero; prior immutable facts untouched; no fabricated success |
| ES04 | Entry read false; suspend evidence loader, assert fake stop generation, release loader; second read true -> deny, zero new transport; prove exact race with controlled promises rather than sleeps |
| ES05 | Independent stop persists through new API/WRK/SCH/control-reader instances and simulated host restart; zero initial admissions. Lost/corrupt/wrong-target/stale/replayed source denies |
| ES06 | Runtime, MON, deployment agent or forged actor attempts clear/replace/write/choose reader; fake authorizer denies, generation unchanged, audit bounded. Independent-clear alone leaves local H latch/suspension blocking |
| ES07 | Iterate API direct, both queues, every scheduler/sweep and A03 E01-E09 effect family; stop before final fake effect -> zero new transport. Missing coverage row is failure, not waiver. Record safe receipt preservation separately |
| ES08 | Stop after fake transport submission but before ack; preserve barrier and UNCERTAIN/PENDING_EXTERNAL if no authoritative receipt; no second send. Do not claim prior submission was prevented |
| ES09 | Fake audit/source persistence fault: deny restoration and new effects, never assert durable stop/clear success without proof; local H transaction rollback and independent stopped posture remain distinct |
| ES10 | Fixture propagation budget B=100ms (test constant, not production promise); step clock/reader acknowledgements deterministically and flag over-budget/missing role. Readiness remains blocked; record linearization race, no automatic terminate/resume |

## 3. A12 drain, suspension and restart

### A12.1 Process and safety state separation

Proposed process states STOPPED, STARTING, READY, DRAINING, SUSPENDED, STOPPING, FAILED are orchestration labels, not replacements for C job states or H DISABLED/SHADOW/CANARY/ACTIVE/DEGRADED/SAFE_MODE/SUSPENDED. Separate controls: local drain prevents this instance admitting work; queue global pause affects queue delivery; H suspension blocks exact-scope effects; independent stop overrides every mapped scope. None means successful cancellation of submitted effects or a grant to resume. C allows intentional replicas; prevent accidental duplicate startup, not all multiple registered workers by definition.

| Evidence | Meaning / acceptance |
|---|---|
| Process liveness | Listener/event loop/supervisor process generation exists. It does not prove DB/queue, consumer, scheduler or execution permission |
| API readiness | Intended request/producer dependency/config/release function is available via inert checks, independent of API-local worker handle. Effect admission reports stop/drain/authority blocks separately. Operational read-only/admin observation may stay available while execution readiness is false |
| Worker readiness | Authenticated current instance/role/contracts/release, C durable eligibility, dependencies and approved claim binding. Missing dependency/stop status means no new work; process up alone is insufficient |
| Worker heartbeat | C default late 15s/stale 60s/dead 300s; invalid/future time fails closed, stale owner must register new instance. These are runtime eligibility semantics, not E's observer threshold |
| Scheduler readiness/heartbeat | Per-job configured enabled/disabled state, owner/fence, last start/completion, active pass, next due and current stop status. Disabled is explicit; stale or missing owner never inferred healthy |
| Monitoring freshness | A08-A10 E observer defaults worker stale >120s, scheduler >300s are separate from C liveness. C can refuse work before E shows degradation; E HEALTHY never overrides C/H. Required time/evidence policy approval remains D09 OPEN |

Current baseline: API boot starts both queue consumers under production+Redis and starts credit renewal plus conditional/default-on metrics and boot sweeps; standalone worker starts both consumers too. BullMQ stored handles are not construction guards; repeated constructors can overwrite tracked handles. `worker.ts` installs SIGINT/SIGTERM handlers after startup and memoizes a shutdown promise, but closes only its declared consumers/BullMQ path; it is not the complete C/H/child/DB/timer lifecycle or a Windows SCM stop adapter. API has no coordinated equivalent. Build has only boot/worker entry points, no scheduler target. C/H production bindings remain separate, unactivated dependencies. These gaps block runtime acceptance.

### A12.2 Role and phase requirements

| Phase / role | Required behavior / retained truth |
|---|---|
| Inert startup/composition | Validate immutable role/release/schema, identity, dependencies, H/independent reader and explicit job policy before listeners/admissions/constructors/sweeps. Unknown/conflicting role fails closed. No migrations/provider probes. Status imports cannot start workers/timers. Missing production Redis cannot activate interval/inline fallback |
| API drain | Mark effect/producer admissions closed before async waits; readiness reports draining, continue only approved bounded reads/inbound receipt/audit paths. Track accepted effect requests and enqueues across race; recheck stop/authority before their final effect. Finish safe response/receipt evidence, then close listener within approved deadline |
| Queue-worker drain | Synchronously close local intake then persist C DRAINING. Stop fetching/claiming through this instance; recheck eligibility after already-entered async claim. Such a claim may fence a row but must not newly dispatch if ineligible. Track each active run/lease/barrier/receipt. C stop returns drained:false while active; await accounting and poll stop under bounded procedure |
| Scheduler pause/drain | Cancel future ticks, forbid new passes/sweeps and record desired pause durably outside auto-start defaults. Track in-flight passes/continuations, not just timer handles. Recheck exact job owner/fence and H/stop before each effect; lease loss blocks new effects. Preserve active-operation maintenance needed for fencing and safe results |
| Suspension | H MISSION/CAPABILITY/PROVIDER/EXECUTION/WORKER/SCHEDULER latches exact scope; apply to every affected tuple for wider incident. Pause/drain is a C/X handoff, not H or OS privilege for a queue. Read-only review and approved no-send reconciliation may continue, P10 execution-capable reconciliation cannot bypass |
| Controlled shutdown | Deliver selected wrapper/SCM stop through reviewed adapter to application drain; do not assume Windows sends Unix signals. Idempotent repeated stop request shares tracked completion. Close all constructed consumers, timers, active child processes, producers, Redis and ioredis clients, DB and listener after safe evidence writes. Track cancellation/deadlines; no final success if handles/jobs remain unaccounted |
| Deadline/forced termination | Record active/uncertain work and approved escalation before process termination where possible. Crash path must retain durable barrier/receipt/stop truth without final process callback. Do not erase locks/results or force queue success. Resource limits/termination authority/grace period are approval gates, no commands provided |
| Lease/release fencing | C fixed job lease is 60s, not heartbeat-renewed. Current version/instance/epoch/deadline required at barrier/completion. Expired owner cannot finish/write on a newer epoch. Reclaim/lease expiry does not authorize replay past dispatch barrier; long work requires governed reconciliation. Legacy timer renewals remain distinct from C lease |
| Planned restart/rollback | Independently authorized drain/stop, compatible exact role/runtime/release/schema manifest, bounded active completion/uncertainty evidence, then old resources closed before replacement ownership. New process nonce/instance; re-read independent stop and H latches. Rollback cannot restore old authority/stop state; mixed releases deny unless explicit certified compatibility binding |
| Unexpected crash/reboot | Register new instance after authentic startup checks, preserve durable paused/stop posture, reload exact action/receipt/state and current governance. No on-boot approval/engagement sweep automatically executes; no scheduler activation due to absent desired-state record. Fail closed on unknown state |

Do not claim C's run-active count alone proves platform drain: supervisor composition must also account for API requests, started-but-unfinished claims, scheduler passes, queued admissions, subprocesses and receipt persistence. A stop return with no active runs cannot erase a raced fenced job. Heartbeats may continue in draining to preserve truthful status until terminal shutdown; health reads never renew leases/register/start owners.

Scheduler/consumer preservation of A03 P01-P13: P01/P02 have explicit single initial queue-host owner and guarded constructors (capacity 5/2 per A03, not approved global budget); API has zero consumers. P03 legacy interval fallback remains OFF in production. P04 credit renewal, P05 lifecycle, P06 metrics, P07 listening, P08/P09 continuations and P10 recovery move only under assigned per-job ownership/admission policy; default-on P06 and unconditional P04/P08-P10 are blockers until refactored. Preserve credit/rejection/safety obligations without granting send authority; disabled obligation is an explicit gap. P11 API generation is enqueue-only under proposed role, no inline fallback when consumer disabled. P12 fencing/claim maintenance stays with active operation; P13 connection callbacks/timeouts/housekeeping require tracked shutdown and cannot be mistaken for independent schedulers. Role flags alone do not constrain direct API E01-E09 effects.

### A12.3 Crash truth and retry rules

| Crash point (C5-C6) | Next permissible step |
|---|---|
| No durable R9-D intent | Refuse runtime dispatch; never fabricate an action |
| Intent exists, no runtime dispatch barrier | Reload exact material and present R9 A/B/C/F/R9-D plus H/C/D eligibility; no automatic queue retry authority |
| Barrier persisted, R9-D not yet called | Conservatively UNCERTAIN even if work may not have sent; no barrier deletion or resend to improve availability |
| During dispatch / provider ack before local ack | Load authoritative R9-D receipt if any; otherwise UNCERTAIN, preserve reference and require governed reconciliation |
| R9-D result persisted, runtime completion missing | Copy immutable receipt classification under current fence if eligible; never redispatch. COMPLETED processing can still have UNCERTAIN/PENDING_EXTERNAL result |
| During governed recovery | Re-read preserved evidence and current authority; never inherit old process approval, canary reservation or stale H grant |

Retry needs newly prepared R9-D RETRY_STEP, fresh exact R9-F decision different from the failed action's decision and latest failed/uncertain failedAttemptRef, same scope/material binding and current H/C/D/stop checks. BullMQ attempts/backoff, queue redelivery, missing heartbeat/ack or lease expiration provide none of this. Persisted uncertainty cannot become success through process exit code, liveness, drained:true or healthy metrics. Callbacks/outcomes remain R9-D/R9-E authorities.

### A12.4 Synthetic lifecycle fault-injection matrix

LC01-LC12 are **NOT RUN**. Later harness uses ES test clocks/scopes and fake queue/store/receipt/supervisor/timers/child handles, explicit promise barriers, deterministic nonce fixtures and no real OS/services/providers. Capture state transitions, claim/transport counts, safe receipts, fence versions/epochs, active counts, desired-state and audit/observation evidence; compare exact before/after invariants. Fakes do not prove Windows delivery, MySQL contention or propagation latency.

| ID | Fault / expected assertions |
|---|---|
| LC01 | Start API then designated worker, call each constructor twice; intended two queue roles constructed exactly once in worker, zero in API; every handle registered for close. Conflicting/missing role denies; no P03/P11 fallback |
| LC02 | Begin asynchronous C claim, hold pre/post-CAS promise, issue drain, release promise; subsequent claims deny; raced fenced job never transports when ineligible; no fake CAS “reread winner” success |
| LC03 | Drain while one fake run/HTTP effect/renderer active; drained:false until all tracked categories settled, not just timers stopped. Repeated stop idempotent; receipt accounting retained and each resource closes at most once |
| LC04 | Scheduler paused mid-pass; cancel future ticks, preserve required operation maintenance, no new pass/effect after stop recheck. Restart with missing desired-job policy remains disabled; no unconditional continuation sweep |
| LC05 | Inject crash at every row of A12.3; assert corresponding refusal/read/reconciliation action and zero unauthorized second send. Separate ack-before-local-persist case retains UNCERTAIN |
| LC06 | Lease expires or owner/epoch/version replaced, old worker completes or dispatches; deny stale fence writes/transport. Reclaim alone cannot bypass durable barrier or authorize retry |
| LC07 | New process instance after crash/release rollback; nonce changes, exact release/contracts checked, stopped/paused H/independent state preserved. Drift/unknown compatibility denies rather than widen supported set |
| LC08 | Liveness HTTP200 while readiness dependency degraded, heartbeat stale/missing or stop unreadable; distinguish signals and deny admission. E healthy observer cannot override C stale 60s eligibility or H latch; probes write no registrations/alerts |
| LC09 | Stop asserted during async evidence/claim/scheduler load and between fake transport gates; observe deny and measured fixture propagation acknowledgements; already-submitted effect classified uncertain if receipt missing, no new send |
| LC10 | Simulate Windows-wrapper stop request, repeated signal and deadline expiry with remaining fake handles; controlled drain/cleanup or recorded forced-termination uncertainty, no fake graceful success. Real SCM/signal delivery remains NOT RUN |
| LC11 | Queue redelivers failed/uncertain job automatically; reject redispatch. Only a valid fake new RETRY_STEP with latest attempt/current decision/parameters/release/stop can pass fake gates; wrong/replayed binding denies |
| LC12 | Pause/resume/global queue pause/stop/monitoring recovery and tenant/business collision attempts; no unauthorized clear/auto-resume, role/scope state isolated, exact approvals revalidated. Preserve dead-letter/original job when evidence persistence fails |

## 4. Explicit application assignments and approval gates

| Item / A03 link | Supported responsibility / remaining assignment |
|---|---|
| AP01 C01 inert API/role split; C02 worker guards | A platform role/topology specification only. Application implementer UNASSIGNED; X-coordinated explicit authorization required for boot.ts, worker.ts and queue/bullmq constructors; no code supplied |
| AP02 C03 scheduler entry/build and C04 credit lifecycle | Application/build/billing owners UNASSIGNED. New scheduler entry filename/command/role policy not approved; X coordinates C/B/F/H review, including credit race/owner proof |
| AP03 C05 sweep cancellation and C10 legacy effects | Application implementer UNASSIGNED; exact safe receipt/reconciliation versus send boundary and E01-E09 SDK/communications coverage must be approved |
| AP04 C06 health and C07 C/D/H composition | X coordinates contract-bound production binding and integrated verification; application/collector implementer UNASSIGNED. C runtime, H control, F security semantics not reimplemented by platform docs |
| AP05 C08 drain/signal/resources and C09 tool alignment | A owns later authorized supervisor/process configuration. Application/Windows lifecycle adapter and deployment-tool implementers UNASSIGNED; explicit owner needed even if files are called deployment scripts |
| AP06 independent source/reader and human admin | A platform preparation; H A/X mechanism/wiring responsibility; X/F bind actual independent identity/least privilege under H contract. Concrete mechanism, code implementer, STOP human/custodian and clear approver UNASSIGNED |

Approval gates: D02 supervisor, process/job desired state, restart/backoff/grace/termination budget and signal adapter; D05/D07 independent identity, source/reader permissions, legacy admin risk and no wider credential inheritance; D09 trusted time/heartbeat/stop propagation metrics, alert route and threshold mismatch review; D11 actual stop source, target coverage, durable persistence, monotonic replay semantics, timeout/freshness, certified propagation/transport race bound, incident/assert/restore authorities; D12 named implementers/reviewers and integrated acceptance signatories. All OPEN. X owns canonical migration convergence; no new schema migration is approved or executed here. Real Windows, MySQL CAS/concurrency, SDK effect interlocks and Zuto regression proof remain separately gated.

Restoration or propagation incident handling must not grant MON service control, deployer secret-source authority, runtime H admin handles, backup rights or stop-source modification. E may report stop/drain/uncertainty only; C-OBS bounded fleet snapshots (up to 500 rows per category) cannot certify global drained counts. Missing fleet/collector coverage explicitly blocks a fleet-wide “all drained” claim. Stop and deployment approval remain separate from R9-F execution/independent H restoration.

## 5. Retained local planning crosswalk and verdicts

| Identifier | A11-A12 contribution / residual gate |
|---|---|
| A01 | Source preservation, independent stage acceptance and ownership evidence |
| A02 | Windows/Zuto host isolation design only, no current service/stop proof |
| A03 | P01-P13/E01-E09/C01-C10 inventory preserved and lifecycle detail elaborated |
| A04 | Immutable role/release identity; source/native package gates remain |
| A05 | API/IIS traffic drain target, no whole-host/Zuto stop or IIS changes |
| A06 | Independent reader/admin and per-role least privilege, no identities/ACLs provisioned |
| A07 | Q01 functional-only ownership, source/rotation/approval blockers retained |
| A08 | Original API supervision/readiness/drain requirements elaborated, live gate OPEN |
| A09 | Original worker/scheduler/fencing/restart requirements elaborated, live gate OPEN |
| A10 | Original DB/Redis/CAS/schema authority retained, no migration |
| A11 | Original provider boundary requires final fresh stop/authority gate, no calls |
| A12 | Original telemetry reports stop/uncertainty, never control authority |
| A13 | Stop-state recovery must not be rolled back; backup stage not begun |
| A14 | Primary mission A11 mapping: independent stop/source/human/propagation proof OPEN |
| A15 | Controlled restart/release and rollback preserve authority/uncertainty |
| A16 | Independent signatories and governed activation remain OPEN |
| D01 | Exact API/site/process targets, no Zuto or global IIS impact |
| D02 | Supervisor/signals/drain/admission/job topology/grace/restart policy OPEN |
| D03 | Manifest/release/instance compatibility and rollback attribution OPEN |
| D04 | Scratch/partial media/child cleanup paths OPEN |
| D05 | Runtime/STOP/source/reader tokens and admin residual approval OPEN |
| D06 | Durable DB/Redis fencing/recovery/restart semantics OPEN |
| D07 | Role-specific sources, human credential custody and reader trust OPEN |
| D08 | Existing TLS/DNS isolation retained, no changes |
| D09 | Stop/lease/heartbeat/clock evidence and C/E threshold distinction OPEN |
| D10 | Independent stop persistence cannot be cleared by app restore; later proof OPEN |
| D11 | Mechanism, human assertion/clear authority and propagation bound OPEN |
| D12 | Express code-owner authorization, X coordination and signatories OPEN |

Separate acceptance: A11 documentation PASS, ES01-ES10 NOT RUN, integrated/live independent-stop acceptance BLOCKED. A12 documentation PASS, LC01-LC12 NOT RUN, integrated/live lifecycle acceptance BLOCKED. Documentation contains no claim of tested safety, real stop timing or production compliance. Stop after A12; do not begin A13.
