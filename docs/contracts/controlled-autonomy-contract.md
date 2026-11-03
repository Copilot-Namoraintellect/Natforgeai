# Controlled autonomy contract — R10-H

Version: `controlled-autonomy/v1`. Base: `799f6b4cb351ebe969f97da606324605fdf2a07b`.
Implementation: `api/lib/autonomy/`. No production activation, deployment,
provider call, OneGrid access or migration execution is authorized here.

## Product levels and operational states

| Product level | Meaning |
|---|---|
| LEVEL_1_DECISION_SUPPORT | Observe, analyse, reason, recommend; never dispatch |
| LEVEL_2_ORCHESTRATED_INTELLIGENCE | Governed formation/planning/scheduling/preparation; an execution consumption additionally needs exact human approval |
| LEVEL_3_GOVERNED_AUTONOMY | Execute only explicitly bounded capabilities/actions with exact current R9-F authority |
| LEVEL_4_ADVANCED_AUTONOMOUS_OPERATIONS | Continuous operation within the same explicit constraints; no extra privilege to change any authority |

`DISABLED` is the internal zero-authority level, not a customer tier.
Runtime states are separate: DISABLED, SHADOW, CANARY, ACTIVE, DEGRADED,
SAFE_MODE, SUSPENDED. Configured maximum is distinct from effective level.
An enabled feature or healthy runtime never grants autonomy. Unknown values,
absent policy, absent health/authority, storage errors and expired evidence
fail closed. Missing health must be resolved as false/unknown, never true.

## Exact policy binding

A strict policy fixes authenticated tenant, verified business, capability,
action class, configured maximum, capability maximum, action maximum,
effective/expiry time, version, administration authority source and release.
The minimum of the three ceilings applies. There are no default business
policies, wildcards, client priority rules or package entitlements.
Each scope is an independently configured exact tuple. Unsupported capability
names never become executable merely by having an H policy: R9-B/D's closed
capability vocabulary remains required. Capability/action entries may differ.

Future organisation, business unit, brand and market can extend the versioned
scope vocabulary. R11 hierarchy, enterprise IAM, package entitlement, approval
threshold and risk policy remain outside this implementation. No authority
is inherited across tenants, businesses or capabilities.

## Trust boundary and administration

`createAutonomyController` is trusted server composition, never an agent tool
or HTTP endpoint. It returns distinct administration, runtime and observer
handles. Bind only the runtime handle to an authenticated, fixed tenant/business
worker. The administration handle requires a separate injected administrative
authorizer on every call, verifies actor class/source, and uses expected-version
concurrency. A self-declared admin role, actor string or model instruction
cannot satisfy that authorizer. R10-X/F must bind actual independent identity,
least-privilege process/DB credentials and policy approval before activation.

Only administration may raise effective/configured/capability/action levels,
change policy/release/canary, remove a suspension, exit safe mode, or clear the
local kill latch. A skip-stage reference is ineffective without an explicit
authorizer verdict that allows skipping. No model writes policy or audit.
The runtime handle exposes only `downgrade`, `enterSafeMode`, and `gate`.
No monitoring, backup, secret, approval, budget, provider/account change,
mission/task mutation, shell, SQL or code tool exists on either runtime or
observation surfaces. A process with arbitrary code/DB access is beyond this
API boundary and requires R10-F/X containment, not a stronger actor string.

## Activation and rollback

Normal progression:

DISABLED → SHADOW → LEVEL 1 ACTIVE → LEVEL 2 ACTIVE → LEVEL 3 CANARY →
LEVEL 3 ACTIVE → LEVEL 4 CANARY → LEVEL 4 ACTIVE.

Skipping a stage requires both an explicit reference and independent admin
authorization. Downward rollback is unrestricted within existing maximums.
Runtime safety can strictly decrease effective level (4→3→2→1→disabled),
or enter SAFE_MODE at the same/lower level. It cannot modify configured bounds,
canary, kill latch or suspension. DEGRADED conservatively blocks new dispatch.
Health recovery has no upward transition. Restoration always needs explicit
administration and dispatch must revalidate all present upstream authority.

Policy scope/source/time/version and release are exact. A policy edit cannot
reset consumed canary volume. There is deliberately no automatic canary reset;
future fresh campaigns need an explicitly versioned migration/administration
design rather than silently forgetting already admitted work.

## Additional action gate

The caller names only a bounded action reference on a server-bound scope.
A fresh server resolver loads its immutable R9 action, mission, task, schedule,
parameters fingerprint, governance decision, provider/account and release.
It must run the real current A/B/C/F consumption checks and frozen C/D/F
health checks; booleans are a trusted composition port, never accepted from
clients, queue jobs, model output or an H approval substitute.

