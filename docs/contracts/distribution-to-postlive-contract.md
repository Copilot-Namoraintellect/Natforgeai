# DISTRIBUTION → POST-LIVE CONTRACT (R4-C)

> **Stream:** WBS-R4 Stream C — Audience / Distribution / Publishing Autonomy
> **Branch:** `feature/r4-c-distribution-autonomy`
> **Audience:** Stream D (post-live: engagement, observation, KPI, learning), R4 integration owner
> **Status:** authoritative as of the R4-C acceptance harness (`r4-c-downstream-acceptance.test.ts`)
> **Consumes:** Stream B `CREATIVE_TO_DISTRIBUTION_CONTRACT`, Stream E `FINANCIAL_RELIABILITY_CONTRACT`, Stream A `CORE_LIFECYCLE_CONTRACT`

This contract defines the single authoritative surface from the distribution /
publishing pipeline to post-live consumers. Stream D consumes the durable
publication record defined here; it must not re-derive publication authority,
re-execute publications, or mutate publication artefacts.

---

## 1. Authoritative publication receipt identity

The authoritative publication artefact is the **canonical publication receipt**:

- **Identity (deterministic):** `operationId = publication:{platform}:{queueItemId}`
  (`derivePublicationOperationId`, `api/lib/integrations/adapters/platform-adapter.ts:63`;
  `publication-idempotency.ts:174`). The identity is minted **before** any provider
  call and is stable across retries, duplicate worker executions, and replays of the
  same logical publication.
- **Exactly one receipt per logical publication:** the receipt persists as a
  `publication_success` row in `audit_events`, replay-safe under the unique
  `eventFingerprint` index (`publication-receipt-store.ts:43`,
  `audit-store.ts:180`). An exact replay reuses the durable row; a mutated replay
  under the same fingerprint fails closed (`fingerprintConflictError`).
- **Disposition authority:** `resolvePublicationExecutionDisposition`
  (`publication-idempotency.ts:384`) maps durable state to `execute | retry |
  replay_success | terminal`. Only `execute`/`retry` permit a provider call;
  `replay_success` returns the stored receipt with zero provider calls and zero
  mutations. `receipt_state_drift` and `package_mismatch` are terminal fail-closed.

## 2. Receipt fields (publication-receipt.ts:54-74)

| Field | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `operationId` | `publication:{platform}:{queueItemId}` (Section 1) |
| `queueItemId` | Owning `publishing_queue` row |
| `platform` | Published platform (adapter id) |
| `status` | `"published"` only (failures never mint receipts) |
| `externalPostId` | Provider-side post id (e.g. Meta post id, UGC URN) |
| `externalUrl` | Provider URL when the provider returns one (may be absent, e.g. LinkedIn) |
| `publishedAtIso` | Shared success clock (one timestamp for row, receipt, audit) |
| `classification` | `"governed"` \| `"legacy"` |
| `publishPackageId` | `ppv1-…` package id for governed publications, else `null` |
| `packageFingerprintSha256` | Governed package content fingerprint, else `null` |
| `receivedAtIso` | Receipt persistence time |

Normalized receipts additionally carry `queueItemId`, `userId`, `campaignId`,
`businessId`, `contentId` in the audit-event row (`occurredAt = publishedAtIso`,
`source: "workflow"`, `outcome: "succeeded"`, governed `packageId` in the
first-class `audit_events.packageId` column, receipt verbatim under the
`publicationReceipt` metadata key).

## 3. Publication / package / campaign lineage

Every governed receipt binds the full downstream lineage:

- **Package lineage:** `publishPackageId` + `packageFingerprintSha256`
  (immutable `PublishPackage`, `publish-package-contract.ts:158`). The package
  binds the seven Stream B Strategy coordinates (`PublishPackageStrategyAuthority`:
  `strategySnapshotId`, `strategyVersion`, `businessDnaSnapshotId`,
  `strategyHashSha256`, `strategyRunId`, `approvalRequestId`,
  `creativeBriefFingerprint`), `approvedCopy`, `selectedContent`, `captionArtifact`,
  `visualArtifact` lineage, and `evidence.launchApprovalRequestId`.
- **Campaign / creative references:** `campaignId`, `userId`, `businessId`,
  `contentId` (= `contentPostId`), `creativeBriefFingerprint` (via the package /
  content metadata), platform and integration identity
  (`destination.platform`, `destination.integrationId`).
- **Durable mirrors:** the `publishing_queue` row is the primary success authority
  (`status: published`, `publishedAt`, `externalPostId`);
  `content_posts.status/publishedAt` and `metadata.publishedPlatforms[]` are
  post-live-readable mirrors written by `finalizeCampaignPublishState`.

## 4. Platform / account identity

- Platform is the adapter id: `facebook | instagram | linkedin | twitter`
  (`PLATFORM_ADAPTER_IDS`). Anything else fails closed at the adapter registry
  (`provider_unsupported`, non-retryable).
- Account identity is the **server-resolved** `social_integrations` row
  (`integrationId` on the queue row / package destination). Post-live consumers
  must treat `integrationId` as the account reference — never a client-supplied
  page name or handle.
- Provider credentials are decrypted only at the runner boundary; receipts and
  all downstream surfaces carry **no token material** (receipt normalization
  scans every string field and rejects secret-like patterns).

## 5. Publication timestamp

`publishedAtIso` is the single shared success clock: the queue row's `publishedAt`,
the receipt's `publishedAtIso`, the audit event's `occurredAt`, and
`content_posts.publishedAt` all derive from it. Post-live time windows must use
this timestamp.

## 6. Provider-operation / reconciliation identity

