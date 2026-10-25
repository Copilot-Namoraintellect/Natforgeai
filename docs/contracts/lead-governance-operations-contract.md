# LEAD GOVERNANCE / OPERATIONS CONTRACT — WBS-R6 Stream F

> **Status:** canonical lead-operations governance contract for R6 (supersedes none;
> extends `docs/contracts/marketing-operations-governance-contract.md` from R5-F)
> **Branch:** `feature/r6-f-lead-governance`
> **Common base:** `a947ecb` (R5 `MARKETING_OPERATIONS_V1_READY`)
> **Date:** 2026-06-28
> **Audience:** R6-X integration, R6-A/B/C/D/E stream owners, operators
> **Rule:** this contract is the single integration reference for R6 lead
> operational visibility, health classification, blocker taxonomy, privacy
> governance and governed recovery. Streams must not bypass it or duplicate
> its state.

---

## 1. Projection identity

The canonical R6 lead-operations read model is
`projectLeadOperations({ leadId, now?, executor? })`
(`api/lib/governance/lead-operations-projection.ts`).

- **One projection only.** No second lifecycle/state machine exists; the
  projection derives everything from durable authorities and owns **no**
  mutable operational state. The CRM pipeline (`leads.status`) remains owned
  exclusively by the CRM router — the projection only reads it.
- **Read-only.** It never writes, transitions, retries, acknowledges or
  "heals" what it observes.
- **Deterministic.** Explicit-clock pure derivation
  (`deriveLeadBlockers` / `deriveLeadOperationalState` are pure functions over
  normalized `LeadOperationsEvidence`).
- **Actor-agnostic.** The lib never receives client ownership. Visibility is
  the caller's decision (admin operator surface reads any lead; user surfaces
  remain owner-scoped and unchanged by F).
- **Secret/PII-free.** Only allow-listed non-PII columns are selected
  (§12).
- **Business rollup.** `summarizeLeadGovernance` (`lead-operations-summary.ts`)
  folds leads up to the owning `businesses` row for operator listings.

## 2. Lead operational states

`LEAD_OPERATIONAL_HEALTH` (closed vocabulary, mirrors R5):

| State | Meaning |
|---|---|
| `HEALTHY` | No open blockers; the lead is actionable within policy. |
| `DEGRADED` | No open blocker, but a recent failure trace exists (reserved; no failure source is wired before stream convergence). |
| `BLOCKED_OPERATOR` | Open blocker(s) requiring a human operator/approver (privacy suppression, retention disposition, future review queues). |
| `BLOCKED_CONFIGURATION` | Open blocker(s) requiring configuration/integration decisions (future scoring/capability classes). |
| `AUTO_RECOVERING` | Open blocker(s) are all AUTO_RECOVER class; bounded system retry is in progress. |
| `UNSUPPORTED` | No lead capability evidence (lead not found); never guessed. |
| `FAIL_CLOSED` | Security rejection, cross-tenant evidence, or unreadable authority. |

Precedence (worst wins): `FAIL_CLOSED` > `BLOCKED_OPERATOR` >
`BLOCKED_CONFIGURATION` > `AUTO_RECOVERING` > `DEGRADED` > `HEALTHY`.

Per-area stream states carry their own honesty semantics: areas without
landed stream authority report `supported: false` / `status: "unavailable"`
with `unavailableReason` — never an error, never guessed (§13).

## 3. Blocker taxonomy

`LEAD_BLOCKER_CLASSES` (closed, 16 —
`api/lib/governance/lead-blocker-taxonomy.ts`):

`IDENTITY_CONFLICT`, `IDENTITY_INSUFFICIENT_EVIDENCE`, `SCORE_STALE`,
`SCORE_UNAVAILABLE`, `QUALIFICATION_REQUIRES_REVIEW`, `QUALIFICATION_BLOCKED`,
`NURTURE_POLICY_BLOCKED`, `SALES_HANDOFF_FAILED`, `CRM_UNAVAILABLE`,
`CONVERSION_LINKAGE_UNRESOLVED`, `PRIVACY_SUPPRESSED`, `RETENTION_EXPIRED`,
`CROSS_TENANT_REJECTION`, `SECURITY_REJECTION`, `STALE_OPERATION`,
`UNSUPPORTED_CAPABILITY`.

