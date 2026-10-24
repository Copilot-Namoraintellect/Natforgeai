# WBS-R5 STREAM B — INTENT & SENTIMENT INTELLIGENCE: PRE-CODE INVENTORY

> **Status:** PRE-CODE INVENTORY (produced before any B1+ code)
> **Date:** 2026-10-24
> **Branch:** `feature/r5-b-intent-sentiment`
> **Base commit:** `e4493a8` (docs(recovery): WBS-R4 X8 FULL_AUTONOMY_V1 acceptance report — READY)
> **Scope:** repository/intelligence inventory of everything R5 Stream B must reuse, avoid, or coordinate with. Every file:line reference below was re-verified with Read/Grep against the tree at the base commit; line numbers that drifted from field notes were corrected in place.

**Working-tree event during preparation (verified):** while this inventory was being written, B1 contract work landed on the branch — commit `3259721` added `docs/contracts/social-intelligence-contract.md` (Status: ACCEPTED, Base `e4493a8`), and two uncommitted modules appeared under `api/lib/intelligence/`: `interpretation-contract.ts` (closed vocabularies incl. a 15-value intent taxonomy) and `canonical-signal.ts` (R5-A-facing adapter). Sections 3, 7, 8 and 10 reconcile the inventory with these artifacts. All R4 module references were verified against base `e4493a8`, where no Stream B code existed.

## 1. Scope of inventory

Stream B adds intent & sentiment intelligence over social signals. This inventory maps: (2) reusable R4 modules, (3) existing sentiment/classifier code that constitutes semantic-overlap risk, (4) provider/prompt security boundaries, (5) canonical data structures, (6) billing implications, (7) overlap-risk files, (8) R5-A contract dependencies, (9) security risks, (10) gaps converted into B1+ design decisions, reconciled with the B1 contract where it already decided them. Method: every reference below was opened and confirmed; nothing is cited from memory.

## 2. Reusable R4 modules

