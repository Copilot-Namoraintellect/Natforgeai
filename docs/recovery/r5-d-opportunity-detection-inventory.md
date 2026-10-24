# R5-D OPPORTUNITY DETECTION — D0 REPOSITORY INVENTORY

> **Stream:** WBS-R5 Stream D — Opportunity Detection
> **Branch:** `feature/r5-d-opportunity-detection` @ `e4493a8` (R4 `FULL_AUTONOMY_V1_READY` programme base `integration/r5-marketing-operations`)
> **Date:** 2026-10-24
> **Method:** base-branch inventory only. R5-A/B/E/F code was inspected read-only
> from frozen branch refs (`c9a930e`, `b939328`, `c936caa`, `5800626`) through
> their published contracts; nothing was merged.

---

## 0. Headline findings

1. **There is no existing "opportunity" module anywhere on the base.** A
   case-insensitive grep for `opportunit` over `api/`, `db/`, `src/` finds only
   two LLM prompt strings (`api/lib/agents/creative-agent.ts:1366`,
   `api/lib/agents/engagement-agent.ts:118`). Opportunity detection is greenfield.
2. **The nearest existing neighbour is the audience-intelligence pipeline**
   `social_engagement_events` → `campaign_interest_signals` → `lead_scores` →
   `outreach_recommendations` → optional `leads` auto-create
   (`api/lib/agents/audience-intelligence-agent.ts:551-591`). That pipeline
   already crosses the line R5-D must not cross (it creates `leads` rows and
   assigns numeric scores). R5-D parallels it; it does not replace or mutate it.
3. **Naming collision warning:** `docs/contracts/distribution-to-postlive-contract.md`
   and `learning-to-next-cycle-contract.md` on the base use "Stream D" to mean
   the **R4 post-live stream** (engagement/observation/KPI/learning). All R5-D
   artefacts must use the disambiguating prefix **"R5-D"** and refer to this
   stream as "R5-D (opportunity detection)".
4. **No shared canonical-JSON/sha256 helper exists** — every module owns a local
   copy (`audit-store.ts:82`, `business-dna-store.ts:78`,
   `credit-reservation.ts:206-212`, `publish-package-contract.ts:197-210`).
   R5-D follows the same local-copy convention (frozen helper registries stay
   untouched).
5. **Migration collision is real and three-way:** R5-A provisional
   `0029_social_listening_foundation`, R5-B provisional `0029_add_social_interpretations`,
   R5-E provisional `0029_sad_donald_blake` all sit at journal idx 29 on separate
   branches. R5-D therefore uses **provisional `0030_opportunity_detection_foundation`**
   (never renumbering upstream artefacts) and records the convergence requirement
   for R5-X. See §15.

---

## 1. Inventory by dimension

### 1.1 Leads / CRM (MUST NOT be repurposed as opportunity authority)

- **Table `leads`** — `db/schema.ts:387-419`: `id`, `userId`, `businessId`,
  `campaignId`, `name` (notNull), `email`, `phone`, `company`, `jobTitle`,
  `source` (free-text), `status` enum `new|contacted|qualified|proposal|
  negotiation|won|lost`, `score` int 0-100, `notes`, `lastContact`,
  `nextFollowUp`, `customFields` json. **No external-identifier column**; the
  audience agent stashes `customFields.externalIdentifier`
  (`api/lib/agents/audience-intelligence-agent.ts:448-449,562-567`).
- **Table `lead_activities`** — `db/schema.ts:424-438`: typed activity log.
- **`api/lead-router.ts`**: `create/update/delete/activities/autoScore/
  bulkAutoScore`, all `authedQuery`. Scoring is a hardcoded source map + field
  bonuses, capped at 100, and **auto-promotes pipeline status** (`:205-277`).
- **"Successful result" coupling** — `lead.update` → status `won` with non-null
  `campaignId` → `checkLimit` + `incrementResultUsage`
  (`api/lead-router.ts:124-141`, `api/lib/subscription.ts:141-167`).
  R5-D MUST NOT touch this counter or these transitions.
