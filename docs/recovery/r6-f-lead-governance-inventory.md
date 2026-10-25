# WBS-R6 STREAM F (F0) — LEAD GOVERNANCE / OPERATIONS INVENTORY

> **Stream:** R6-F Lead Governance / Operations
> **Branch:** `feature/r6-f-lead-governance`
> **Common base:** `a947ecba99696403679091f9ff64d0a577faf3da` (R5 `MARKETING_OPERATIONS_V1_READY`)
> **Date:** 2026-06-28
> **Status:** F0 inventory — input to F1–F9

This document inventories every existing capability relevant to R6 lead
governance/operations, records what R6-F reuses, and identifies gaps, overlap
risks, privacy risks and schema implications. It is the F0 deliverable required
by the stream charter.

---

## 1. R6 programme position at inventory time

| Branch | Tip vs base `a947ecb` | State |
|---|---|---|
| `feature/r6-a-lead-identity` | 0 | label on base; no artefacts |
| `feature/r6-b-lead-scoring` | 0 | label on base; no artefacts |
| `feature/r6-c-lead-qualification` | 0 | label on base; no artefacts |
| `feature/r6-d-nurture-sales-handoff` | 0 | label on base; no artefacts |
| `feature/r6-e-conversion-tracking` | 0 | label on base; no artefacts |
| `integration/r6-lead-autonomy` | 0 | placeholder cut at the R5 acceptance commit |

None of the R6 A–E streams has produced artefacts yet; their expected
contracts (`lead-identity-to-scoring-qualification-contract.md`,
`lead-scoring-to-qualification-contract.md`,
`conversion-to-attribution-contract.md`) do not exist on any branch ref.
The only R6 programme document available is the R5-D → R6 entry contract
`docs/contracts/opportunity-to-lead-autonomy-contract.md` (present on base),
which binds R6 to: derive its own lead identity/score/qualification; never
mutate R5 rows; treat opportunity confidence as evidence class, not sales
permission; minimise PII (hash-only actor identity).

**Implication for F:** the projection must derive from (a) the existing CRM
authorities on the common base (`leads`, `lead_activities`, `businesses`) and
(b) F-owned privacy/suppression state. Every A/B/C/D/E-sourced area
(identity, scoring, qualification, nurture, sales handoff, conversion) is
surfaced honestly as `supported: false` / `unavailable` until that stream
integrates at R6-X. F must not invent their state and must not create a
second lifecycle state machine.

## 2. Reusable R4/R5 governance authority (verified on base)

### 2.1 Middleware / authority

`api/middleware.ts` — unchanged by F:

- `publicQuery`, `authedQuery` (requireAuth: `ctx.user` **and**
  `ctx.session.verified`), `adminQuery` (authed + `role === "admin"`).
- Exactly one privileged role; no operator role, no impersonation. The R6-F
  operator surface = verified admin session, same as R5-F.

### 2.2 Audit authority (consume, do not rebuild)

- `api/lib/audit/audit-event.ts` — `createAuditEvent` (pure, caller-stamped,
  deep-frozen), `sanitizeAuditMetadata` (key-level secret redaction),
  `buildAuditEventFingerprint` (SHA-256, key-sorted).
- `api/lib/audit/audit-store.ts` — `persistAuditEvent`: fingerprint-unique
  `audit_events` ledger; exact replay = `idempotent_replay`; same fingerprint,
  different content = `AUDIT_FINGERPRINT_CONFLICT` (fail closed); optional
  caller-owned executor so mutation + audit commit as one unit.
- `api/lib/governance/admin-audit.ts` — `recordAdminMutationAudit`: closed
  vocabularies `ADMIN_AUDIT_ACTIONS` (21 actions) / `ADMIN_AUDIT_TARGET_TYPES`
  (13 types); fails closed on invalid actor/action/target; tx-executor aware.

### 2.3 Projection pattern (direct predecessor)

`api/lib/governance/r5-operations-projection.ts` (R5-F1):

- `projectR5BusinessOperations({ businessId, now?, executor? })` — actor-agnostic,
  deterministic (explicit clock), read-only; derives from durable tables only;
  **no second mutable lifecycle state machine**.
- Strict layering: `collectR5BusinessEvidence` (allow-listed IO) →
  `deriveR5Blockers` (pure) → `deriveR5OperationalState` (pure, clock).
- Honesty invariants: authority absent → `unavailable`, never guessed;
  security/ownership blockers only from explicit fail-closed evidence, never
  inferred from absence.