| Module | Reuse for | Key symbols (verified at e4493a8) |
|---|---|---|
| **AI boundary** | | |
| `api/lib/agents/openai.ts` | single OpenAI client; both models gpt-4o-mini | `createOpenAI` :4, `defaultModel` :6, `structuredModel` :7 |
| `api/lib/agents/runner.ts` | the ONLY governed LLM entry point for billable interpretation | `runAgent<TOutput>` :81 (`userId, campaignId?, agentType, prompt, schema, system?, skipBilling?, abortSignal?, billingIdempotencyKey?` :41-57); pre-flight `enforceCostControl` :104 → `reserveWalletCredits` :119 → `agent_runs` row :159 → `withProviderTimeout(generateObject)` :171-173 → `settleWalletCredits` :205 + `recordAiUsage` :213; failure classes `isSchemaError/isProviderError/isQuotaError` :257-264 with release :274 / settle :285. **AgentType is a closed union** :32-39 (strategy, creative, audience, distribution, engagement, sales, optimisation) |
| `api/lib/reliability/provider-timeout.ts` | provider timeout wrapper | `withProviderTimeout` :51, `ProviderTimeoutError` :14 |
| `api/lib/safety/checker.ts` | direct-LLM precedent OUTSIDE the runner | `checkContentSafety` :15, `SafetyResultSchema` :7, fixed `SAFETY_CHECK_COST = 1` :36, direct `generateObject` :61, `agentType: "safety_check"` in ai_usage :99, insufficient-credit fail → `medium` :43-48 |
| `api/lib/agents/runner-billing-identity.test.ts` / `api/lib/agents/strategy-agent.test.ts` | test-double precedents (module-level `vi.mock`) | `vi.mock("ai")` at runner-billing-identity.test.ts:4 and strategy-agent.test.ts:27; `vi.mock("./openai")` strategy-agent.test.ts:73 |
| **Billing / exact-once** | | |
| `api/lib/billing/credit-reservation.ts` | reservation state machine + deterministic identity | states `"reserved"\|"settled"\|"released"` :23; terminal set :150-152; transitions map `reserved → settled\|released` :156 (terminal rejects all re-transition :175-178); `buildCreditReservationId` :253 = sha256 :210 over canonical JSON :206; no wall-clock/random in identity :9, :237 |
| `api/lib/billing/credit-reservation-engine.ts` | wallet hold authority | `SELECT ... FOR UPDATE` :112; `reserveWalletCredits` :195, `settleWalletCredits` :248, `releaseWalletCredits` :304 |
| `api/lib/billing/credit-engine.ts` | claim-first ledger | `throwIdempotencyCollision` :33; `deductCredits` :168 (claim INSERT, ER_DUP_ENTRY rollback :200-201); `recordAiUsage` :386; `refundCredits` :487 |
| `api/lib/workflow/agent-billing-identity.ts` | identity-minting precedent | `AGENT_BILLING_CONTRACT = "workflow/agent-billing@v1"` :30; `buildAudienceBillingIdentity` :46, `buildDistributionBillingIdentity` :61; audience-intel format `agent-audience-intel-${sha256("workflow/agent-billing@v1:audience-intel:{campaignId}:{continuationId}")}` :76-77 |
| `api/lib/agents/engagement-agent.ts` | event-scoped billing identity | `buildEngagementReplyBillingIdentity` :39 |
| `docs/contracts/financial-reliability-contract.md` | FROZEN key registry | §2 billing key registry (FROZEN formats) :44 — new keyed operations ADD a row; §9 external-call safe pattern :158; §12 overlap-risk files :210 (lists `runner.ts`, `cost-control.ts`) |
| **Idempotency / versioning** | | |
| `api/lib/workflow/workflow-operation.ts` | deterministic operation ids | `buildWorkflowOperationId` :229; `InMemoryWorkflowOperationRegistry` :380 |
| `api/lib/queue/bullmq.ts` | deterministic job ids | `toContentGenerationBullMqJobId` :98 (`content-generation-{agentRunId}`), `toPublishingBullMqJobId` :102 (`publish-{queueItemId}`) |
| `api/lib/audience/ingest.ts` | signal dedup hash | `computeDedupHash` :50-64 = sha256 of `userId\|platform\|externalProfileId\|externalContentId\|actorExternalId\|eventType\|eventTimestamp`; unique index db/schema.ts:961 |
| `api/lib/learning/contracts/learning-config.ts` | version pinning | `LEARNING_EVALUATION_VERSION = "learning-v1"` :15; "persisted learning records stay bound to the version that produced them" :6-7; `learning-v2` coexists :22-25 |
| `api/lib/learning/learning-record-authority.ts` | record/evidence fingerprints | `computeEvidenceFingerprint` :157, `computeRecordFingerprint` :168 |
| `api/lib/creative/image-render-recovery-classifier.ts` | pure deterministic classifier shape | zero imports; closed evidence types :11-41; closed classification enum :44; every result `mutationAuthorized: false` :59; `classifyImageRenderRecovery` :116 |
| **Governance / audit** | | |
| `api/lib/audit/audit-event.ts` | pure audit-event constructor | `AUDIT_EVENT_TYPES` closed taxonomy :34; `SENSITIVE_METADATA_KEY` regex :167; `sanitizeAuditMetadata` :334; `createAuditEvent` :348 (caller-supplied `occurredAt`, never invented :193-199); `buildAuditEventFingerprint` :392 |
| `api/lib/audit/audit-store.ts` | durable replay-safe persistence | `persistAuditEvent` :180 — fingerprint unique key, replay reuses row, content mismatch fails closed :189-196; executor seam `{select, insert}` :39-40 |
| `api/approval-router.ts` | fail-closed governance precedent | G-04 invariant comment :171 (pending/rejected never converted to approved) |
| `api/lib/engagement/sensitive-reply-approval.ts` | version-bound idempotency + privacy | `SENSITIVE_REPLY_APPROVAL_CONTRACT_VERSION` :34 bound into the idempotency hash :156; never echoes raw provider event keys (fingerprints only) :17-19 |
| **Business context** | | |
| `api/lib/business-dna.ts` | grounded business facts for prompts | `BusinessDNASnapshot` :22 (`snapshotId` :23, `version` :25, `evidenceHashSha256` :26, `approvedClaims` :37, `prohibitedClaims` :38) |
| `api/lib/business-dna-store.ts` | write-once immutable store | write-once/no-update replay-or-conflict :15-18; `persistBusinessDnaSnapshot` :155; ⚠ `getLatestBusinessDnaSnapshotForBusiness(businessId)` :239 takes **no userId** |
| `api/lib/business-dna-governance.ts` | owner-scoping precedent | loads business by **both** id and userId :22 (`BusinessNotFoundForUserError` :70-77) |
| `api/lib/strategy/strategy-snapshot.ts` | versioned per-campaign snapshot | `StrategySnapshot` :14, `buildStrategySnapshot` :164; unique `(campaignId, version)` db/schema.ts:261-264 |
| **Middleware** | | |
| `api/middleware.ts` | procedure classes | `publicQuery` :12; `requireAuth` checks `ctx.user` AND `ctx.session.verified` :17, :24; `authedQuery` :70; `adminQuery` :71; `aiActionQuery` :76 (per-user/day AI budget via `rateLimitUser(ctx, "ai", path)` :60-63) |
| `api/lib/rate-limiter.ts` | tier-based limits + tenant key shape | `TIER_RATE_LIMITS` :8; key `rate:user:${ctx.user.id}:${type}` :152 |
| `api/lib/subscription.ts` | quota checks | `checkLimit(userId, "campaign"\|"result")` :167-169 |
| **Caching** | | |
| `api/lib/redis.ts` | no general cache layer exists; redis consumers only | `getRedisClient` :7; used by `api/lib/rate-limiter.ts:40-48`, `api/lib/integrations/oauth-state.ts:1`, `api/health-router.ts:36` (health ping) |

