# LEAD NURTURE / SALES HANDOFF CONTRACT (WBS-R6-D)

> **Stream:** WBS-R6 Stream D — Nurture / Sales Handoff Autonomy
> **Module authority:** `api/lib/nurture/`, `api/nurture-router.ts`
> **Schema:** `nurture_handoff_decisions`, `sales_handoffs`,
> `handoff_dispatch_receipts`, `nurture_touch_records` (provisional migration
> `0034_nurture_sales_handoff_autonomy` — artefacts only, **not executed**;
> see `docs/recovery/r6-d-unexecuted-migrations.md`; R6-X owns canonical
> sequencing)
> **Upstream (frozen, consumed not merged):** R6-A identity
> (`ded8f2876e7c`), R6-B scoring (`259dc88`), R6-C qualification
> (`580700a9416b`), R6-E conversion (`d31270d`), R6-F governance
> (`c4932c6`); R5 integrated base `a947ecb`
> **Audience:** R6-X integration, R6-F operations projection, operators
> **Status:** authoritative as of the R6-D acceptance harness

This contract defines the single canonical nurture and sales-handoff
authority. R6-D owns **nurture eligibility, nurture state, nurture
sequencing authority, governed sales-handoff preparation, exact-once
sales-handoff identity, handoff lifecycle, safe CRM/provider integration
seams, policy/approval binding, and downstream sales-handoff evidence.**

It does **not** own lead identity (A), scoring (B), qualification (C),
conversion authority (E), final CRM implementation, sales-pipeline
management, attribution, or business optimization.

**Required principle:** qualification is required but is not sufficient for
outreach. No nurture action and no sales handoff may execute unless
server-side governed R6-D code — acting on a current, tenant-owned
`QUALIFIED` qualification, an actionable privacy state, an allowed and
current policy, satisfied approval where required, and a truthful provider
capability — explicitly authorizes it. Privacy/suppression/policy always
override progression.

---

## 1. Authority identity

`NURTURE_HANDOFF_CONTRACT_VERSION = "lead-nurture-sales-handoff/v1"`.
All identities are deterministic, server-minted, tenant-anchored, and
derived without wall-clock or randomness:

```
decisionKey  = sha256(canonicalJson({ v: 1, userId, businessId, leadId,
              qualificationId, qualificationFingerprint, privacyState,
              privacyStateUpdatedAt, conversionStopped, handoffExists,
              policyVersion, channel, cadenceBlocked }))
nurtureDecisionId = "nd1:" + decisionKey

handoffKey   = sha256(canonicalJson({ v: 1, userId, businessId, leadId,
              qualificationId, handoffPolicyVersion }))
handoffId    = "sh1:" + handoffKey

executionIdentity = "hd1:" + sha256(canonicalJson({ v: 1, handoffId, attemptSeq }))
touchIdentity     = "nt1:" + sha256(canonicalJson({ v: 1, userId, leadId,
              nurtureDecisionId, touchSeq }))
```

`qualificationFingerprint` =
`sha256(canonicalJson(qualificationHandoffProjection))` — D binds the exact
projection content it consumed. Identity prefixes (`nd1:`/`sh1:`/`hd1:`/
`nt1:`) make every id self-describing in logs and receipts. The DB enforces
uniqueness of each identity; duplicate/concurrent delivery converges to one
durable row (`idempotent_replay`); replay of the same identity with different
material fails closed (`NURTURE_REPLAY_CONFLICT` / `HANDOFF_REPLAY_CONFLICT`).

## 2. Qualification dependency

D consumes qualification **exclusively** through the frozen C handoff
projection (`docs/contracts/lead-qualification-to-nurture-handoff-contract.md`
§15), re-validated on every call:

- The projection must carry exactly the frozen key set, closed vocabularies,
  and a known `engineVersion`/`qualificationPolicyVersion`; any structural
  drift, unknown decision value, or unknown contract version fails closed
  (`NURTURE_UPSTREAM_CONTRACT_MISMATCH`) — D never guesses.
- `mayProgress: true` is necessary, never sufficient: D re-derives
  progression from the projection content (fresh `validUntil`, decision
  `QUALIFIED`, privacy actionable) at decision time.
- A missing/cross-tenant `qualificationId` ⇒ `QUALIFICATION_NOT_FOUND`.
  D never mints, repairs, re-derives, or mutates qualification records.

## 3. Identity dependency

