# WBS-R5 STREAM A — SOCIAL LISTENING: REPOSITORY / CAPABILITY INVENTORY (A0)

> **Stream:** WBS-R5 Stream A — Social Listening Autonomy
> **Branch:** `feature/r5-a-social-listening`
> **Base:** `e4493a8ecd30f513e2a022f4aca0941f5dced485` (R4 authority: `FULL_AUTONOMY_V1_READY`)
> **Date:** 2026-07-05
> **Verdict:** R4 provides a strong ingestion/idempotency/observability substrate.
> R5-A adds one canonical signal model + one listening-state model; everything
> else is reused, not duplicated.

---

## 1. What already exists (R4 authority) — reuse, do not rebuild

### 1.1 Provider bindings (authoritative ownership)

| Asset | Location | Notes |
|---|---|---|
| `social_integrations` table | `db/schema.ts:843` | `userId`, `businessId`, `platform` (enum facebook/instagram/linkedin/tiktok/twitter/whatsapp/email), `pageId`, `pageAccessTokenEncrypted`, `instagramBusinessAccountId`, `permissions`, `status` (`connected`/`expired`/`disconnected`), `lastSyncAt`. **This is the authoritative provider-account → tenant binding.** |
| OAuth connect/callback | `api/lib/integrations/oauth.ts`, `oauth-callback.ts`, `oauth-state.ts` | Meta + LinkedIn token exchange; page selection; instagram business account derivation. Rows upserted with `userId`/`businessId`. |
| Integration router | `api/integration-router.ts` | `getConnectedPlatforms` (token never leaves API — only `hasPageAccessToken`), connect/disconnect, `assignIntegrationBusiness` (owner-scoped + admin audit), token refresh, `testConnection`. |
| Platform config | `api/lib/integrations/platforms.ts` | OAuth configs per platform; `getMetaOAuthScopes()`; `isFacebookPublishingReady` / `isInstagramPublishingReady` (permission-scoped readiness). |

### 1.2 Outbound publishing (NOT listening — boundary)

| Asset | Location | Notes |
|---|---|---|
| Governed adapter boundary | `api/lib/integrations/adapters/*` | `PlatformAdapter` transport seam (facebook/instagram/linkedin/twitter). Outbound only. `derivePublicationOperationId` → `publication:{platform}:{queueItemId}` is the **stable publication identity**. |
| Publication receipts | `api/lib/publish/publication-receipt*.ts` | Canonical receipt persisted as `publication_success` `audit_events` row (replay-safe via unique `eventFingerprint`). `publishing_queue` row is the primary success authority (`status`, `publishedAt`, `externalPostId`). |

### 1.3 Inbound / webhook ingestion (engagement-owned — overlap risk)

| Asset | Location | Notes |
|---|---|---|
| Engagement inbound pipeline | `api/lib/engagement/inbound.ts` | Meta webhook verification (`X-Hub-Signature-256` HMAC, `verifyMetaWebhookSignature`), `normalizeMetaWebhookPayload` (messaging + comments), durable acceptance on `engagement_webhook_events` (unique `(provider, externalEventId)`), atomic `processing` claim with lease, `recoverStaleEngagementEvents`. Registered at `POST /api/webhooks/:platform` (`api/boot.ts:95`). **Owned by the Engagement agent (AI reply proposals) — R5-A must not change its semantics.** |
| `engagement_webhook_events` | `db/schema.ts:1142` | Ingestion audit + idempotency lifecycle (`received`→`processing`→`completed`/`escalated`/`failed`). No business attribution column, no provider-account binding beyond `integrationId`, no campaign/publication attribution evidence, no checkpoint. |

### 1.4 Polling-based audience ingestion (audience-owned — overlap risk)