Gate evaluation requires the current effective level/state and exact policy,
mission currency, task/schedule readiness, exact R9-F consumability, runtime,
provider, security and environment safety. Provider/mission suspension blocks.
Required monitoring/backup failures latch audited SAFE_MODE with effective
DISABLED. Security/runtime/provider failure does likewise. Recovering health
does not clear the latch. R9-F BLOCK is always BLOCK. REVIEW_REQUIRED needs
the real exact human approval; H cannot invent an approval or weaken risk.
L1 cannot dispatch; L2 additionally needs human approval even when F ALLOWs.
L3/L4 require level/capability/action bounds and exact current authority.

`gate` returns an additional permission check, never an execution receipt,
R9 approval, dispatch token or outcome. `actualExecution` is always false.
The R9-D service checks its server-composed H hook before dispatch reservation
and again immediately before adapter transport. The application dependency
factory binds `unconfiguredAutonomyGate`, which always denies until R10-X
supplies the durable control plane and exact C/D/F evidence composition.
Omission is permitted only for identity-certified, frozen, inert R9 sandbox
registries; an arbitrary registry without the hook fails closed. Historical
R9-X tests supply explicit sandbox authority via an isolated test mock.

An admitted check can never replace provider-side current authority. R10-X
must bind H at D's provider boundary as well as C's R9 dispatch entry and
coordinate independent stop status; no stale grant may be queued or replayed.
Transport already in flight cannot be undone. Preserve uncertainty and ask
R9-E/F for reconciliation rather than replaying or erasing attempt evidence.

## Shadow and canary

SHADOW evaluates server evidence and returns `shadow:true`, `allowed:false`,
`actualExecution:false`, `reason:SHADOW_ONLY`. It has no callback or provider
transport. It never writes a success outcome or external execution fact.
Mission formation, action and recovery previews remain advisory under their
existing authorities; H does not create them.

CANARY requires L3/L4, exact tenant/business/capability/action class, bound
provider, policy/release, a validity window, deterministic percentage and
an absolute volume ceiling. The SQL repository serializes per scope using
FOR UPDATE; unique action reservations deduplicate repeated gate checks.
Reservations are conservative admitted volume, not proof of actual execution.
No agent can reset or expand them. Administrators alone may change the bounds.

## Safe mode, suspension and kill switch

SAFE_MODE permits observation, safe reads, evidence preservation and governed
reconciliation through existing R9 authorities, but no new execution or retry.
Neither H nor safe mode edits mission, task, approval or execution history.
Local suspension kinds: MISSION, CAPABILITY, PROVIDER, EXECUTION, WORKER,
SCHEDULER. They are exact-scope stop latches with reference labels, conservatively
blocking every action in the configured tuple. Apply to each affected tuple
for broader suspension. Worker drain and scheduler pause are C/X handoffs,
not infrastructure administration. External mission/provider suspension from
the resolver is also mandatory. Resume removes no historical fact and creates
no dispatch authorization: new execution still revalidates A/B/C/F/C/D safety.

Kill switch has both an audited H local latch and mandatory independent
`emergencyStopped` reader. Administration controls the independent mechanism
outside runtime/model authority. Missing/unavailable reader throws or returns
stopped. Read at gate entry and after asynchronous evidence loading. The agent
cannot disable, override, delete, change, or conceal it; observation includes
the combined stopped state. R10-A/X owns the rapid out-of-process mechanism,
incident administration and deployment/process wiring. No physical kill claim
is made by this repository-only implementation.

## Persistence, audit and concurrency

Provisional `0038_r10_h_autonomy_activation.sql` is an artifact only; no journal
entry, migration execution or sibling merge. R10-X owns convergence.
MySQL repository uses parameterized static statements, exact unique scope,
row locking, expected-version CAS and atomic state + audit commit. Failure to
persist audit rolls back the authority change. Canary reservations share the
lock. Observation uses SELECT only and never initializes a scope.
SQL pool and repository are not agent handles. Production DB permissions must
deny audit UPDATE/DELETE; the repository exposes no such methods. Real MySQL
concurrency/permission drills remain a later R10-X infrastructure binding gate.

Each authority change appends previous/new effective level and state, exact
scope, closed reason, authority source, human/system/runtime actor type,
policy version, timestamp, correlation ID and full state fingerprint. No free
model text, raw action parameters, credentials or chain-of-thought persists.
No runtime method can alter activation audit. Audit/observability never grants
authority. See the separate observability handoff contract.