`leadId` is the R6-A canonical identity (`lid1:…`), opaque and immutable.
Before any decision or execution D revalidates via the A port that the
identity exists, belongs to the authenticated tenant, and that the
qualification's `businessId` matches the identity's business scope
(`OWNERSHIP_MISMATCH` otherwise). Forged lead ids and cross-business lead
references are rejected. D never creates identities, never merges, and never
re-resolves identity chains (C already resolved `merged` chains at
evaluation time).

## 4. Privacy / governance dependency

The F privacy gate is normative and consulted **at decision time and again
at execution time** (durable re-read, never a cached projection copy):

`SUPPRESSED · RESTRICTED · RETENTION_EXPIRED · ARCHIVED` ⇒ not actionable ⇒
decision `BLOCKED` with the matching reason code. `ACTIVE` (implicit
default) and `RETENTION_PENDING` (until deadline) are actionable. When the
F bridge is unavailable (pre-migration environment), nurture/handoff
progression fails closed (`PRIVACY_STATE_UNAVAILABLE`) — privacy truth is
never guessed. Privacy blockers surface in F-compatible operations evidence
(blocker class family `NURTURE_POLICY_BLOCKED` / `PRIVACY_SUPPRESSED` /
`RETENTION_EXPIRED`).

## 5. Decision vocabulary (closed)

`NURTURE · SALES_HANDOFF · WAIT · REVIEW_REQUIRED · BLOCKED · NO_ACTION`.

| Decision | Meaning |
|---|---|
| `NURTURE` | Lead is eligible for governed nurture on the evaluated channel; cadence and capability bounds apply at execution. |
| `SALES_HANDOFF` | Lead is eligible for governed sales handoff; approval binding per policy. |
| `WAIT` | Not progressible now — more evidence (qualification `INSUFFICIENT_EVIDENCE`) or cadence window (`NURTURE_CADENCE_LIMITED`). Never automatic outreach. |
| `REVIEW_REQUIRED` | Qualification is `REVIEW_REQUIRED`; only a new deterministic `QUALIFIED` may progress (review resolution is historical evidence). |
| `BLOCKED` | Hard stop: privacy, stale qualification, forged/tampered upstream, capability fail-closed, conflicting replay, policy denial. |
| `NO_ACTION` | Nothing to do: `NOT_QUALIFIED`, or an authoritative conversion already stopped progression (`CONVERSION_STOP`). |

Unknown values can never occur (closed storage); any client-supplied value is
rejected by schema validation.

## 6. Nurture eligibility

Deterministic; all must hold (no agent may override):

1. Current (latest), unexpired `QUALIFIED` qualification for this lead.
2. Privacy actionable (§4) at decision time and at touch time.
3. No authoritative conversion stop (§13) where policy requires stopping.
4. Channel in the policy allow-list and provider capability not fail-closed
   (§10).
5. Cadence within policy bounds (§7): `minIntervalHours` since last touch on
   the channel and `maxTouchesPerWindow` per `windowDays`.
6. Approval satisfied where policy requires it (§9).

Ineligible sets never nurture: suppressed / restricted / retention-expired /
archived leads; `NOT_QUALIFIED`; `REVIEW_REQUIRED`; `BLOCKED` qualification;
stale qualification; stale or unavailable privacy state; converted leads
where policy stops nurture.

## 7. Nurture sequence identity

Nurture sequencing is **versioned, deterministic, and bounded**:

- One touch ⇒ one `touchIdentity` (`nt1:…`, unique with `(userId,
  touchIdentity)`); duplicate/concurrent touches converge; conflicting replay
  fails closed (`NURTURE_REPLAY_CONFLICT`).
- Touch sequence numbers are derived from durable touch records
  (`touchSeq = count + 1`); there is no uncontrolled loop and no
  model-controlled cadence.
- Frequency is policy-controlled only
  (`nurtureCadence: { minIntervalHours, maxTouchesPerWindow, windowDays }`);
  over-cadence evaluation yields `WAIT` (`NURTURE_CADENCE_LIMITED`), never a
  silent send.
- Safe stop conditions: privacy change, conversion (§13), policy change
  (`STALE_POLICY_VERSION` at execution), handoff completion, explicit
  `CANCELLED`.
- Touch content is draft model output validated by §-D4 boundary before any
  execution; a touch executes only through the §11 execution seam.

## 8. Handoff identity

Exact-once, deterministic (§1): the same business + lead + qualification +
handoff policy version ⇒ the same `handoffId`, forever. One handoff row per
identity; retries and concurrent preparations converge (`idempotent_replay`);
a raced insert re-reads. Conflicting replay of the same identity with
different material fails closed (`HANDOFF_REPLAY_CONFLICT`).

**Handoff lifecycle (closed):**