| Asset | Location | Notes |
|---|---|---|
| Audience ingest | `api/lib/audience/ingest.ts` | Loads connected integrations, runs `fetchMetaAudienceData` / `fetchLinkedInAudienceData`, upserts `social_profiles` + `social_engagement_events` (dedup via unique `dedupHash` = sha256 over user/platform/profile/content/actor/type/timestamp), aggregates `campaign_interest_signals`. Manual/agent-triggered, not scheduled. |
| `social_engagement_events` | `db/schema.ts:919` | Official-API engagement events with actor + `messageText` (500-char truncated). **No external event id, no provider-account linkage, no publication/receipt linkage** — cannot serve as canonical replay-safe signal evidence. |
| `campaign_interest_signals` | `db/schema.ts:968` | Aggregated per campaign+actor (unique `(campaignId, externalIdentifier)`). R5-B/C territory (qualification/scoring inputs). |
| `social_profiles` | `db/schema.ts:876` | Permissioned owned-account audiences. |

### 1.5 Post-live observation / analytics / learning (downstream — overlap risk)

| Asset | Location | Notes |
|---|---|---|
| Post-live metrics observation | `api/lib/workflow/post-live-metrics-observation-*` | Lease-protected scheduler pass writing `analytics` rows with deterministic `observationId` (`obs:` + sha256). Env-gated (`POST_LIVE_METRICS_OBSERVATION_ENABLED`, default on). Scheduler pattern to reuse for listening polling. |
| `analytics` table | `db/schema.ts:503` | Metric observations; unique `observationId`. |
| Learning observations | `api/lib/learning/contracts/observation.ts` | Analytics → learning observations (Stream D owned). |

### 1.6 Durable evidence / idempotency / observability substrate

| Asset | Location | Notes |
|---|---|---|
| Replay-safe audit store | `api/lib/audit/audit-store.ts` | `persistAuditEvent`: fingerprint-unique, exact replay reuses row, conflicting content fails closed. Pattern to mirror for signal persistence. |
| Scheduler pattern | `api/lib/workflow/post-live-metrics-observation-scheduler.ts` | Process-local singleton, skip-if-in-flight, first pass immediate, env-gated start in `api/boot.ts`. |
| Health/operator surface | `api/health-router.ts` | `getSystemHealth` (db/redis/worker checks), queue health, `system_alerts` + admin alert management with mutation audit. Reuse for listening observability (A6). |
| Alerts | `api/lib/alerts.ts` | `createAlert` / `listAlerts` / `acknowledgeAlert` / `resolveAlerts`. |
| Rate limiting | `api/lib/rate-limiter.ts` | `rateLimitPublic`, `rateLimitUser` middlewares. |
| Queue infra | `api/lib/queue/bullmq.ts` | BullMQ publishing/content workers; terminal replay/reconciliation. Not needed for listening v1 (schedulers suffice). |
| Env config | `api/lib/env.ts` | Typed env with `parsePositiveInteger` pattern; `isProduction`. |

### 1.7 AuthZ / tenancy

| Asset | Location | Notes |
|---|---|---|
| tRPC middleware | `api/middleware.ts` | `publicQuery`, `authedQuery` (JWT + 2FA verified), `adminQuery`, rate-limited variants. |
| Context | `api/context.ts` | `ctx.user` = full user row from DB. |
| Ownership convention | integration router, audience access (`api/lib/audience/access.ts`) | Every query is `userId`-scoped; admin bypass only where explicitly designed. |

---

## 2. Current inbound / outbound boundaries

- **Inbound (live today):** Meta webhooks only (`facebook`/`instagram`/`whatsapp` via `POST /api/webhooks/:platform`), verified by HMAC, consumed by the Engagement pipeline. Non-Meta platforms are rejected fail-closed in production.
- **Inbound (polling, manual):** Meta + LinkedIn audience adapters fetch profiles/engagement on demand (agent-triggered).
- **Outbound (live today):** publishing adapters (FB/IG/LinkedIn/Twitter), WhatsApp send, email send.
- **Listening (continuous, automatic):** does not exist. No webhook subscription management, no checkpoint/cursor polling, no per-account listening state.

## 3. Reusable R4 identities