Classification rules are normative and pure
(`LEAD_BLOCKER_CLASS_POLICY`). Security/tenant classes are produced only from
explicit fail-closed evidence — never inferred from absence of data
(same rule as R5-F). Today the only wired blocker sources are the F-owned
privacy gate; A–E classes activate when their streams register durable
evidence at R6-X.

## 4. Recovery classifications

`LEAD_RECOVERY_CLASSES` (closed, reuses R5):
`AUTO_RECOVER`, `OPERATOR_ACTION`, `FAIL_CLOSED`, `GOVERNANCE_APPROVAL`.

| Blocker classes | Recovery class |
|---|---|
| `IDENTITY_INSUFFICIENT_EVIDENCE`, `SCORE_STALE`, `SALES_HANDOFF_FAILED`, `CRM_UNAVAILABLE` | `AUTO_RECOVER` (system-retryable) |
| `IDENTITY_CONFLICT`, `SCORE_UNAVAILABLE`, `CONVERSION_LINKAGE_UNRESOLVED`, `RETENTION_EXPIRED`, `STALE_OPERATION`, `UNSUPPORTED_CAPABILITY` | `OPERATOR_ACTION` |
| `QUALIFICATION_REQUIRES_REVIEW`, `QUALIFICATION_BLOCKED`, `NURTURE_POLICY_BLOCKED`, `PRIVACY_SUPPRESSED` | `GOVERNANCE_APPROVAL` |
| `CROSS_TENANT_REJECTION`, `SECURITY_REJECTION` | `FAIL_CLOSED` |

**Invariant:** automatic recovery is never declared for conditions embedding
a human decision (identity merge, qualification review, nurture policy,
suppression lifting, retention disposition, security).
`systemRetryAllowed === true` only for AUTO_RECOVER classes.

## 5. Privacy states

`LEAD_PRIVACY_STATES` (closed, F-owned, durable in `lead_privacy_states`):

| State | Meaning |
|---|---|
| `ACTIVE` | Default; no privacy overlay. Implicit when no durable row exists. |
| `SUPPRESSED` | Governance decision: no nurture/contact; not actionable. |
| `RESTRICTED` | Evidence handling restricted; minimized projection only; not actionable. |
| `RETENTION_PENDING` | Retention countdown scheduled (`retentionDeadlineAt`); still actionable until the deadline. |
| `RETENTION_EXPIRED` | Deadline passed; must not silently remain actionable; disposition required. |
| `ARCHIVED` | Terminal operational state; no outgoing transitions. |

**Privacy status can never be changed through untrusted client fields.** The
only client-supplied inputs are `targetState`, bounded `reason`, optional
staleness assertion and (for pending) `retentionDeadlineAt`; the current
state is always re-read server-side and guarded by CAS.

## 6. Suppression semantics

- A suppressed (or restricted) lead **cannot be nurtured or contacted**:
  `leadPrivacyGateFor(state)` is the single gate (`nurtureAllowed`,
  `contactAllowed`, `actionable`); nurture/contact streams MUST consult it
  before execution.
- Suppression lifting (`SUPPRESSED → ACTIVE`) is a governance decision
  (recovery class `GOVERNANCE_APPROVAL`) — never automatic, never silent.
- The suppression blocker (`PRIVACY_SUPPRESSED`) is visible on operator
  surfaces with recovery class and safe next action.
- Suppressed leads still expire through retention sweeps (privacy hygiene).

## 7. Retention semantics

- `RETENTION_PENDING` requires a future `retentionDeadlineAt`; the deadline
  is cleared when leaving the pending states.
- `RETENTION_EXPIRED` is reachable only from `RETENTION_PENDING` — via the
  deterministic sweep (`sweepLeadRetention`, CAS-guarded, idempotent) or an
  explicit governance transition. No `ACTIVE → RETENTION_EXPIRED` shortcut.
- Retention-expired leads cannot be nurtured/contacted and carry the
  `RETENTION_EXPIRED` blocker with `dispose_retention_expired` next action.
- **Physical deletion/erasure is out of scope for F.** `ARCHIVED` is the
  terminal operational state; actual erasure is reserved for later controlled
  implementation under its own governance decision (documented here, not
  faked).