- Guarded information-schema bridge (`r5-stream-evidence.ts`): raw-SQL DTO
  reads of stream tables with `tableExists` guard; absent tables degrade to
  `{ available: false, reason: "stream_tables_absent", ...zeroed }` — never an
  error, never guessed. This is the pattern F mirrors for its own new table
  and for future A–E evidence tables.
- Cross-business visibility is the caller's decision; the lib never receives
  client ownership.

### 2.4 Recovery surfaces already governed (precedent)

| Surface | Authority | Idempotency |
|---|---|---|
| Terminal replay D1–D3 (`admin.requestTerminalReplay` / `executeTerminalReplay` / `reconcileTerminalReplays`) | `api/lib/queue/terminal-replay*.ts` | `replayKey` unique + active-claim mutex |
| Stale creative claim sweep (`admin.sweepStaleCreativeClaims`) | `api/lib/creative/creative-stale-claim-sweep.ts` | conditional UPDATE; re-run = no-op |
| Opportunity expiry sweep (`opportunity.sweepExpiry`, admin) | R5-D deterministic sweep | CAS; re-run converges |
| R5-F `operations.retryOperation` | delegates to D1 terminal replay + next-cycle retry/dispatch | kill-switch gated; server-derived binding; staleness assertion; convergence short-circuits write zero audit |
| R5-F readiness (`health.getR5OperationsReadiness`) | per-area `safeR5ReadinessArea` isolation | read-only rollup |

All privileged mutations record exactly one canonical `admin_mutation` audit
event; no-op/convergence paths write zero events.

### 2.5 Health / readiness surface

`api/health-router.ts`:

- `getSystemHealth` (public): db/redis/worker/scheduler checks.
- `getR5OperationsReadiness` (admin): per-component
  `ready|degraded|blocked|unsupported|unavailable|attention|unknown`
  vocabulary, counters, top-blocked businesses (≤10), per-area failure
  isolation — the direct template for F4.

### 2.6 Tenancy idiom

Every user-scoped query chains
`and(eq(resource.id, …), eq(resource.userId, ctx.user.id))`. Operator
surfaces re-derive ownership from durable rows, never client input. F keeps
the same discipline; the operator router is admin-scoped by design and user
surfaces remain owner-scoped.

## 3. Durable authorities the R6-F projection can read today