| Identity | Value | Source |
|---|---|---|
| Publication operation id | `publication:{platform}:{queueItemId}` | `platform-adapter.ts:63` |
| Publication receipt | `publication_success` audit row (`eventFingerprint` unique) | `publication-receipt-store.ts:43` |
| Provider account binding | `social_integrations.id` (+ `pageId` / `instagramBusinessAccountId`) | `db/schema.ts:843` |
| Tenant | `users.id` (owner) + `businesses.id` (binding) | `db/schema.ts` |
| Webhook authenticity | Meta `X-Hub-Signature-256` HMAC | `inbound.ts:90` |
| Replay-safe persistence | fingerprint-unique insert, fail-closed conflict | `audit-store.ts:180` |

## 4. Schema impact assessment

**Existing tables are insufficient for the canonical signal:**

- `engagement_webhook_events`: engagement-processing lifecycle, no businessId, no provider-account scoping, no attribution evidence, no checkpoint, no deterministic server-derived signal identity decoupled from processing.
- `social_engagement_events`: no external event id, no provider account binding, no receipt/publication linkage, dedup hash includes mutable fields (message text refresh on duplicate).

**Minimal necessary addition (2 tables, see `docs/contracts/social-signal-contract.md`):**

1. `social_signals` — canonical, immutable, replay-safe evidence per logical provider event; unique deterministic `signalKey`; attribution tier columns; status/readiness; `ingestionVersion`.
2. `social_listening_states` — per-integration listening checkpoint/cursor + last-success/failure + failure classification for observability (A5/A6).

No changes to any existing table. Migration artefacts created, **not executed**.

## 5. Overlap-risk files (do not regress)

| File | Risk |
|---|---|
| `api/lib/engagement/inbound.ts` | Same Meta webhook path. R5-A listens without touching engagement acceptance/processing semantics. |
| `api/lib/audience/ingest.ts` | Audience-owned event ingestion; R5-A does not reuse its dedup (mutable hash) — separate evidence layer. |
| `api/lib/workflow/post-live-metrics-observation-*` | Scheduler pattern reused; no behavior change. |
| `api/integration-router.ts` | Binding authority; reused read-only. |
| `api/lib/learning/*`, `campaignInterestSignals`, `leadScores` | R5-B/C/D territory — R5-A writes none of these. |
| `api/boot.ts` | Webhook route wiring; additive only. |

## 6. Security risks observed (R5-A must close)

1. Only Meta has webhook authenticity verification; R5-A must fail closed for unverifiable providers (same rule as `inbound.ts`).
2. `engagement_webhook_events.payloadSummary` retains message text — R5-A retains bounded sanitized text only, no raw payload persistence.
3. No cross-business guard on provider-account → publication binding today (R5-A must prove receipt ownership matches integration ownership or fail closed).
4. Client-supplied `businessId` on connect/assign — R5-A never trusts client ownership; attribution always derived server-side from `social_integrations` / receipts.

## 7. Provider capability gaps

| Provider | Outbound publish | Inbound webhook | Polling | R5-A capability verdict |
|---|---|---|---|---|
| Facebook (Meta) | ✅ | ✅ (HMAC verified) | ✅ audience adapter | webhook + receipt/poll attribution |
| Instagram (Meta) | ✅ | ✅ (HMAC via Meta) | ✅ audience adapter | webhook + attribution |
| WhatsApp (Meta) | send only | ✅ (via Meta) | — | webhook signal types (message) |
| LinkedIn | ✅ | ❌ no verifier | ✅ audience adapter | polling only, cursor-based; webhook unsupported (fail closed) |
| Twitter/X | ✅ | ❌ no verifier | ❌ | **unsupported — fail closed** |
| TikTok | ❌ stub | ❌ | ❌ | **unsupported — fail closed** |
| Email | send only | ❌ | ❌ | not a social provider for listening |

No live provider is called by R5-A; all acceptance uses fakes. Polling schedulers are env-gated and default OFF until operator configuration.