- Identity/provenance history (`previousState`, `source`, `actorUserId`,
  `updatedAt`) remains on the durable row for audit.

## 8. Operator authorization

- The operator surface (`leadGovernance` router) is **admin-scoped**: every
  procedure requires an authenticated, OTP/2FA-verified admin session
  (`adminQuery`).
- No separate operator role; no impersonation; actor = `ctx.user.id`.
- Operator reads may cross businesses (operator visibility by design); user
  surfaces remain strictly owner-scoped and are unchanged by F.
- All mutations re-derive ownership from durable rows (`leads.userId` /
  `businesses.userId` via the lead row) — never from client input.
- Errors are bounded (no raw exception internals, no PII, no payloads).

## 9. Allowed recovery actions

Narrow, evidence-backed adapters that delegate to existing governed
authorities, adding binding validation, staleness rejection and audit:

| Action | Delegates to | Convergence |
|---|---|---|
| `leadGovernance.retryOperation` — `retention_sweep` | `sweepLeadRetention` (F-owned deterministic reconciliation) | row CAS (`RETENTION_PENDING` → `RETENTION_EXPIRED`); re-run = `converged: true` |
| `leadGovernance.setPrivacyState` | `transitionLeadPrivacyState` (F-owned CAS state machine) | CAS on current state; same-target replay = `already_applied` |

Stream recovery kinds (score recompute, qualification evaluation retry,
handoff transport retry, conversion reconciliation) are **activation slots
for R6-X**: each may be added only when its stream's governed authority
exists, with the same binding/staleness/idempotency/audit discipline. No
endpoint for them exists today.

Every action: server-authorized; kill-switch gated where batch
(`R6_LEAD_RECOVERY_ADMIN_ENABLED`); binds to the exact lead/business/
operation re-derived from durable rows; validates current state; rejects
stale requests (`expectedStatus` mismatch → `CONFLICT`); idempotent;
preserves source identities; audited exactly once per real mutation
(outcome-bearing); **mutation + audit are tx-atomic** — an audit failure
rolls the mutation back and fails closed.

## 10. Forbidden recovery actions

No endpoint — under any name — may provide: force merge, force score, force
qualify, force contact/nurture, force handoff success, force conversion,
arbitrary lifecycle-state setters, generic force-complete, suppression/
privacy override without governance transition, approval fabrication, or
client-supplied lifecycle state / recovery identity / billing identity.
The F9 acceptance suite asserts no such procedure exists on the
`leadGovernance` router and that the CRM lifecycle router is untouched.

## 11. Audit requirements

- Every privileged R6-F mutation records exactly one canonical
  `admin_mutation` event via `recordAdminMutationAudit`
  (`api/lib/governance/admin-audit.ts`) into the fingerprint-unique
  `audit_events` ledger.
- Closed-vocabulary extensions (F7): `ADMIN_AUDIT_ACTIONS` gains
  `admin.lead_privacy_state_changed`, `admin.lead_retention_sweep`;
  `ADMIN_AUDIT_TARGET_TYPES` gains `lead`, `lead_privacy_state`,
  `lead_operation`.
- Actor is always the authenticated admin id — never invented; audit fails
  closed on invalid actor/action/target.
- Mutation + audit commit as one transaction (caller-owned executor threaded
  into the audit store); audit failure rolls back the mutation.
- No-op/convergence paths write **zero** audit events.
- Never logged: raw email/phone/name, provider tokens, payment credentials,
  hidden reasoning, unrestricted social content, `lead_activities`
  descriptions. Metadata is allow-listed ids/states/counts only plus the
  canonical WBS7A key sanitizer.

## 12. Sensitive-data restrictions

- Never selected/projected/logged: `leads.{name,email,phone,company,jobTitle,notes,customFields}`,
  `lead_activities.description`, any token/secret/credential material,
  provider payloads, payment data.
- Projections expose: internal ids (`leadId`, `businessId`, `userId`,
  `campaignId`), CRM status, legacy score, timestamps, health/blocker
  classes, privacy state, counts.
- RESTRICTED leads appear on operator surfaces with this same minimized
  field set; restricted evidence never reaches general surfaces.
