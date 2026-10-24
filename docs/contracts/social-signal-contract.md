# CANONICAL SOCIAL SIGNAL CONTRACT (WBS-R5-A A1)

> **Stream:** WBS-R5 Stream A — Social Listening Autonomy
> **Module authority:** `api/lib/social-listening/`
> **Schema:** `social_signals`, `social_listening_states` (migration `0029_social_listening_foundation` — artefacts only, **not executed**)
> **Audience:** R5-B (sentiment/interpretation), R5-C (qualification/scoring), R5-D (engagement/learning), R5 integration owner
> **Status:** authoritative as of the R5-A acceptance harness

This contract defines the single normalized social-signal model. R5-A owns
signal **acquisition and normalization only**: ingest → validate → attribute →
deduplicate → persist → surface. No sentiment interpretation, autonomous
engagement, opportunity qualification, lead scoring, or business-action
decision happens at this layer, and no downstream stream may redefine signal
authority.

---

## 1. Signal identity (deterministic, server-derived)

```
one logical provider event (provider, providerAccountId, externalEventId)
  → signalKey = "sigv1:" + sha256( provider | providerAccountId | externalEventId )
```

- `deriveSignalKey` — `api/lib/social-listening/signal-contract.ts`
- The natural triple is enforced unique at the database level
  (`social_signals.ss_natural_key_uidx`): duplicate delivery, concurrent
  delivery, and provider retry of the same event collapse to **one durable row**.
- `signalKey` is minted only by the server. Clients can never supply or
  influence identity; there is no client-controlled idempotency key.
- The same `externalEventId` from a **different provider or account** produces a
  different `signalKey` and a different natural-key row — no cross-tenant or
  cross-account collision is possible.
- A **tampered** `externalEventId` is by definition a different logical event;
  it is not a replay and is not suppressed (it may still be rejected as
  malformed by adapter validation).

## 2. Signal schema (`social_signals`)

| Field | Type | Authority | Notes |
|---|---|---|---|
| `id` | serial | DB | Row pointer only; never the canonical identity. |
| `signalKey` | varchar(64), unique | server | Section 1. |
| `userId` | bigint | server | Tenant owner from `social_integrations.userId`. Never client-supplied. |
| `businessId` | bigint, null | server | From the authoritative binding; `null` when the binding carries none. |
| `provider` | varchar(32) | server (validated) | `meta` \| `linkedin` \| `twitter` \| `tiktok`. Unknown → fail closed. |
| `platform` | varchar(32) | server (validated) | `facebook` \| `instagram` \| `whatsapp` \| `linkedin` \| `twitter` \| `tiktok`. |
| `integrationId` | bigint | server | Authoritative `social_integrations` binding the signal was accepted under. |
| `providerAccountId` | varchar(255) | provider (validated) | Page/account id the event arrived on. |
| `externalEventId` | varchar(255) | provider (validated) | Provider event identity (message `mid`, comment id, poll event id…). |
| `externalObjectId` | varchar(255), null | provider | Provider object the event refers to (post id). |
| `parentExternalObjectId` | varchar(255), null | provider | Thread / parent comment reference where supplied. |
| `signalType` | enum | server (mapped) | Section 3. |
| `occurredAt` | timestamp | provider (safe-converted) | Provider event time; invalid timestamps fail closed (no silent "now"). |
| `observedAt` | timestamp | server | Acceptance clock at persistence. |
| `sourceCampaignId` | bigint, null | server (evidence) | Only when directly attributed. |
| `sourcePublicationId` | varchar(255), null | server (evidence) | `publication:{platform}:{queueItemId}` of the attributed publication. |
| `sourcePublicationReceiptId` | varchar(128), null | server (evidence) | `audit_events.eventFingerprint` of the `publication_success` receipt. |
| `actorReference` | varchar(255), null | provider (validated) | Opaque provider actor id. |
| `actorDisplayName` | varchar(255), null | provider (bounded) | Bounded display name; PII minimized (no emails/phones retained). |
| `contentReference` | varchar(255), null | provider | Provider perma-link (comment URL…). |
| `contentText` | text, null | provider (sanitized) | Bounded to 1024 chars; audit/reconciliation evidence only. |
| `providerEvidenceHash` | varchar(64) | server | sha256 over the canonical evidence fragment (key-sorted JSON). |
| `attributionType` | enum | server | Section 4. |
| `status` | enum | server | `accepted` — the only R5-A state. |
| `ingestionVersion` | int | server | Currently `1`. Bumped only by a governed ingestion change. |
| `createdAt` | timestamp | DB | Persistence time. |

## 3. Signal types