- **Provider operation:** adapters derive the same `operationId` and return it in
  the normalized receipt (`{platform, operationId, status: "published",
  externalPostId, externalUrl}`). External retries re-enter under the same
  operation identity — a provider may be called again after an ambiguous failure,
  but the wallet effect and the durable receipt stay exact-once.
- **Reconciliation:** receipt-vs-queue drift is detected by the disposition layer
  (`receipt_state_drift` terminal). The runner's guarded claim reconciles a lost
  race in-transaction against the stored (or legacy-hydrated) receipt, refusing
  incompatible state. Queue-side reconciliation authorities
  (`queue_terminal_failures.failureKey`, `queue_replay_requests.replayKey`) own
  recovery bookkeeping; post-live must not write them.

## 7. What Stream D / post-live MAY consume

- `publication_success` audit events (validated through
  `loadPublicationReceiptForQueueItem` / `extractPublicationReceiptFromMetadata`
  — never parse raw metadata directly).
- `publishing_queue` rows in `published` state (`externalPostId`, `publishedAt`,
  `platform`, `integrationId`).
- `content_posts` published mirrors (`metadata.publishedPlatforms`,
  per-platform post ids).
- Campaign `workflowContext.audienceIntelligence*` results produced upstream
  (read-only).

## 8. Fields downstream consumers MUST NOT mutate

- Receipt audit events and the `publicationReceipt` metadata payload.
- `publishing_queue` rows (status transitions are owned by the publishing runner,
  recovery policy, and replay executors).
- Publish packages and their envelopes (`publishing_queue.metadata`).
- Strategy / Business DNA / creative-brief coordinates anywhere they appear.
- `credit_transactions`, `credit_reservations`, and any billing row.

## 9. Retry / idempotency semantics

- One logical publication ⇒ at most one durable receipt and at most one
  publishing charge per queue item (Stream E registry identity
  `publishing:{queueItemId}`; the runner's charge evidence is the durable
  `credit_transactions` row attributed by `metadata.queueItemId`, and retries
  under `retrying` skip the charge).
- Replays after success return `replay_success` with the stored receipt — zero
  provider calls, zero charges, zero mutation.
- Failures never mint receipts; the recovery policy
  (`decidePublicationRecovery`) owns retry/backoff/escalation classes.
  Post-live must treat non-`published` queue rows as NOT published (no success
  inference from `externalPostId` alone).

## 10. Unsupported / failed publication semantics

- **Unsupported provider:** fail closed at plan time (distribution eligibility)
  and at the adapter registry; no queue row may reach execution for a platform
  with no adapter.
- **Failed publication:** queue row in `failed` / `retrying` / `safety_blocked` /
  `pending_approval` states carries `lastError` and recovery fields. Post-live
  must not observe engagement for a publication that has no canonical receipt.
- **Ambiguous provider outcome:** never fabricated into success; the row parks in
  a retryable state and re-enters under the same identity.

## 11. Security invariants (normative)

1. Fail closed by default: malformed packages, tampered envelopes, drifted
   receipts, and stale launch authority block execution before any side effect.
2. Server-derived identities only: `operationId`, package id, receipt identity,
   and billing keys are pure functions of durable server coordinates.
3. Tenant isolation: publication reads/writes are owner-scoped at the DB layer;
   cross-user receipt loads fail closed.
4. No secrets downstream: tokens never appear in receipts, audit metadata,
   queue rows, or any post-live surface.
5. Authorization before external execution: launch approval lineage and the
   pre-publish validation gate re-validate on every attempt.
6. Lineage immutability: Strategy/creative coordinates are never mutated by
   distribution or post-live consumers.

## 12. Overlap-risk modules (coordinate before changing)

| Module | Why risky |
|---|---|
| `api/lib/workflow/publishing-runner.ts` | Execution authority shared with Stream E billing point |
| `api/lib/publish/publication-receipt*.ts` | Receipt contract consumed here and by reconciliation |
| `api/lib/publish/publication-idempotency.ts` / `publication-recovery-policy.ts` | Disposition/recovery semantics |
| `api/lib/queue/bullmq.ts` / `publishing-worker.ts` | Queue identity shared with Stream A contract §5 |
| `api/lib/integrations/adapters/*` | Provider boundary shared with Stream E residual tracking |
| `api/lib/agents/distribution-agent.ts` / `audience-intelligence-agent.ts` | Stream C-owned execution + billing-key plumbing |
| `db/schema.ts` (`publishing_queue`, `audit_events`) | Durable authority columns |
| `api/lib/workflow/triggers.ts` / `budget-resume.ts` | Stream A consume-only; C0.2 added key transport (argument-only) |

## 13. Migration / schema dependencies

None. This contract persists entirely in existing tables and columns:
`publishing_queue` (incl. `metadata` JSON envelope), `audit_events` (incl.
first-class `packageId` and unique `eventFingerprint`), `content_posts`
published mirrors, and the campaign `workflowContext` JSON. No migration was
executed or required for R4-C.

## 14. Known residuals (tracked, not silently owned)

1. `publishing_queue` has no DB unique constraint on
   `(userId, campaignId, contentPostId, platform)`; creation-time idempotency is
   a guarded select convention. A unique index is recommended at integration
   time (schema change, out of scope for R4-C per no-migration rule).
2. Provider calls carry no provider-side idempotency key (Meta/LinkedIn support
   them); the local receipt/disposition layer owns exact-once and a residual
   duplicate-external-post window remains after ambiguous failures (tracked in
   Stream E contract §9).
3. Legacy (non-governed) publications carry `classification: "legacy"` with null
   package fields; post-live must not treat legacy receipts as governed lineage.

*End of contract. Changes require a Stream C contract revision commit on
`feature/r4-c-distribution-autonomy`.*