- Error responses carry bounded mapped messages only.
- The cross-agent security addendum applies: no model/agent output becomes
  execution authority; all state transitions flow through server-side
  governed code with closed vocabularies and zod-bounded inputs.

## 13. States consumed from A/B/C/D/E (read-only)

| Stream | Fields consumed | Today |
|---|---|---|
| R6-A identity | `identityStatus`, `identityConfidence` | `supported:false` |
| R6-B scoring | `latestScore`, `scoreStatus` | `supported:false`; legacy `leads.score` surfaced read-only as `legacyScore` |
| R6-C qualification | `qualificationStatus` | `supported:false`; CRM `leads.status` consumed read-only as `crmStatus` |
| R6-D nurture/handoff | `nurtureStatus`, `salesHandoffStatus` | `supported:false`; privacy gate still answers `nurture.allowed` |
| R6-E conversion | `conversionStatus`, `conversionLinked` | `supported:false` |

Future reads go through guarded information-schema bridges (absent ⇒
`unavailable`, never an error), per the R5-F precedent. R6 streams must not
re-derive or duplicate these states.

## 14. Fields F must not own or mutate

F must not own or write: lead identity (A), scores (B), qualification
decisions (C), nurture content/handoff execution (D), conversion authority
(E), CRM lifecycle state (`leads.status` via lead-router), opportunity/R5
rows, policy decisions, billing/wallet rows, approval decisions. F adds no
lifecycle state of its own beyond the privacy overlay (§5), which governs
processing rights, not pipeline position.

## 15. Schema dependencies

F adds exactly one table: `lead_privacy_states` (migration artefact
`0034_lead_privacy_governance` — **created, NOT executed**; see
`docs/recovery/r6-f-unexecuted-migrations.md`). Runtime code bridges it
behind a guarded information-schema check (absent ⇒ privacy `unavailable`,
mutations fail closed). No FK coupling to future R6 tables (repo convention:
enforcement in query predicates). R6-X owns canonical sequencing.

## 16. Overlap-risk files

| File | Note |
|---|---|
| `api/health-router.ts` | F adds one admin R6 readiness procedure |
| `api/router.ts` | F registers one `leadGovernance` router |
| `api/lib/governance/admin-audit.ts` | F extends closed vocabularies additively |
| `api/r5-test-support.ts` | F extends the shared fake additively (lps unique-leadId simulation) |
| `db/schema.ts` | F adds exactly one table; nothing else |
| `api/lead-router.ts` | **untouched** — sole CRM lifecycle owner |
| `api/lib/governance/r5-*.ts` | consumed unchanged |
| Future A–E evidence tables | F reads via guarded bridge only |

## 17. Security invariants

1. Fail closed by default; least privilege; verified-admin session only on
   operator surfaces.
2. No client-supplied lifecycle state, recovery identity, privacy state or
   billing identity.
3. Tenant isolation preserved: every mutation re-derives ownership from the
   durable lead/business row; forged businessId/leadId pairs are rejected.
4. Stale operator actions rejected (`CONFLICT`); replayed/duplicate actions
   converge safely; concurrent actions serialize on durable CAS guards.
5. Operator actions cannot bypass policy, billing, approval, tenant,
   privacy or CRM rules — they only invoke existing governed authorities.
6. Policy denials, terminal states (ARCHIVED) and suppression cannot be
   force-overridden; no procedure exists to do so (asserted by F9).
7. Every privileged mutation audited; audit failure rolls back the mutation
   (no unaudited successful mutation can persist).
8. Projections and audit metadata carry no secrets, tokens, raw PII or
   payloads (asserted by tests).
9. AUTO_RECOVER remains non-human: the system retries; operators are only
   shown that retry is in progress.
10. Cross-agent addendum: agents may propose; only server-side governed code
    authorizes. No agent output, retrieved content, or downstream
    instruction may mutate identity, policy, billing, qualification,
    conversion, lifecycle or privacy state. Compromise of any single agent
    grants no platform authority.

---

**R6-X: treat this contract as canonical. Operator visibility, blocker
classification, privacy enforcement and governed recovery flow through this
projection and the `leadGovernance` router only.**