| Area | Tables (columns that matter) |
|---|---|
| Lead / CRM | `leads` (`id`, `userId`, `businessId`, `campaignId`, `status` enum `new|contacted|qualified|proposal|negotiation|won|lost`, `score` default 0, `lastContact`, `nextFollowUp`, `createdAt`, `updatedAt`); **PII columns never projected:** `name`, `email`, `phone`, `company`, `jobTitle`, `notes`, `customFields` |
| Lead activity | `lead_activities` (`leadId`, `type` enum `note|call|email|meeting|task|status_change`, `createdAt`) — timestamps only; `description` never projected |
| Business / tenant | `businesses` (`id`, `userId`, `name`) |
| Opportunity handoff (upstream context) | `opportunity_handoffs`, `opportunity_candidates`, `opportunity_suppressions` (R5-D-owned; F reads nothing here at F1 — handoff consumption is A's job; listed for X awareness) |
| Policy / approval | `approval_requests` (governance waits surface via counters if needed) |
| Ledger | `audit_events` (fingerprint-unique) |

**Privacy/suppression/retention today:** nothing at lead level. The only
prior art is R5-D opportunity suppression (`opportunity_suppressions` with a
closed reason enum + user-scoped indexes) and privacy-safe logging idioms in
creative. Lead-level suppression, retention and restriction are greenfield —
this is the single schema addition F makes (§7).

## 4. R6-F gaps (what F must add)

1. **No lead-operations projection.** Need one read-only, lead-scoped (plus
   business rollup) operational read model folding identity / scoring /
   qualification / nurture / handoff / conversion / privacy into one view,
   honestly reporting unsupported areas.
2. **No lead blocker/recovery taxonomy.** Need lead-specific closed blocker
   classes with normative recovery classifications
   (AUTO_RECOVER / OPERATOR_ACTION / GOVERNANCE_APPROVAL / FAIL_CLOSED).
3. **No lead privacy/retention/suppression state.** Need durable
   ACTIVE / SUPPRESSED / RESTRICTED / RETENTION_PENDING / RETENTION_EXPIRED /
   ARCHIVED operational states, governance-mutated, CAS-convergent, audited.
4. **No R6 readiness surface.** Need `health.getR6LeadGovernanceReadiness`
   mirroring the R5 readiness vocabulary.
5. **No operator read endpoints** answering the ten F5 questions.
6. **No governed recovery adapter** over real authority. The only real,
   F-owned deterministic reconciliation available today is the retention
   sweep (RETENTION_PENDING → RETENTION_EXPIRED). Stream recoveries (score
   recompute, qualification retry, handoff transport, conversion
   reconciliation) have no backing authority until B/C/D/E land — they are
   contract-level activation slots for R6-X, not endpoints now.
7. **No acceptance harness** wiring fixture states → projection →
   classification → operator read → governed recovery → audit → updated
   projection.

## 5. Overlap-risk files (coordinate before changing)

| File | Risk |
|---|---|
| `api/health-router.ts` | F adds one admin R6 readiness procedure (additive) |
| `api/router.ts` | F registers one `leadGovernance` router (additive) |
| `api/lib/governance/admin-audit.ts` | F extends closed vocabularies additively |
| `api/lead-router.ts` | **unchanged by F** — CRM lifecycle stays sole owner of `leads.status` transitions |
| `api/lib/governance/r5-*.ts` | consumed unchanged |
| `db/schema.ts` | F adds exactly one table (`lead_privacy_states`); nothing else |
| `api/middleware.ts`, `api/context.ts` | sufficient as-is; F does not modify |
| Future A/B/C/D/E evidence tables | F reads via guarded bridge only; never imports their schemas |

## 6. Privacy risks and controls (pre-build)

- **PII in projections:** `leads` carries name/email/phone/company/notes.
  Control: explicit column allow-list — projections expose ids, statuses,
  scores, timestamps, counts only. Verified by secret/PII scan tests (F9.20).
- **PII in audit metadata:** control = `recordAdminMutationAudit` + canonical
  sanitizer; metadata built from whitelisted fields (ids, states, counts).
- **Restricted evidence leakage:** RESTRICTED leads appear on operator
  surfaces with the same minimized field set; no activity descriptions, no
  contact fields, ever.
- **Suppression enforcement:** suppressed/restricted/expired leads expose
  `nurtureAllowed: false` with privacy reason through the projection gate;
  C/D streams must consult the gate before nurture/contact (contract §6/§13).
- **Cross-business inspection:** operator reads are admin-scoped; user
  surfaces unchanged; forged businessId/leadId pairs rejected by re-derived
  ownership (F9.12).
- **Provider/payment data:** never touched by F; no tokens, credentials or
  payment fields enter the lead-operations path.

## 7. Schema implications

**One minimal addition is required:** `lead_privacy_states` (F-owned,
lead-keyed current privacy state + provenance + retention deadline). Without
it, suppression/retention operational state has no durable home and F would
have to fake it. Migration artefact continues the accepted R5 chain at
`0034_lead_privacy_governance` — **created, journal/snapshot parity verified,
NOT executed** (see `docs/recovery/r6-f-unexecuted-migrations.md`). Runtime
code reads/writes it through the guarded information-schema bridge: absent ⇒
privacy area `unavailable` and all governance mutations fail closed with an
honest migration-pending error. No other schema change; no FK coupling to
future R6 tables (repo convention: enforcement in query predicates).

## 8. Expected A/B/C/D/E states consumed (forward contract)

| Stream | States F will consume (read-only, via guarded bridge) | Today |
|---|---|---|
| R6-A identity | `identityStatus` (`resolved|conflicting|unresolved|...`), `identityConfidence` | `supported:false` |
| R6-B scoring | `latestScore`, `scoreStatus` (`current|stale|...`) | legacy `leads.score` column visible but scoring area `supported:false` |
| R6-C qualification | `qualificationStatus` | `supported:false` (CRM `leads.status` remains the durable pipeline record, consumed read-only) |
| R6-D nurture / handoff | `nurtureStatus`, `salesHandoffStatus` | `supported:false`; privacy gate still reports `nurtureAllowed` |
| R6-E conversion | `conversionStatus` | `supported:false` |

Physical deletion semantics are **out of scope** for F: ARCHIVED is the
terminal operational state; actual erasure is documented for later controlled
implementation (contract §7).

## 9. Test approach (matches repo idiom)

- Pure derivation: unit tests over evidence fixtures (no DB), mirroring
  `r5-operations-projection.test.ts`.
- Router/service tests: `vi.mock("./queries/connection")` +
  `createFakeDb(seed)` from `api/r5-test-support.ts` (extended additively
  with transaction support for mutation+audit atomicity); real audit store
  runs against the fake; logger mocked.
- F9 acceptance: one deterministic harness covering the 26 charter checks
  end-to-end at the tRPC caller boundary, including seeded PII canaries to
  prove no leakage.
