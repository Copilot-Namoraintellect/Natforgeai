# R6-D NURTURE / SALES HANDOFF — D0 INVENTORY

> **Stream:** WBS-R6 Stream D — Nurture / Sales Handoff Autonomy
> **Branch:** `feature/r6-d-nurture-sales-handoff`
> **Base:** `a947ecb` (R5 `MARKETING_OPERATIONS_V1_READY`)
> **Date:** 2026-06-28
> **Rule:** upstream A/B/C/E/F consumed as frozen branch refs only — **not merged**.

---

## 1. Frozen upstream contracts consumed (branch refs)

| Authority | Ref | Contract doc | What D consumes |
|---|---|---|---|
| R6-A identity | `ded8f2876e7c` | `docs/contracts/lead-identity-contract.md` | Canonical `leadId` (`lid1:…`), tenant/business ownership, identity status (read-only revalidation) |
| R6-B scoring | `259dc88` | `docs/contracts/lead-scoring-to-qualification-contract.md` | Nothing directly — scores reach D only inside the C qualification projection (`scoreReference`) |
| R6-C qualification | `580700a9416b` | `docs/contracts/lead-qualification-contract.md`, `docs/contracts/lead-qualification-to-nurture-handoff-contract.md` | The D-consumable projection (§15): `qualificationId`, `decision`, `reasonCodes`, `validUntil`, `privacy{state,actionable}`, `mayProgress`, `progressBlockedReason` |
| R6-E conversion | `d31270d` | `docs/contracts/conversion-event-contract.md` | Read-only stop-condition evidence: authoritative (non-reversed, non-pending) conversions linked to the lead/business |
| R6-F governance | `c4932c6` | `docs/contracts/lead-governance-operations-contract.md` | `leadPrivacyGateFor` semantics (SUPPRESSED/RESTRICTED/RETENTION_EXPIRED/ARCHIVED ⇒ not actionable); durable privacy state re-read at decision time |

### 1.1 C→D projection (the only qualification surface D may use)

`qualification.getHandoffProjection({ qualificationId })` / server-side
`buildHandoffProjection` — frozen key set: `qualificationId, businessId,
leadId, decision, reasonCodes, scoreReference, evidenceSnapshotReference,
qualificationPolicyVersion, engineVersion, evaluatedAt, validUntil, review,
privacy, mayProgress, progressBlockedReason`.

Closed decisions: `QUALIFIED · NOT_QUALIFIED · REVIEW_REQUIRED ·
INSUFFICIENT_EVIDENCE · BLOCKED`. Only a fresh, current, privacy-actionable
`QUALIFIED` projects `mayProgress: true`. Unknown/malformed ⇒ fail closed.

### 1.2 F privacy gate (normative for nurture/contact)

`SUPPRESSED`, `RESTRICTED`, `RETENTION_EXPIRED`, `ARCHIVED` ⇒ not actionable
(`nurtureAllowed: false`). `ACTIVE` (implicit default, no row) and
`RETENTION_PENDING` (until deadline) are actionable. D re-reads the durable
state at every decision; the privacy blocker must surface in F-compatible
operations evidence (`NURTURE_POLICY_BLOCKED` blocker class family).

### 1.3 E conversion stop conditions

`conversion_events` rows with `sourceTrustClass ∈ VERIFIED_*` (or
`USER_REPORTED`) and `outcomeStatus` not in a terminal reversal
(`REVERSED/REFUNDED/CANCELLED`) are authoritative outcome evidence. D reads
via a narrow port; never mutates; never claims attribution.

---

## 2. Reusable R5 infrastructure (integrated base)

