# R10-H autonomy / activation inventory

Inspected programme base: `799f6b4cb351ebe969f97da606324605fdf2a07b`.
Branch: `feature/r10-h-autonomy-activation`. Inspection is read-only for siblings.

## Existing controls and possible authority increases

| Surface | Existing control | Can increase execution reach? |
|---|---|---|
| api/lib/env.ts | ENABLE_PREMIUM_VIDEO, ENABLE_BASIC_DRAFT_VIDEO, ENABLE_PREMIUM_TEMPLATE_PROVIDER, ENABLE_HYBRID_LEAFLET_PIPELINE | Yes: enable provider-backed generation; feature flags are not autonomy authority |
| api/lib/env.ts | ENGAGEMENT_PROVIDER_TRANSPORT_ENABLED, default false | Yes: permits existing engagement transport; must remain under its existing policy and future H/X boundary |
| api/lib/env.ts | SOCIAL_LISTENING_POLLING_ENABLED, default false | Enables external polling, not dispatch authorization |
| api/lib/env.ts | POST_LIVE_LIFECYCLE_ENABLED, default false | Enables lifecycle reconciliation; not execution approval |
| api/lib/env.ts | POST_LIVE_METRICS_OBSERVATION_ENABLED, default true | Observation only; must not restore authority |
| api/lib/creative/image-render-claims-mode.ts | IMAGE_RENDER_CLAIMS_MODE off/on | Changes creative claim processing, not customer autonomy |
| api/lib/creative/message-approval/canary-selector.ts | CREATIVE_PIPELINE_V2_CANARY_ENABLED, campaign/business/user allowlists, percent and salt | Yes: widens creative pipeline adoption; distinct from runtime autonomous execution permission |
| api/lib/creative/message-approval/shadow-runner.ts | Diagnostic shadow pipeline | Advisory creative evidence; preserve explicit shadow labels |
| api/lib/creative/campaign-message-architect.ts | Shadow observation, error classification | No new execution authority |
| api/campaign-router.ts | Campaign creation/status activation and strategy/content generation | Yes: active campaign/workflow state can reach legacy generation/distribution; status alone must not become H authority |
| api/automation-router.ts | Stored workflow enabled/paused state | Changes workflow definition activity; external execution engine remains separate |
| api/worker.ts | Redis-configured standalone startup launches publishing and content-generation workers; SIGINT/SIGTERM drain | Yes: startup activates existing queues; no central H kill switch at base |
| api/lib/queue/publishing-worker.ts | Publishing queue consumption | Existing external publication path; future X must compose H without bypassing publication approval |
| api/lib/queue/content-generation-worker.ts | Content generation consumption | Existing generation/provider path, not governed autonomy activation |
| api/lib/mission-authority/ | R9-A objective/lifecycle/mission scope | Authoritative mission lifecycle only; H cannot change it |
| api/lib/mission-planning/, mission-scheduling/ | Ready plan/task/schedule | Preparation readiness, never dispatch authority |
| api/lib/mission-governance/ | R9-F exact immutable decisions and OTP-bound approvals | Yes: exact approved action becomes consumable, never an H level change |
| api/lib/execution-coordination/ | R9-D prepare/dispatch; server adapter registry | Dispatch authority from A/B/C/F; sandbox-only in programme base |
| api/lib/mission-state-recovery/ | Recovery candidate, governance bind/consume | Advisory recovery; no self-authorized replay or autonomy restoration |
| api/middleware.ts, admin-router.ts | Authenticated admin controls, user role changes | Sensitive administrative boundary; JWT role alone is insufficient for new H upward authority |
| scripts/deployment/start-runtime.ps1 | Process startup / deployment runtime | Infrastructure ownership; not called here |

R9-X `mission-control-autonomy-boundary-contract.md` supplies four architectural
levels but no runtime activation. There is no unified durable H policy,
safe-mode latch or independent platform kill implementation at this base.
Provider credentials, subscription entitlements and campaign activation are
not autonomy policy. Existing legacy paths are inventoried, not rewritten or
activated here: R10-X must bind every external side-effect entry before live
activation, including legacy queues, engagement and generation paths.

## Frozen siblings inspected without merges

| Stream | Exact cached origin head | Evidence inspected |
|---|---|---|
| B | 5d20c418c8efc6a44abaa053e43c4691af2a5bb1 | Data/concurrency acceptance: structural checks, real-MySQL environment gate; require transaction/CAS/unique anchors |
| C | cc5712d0a16dfd7dcfc5f0f2991b0d354f853a06 | autonomous-runtime-resilience contract + runtime-service: durable dispatch barrier, no automatic retry, drain, release binding; enters real R9-D |
| D | d9492c6c2be4389d046948fc5aefd00b350b2d7d | production-provider-adapter contract + provider-resilience-service: fresh authorize resolver, immutable exact provider/account, sandbox-only, no provider-switch authority |
| E | ea4f1f890ecd59079b4b13f7a67a6c96c617e11c | production-observability + platform handoff: unknown telemetry never healthy; monitoring has no control authority |
| F | d02187cc72a30a1ae7790617dc692a75a752089b | production-security-configuration contract: service identities, tenant/security boundaries, no agent privilege to secrets/infrastructure |
| G | e4c5e56fc31001f66167be3f0d1bba686bc39d63 | backup-monitoring contract: runtime cannot suppress backup alerts; failed/missing controls are safety evidence |

`git ls-remote origin refs/heads/feature/r10-e-observability-operations` failed:
GitHub:443 unreachable. E's exact **cached** hash matches expected ea4f1f8;
current remote verification remains unproven. Frozen compatibility tests read
these exact Git objects; they do not claim sibling implementation suites were
run or that production integrations exist.

H adds the authoritative mechanism and a closed R9 application dispatch hook.
No environment flag can activate H. Trusted administration identity, independent
kill infrastructure, C/D live binding, E collector, F DB/process privileges and
G backup pipeline remain R10-A/X composition responsibilities. No production
authority increases during this work.