## 3. Existing classifiers / sentiment code — overlap risk

| Code | What it already does | Risk for R5-B |
|---|---|---|
| `api/lib/agents/engagement-agent.ts:13-20` | `ReplySchema` with `sentiment: enum["positive","neutral","negative","urgent"]` :20, `shouldEscalate` :18, `leadScore` :17 | legacy 4-value sentiment vocabulary produced as a reply by-product, not an intelligence product |
| `api/lib/engagement/sensitive-reply-approval.ts:42-46,167-186` | `SensitiveReplySentiment` + `deriveSensitiveReplyRiskLevel` deterministic rule (urgent/negative→high, neutral→medium, positive→low; escalation reason bumps one level) | second copy of the 4-value enum; semantic drift if scales are bridged loosely |
| `api/lib/audience/scoring.ts` | rule weights | `computeBaselineScore` :69, `confidenceFromScore` :121, `actionFromScore` :127 ("reach_out"\|"nurture"\|"ignore") — opportunity-adjacent vocabulary |
| db/schema.ts:1011-1033 | `leadScores`: `score` :1024, `confidence` enum [low, medium, high] :1025, `recommendedAction` enum reach_out/nurture/ignore :1030 | persisted scoring vocabulary B must not silently re-define |
| db/schema.ts:1113-1118 | `conversation_messages.sentiment` enum [positive, neutral, negative, urgent], nullable | third copy of the 4-value enum, persisted |
| db/schema.ts:1248-1259 | `ai_usage.agentType` DB enum (10 values) | closed at the DB level too — a new agent type needs a migration |
| **Intent (base commit)** | NO intent taxonomy existed anywhere (only `PublishPackageIntent`, `api/lib/publish/publish-package-builder.ts:295` — unrelated publishing domain) | was greenfield; now claimed by B1 (see below) |
| **B1 contract (landed during prep)** | `INTENT_VALUES` 15-value closed taxonomy `api/lib/intelligence/interpretation-contract.ts:18-34`; `SENTIMENT_VALUES` **5-value** [positive, neutral, negative, mixed, unknown] :36 with `urgent` relocated to a separate `URGENCY_VALUES` scale :38; `SOCIAL_INTELLIGENCE_SCHEMA_VERSION = "social-intelligence/v1"` :13, `CLASSIFIER_VERSION = "intent-sentiment-classifier/v1"` :14 | B1 deliberately diverged from the legacy 4-value scale — any bridge to `conversation_messages.sentiment` / engagement `ReplySchema` needs an explicit, versioned mapping; drift risk is now concrete, not hypothetical |