- **Risk:** `leads`/`lead_scores` are exactly what R5-D must not create. Any
  schema or vocabulary drift toward lead semantics (score 0-100, pipeline
  statuses, "qualified") is out of scope. R5-D statuses stay pre-lead.

### 1.2 Interest signals (existing aggregation precedent)

- **Table `campaign_interest_signals`** — `db/schema.ts:968-1006`: per
  `(campaignId, externalIdentifier)` actor row; `signalType` enum
  `engagement|follow|message|click`; `strength` 0-100; `sourceEventIds` json;
  **unique `cis_campaign_actor_uidx`** added by migration
  `0028_add_campaign_interest_signal_actor_unique.sql` (current journal max, idx 28).
- **Writer:** `aggregateInterestSignals()` — `api/lib/audience/ingest.ts:288-371`;
  upsert keyed `` `${platform}:${externalProfileId}:${actorExternalId||"anonymous"}` ``.
- **Relevance to R5-D:** this is the established in-repo pattern for
  actor-scoped, campaign-attributed aggregation with DB-unique convergence.
  R5-D mirrors its *shape* (natural-key unique + upsert-strengthen) but keys on
  R5-B interpretation identity, not on audience ingest events.
- **Risk:** read-only for R5-D. The `(campaignId, externalIdentifier)` unique
  key must not acquire a second writer.

### 1.3 Engagement (existing inbound pipeline — R5-C territory today)

- **`api/lib/engagement/inbound.ts`** (806 lines): Meta-HMAC-verified webhook
  pipeline, `engagement_webhook_events` unique `(provider, externalEventId)`,
  lease-claim processing, `conversation_threads`/`conversation_messages`.
- **Legacy sentiment enum** — `conversation_messages.sentiment`
  (`positive|neutral|negative|urgent`, `db/schema.ts:1107-1131`): deliberately
  NOT aligned with R5-B's coarse vocabulary (B contract §16 known residual).
  R5-D consumes B's vocabulary only; never this legacy column.
- **R5-C convergence note:** R5-C's durable engagement receipt does not exist on
  any branch available at implementation time (its branch ref equals the base).
  R5-D therefore consumes engagement evidence through a narrow structural
  adapter seam only (see D7 in the candidate contract).

### 1.4 Post-live observations (identity role model)

- **`buildObservationId`** — `api/lib/workflow/post-live-metrics-observation-pass.ts:173-188`:
  `obs:` + sha256 of canonical `{campaignId, date, externalPostId, metricType,
  platform}`. Deterministic, no wall-clock, DB-unique upsert. **This is the
  closest existing precedent for R5-D's deterministic opportunity identity.**
- Publication receipts: `publication_success` audit events via
  `api/lib/publish/publication-receipt.ts`; read-only attribution inputs.

### 1.5 Audience intelligence (highest overlap)

- `api/lib/audience/`: `ingest.ts`, `scoring.ts` (pure keyword scoring),
  `access.ts` (tier gate). Tables `lead_scores` (`db/schema.ts:1011-1049`,
  enum `confidence low|medium|high`, `recommendedAction reach_out|nurture|ignore`)
  and `outreach_recommendations` (`:1054-1084`).
- `persistAudienceIntelligence` optionally **auto-creates `leads` rows** for
  reach_out/score≥70 — the exact behaviour R5-D must avoid duplicating.

### 1.6 Business DNA / strategy (context grounding)

- `api/lib/business-dna.ts`: canonical `BusinessDNASnapshot` with
  `evidenceHashSha256`; `business_dna_snapshots` table
  (`db/schema.ts:208-232`, immutable-by-convention). R5-B already consumes this
  for relevance; R5-D consumes only B's *output* labels, not DNA internals.

### 1.7 Attribution / lineage