```
PREPARED → APPROVAL_REQUIRED → APPROVED → DISPATCH_PENDING → DISPATCHED
   ⇄ FAILED (reconcile/retry)        → ACKNOWLEDGED | BLOCKED | CANCELLED
```

- `PREPARED` — durable row created by a `SALES_HANDOFF` decision.
- `APPROVAL_REQUIRED` — policy requires human approval; durable approval
  request bound (§9).
- `APPROVED` — human approval resolved through the governed approval
  surface; binding revalidated at dispatch.
- `DISPATCH_PENDING` — executable; awaiting transport claim (CAS).
- `DISPATCHED` — transport accepted the execution (receipt recorded).
- `ACKNOWLEDGED` — **set only from transport/bridge evidence**, never by a
  client. No client-supplied success exists anywhere.
- `FAILED` — transport failed; reconciliation may retry safely (§12).
- `BLOCKED` — governance stop (privacy/policy/capability) after preparation.
- `CANCELLED` — terminal operator/user cancellation of a pending handoff.

No fabricated CRM success: without truthful transport evidence the row stays
`DISPATCHED`/`FAILED`, never `ACKNOWLEDGED`.

## 9. Approval semantics

- Reuses the governed approval infrastructure
  (`approval_requests`, approval router human surface) with one additive
  `approvalType = "sales_handoff"`. The D binding (JSON `context`) pins:
  `handoffId`, `nurtureDecisionId`, `businessId`, `leadId`,
  `qualificationId`, `qualificationFingerprint`, `handoffPolicyVersion`,
  `contentSnapshotHash`, `expiresAt`.
- Approval authorizes **exactly** the bound handoff identity under the bound
  policy version and content snapshot. Rejected at dispatch/authorization
  time: cross-lead replay, cross-business replay, cross-handoff replay,
  stale/expired binding (`EXPIRED_DECISION`), policy change
  (`STALE_POLICY_VERSION`), edited/missing binding
  (`APPROVAL_BINDING_MISMATCH`), forged approval rows.
- Human rejection permanently blocks the handoff identity
  (`ACTION_REJECTED_BY_HUMAN`); the only path forward is a new governed
  decision cycle (new qualification ⇒ new identity).
- **Self-approval prohibition:** the nurture service never resolves approval
  rows; resolution flows only through the human approval surface, and an
  actor cannot approve a proposal it created (existing approval flow
  invariant; D adds no bypass and no service-side resolution procedure).
- Stale approval (binding expired) is never executable.

## 10. Provider capability semantics

Truthful, closed capability states: `SUPPORTED · UNSUPPORTED ·
REQUIRES_CONFIGURATION · REQUIRES_APPROVAL · BLOCKED`.

- Capability is **delegated truth**, never duplicated: engagement actions
  defer to the R5-X integrated matrix (`provider-capability-matrix/v1`);
  CRM-handoff/email/SMS transports that have **no repository implementation
  are honestly `UNSUPPORTED`/`REQUIRES_CONFIGURATION`** — never simulated.
- `UNSUPPORTED` or `BLOCKED` at execution ⇒ fail closed
  (`CAPABILITY_UNSUPPORTED`); the durable row reflects the honest state.
- The only `SUPPORTED` execution path shipped by R6-D is the
  **fake/test-only** in-memory transport (`createFakeNurtureTransport`,
  `api/lib/nurture/nurture-transport.ts`),
  explicitly named, documented, and used solely by tests. It performs no
  network I/O and contacts no real lead.
- `REQUIRES_APPROVAL` capability composes with §9: execution only after the
  approval gate passes.

## 11. Execution identity

Every external-effect attempt carries a stable, replay-safe
`executionIdentity` (`hd1:…` for handoffs, `nt1:…` for touches):

- The transport receives the identity as its idempotency key; a replayed
  attempt converges to the same durable receipt and never duplicates the
  external effect.
- Before any dispatch, all of the following are validated in order:
  tenant/business ownership (durable re-read), lead identity, current
  unexpired `QUALIFIED` qualification, privacy actionable, policy current,
  approval satisfied where required, capability truthful, idempotency
  identity claimable (CAS).
- Dispatch is claim-based (CAS status transition); a lost claim returns the
  current durable state instead of double-executing.
- Results are append-only receipts (`handoff_dispatch_receipts`) with
  bounded result labels; receipts are execution evidence, never mutated.

## 12. Retry / reconciliation

- Reconciliation re-runs the full §11 gate set against **current** durable
  authorities; a handoff retries only from `FAILED` (or a timed-out
  `DISPATCH_PENDING` claim) via CAS; privacy/policy/approval drift blocks
  (`BLOCKED`) rather than retrying.