## 4. Model provider boundaries & prompt/security patterns

- All governed LLM calls go through `runAgent` (§2). Direct `generateObject` exists only in the safety checker precedent (`api/lib/safety/checker.ts:61`), which is unreserved claim-first billing — NOT a model to copy for B.
- `api/lib/agents/prompts.ts`: `strategyAgentPrompt` :1 — labelled authority hierarchy ("CAMPAIGN BRIEF — THIS IS THE AUTHORITATIVE GROUND TRUTH" :83) and explicit grounding-precedence comments :42, grounding requirements :133-138. B's prompt builder should mirror this labelled-precedence style.
- `api/lib/agents/engagement-agent.ts:100-132`: fixed instruction block with untrusted inbound text wrapped in triple-quote delimiters :111-114 — the only pre-B untrusted-text handling pattern.
- `api/lib/audit/audit-event.ts:167,319`: `SENSITIVE_METADATA_KEY` regex strips token/password/secret-ish metadata keys before persistence.
- `api/lib/engagement/sensitive-reply-approval.ts:17-19`: provider event keys never surfaced — fingerprints only.
- **No dedicated prompt-injection sanitizer exists at base** (searched `api/lib` for injection/sanitize patterns: only audit-metadata sanitization and `sanitizeTitle` in `api/lib/agents/creative-agent.ts:71`). B1 closes this via planned `input-safety.ts` + prompt-injection-resistant `model-boundary.ts` (contract §2 :41, :43; §7 :185) — still to be implemented.

## 5. Data structures (canonical signal stores + JSON-column pattern)

- db/schema.ts: **1628 lines, 47 `mysqlTable` tables** (verified count — field notes said 43, corrected). Conventions: `id: serial PK`, `userId: bigint unsigned`, `createdAt: timestamp defaultNow`, `$inferSelect`/`$inferInsert` exports.
- `socialEngagementEvents` db/schema.ts:919-963 — platform enum :926-932, `externalProfileId` :934, `externalContentId` :935, `dedupHash` unique :961, `eventType` enum follow/like/comment/share/message/click/save/post_interaction :937-946, `messageText` :950, `metadata` json :952. **This is R5-A's most likely canonical signal shape — confirmed by B1 contract §3 :51-59.**
- `campaignInterestSignals` :968-1006 (aggregated per campaign+actor; unique `cis_campaign_actor_uidx` :1001-1004 — the audience-ingest upsert relies on it :996-1000; `signalType` enum :977).
- `conversationThreads` :1089 / `conversationMessages` :1107 (unique `(threadId, dedupKey)` inbound idempotency guard :1126-1129) / `engagementWebhookEvents` :1142 (inbound ingest audit, lifecycle received→processing→completed\|escalated\|failed :1135-1141).
- `leadScores` :1011-1049 and `outreachRecommendations` :1054-1084 (channel enum :1063-1070, `acceptedAt`/`dismissedAt` :1077-1078) — the opportunity-adjacent stores; B reads none, writes none.
- JSON-column exemplar: `learningRecords` :1209-1239 — heavy JSON payload columns, `idempotencyKey` unique :1235, `evaluationVersion` :1215.
- `audit_events` :1588-1625: `eventFingerprint` unique :1617, `occurredAt` varchar verbatim :1599.
- Migrations: `db/migrations/meta/_journal.json` 29 entries idx 0-28, latest `0028_add_campaign_interest_signal_actor_unique` → **next: `0029_*`**. Two files numbered 0012 exist on disk (`0012_add_message_pack_asset_type.sql`, `0012_strange_puff_adder.sql`); the journal tracks idx 12 = `0012_add_message_pack_asset_type`. `drizzle.config.ts:4-6` requires `DATABASE_URL`.

