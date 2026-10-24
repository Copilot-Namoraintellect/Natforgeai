# SOCIAL LISTENING → INTELLIGENCE CONTRACT (WBS-R5-A)

> **Stream:** WBS-R5 Stream A — Social Listening Autonomy
> **Branch:** `feature/r5-a-social-listening`
> **Audience:** R5-B (sentiment/interpretation), R5-C (qualification/scoring), R5-D (engagement/learning), R5 integration owner
> **Module authority:** `api/lib/social-listening/`
> **Signal model authority:** `docs/contracts/social-signal-contract.md` (A1)
> **Status:** authoritative as of the R5-A acceptance harness (`r5-a-acceptance.test.ts`)

This contract defines exactly what downstream streams may consume. R5-B/R5-C/R5-D
must NOT redefine social-signal authority, re-derive identities, or mutate
canonical evidence. R5-A owns acquisition and normalization only — no
sentiment, no qualification, no scoring, no engagement decisions.

---

## 1. Canonical signal identity

```
signalKey = "sigv1:" + sha256( provider | providerAccountId | externalEventId )
```

- `deriveSignalKey` — `api/lib/social-listening/signal-contract.ts`
- One logical provider event → one canonical identity. DB-unique natural key
  `(provider, providerAccountId, externalEventId)` on `social_signals`
  (`ss_natural_key_uidx`). Server-derived only; no client-controlled identity exists.

## 2. Signal schema

Canonical durable table `social_signals` (migration `0029_social_listening_foundation`,
artefacts committed, **not executed**). Full field table in
`docs/contracts/social-signal-contract.md` §2. Key consumption fields:
`signalKey`, `userId`, `businessId`, `provider`, `platform`, `signalType`,
`occurredAt`, `observedAt`, `sourceCampaignId`, `sourcePublicationId`,
`sourcePublicationReceiptId`, `actorReference`, `actorDisplayName`,
`contentReference`, `contentText`, `providerEvidenceHash`, `attributionType`,
`status`, `ingestionVersion`, `createdAt`.

## 3. Signal types

`comment` · `reply` · `mention` · `reaction` · `direct_message` · `repost` ·
`follow` · `unfollow` · `campaign_response` · `inbound_message` · `unknown`

Adapters never guess: unrecognized provider evidence maps to `unknown`.
Provider subsets (A1 contract §8): Meta webhooks currently emit
comment/reply/mention/reaction/direct_message; LinkedIn polling emits per its
fetch seam; twitter/tiktok are unsupported (fail closed).

## 4. Attribution semantics

| `attributionType` | Meaning | `source*` fields |
|---|---|---|
| `direct` | provider object resolved to a published `publishing_queue` success row owned by the binding's tenant | campaign + publication + receipt all set (receipt may be null for legacy rows) |
| `business` | binding maps to a business, no publication linkage | all `null` |
| `unattributed` | connected account, no linkage, or no business bound | all `null` |

Confidence is derived deterministically from the type — there is no separate
confidence column and no fabricated linkage.

## 5. Provider/account authority

- Tenant/business context comes only from the `social_integrations` binding
  (`integrationId`, `userId`, `businessId`) resolved by provider account id.
- Client-supplied `businessId`/`userId`/campaign hints are never trusted.
- Foreign/cross-business publication matches never bind; ownership mismatches
  fail closed (`OWNERSHIP_MISMATCH`).

## 6. Immutability rules

`social_signals` rows have no update path. `providerEvidenceHash`
(sha256 over the canonical key-sorted evidence fragment) proves byte-stability.
Downstreams must treat rows as read-only evidence; state changes belong in
downstream-owned tables keyed by `signalKey`/`id`.

## 7. Replay / idempotency semantics

Duplicate delivery, concurrent delivery, provider retry, and crash-after-persist
all collapse to the one durable row (`duplicateClassification:
"idempotent_replay"`). Conflicting replay under one identity fails closed
(`SIGNAL_FINGERPRINT_CONFLICT`). Same external id from a different
provider/account is a distinct signal. Downstreams may rely on
**at-most-one accepted row per `signalKey`**.

## 8. Listening capability status

Per-binding durable status lives in `social_listening_states`
(`mechanism`, `status`, `cursor`, `cursorUpdatedAt`, `lastSuccessAt`,
`lastFailureAt`, `lastFailureClass`, `lastFailureCode`, counters). Operational
view: `listening.getOverview` (authed, tenant-scoped) and
`listening.adminGetOverview` (admin). Capability matrix: Meta webhook+polling;
LinkedIn polling-only; twitter/tiktok unsupported.