- No `sourceCampaignId` column exists on base tables; lineage is nullable
  `campaignId`/`businessId`/`userId` triples, **no FK constraints**
  (`db/schema.ts:691-693` convention). R5-A/B introduce `sourceCampaignId`/
  `sourcePublicationId`/`sourcePublicationReceiptId` on `social_signals`;
  R5-D mirrors those names in its evidence seam (contract-consumed, not merged).

### 1.8 Provider actor identifiers

- `social_integrations` (`db/schema.ts:843-871`): platform enum (7), `pageId`,
  encrypted tokens, `status connected|expired|disconnected`.
- `social_profiles` (`db/schema.ts:876-914`): unique `(userId, platform, externalId)`.
- Actor triple on `social_engagement_events`: `actorHandle`,
  `actorDisplayName`, `actorExternalId` + `externalProfileId`.
- R5-A's canonical actor fields (`actorReference`, `actorDisplayName`) exist
  only on the A branch. R5-D stores a **keyed hash** of the actor reference,
  never raw actor PII, in its own tables (privacy minimization, §14).

### 1.9 Intent / sentiment / opportunity fields

- No intent column anywhere on base. The only sentiment column is the legacy
  `conversation_messages.sentiment` (§1.3). No opportunity fields, no
  opportunity metric in `analytics`.

### 1.10 Audit (shared ledger — additive only)

- `api/lib/audit/audit-event.ts`: closed `AUDIT_EVENT_TYPES` (13 values,
  `:34-50`); pure `createAuditEvent` (no clock); `sanitizeAuditMetadata` with
  `SENSITIVE_METADATA_KEY` stripper; fingerprint = sha256 of canonical envelope.
- `api/lib/audit/audit-store.ts`: `persistAuditEvent` — select-by-fingerprint,
  replay-safe, `AUDIT_FINGERPRINT_CONFLICT` fail-closed; optional caller
  executor seam.
- R5-D adds `opportunity_detected`, `opportunity_suppressed`,
  `opportunity_state_changed`, `opportunity_handed_off` to the taxonomy
  (additive pattern identical to R4-F `admin_mutation`, R5-E `policy_decision`).

### 1.11 Idempotency patterns (mirrored)

- Canonical JSON + sha256 local copies (§0.4); deterministic identity payloads
  excluding wall-clock (`credit-reservation.ts:239-263`);
  natural-key unique indexes with select→insert→duplicate-race re-read
  (`audit-store.ts:188-227`); CAS/lease claims (`inbound.ts`);
  state machines with mutually exclusive terminals (`credit_reservations`).

### 1.12 Billing (untouched)

- `runAgent` (`api/lib/agents/runner.ts`) with closed `AgentType` union (7
  values) and `ai_usage` enum (10 values). R5-D detection is **fully
  deterministic (rule-first) and non-billable**: no `runAgent` call, no
  reservation, no `ai_usage` row, no `AgentType` extension, no
  `financial-reliability-contract.md` registry change. If a future model-based
  classifier is added it must go through the existing governed runner with a
  registered billing identity — that is an R5-X decision, out of scope here.

### 1.13 Router / middleware

- `api/router.ts`: 24 sub-routers; R5-D adds `opportunity` (hottest merge file —
  append-only, one line).
- `api/middleware.ts`: `authedQuery` (session-verified), `adminQuery`. R5-D
  user surfaces are `authedQuery`; no new middleware.

### 1.14 Schema / migration conventions

- `mysqlTable` + `serial` PK + `bigint unsigned mode:number` refs + `mysqlEnum`
  closed vocab + `varchar` explicit lengths + `json` payloads + `timestamp
  defaultNow()` + `updatedAt.$onUpdate`; short-prefix index names
  (`cis_`, `ls_`, `or_` …) suffixed `_idx`/`_uidx`; type exports immediately
  after each table; section banners.