- Each retry is a new `attemptSeq` (new `executionIdentity`); the transport
  idempotency key prevents duplicate external effects even when a previous
  attempt's outcome is uncertain (crash window): reconcile first reads the
  durable receipt; an accepted receipt is returned as `converged`, never
  re-dispatched.
- No in-memory dedupe anywhere; convergence is DB-authoritative.

## 13. Conversion stop conditions

D consumes R6-E conversion authority **read-only** through a narrow port:
an authoritative conversion for the lead/business is a `conversion_events`
row with `sourceTrustClass ∈ {VERIFIED_INTERNAL, VERIFIED_PROVIDER,
VERIFIED_CRM, VERIFIED_PAYMENT, USER_REPORTED}` and `outcomeStatus` not in
`{REVERSED, REFUNDED, CANCELLED}` (unverified/pending evidence never stops
progression).

Where `policy.stopOnAuthoritativeConversion` (default **true**):

- nurture evaluates to `NO_ACTION` (`CONVERSION_STOP`);
- sales-handoff preparation is suppressed (`handoffExists` pinning prevents
  duplicate handoff after conversion);
- conversion provenance (ids only) is preserved on the decision record.

D never mutates conversion authority, never records conversions, and never
claims attribution (E §2 causation disclaimer applies verbatim).

## 14. Audit semantics

- Every material effect — decision recorded, handoff lifecycle transition,
  dispatch attempt, nurture touch, reconciliation — writes **exactly one**
  canonical audit event (`audit_events`, fingerprint-unique) of a closed
  additive type: `lead_nurture_decision`, `sales_handoff_state_changed`,
  `sales_handoff_dispatch`, `lead_nurture_touch`.
- Metadata is ids/hashes/closed labels/counts only: `businessId`, `leadId`,
  `nurtureDecisionId`/`handoffId`/`executionIdentity`/`touchIdentity`,
  `qualificationId`, privacy state + version source, `policyVersion`,
  actor (`ctx.user.id`), result, timestamps. **No PII, no message text, no
  tokens, no payloads, no model reasoning.**
- No-op convergence paths write **zero** audit events; replay of an accepted
  effect returns the durable row without re-emitting.

## 15. Immutable fields

`nurture_handoff_decisions` rows are **fully immutable** after acceptance
(there is no update/delete path; corrections are new decisions).
`sales_handoffs` mutates only through the closed lifecycle with CAS `version`
guards; identity fields (`handoffId`, `userId`, `businessId`, `leadId`,
`qualificationId`, `handoffPolicyVersion`) are immutable.
`handoff_dispatch_receipts` and `nurture_touch_records` are append-only.
Audit events are immutable ledger entries.

## 16. Downstream consumable fields

R6-F (and later R6-X surfaces) consume one read projection per lead:

```
LeadNurtureHandoffView {
  leadId, businessId,
  latestDecision: { nurtureDecisionId, decision, reasonCodes,
                    channel, policyVersion, occurredAt, validUntil } | null,
  nurtureStatus: "eligible" | "waiting" | "blocked" | "stopped"
               | "unavailable",
  salesHandoffStatus: HandoffLifecycleState | "none" | "unavailable",
  blockedReason: string | null
}
```

Unavailable is honest (D tables absent pre-migration), never guessed. The
F-compatible blocker mapping: privacy blockers → `PRIVACY_SUPPRESSED` /
`RETENTION_EXPIRED`; policy/cadence → `NURTURE_POLICY_BLOCKED`; failed
dispatch → `SALES_HANDOFF_FAILED`.

## 17. Forbidden mutations

D must never: mint or alter lead identity; recompute or alter scores; alter,
resolve, or re-derive qualification decisions or reviews; mutate privacy
state; mutate conversion authority or claim attribution; create CRM rows or
CRM ownership; mark a handoff successful/acknowledged from client input;
bypass or fabricate approval; select provider credentials; execute real
provider/CRM calls from model output; store raw PII/message text; or weaken
any upstream suppression. There is no generic force-state endpoint, and no
procedure accepts lifecycle state, success flags, risk, decision, approval,
or billing identity from clients.

## 18. Schema dependencies

D-owned (provisional `0034_nurture_sales_handoff_autonomy` — artefact only,
**NOT executed**; A/B/C/E/F each created their own provisional `0034_*`;
R6-X owns canonical convergence; see
`docs/recovery/r6-d-unexecuted-migrations.md`):

- `nurture_handoff_decisions` — immutable decisions (unique
  `nurtureDecisionId`; unique `(userId, decisionKey)`).