## 9. Failure classes

`AUTO_RECOVER` (transient/rate-limit/network — binding stays active),
`OPERATOR_ACTION` (revoked/expired auth, missing scope/setup — binding blocked),
`FAIL_CLOSED` (ownership/authenticity/malformed — event rejected, never bound).
Recorded durably per binding; surfaced as `configurationBlocker` / `stale`.

## 10. Sensitive-data restrictions

- No provider tokens/secrets/API keys in signals, payloads, logs, or audit rows.
- Raw provider webhook payloads are not persisted.
- Retained PII is minimized: opaque `actorReference`, bounded
  `actorDisplayName`, bounded `contentText` (1024 chars).
- Downstreams must not expand PII retention without a governance decision.

## 11. Fields R5-B may consume

`signalKey`, `signalType`, `contentText`, `contentReference`, `actorReference`,
`actorDisplayName`, `occurredAt`, `observedAt`, `platform`, `provider`,
`attributionType`, `sourceCampaignId`, `parentExternalObjectId` (threading),
`providerEvidenceHash` (integrity verification). R5-B may **read** any column
but must not write to `social_signals`.

## 12. Fields R5-C may consume

Everything in §11 plus `businessId`, `userId`, `sourcePublicationId`,
`sourcePublicationReceiptId`, `externalObjectId`. R5-C consumes attribution +
signal metadata for qualification/scoring; it must not re-score by mutating
evidence and must not trust any non-`social_signals` copy of these fields.

## 13. Fields R5-D may consume

Everything in §11–§12 plus `status` and `ingestionVersion` (for consumption
gating). R5-D (engagement/learning) may join signals to campaigns/publications
via the `source*` lineage; it must not re-derive publication authority
(R4-C contract owns receipts).

## 14. Fields downstream streams must not mutate

ALL `social_signals` columns. Specifically: identity (`signalKey`,
`provider`, `providerAccountId`, `externalEventId`), authority
(`userId`, `businessId`, `integrationId`), evidence (`contentText`,
`contentReference`, `actor*`, `providerEvidenceHash`), lineage
(`sourceCampaignId`, `sourcePublicationId`, `sourcePublicationReceiptId`),
`attributionType`, `status`, `ingestionVersion`, timestamps. Downstream
classifications live in downstream tables keyed by `signalKey`.

## 15. Schema/migration dependencies

- Migration `0029_social_listening_foundation` (creates `social_signals`,
  `social_listening_states`) is required before this contract is live.
  Artefacts committed; **execution is an integration/deploy-step decision —
  R5-A did not execute migrations.**
- Downstream tables may reference `social_signals.signalKey` (varchar 64) or
  `id` (serial) but must not add FK constraints that couple migrations.

## 16. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Engagement pipeline | `api/lib/engagement/inbound.ts`, `engagement_webhook_events` | engagement-owned; R5-A shares only the authenticity primitive (`api/lib/integrations/webhook-authenticity.ts`) |
| Audience ingestion | `api/lib/audience/*`, `social_engagement_events`, `campaign_interest_signals` | audience-owned; R5-A never writes these |
| Publication authority | `api/lib/publish/*`, `audit_events` receipts | read-only attribution inputs |
| Learning | `api/lib/learning/*` | downstream consumer |
| Webhook route | `api/boot.ts` `/api/webhooks/:platform` | engagement response unchanged; listening result is additive |

## 17. Security invariants

1. Server-side authorization on every surface (`authedQuery`/`adminQuery`); tenant scoping from `ctx.user.id` only.
2. Provider-account ownership is proven from `social_integrations` before any persistence; unowned accounts fail closed.
3. Webhook authenticity (Meta HMAC) verified before parsing; unverifiable platforms fail closed.
4. Exact-once dedup is DB-authoritative; no in-memory dedup; no client idempotency identity.
5. Immutable evidence after acceptance; conflicting replay fails closed.
6. Failure classes are recorded durably; FAIL_CLOSED events are never retried blindly.
7. No secrets in any payload/log/audit row; raw payloads not persisted; PII minimized.
8. Unsupported capabilities report unsupported and never fake success.

---

**R5-B/R5-C/R5-D: consume `social_signals` through this contract. Do not
redefine signal authority.**