## 6. Billing implications

- Any billable B interpretation call must run `runAgent` reserve→settle/release (:119/:205/:274), never the checker-style direct path. B1 contract §13 (:293-303) fixed exactly this: rules path **non-billable** (`billingIdentity` null, no reservation, no ai_usage) :295; model path one governed `runAgent` with `billingIdempotencyKey = billingIdentity`, reserve → single provider call → settle/release, same-key retries → at most one durable charge :296-300. Contract §5 adds the timeout corollary: provider timeout → runner releases (refund path) → no record; retry re-enters under the same billingIdentity, so at most one durable charge survives per logical interpretation version :146-148.
- A new keyed operation requires a **new row in the FROZEN §2 billing key registry** (financial-reliability-contract.md:44); B1 contract §13 already requires the `interpretation` identity row there (:301-303) with format `interpretation:` + sha256 over `intelligence/interpretation-billing@v1:{businessId}:{signalId}:{signalVersion}:{signalContentHash}:{classifierVersion}` (contract §5 :125-127). Mint identities in the spirit of `agent-billing-identity.ts:30` / `engagement-agent.ts:39`.
- AgentType extension is dual: runner union `api/lib/agents/runner.ts:32-39` **and** DB enum `ai_usage.agentType` db/schema.ts:1248-1259 — both closed. B1 contract names `agentType: "interpretation"` (§2 :43, §13 :301) — neither closed type has been extended yet.
- Quota-adjacent: `checkLimit` covers only campaign/result (`api/lib/subscription.ts:167-169`); interpretation limits come from `aiActionQuery` + wallet credits. Runner `abortSignal` support (:49) is the cancellation seam if interpretation ever runs under an upstream deadline.
- The checker's `checkCredits` pre-check (`api/lib/safety/checker.ts:41`, balance check `api/lib/billing/credit-engine.ts:432`) is NOT the governed path — the runner's `enforceCostControl` :104 already runs reservation-time capacity checks; B must not mix the two billing styles in one call.

## 7. Overlap-risk files

| File | Why risky | B1+ rule |
|---|---|---|
| `api/router.ts` | `appRouter` :27, keys :48-71, `export type AppRouter` :74 | add import + key only; client is type-inferred (`createTRPCReact<AppRouter>()`, src/providers/trpc.tsx:8) — no client registry change |
| `db/schema.ts` | 47-table shared schema | additive only; B1 adds `socialInterpretations` (contract §2 :48; unique keys per contract §5 :130-134) via migration `0029_*` |
| `db/migrations/` journal | idx 28 → next `0029_*`; duplicate 0012 on disk | never renumber; follow journal |
| `api/lib/agents/runner.ts` | AgentType union :32-39; E-contract §12 overlap list | extend union in one commit with ai_usage migration + §2 registry row |
| `docs/contracts/financial-reliability-contract.md` | §2 formats FROZEN :44; §12 coordination list :210 | one added row for `interpretation`; nothing else edits |
| `api/lib/audit/audit-event.ts` | `AUDIT_EVENT_TYPES` :34 closed taxonomy | add B event types as new vocabulary entries |
| `api/middleware.ts` / `api/lib/rate-limiter.ts` | per-user/day AI budget keys shared across features | interpretation reuses the existing `"ai"` rate-limit type via `aiActionQuery` — no new type string needed |
| `api/lib/engagement/`, `api/lib/audience/`, `api/lib/learning/` | taken namespaces | new code under `api/lib/intelligence/` (now claimed by B1; planned module map in contract §2 :39-49); shared types in `contracts/` |
| Test harness | vitest, no real DB | copy the pattern: `vi.mock("./queries/connection")` + chainable mock keyed on `(table as any)[Symbol.for("drizzle:Name")]` (`api/learning-router.test.ts:5,17,41`), `buildCtx {resHeaders, user:{id,tierSlug}, session:{verified}}` :132-138, `router.createCaller(ctx)`; unauth→UNAUTHORIZED :238, cross-user→NOT_FOUND :219-224; store tests use `{select, insert}` executor fakes |