- `sales_handoffs` — exact-once handoffs (unique `handoffId`; unique
  `(userId, handoffKey)`; CAS `version`).
- `handoff_dispatch_receipts` — append-only attempts (unique
  `executionIdentity`).
- `nurture_touch_records` — append-only touches (unique `(userId,
  touchIdentity)`).
- `approval_requests.approvalType` gains one additive value
  `sales_handoff` (R5-E `marketing_action` precedent).
- `AUDIT_EVENT_TYPES` gains `lead_nurture_decision`,
  `sales_handoff_state_changed`, `sales_handoff_dispatch`,
  `lead_nurture_touch` (code-level additive).
- No FK coupling to upstream R6 tables (repo convention: enforcement in
  query predicates). Runtime entry points are information-schema guarded;
  absent tables ⇒ honest `unavailable` reads and fail-closed writes.

## 19. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Upstream authorities | `api/lib/qualification/*`, `api/lib/lead-identity/*`, `api/lib/conversion/*` (branch refs) | read-only ports; never written |
| Privacy gate | `api/lib/governance/lead-privacy-store.ts` (F) | F-owned — read-only port |
| CRM lifecycle | `api/lead-router.ts`, `leads`, `lead_activities` | **untouched** |
| Approval surface | `api/approval-router.ts`, `approval_requests` | reuse; one additive enum value; no flow bypass |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive values only |
| Router registry | `api/router.ts` | one additive `nurture` registration |
| Provider truth | `api/lib/engagement/provider-capability-matrix.ts` | delegate — no parallel matrix |
| Schema / migrations | `db/schema.ts` (append-only), `db/migrations/` | provisional 0034 artefact only; no renumbering |
| F operations projection | `api/lib/governance/lead-operations-*.ts` (F) | F-owned; D exposes §16 view only |

## 20. Security invariants

1. Server-side authorization on every surface; tenant anchor from
   `ctx.user.id` only; business/lead ownership re-derived from durable rows
   on every reference; forged/cross-tenant ids ⇒ not-found/fail-closed.
2. No client-supplied authority: inputs are ids and bounded options only;
   decisions, approvals, success states, risk, and identities are
   server-derived.
3. Exact-once convergence is DB-authoritative (unique anchors + CAS); replay
   converges; conflicting replay fails closed; no destructive paths.
4. Privacy always overrides progression; the privacy gate is re-read at
   decision **and** execution time.
5. Immutable decision history; bounded vocabularies everywhere; fail closed
   on unknown values, absent records, stale versions, unavailable bridges.
6. Projections carry ids/hashes/closed labels/timestamps — no PII, social
   text, raw evidence, or model reasoning.
7. Approval binds exact identity + policy version + content snapshot;
   rejection is permanent; no replay across leads/businesses/handoffs.
8. External effects are claim-based, idempotency-keyed, receipt-backed;
   unsupported capability fails closed; the fake transport is test-only.
9. Secrets/PII never enter decision records, receipts, audit metadata, logs,
   or client responses.
10. Nurture cadence is policy-bounded; no infinite contact loop exists by
    construction (sequence numbers derive from durable rows).

## 21. Rogue-agent invariants

1. **Authority separation:** agents/models may propose draft content only;
   only governed server-side R6-D code authorizes nurture or handoff. No
   model may set `ACKNOWLEDGED`, contact a lead, create CRM ownership, bypass
   approval, or alter qualification/privacy/identity.
2. **Prompt-injection isolation:** lead/social/retrieved content and model
   output are untrusted data. Upstream projections pass strict structural
   validators before use; generated drafts pass schema + injection scanning;
   embedded instructions to contact, escalate, exfiltrate, or bypass are
   inert text. No untrusted text is concatenated into authority paths.
3. **Tool least privilege:** no runtime model/agent receives shell/SQL/admin/
   CRM/provider credentials; transports are server-selected and
   capability-gated; no dynamic tool execution from generated text.
4. **Cross-agent trust:** A/C/E/F payloads are revalidated against frozen
   contracts on every call; unknown versions, structural drift, or stale
   states are rejected, never guessed; "internal" agent claims carry no
   authority.
5. **Self-approval prohibition:** an agent cannot approve its own nurture
   action or sales handoff, fabricate human approval, or fabricate provider/
   CRM success.
6. **Blast-radius bound:** compromise of any single agent, model, or prompt
   grants zero nurture/handoff authority — every privileged effect still
   requires the full §11 gate set, and the durable ledger records exactly
   what occurred.

---

**R6-X / R6-F: consume nurture and sales-handoff state exclusively through
this contract. When in doubt, do not progress.**