| Capability | Location | Reuse decision |
|---|---|---|
| Governed approval ledger | `db/schema.ts` `approval_requests` (+ `api/approval-router.ts` human approve/reject surface) | **Reuse.** D adds one additive enum value `sales_handoff`; binding stored in JSON `context` (same discipline as R5-E `marketing_action`) |
| Approval binding pattern | `api/lib/policy/marketing-action-approval.ts` (`buildMarketingActionApprovalCommand`, `assertMarketingActionExecutable`, `validateMarketingActionApprovalAuthorizable`) | **Mirror for D** (`nurture-approval.ts`): deterministic idempotency key, exact decision+policy+context binding, expiry, permanent rejection |
| Policy kernel vocabularies | `api/lib/policy/policy-types.ts` | Reuse `RiskTier`, reason-code style; D owns its own closed decision vocabulary |
| Provider capability truth | `api/lib/engagement/provider-boundary.ts`, `provider-capability-matrix.ts` (R5-X "one truthful view") | **Delegate, never duplicate.** D's capability gate composes the R5 engagement matrix where (action, platform) overlaps; for CRM-handoff/email channels with no repository transport, capability is honestly `UNSUPPORTED`/`REQUIRES_CONFIGURATION` — never simulated |
| Transport seam pattern | `api/lib/engagement/provider-boundary.ts` (`resolveEngagementCapability` → descriptor or fail-closed) | D ships a `HandoffTransport` seam interface + one explicitly fake/test-only in-memory transport; no real CRM/provider calls |
| Audit ledger | `api/lib/audit/audit-event.ts` (`AUDIT_EVENT_TYPES`, `createAuditEvent`, fingerprint-unique `audit_events`) | **Extend additively** with `lead_nurture_*` / `sales_handoff_*` material types; metadata = ids/hashes/closed labels only |
| Admin audit | `api/lib/governance/admin-audit.ts` (`recordAdminMutationAudit`) | F-owned; D does not write admin audit. D's own durable receipts + canonical audit events are its evidence |
| DB store discipline | `api/lib/opportunity/opportunity-store.ts`, `api/lib/policy/policy-decision-store.ts` | Follow: executor seam (`select/insert/update`), insert-first exact-once unique anchors, CAS `version`, `ER_DUP_ENTRY` convergence, hash-verified immutable rows |
| Router scaffolding | `api/middleware.ts` (`authedQuery`), `api/router.ts` | One additive `nurture` router registration |
| In-memory drizzle fakes | `api/r5-test-support.ts`, `api/lib/policy/policy-stores.test.ts` compact fake | D tests use their own compact fakes; every call passes an explicit executor (no real DB) |
| Rate limiting | `api/middleware.ts` rate-limited procedure builders | `nurture.evaluate` is a cheap read-heavy mutation → use plain `authedQuery`; no AI call inside the router hot path |

### 2.1 Message generation infrastructure (D4 boundary only)

- `api/lib/agents/sales-agent.ts` (`generateFollowUpSequence`) — model-drafted
  follow-up messages behind zod schemas; draft-only.
- `api/lib/engagement/response-generation.ts` — R5-C draft generation +
  injection-scanning discipline.
- `api/lib/email.ts` (`sendEmail`) — **real outbound email; D never calls it.**
  Nurture execution in R6-D goes only through the governed D transport seam;
  the real seam wiring is an R6-X activation slot.

---

## 3. Privacy blockers (must override everything)

| Blocker | Source | D behavior |
|---|---|---|
| `SUPPRESSED` | F `lead_privacy_states` | Decision `BLOCKED`, reason `PRIVACY_SUPPRESSED`; no nurture, no handoff |
| `RESTRICTED` | F | Decision `BLOCKED`, reason `PRIVACY_RESTRICTED` |
| `RETENTION_EXPIRED` | F (swept from `RETENTION_PENDING`) | Decision `BLOCKED`, reason `RETENTION_EXPIRED` |
| `ARCHIVED` | F | Decision `BLOCKED`, reason `PRIVACY_ARCHIVED` |
| Stale privacy vs projection | C projection embeds privacy at evaluation time | D re-reads F at decision time; drift → current F state wins (fail closed) |
| F bridge unavailable (table absent pre-migration) | information-schema guard | Nurture/handoff progression **fails closed** (`PRIVACY_STATE_UNAVAILABLE`); D's own tables are equally guarded |

## 4. Approval authority

- Human approval surface = existing `approval` router (approve/reject by an
  authenticated human of the same tenant). D creates `sales_handoff` approval
  rows bound to the exact handoff identity + qualification + policy version +
  content snapshot hash; `validateHandoffApprovalAuthorizable` runs inside the
  approval decision transaction (same injection point R5-E uses in
  `approval-router.ts`).
- **No self-approval:** the nurture service runs under the tenant user's
  authority to *propose*; approval rows are resolved only by the human
  approve/reject surface; an actor cannot resolve an approval it created
  (enforced by the existing approval router flow — D adds no bypass).
- Approval replay protection: deterministic idempotency key per handoff;
  cross-lead/cross-business/cross-handoff binding mismatch ⇒
  `APPROVAL_BINDING_MISMATCH`; expiry ⇒ `EXPIRED_DECISION`; rejection is
  permanent for the handoff identity.

## 5. CRM / provider gaps (honest capability states)

