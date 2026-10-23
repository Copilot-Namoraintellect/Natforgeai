# CREATIVE → DISTRIBUTION CONTRACT (R4-B)

> **Stream:** WBS-R4 Stream B — Autonomous Creative Factory
> **Branch:** `feature/r4-b-creative-autonomy`
> **Audience:** Stream C (distribution / publishing) and R4 integration
> **Status:** authoritative as of the R4-B acceptance harness (commit `e83244c`)

This contract defines the single authoritative hand-off surface from the
creative pipeline to distribution. Stream C consumes the creative release
package defined here; it must not re-derive creative authority, re-assemble
creative evidence, or mutate creative artefacts.

---

## 1. Authoritative release package identity

The authoritative creative release artefact is the **immutable creative
release package** sealed by Stream B:

- **Location:** `campaigns.workflowContext.creativeReleasePackage`
  (constant: `CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY` in
  `api/lib/creative/release-package.ts`).
- **Package id (deterministic):** `crp:{campaignId}:{creativeBriefFingerprint}`
  (`deriveCreativeReleasePackageIdentity`). Exactly one authoritative package
  exists per (campaign, brief) identity.
- **Content fingerprint:** `packageFingerprintSha256`
  (`computeCreativeReleasePackageFingerprint`). Deterministic over sealed
  content; independent of seal metadata (`sealedAtIso`, `sealedBy`,
  `supersedesPackageId`).
- **Tamper check:** `assertCreativeReleasePackageIntact(pkg)` re-derives the
  fingerprint and throws on any post-seal mutation. Stream C must run this
  check before consuming a package.
- **Absence means "not released":** no sealed package ⇒ the creative set is
  incomplete, stale or ungoverned; distribution must fail closed (continue to
  use the existing per-item publication-readiness gates, which remain
  authoritative for launch mechanics).

## 2. Required lineage fields (must be present and current)

Every sealed package carries, in `package.strategy`:

| Field | Meaning |
|---|---|
| `strategySnapshotId` | Immutable WBS11 Strategy snapshot id |
| `strategyVersion` | Snapshot version |
| `businessDnaSnapshotId` | Business DNA snapshot bound at Strategy approval |
| `strategyHashSha256` | Canonical hash of the Strategy snapshot payload |
| `strategyRunId` | Strategy agent run |
| `approvalRequestId` | strategy_review approval request |
| `creativeBriefFingerprint` | Grounded brief fingerprint the release binds to |

Every artefact ref in `package.artefacts[]` must carry
`creativeBriefFingerprint === package.creativeBriefFingerprint` and bind to
the same Strategy coordinates (`creativeBriefFingerprint`,
`lineageFingerprintSha256` when the row carries a persisted lineage record).
The builder enforces this; Stream C may rely on it after
`assertCreativeReleasePackageIntact` passes.

## 3. Readiness state

| State | How to detect | Meaning |
|---|---|---|
| Released | `readSealedCreativeReleasePackage(campaign)` returns a package and `assertCreativeReleasePackageIntact` passes | Complete governed creative set, current under the approved brief |
| Not released | No package, or package absent / fingerprint mismatch | Do not distribute on creative authority; fall back to existing gates |

Supersession: when the brief changes and the campaign is re-approved and
regenerated, a new package id is sealed with `supersedesPackageId` pointing at
the previous package. Distribution must consume the latest sealed identity
for the current brief fingerprint only.

## 4. Artefact completeness requirements

A sealed package always contains exactly:

- `message_pack` — one ref, the approved Campaign Message Pack
  (campaign_assets, `metadata.passed === true`).
- `leaflet` — one ref, the master campaign post
  (`metadata.imageStatus === "ready"` with a usable `imageUrl`).
- `caption_pack` — one ref (latest authoritative) and optionally
  `caption_adaptation` refs (per-platform variants).
- `supporting_asset` / `content_post` refs — the remaining current outputs.
- `legacyArtefactIds` — ungoverned rows, recorded but never bundled.
- `supersededArtefactIds` — historical rows replaced by newer authoritative
  rows; recorded, never bundled, never mutated.