- `drizzle.config.ts`: schema `./db/schema.ts`, out `./db/migrations`, mysql.
- Journal max idx = **28** (`0028_add_campaign_interest_signal_actor_unique`).
  Gaps exist (no `0008`; two `0012_*` files). **Provisional R5-D migration:
  `0030_opportunity_detection_foundation`** — skipping 0029 entirely because
  A/B/E already collided there; R5-X renumbers canonically at integration.

### 1.15 Governance module on base

- `api/lib/governance/` contains only `lifecycle-projection.ts` (R4-F) and
  `admin-audit.ts` (R4-F). **No `r5-operations-projection` exists on base.**
  F's contract (§11) states the R5-D area reports `{supported:false}` "until
  those streams land" — so R5-D creating its own tables is expected; F will
  bridge to them at R5-X convergence.

---

## 2. Reusable R4/R5 evidence (consumed via contract, not merged)

| Evidence | Owner | How R5-D consumes it |
|---|---|---|
| Canonical interpretation record (intent, sentiment, urgency, relevance, confidence, topics, riskFlags, opportunityIndicators, recommendedHandling, evidenceReferences) | R5-B (`social-intelligence-contract.md`, `intelligence-to-engagement-opportunity-contract.md` @ `b939328`) | Sole evaluation input, via strict structural seam `api/lib/opportunity/canonical-intelligence.ts`. Vocabulary preserved verbatim (§18/§3 of B's handoff contract). |
| Canonical signal identity (`signalKey`, `signalVersion`, provider/platform enums) | R5-A (@ `c9a930e`) | Consumed opaquely through B's record; never re-derived. |
| Publication receipts (`publication_success` audit events) | R4-C | Read-only lineage; R5-D records receipt references as evidence only. |
| Business ownership checks (`businesses.id + userId`) | R4 pattern | Replicated server-side: every candidate/effect binds to the durable owner; forged businessId fails closed. |
| Audit ledger (`audit_events` + `persistAuditEvent`) | WBS7/R4 | One additive canonical event per durable effect; fingerprint-deduped. |
| Policy decision vocabulary (`DENY`/`ESCALATE`/`ALLOW_AUTONOMOUS`/`REQUIRE_APPROVAL`/`NO_ACTION`) | R5-E (@ `c936caa`) | Read-only classification boundary (D6): a DENY/ESCALATE engagement decision is never treated as outreach permission; R5-D itself never initiates governed actions. |
| Ops governance health taxonomy | R5-F (@ `5800626`) | R5-D adds no ops state; F bridges at R5-X. |

## 3. What must NOT be repurposed prematurely as a lead

- `leads` rows, `lead_activities`, `lead_scores`, `outreach_recommendations`
  (audience auto-create path) — R5-D writes **none** of these; acceptance case
  28 asserts zero rows created.
- `campaign_interest_signals` — audience-owned aggregation; R5-D does not
  write it and does not treat it as opportunity authority (different actor-key
  semantics, no intent vocabulary).
- `conversation_messages` / engagement threads — R5-C/R4 engagement territory;
  read-only shapes only.
- The word "qualified"/pipeline statuses/0-100 scores — R5-D vocabulary stays
  pre-lead (`candidate/strengthening/weak/suppressed/expired/escalated/
  handed_off_to_r6` + bounded `LOW/MEDIUM/HIGH/UNKNOWN` evidence strength).

## 4. Schema needs (provisional, minimal)

Four new tables (all in provisional `0030_opportunity_detection_foundation`,
artefacts only — **not executed**):

1. **`opportunity_candidates`** — durable candidate: deterministic
   `opportunityKey` natural identity (sha256 over canonical thread coordinates,
   no wall-clock), `userId` (never null — tenant anchor), nullable `businessId`,
   `source*` first-evidence references, closed `opportunityType` /
   `opportunityStatus` / `confidenceClass` / `evidenceStrength` enums,
   `urgency`, `topicKey`, `actorKey` (hash only), `firstObservedAt`,
   `lastObservedAt`, `evidenceCount`, `detectorRulesVersion`, CAS `version`,
   `handedOffAt`, timestamps. Unique `(userId, opportunityKey)`.
2. **`opportunity_evidence`** — immutable append-only evidence rows:
   `(candidateId, interpretationId)` unique (one interpretation contributes to
   at most one candidate), nullable `engagementReceiptId`, kind enum,
   contribution metadata, content hash. No update path.
3. **`opportunity_suppressions`** — durable suppression decisions keyed unique
   by `interpretationId` (replay-safe): reason code (closed), risk/policy
   linkage, timestamps. Spam/irrelevant/risk-gated evaluations land here, not
   in candidates.
4. **`opportunity_handoffs`** — durable R6 handoff envelope: unique
   `opportunityId` (exactly-once), `handoffId` = `oph:` + sha256 canonical
   envelope, envelope JSON (candidate snapshot + bounded evidence references +
   contract version), timestamps.

No enum edits to existing tables. No FK constraints (convention). No
`agentRuns`/`aiUsage` changes (non-billable).

## 5. Overlap-risk files

| File | Streams | R5-D handling |
|---|---|---|
| `api/router.ts` | every R5 stream | one additive `opportunity` registration |
| `db/schema.ts` | every R5 stream | append-only new tables after existing sections |
| `db/migrations/meta/_journal.json` + `meta/0030_snapshot.json` | every R5 stream | provisional idx 30; collision documented for R5-X (A/B/E at 0029) |
| `api/lib/audit/audit-event.ts` | R4-F done; R5-E adds `policy_decision` | additive closed-taxonomy values `opportunity_*` |
| `docs/contracts/financial-reliability-contract.md` | R5-E owner | **untouched** (non-billable stream) |
| `api/lib/audience/*`, `api/lib/engagement/*` | R5-C, A triggers | read-only shapes; no writes |
| `api/agent-router.ts` | R5-A/E | untouched |
| `api/boot.ts` | A adds webhook route; schedulers | optional default-off expiry scheduler seam only |
| `api/lib/governance/*` | R5-F | untouched; F bridges at R5-X |

## 6. Privacy / security risks identified

1. **Actor PII minimization** — store only `sha256(provider|platform|
   actorReference)` (`actorKey`), never the raw actor reference, in R5-D tables;
   display-level actor data stays in A-owned tables.
2. **Cross-tenant correlation** — `userId` is part of every natural key and
   every query predicate; thread identity binds tenant coordinates, so the same
   external actor under two tenants can never converge (adversarial case 13).
3. **Unattributed (null-business) signals** — candidates may carry
   `businessId: null` (mirrors B §3); never fabricate business linkage; all
   ownership re-derived server-side from `businesses.id + userId`.
4. **Prompt injection** — detection is rule-first over B's *labels* only; raw
   social text never enters R5-D processing (B's §7 sanitization stands
   upstream). Injection content can at most produce B labels; it cannot mint
   unsupported opportunity types (closed enums, fail-closed schema).
5. **No model in the loop** — no hidden reasoning persisted, no model output
   to validate, no billing path; `confidenceClass` is deterministic, never
   client- or model-set.
6. **Suppression durability** — spam/policy rejections are recorded in
   `opportunity_suppressions` (not silently dropped), keyed by interpretationId
   so replays converge and floods are bounded per interpretation.

## 7. R6 handoff requirements (input to the handoff contract)

- Stable server-minted `opportunityId` + `handoffId`; exactly-once durable
  envelope; immutable evidence references; bounded fields R6 may consume vs
  must derive (identity, lead score, qualification, CRM record) vs must not
  mutate; explicit statement that R5 opportunity confidence is **not** a sales
  qualification decision; expiry/suppression semantics R6 must honor.

---

**Inventory verdict:** greenfield module with strong in-repo precedents
(`buildObservationId` identity shape, `campaign_interest_signals` aggregation
shape, `audit-store` replay/fail-closed shape). All upstream vocabulary is
contract-frozen and mirrored structurally — no merges required. Proceed to D1.