`comment` · `reply` · `mention` · `reaction` · `direct_message` · `repost` ·
`follow` · `unfollow` · `campaign_response` · `inbound_message` · `unknown`

Adapters map provider-specific event types onto this set and **must** map
anything they do not specifically recognize to `unknown` — never to a guessed
type. Providers only report the subset their evidence actually supports
(Section 8). `campaign_response` is reserved for provider evidence that maps to
a known NatForgeAI publication (direct attribution).

## 4. Attribution semantics (authoritative, never fabricated)

| Type | Meaning | Campaign/publication fields |
|---|---|---|
| `direct` | Provider object maps to a known NatForgeAI publication receipt (`publishing_queue` published success → receipt). Ownership cross-checked against the binding. | All three filled. |
| `business` | Provider account maps to a business via `social_integrations`, but no publication linkage exists. | All three `null`. |
| `unattributed` | Relevant to a connected account but cannot be tied to a publication (unknown post, foreign receipt, stale receipt). | All three `null`. |

Rules:
- Campaign linkage is **evidence-based only** (receipt lookup by external post
  id under the same binding/user). If ownership of the receipt does not match
  the binding's `userId`, the signal **fails closed** — it is never silently
  re-bound to another tenant.
- Downstream derives confidence from `attributionType` deterministically:
  `direct` = evidence-mapped, `business` = account-mapped, `unattributed` = none.
- Client-supplied `businessId`/`userId`/campaign hints are never trusted.

## 5. Immutability

- A `social_signals` row has **no update path**. Evidence, identity,
  attribution, hash, status, and version are written once at acceptance.
- `providerEvidenceHash` proves byte-stability: replaying the identical
  provider event reproduces the identical hash; any drift between retained
  evidence and its hash is tampering evidence.
- Replay of an accepted event returns the existing row
  (`duplicateClassification: "idempotent_replay"`); a natural-key collision
  whose stored content differs fails closed (`SIGNAL_FINGERPRINT_CONFLICT`).

## 6. Replay / idempotency semantics

| Scenario | Behavior |
|---|---|
| Duplicate delivery, same event | One row; second call returns existing row. |
| Concurrent delivery, same event | DB unique natural key serializes to one row. |
| Crash after persist, before ack | Retry re-reads the durable row; returns existing. |
| Out-of-order arrival | Accepted safely; `occurredAt` order is preserved, no row is corrupted (rows are immutable). |
| Provider retry, same external identity | No duplicate effect. |
| Same external id, different provider/account | Distinct signal — no collision. |
| Malformed / tampered replay | Adapter/contract validation fails closed before persistence. |

## 7. Sensitive-data restrictions

- Provider tokens/secrets/API keys **never** appear in signals, API payloads,
  logs, audit rows, or tests.
- Raw provider webhook payloads are **not** persisted. Only the bounded,
  sanitized fields above are retained.
- No provider credential material is part of the evidence hash input.
- Retained PII is minimized to opaque actor reference + bounded display name +
  bounded content text.

## 8. Provider support matrix (capability, not guesswork)

| Provider | Webhook | Polling | Notes |
|---|---|---|---|
| meta/facebook | ✅ HMAC-verified | ✅ | comments, mentions, reactions, messages |
| meta/instagram | ✅ HMAC-verified | ✅ | comments, mentions, messages |
| meta/whatsapp | ✅ HMAC-verified | — | inbound messages |
| linkedin | ❌ unsupported (fail closed) | ✅ cursor-based | no webhook verifier exists in-repo |
| twitter | ❌ | ❌ | **unsupported — fail closed** |
| tiktok | ❌ | ❌ | **unsupported — fail closed** |

Mechanism per binding is recorded in `social_listening_states.mechanism`;
`unsupported` bindings report `status: "unsupported"` and never fake success.

## 9. Listening state (`social_listening_states`)

Per-binding durable operational record (A5/A6): mechanism, status
(`active`/`blocked`/`unsupported`/`stale`), opaque `cursor` + `cursorUpdatedAt`,
`lastSuccessAt`, `lastFailureAt` + failure class (`AUTO_RECOVER` /
`OPERATOR_ACTION` / `FAIL_CLOSED`) + code/reason, and operational counters
(`acceptedCount`/`duplicateCount`/`rejectedCount`). Counters are operational
metadata, **not** evidence; canonical evidence lives only in `social_signals`.

## 10. Overlap boundaries

- `engagement_webhook_events` (Engagement agent) and `social_engagement_events`
  (Audience Intelligence) remain owned by their streams. R5-A does not write
  them and does not consume their dedup as authority.
- `publication_success` receipts (`audit_events`) and `publishing_queue`
  success rows are read-only attribution inputs.