Artefact refs expose `kind`, `recordType` (`campaign_asset` | `content_post`),
`recordId`, `title`, `creativeBriefFingerprint`, `lineageFingerprintSha256`.

## 5. Retry / idempotency identity for downstream consumers

- Re-consuming the same `packageId` any number of times is safe: the sealed
  record is immutable and retry-safe (`already_present` semantics in
  `syncCreativeReleasePackage`).
- Distribution's own queue idempotency
  (`(userId, campaignId, contentPostId, platform)`) remains unchanged and
  composes with the release identity: use the release only to select and
  validate content, not to replace queue dedup.
- If a sealed package must be referenced in durable distribution rows, store
  `packageId` + `packageFingerprintSha256` (both stable); never store a
  mutable projection of the package.

## 6. Fields downstream distribution MAY consume

- `packageId`, `packageFingerprintSha256`, `campaignId`, `userId`,
  `creativeBriefFingerprint`.
- `strategy` (all seven coordinates — carry into publish-package evidence as
  Stream C already does for `PublishPackageStrategyAuthority`).
- `artefacts[]` (refs, including per-artefact fingerprints).
- `quality.renderedLeafletReady`, `sealedAtIso`, `sealedBy`,
  `supersedesPackageId`, `legacyArtefactIds`, `supersededArtefactIds`.

## 7. Fields downstream distribution MUST NOT mutate

- The sealed package record (`campaigns.workflowContext.creativeReleasePackage`)
  — Stream B owns sealing. Corrections flow through regeneration + re-seal.
- Creative artefact rows referenced by the package (content posts, campaign
  assets, generated images) and their metadata lineage keys.
- `strategy*` / `businessDnaSnapshotId` coordinates anywhere they appear.
- The creative brief fields that feed `creativeBriefFingerprint`.

## 8. Shared modules Stream C must consume (not duplicate)

| Module | Use |
|---|---|
| `api/lib/creative/release-package.ts` | Read/verify the release package (`readSealedCreativeReleasePackage`, `assertCreativeReleasePackageIntact`) |
| `api/lib/creative/publication-readiness.ts` + `publication-readiness-service.ts` | Existing launch/readiness gate (unchanged, still authoritative) |
| `api/lib/publish/publish-package-builder.ts` | Per-platform `PublishPackage` assembly (unchanged) |
| `api/lib/creative/artifact-lineage.ts` | Lineage normalization/tamper checks |
| `api/lib/workflow/strategy-approval.ts` | Strategy approval status/lineage semantics |
| `contracts/image-render-claim-errors.ts` | Sanitized claim error contract (if render claims are enabled) |

## 9. Boundaries

- This contract covers the **creative release** only. Launch approval,
  scheduling, queueing, provider publishing and receipts remain Stream C
  authority (see `docs/publishing-workflow-system-documentation.md`).
- Video artefacts remain optional: existing product support boundaries are
  preserved; a video render job does not participate in the release manifest.
- Stream B does not execute migrations; the package persists in the existing
  JSON workflow context.

## 10. Security considerations (R4 security addendum)

- The sealed package carries lineage coordinates and identifiers only — no
  secrets, tokens, prompts with credential material, or provider payloads.
  Stream C must not add any when persisting or forwarding the package.
- Tenant isolation: sealing is authorized by (campaignId + userId) lookup; a
  cross-tenant seal returns `campaign_missing` and writes nothing. The package
  is server-side only; there is no client endpoint that writes it.
- Fail-closed: malformed or tampered sealed context fails
  `assertCreativeReleasePackageIntact` / reads as absent; database or provider
  failure during sealing never produces a fallback seal.
- `content.approve` binds approval to the server-computed brief fingerprint;
  the key is in the WBS12.9 approval-authority metadata strip list so client
  metadata passthrough cannot mint or forge it.
- Error surfaces transport tRPC codes and reason codes only; no stack traces,
  connection strings or provider details are added by this stream.