| Seam | Reality at base | D capability answer |
|---|---|---|
| CRM handoff dispatch (create CRM ownership / notify sales) | **No repository CRM transport exists.** `api/lead-router.ts` is the CRM owner; nothing dispatches handoffs to an external CRM | `UNSUPPORTED` (default) — handoff can be prepared/approved but dispatch fails closed; reconciliation retry safe |
| Email nurture send | `sendEmail` exists (real SMTP) but is **not wired** to D and must not be autonomously invoked by a model path | `REQUIRES_CONFIGURATION` / `REQUIRES_APPROVAL` per policy; not executed in D |
| WhatsApp / SMS | No transport in repo | `UNSUPPORTED` |
| Engagement channels (public reply etc.) | R5-C matrix truth (Meta public reply only) | Delegate to R5 matrix when D action maps to an engagement action |

Truthful capability states shipped (closed): `SUPPORTED`,
`UNSUPPORTED`, `REQUIRES_CONFIGURATION`, `REQUIRES_APPROVAL`, `BLOCKED`.
The only `SUPPORTED` execution path in D is the **fake/test-only** in-memory
transport used by the acceptance harness — explicitly named and documented.

## 6. Exact overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Qualification authority | `api/lib/qualification/*` (C branch) | C-owned — D never writes; consumes projection via port |
| Identity authority | `api/lib/lead-identity/*` (A branch) | A-owned — read-only port |
| Privacy gate | `api/lib/governance/lead-privacy-store.ts` (F branch) | F-owned — read-only port |
| Conversion authority | `api/lib/conversion/*` (E branch) | E-owned — read-only port |
| CRM lifecycle | `api/lead-router.ts`, `leads`, `lead_activities` | **untouched** — D never creates CRM rows |
| Approval enum | `db/schema.ts` `approval_requests.approvalType` | one additive value `sales_handoff` (R5-E `marketing_action` precedent) |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive `lead_nurture_*` values only |
| Router registry | `api/router.ts` | one additive `nurture` registration |
| R5 opportunity rows | `api/lib/opportunity/*` | read-only |
| Provider capability truth | `api/lib/engagement/provider-capability-matrix.ts`, `provider-boundary.ts` | delegate — no parallel matrix |

## 7. Schema implications

D-owned tables (all provisional `0034_nurture_sales_handoff_autonomy`,
**artefact only, NOT executed**; R6-X owns canonical convergence — A/B/C/E/F
also created provisional `0034_*` artefacts; collision documented in
`docs/recovery/r6-d-unexecuted-migrations.md`):

1. `nurture_handoff_decisions` — immutable governed decision records
   (exact-once deterministic `nurtureDecisionId`, closed decision vocabulary,
   reason codes, policy/privacy/qualification versions).
2. `sales_handoffs` — exact-once handoff identity (`handoffId`), bounded
   lifecycle (`PREPARED · APPROVAL_REQUIRED · APPROVED · DISPATCH_PENDING ·
   DISPATCHED · ACKNOWLEDGED · FAILED · BLOCKED · CANCELLED`), CAS `version`.
3. `handoff_dispatch_receipts` — append-only execution attempts
   (execution identity, attempt seq, bounded result), retry/reconciliation
   evidence.
4. `nurture_touch_records` — append-only nurture touches (exact-once touch
   identity, channel, decision binding); cadence/frequency derived purely.

Plus: one additive `approvalType` enum value; additive audit event types.
Runtime guarded by information-schema checks (absent ⇒ fail closed), the
F/R5-F bridge discipline.

## 8. Security design commitments (from the mission framework)

1. **Authority separation** — D service code is the only authorizer; model
   output is draft-only; `HANDOFF_SUCCESS`/`CONTACTED` markers do not exist
   as client-settable fields anywhere.
2. **Prompt-injection isolation** — upstream projections validated by strict
   structural validators (closed keys/vocabularies); generated draft content
   passes injection scanning; no untrusted text enters prompts or authority
   paths.
3. **Tool least privilege** — no model receives DB/credentials; the D router
   accepts ids only; transports are server-selected.
4. **Cross-agent trust** — A/C/E/F payloads re-validated; unknown contract
   versions rejected (`*_CONTRACT_VERSION_UNSUPPORTED`); stale/malformed
   fails closed.
5. **Self-approval prohibition** — approval resolution only via the human
   approval surface; service never resolves its own proposals.
6. **External-effect safety** — seven pre-dispatch checks (tenant, identity,
   current QUALIFIED, privacy, policy, approval, capability, idempotency).
7. **Secret safety** — no tokens/PII in decision records, receipts, audit
   metadata, or client responses.
8. **Audit** — every material decision/handoff/dispatch writes exactly one
   canonical audit event (fingerprint-unique, idempotent).

---

**D0 verdict:** inventory complete; no upstream merge required; schema
impact = 4 D-owned tables + 1 additive enum value + additive audit types;
provider reality = seams only, fake transport test-only.