## 8. R5-A contract dependencies

- Branch `feature/r5-a-social-listening` exists locally; its contract (`docs/contracts/social-listening-to-intelligence-contract.md`) is **not yet published**.
- This inventory's working assumption — R5-A's canonical signal = `social_engagement_events` shape — was **adopted by B1**: contract §3 (:51-59) consumes an adapter fixture boundary modelled on `social_engagement_events` (`signalId` e.g. `dedupHash`, server-authoritative `signalVersion`), implemented as `api/lib/intelligence/canonical-signal.ts` (pure, fails closed before any record/billing; text-bearing types limited to comment/message/mention/dm, canonical-signal.ts:36-42). The adapter-isolation recommendation is now contract; keep R5-A coupling inside that one module.
- When R5-A publishes, `canonical-signal.ts` is the single file to reconcile — same role `computeDedupHash` plays for ingest identity (`api/lib/audience/ingest.ts:50-64).

## 9. Security risks identified

1. **Untrusted social text**: `messageText` (db/schema.ts:950) is adversarial input flowing into LLM prompts — injection can exfiltrate system-prompt authority or hijack downstream pipelines. Contract §1 :25-26 and §7 :185 already encode this; enforcement modules (`input-safety.ts`, `model-boundary.ts`) are not yet written.
2. **No prompt-injection sanitizer at base** (§4) — must land before any prompt embeds social text.
3. **Tenant isolation**: `getLatestBusinessDnaSnapshotForBusiness(businessId)` has no userId (`api/lib/business-dna-store.ts:239`); caller must scope by owner like `business-dna-governance.ts:22`. Same discipline applies to every B read path; B1 contract §1 :29-30 makes ownership server-authoritative, and contract §5 :144 puts `businessId` into every identity so cross-business `signalId` collisions fail closed.
4. **Sentiment enum semantic drift**: three legacy 4-value copies (§3) vs the B1 5-value scale + separate urgency scale — bridges need explicit versioned mappings, and persisted legacy rows must never be re-interpreted silently.
5. **PII in evidence snippets**: social text copied into B evidence/audit records carries actor PII; follow `SENSITIVE_METADATA_KEY` stripping (audit-event.ts:167), fingerprint-only identity (sensitive-reply-approval.ts:17-19), B1 evidence bounding (excerpts ≤160 chars, contract §10/§14; topics ≤48 chars no PII, `interpretation-contract.ts:208-209`). Logger redaction precedent `api/lib/logger.ts:19-40`.
6. **No cache risk today**: redis is used only for rate limiting (`api/lib/rate-limiter.ts:40-48`), OAuth state (`api/lib/integrations/oauth-state.ts:1`), and the health ping (`api/health-router.ts:36`). If B adds a cache, the key must embed `businessId` (tenant precedent `rate:user:${ctx.user.id}:${type}`, rate-limiter.ts:152).
7. **R5-A contract drift**: the B1 adapter is a fixture boundary modelled on `social_engagement_events`; if R5-A's published contract diverges from that shape, identity/replay semantics built on it must be re-validated before any production ingest.

## 10. Gaps → design decisions for B1+ (reconciled with the landed B1 contract)

| Gap | Decision |
|---|---|
| Closed AgentType + ai_usage enum | Contract fixes `agentType: "interpretation"` (§2 :43, §13 :301-303); still requires one commit extending `runner.ts:32-39` + DB enum `schema.ts:1248` + FROZEN §2 registry row |
| No billing key row for B | Contract §13 :301-303 mandates the identity row in financial-reliability-contract.md §2; format pinned in contract §5 :125-127; §9 external-call safe shape (:158) applies |
| No prompt-injection sanitizer | Contract §2 :41/:43 assigns `input-safety.ts` (sanitize/bound/normalize, reject-before-processing) + `model-boundary.ts` (prompt-injection-resistant construction via `runAgent`) — pure, standalone, unit-tested first |
| No intent taxonomy | CLOSED by B1: 15-value `INTENT_VALUES` + `ModelInterpretationSchema` (`interpretation-contract.ts:18-34,299-311`), `CLASSIFIER_VERSION` :14 bound into records; labels outside the closed vocabularies cannot parse |
| Identity / versioning / replay | Contract §5 :115-148: pure sha256 over canonical JSON (no wall-clock/randomness — same discipline as credit-reservation.ts); unique keys `interpretationId` and `(businessId, signalId, signalVersion, classifierVersion)` :130-134; replay idempotent, tamper/stale rejection fail-closed, historical rows stay bound to their classifier version :136-144 |
| Sentiment scale collision | B1 chose its own 5-value scale + separate urgency (:36-38); legacy 4-value enums stay untouched; any bridge to `conversation_messages.sentiment` / `ReplySchema` is an explicit versioned mapping in the adapter layer |
| Confidence semantics | Contract §8 :205 — bounded ordinal with explicit source (`confidenceBasis` deterministic_rule / model_self_assessed / insufficient_evidence, `interpretation-contract.ts:83-87`); model self-assessment is never re-labelled as statistical confidence (:303-304) |
| Billable endpoint gating | Model path is billable → interpretation mutations ride `aiActionQuery` (middleware.ts:76); reads ride `authedQuery`; owner scoping enforced in-router (NOT_FOUND, not FORBIDDEN, per learning-router.test.ts:219) |
| Router/store | Contract §2 :48 names `interpretation-store.ts` → `socialInterpretations` table: serial PK, bigint unsigned userId/businessId, JSON payload columns, unique keys per §5, `createdAt defaultNow`, `$inferSelect`/`$inferInsert`; migration `0029_*` additive; store pattern = `audit-store.ts:180` fingerprint-unique replay with `{select, insert}` executor seam for tests |
| No leads/opportunity creation | Contract §1 :16-17 — interpretation only; leads stay with `convertThreadToLead` (conversation-router.ts:133) and `autoScore` (lead-router.ts:205); opportunity-adjacent data remains `leadScores` (:1011) + `outreachRecommendations` (:1054) — B writes neither; `recommendedHandling` is a classification, never executed (contract §1 :23-24) |
| Auditability | Contract §15 (:313) — B events extend `AUDIT_EVENT_TYPES` (audit-event.ts:34) with caller-supplied `occurredAt`; exactly-one durable audit event per accepted interpretation (replay returns the existing row, contract §5 :140) |

## Appendix A — Reference corrections vs field notes

Every reference in this document was re-verified with Read/Grep. Corrections made to the supplied notes:

1. **db/schema.ts table count: 47, not 43** (47 `export const … = mysqlTable(` definitions; 1628 lines confirmed).
2. **Journal-tracked 0012:** of the two on-disk 0012 files, the journal tracks `0012_add_message_pack_asset_type` (idx 12); `0012_strange_puff_adder.sql` is untracked.
3. **Date:** taken from the environment (`date` → 2026-10-24 SAST), not 2026-05-30.
4. **B1 drift during prep:** the notes assumed no B code; commit `3259721` + uncommitted `api/lib/intelligence/{interpretation-contract,canonical-signal}.ts` landed mid-flight and are reconciled in §3/§7/§8/§10.
5. All other supplied references (runner pipeline lines, reservation/ledger symbols, audit modules, middleware lines, schema line anchors, middleware/test-harness patterns) matched the tree and are cited as found.
