/**
 * R4-B2 — Immutable creative release package.
 *
 * The creative pipeline's terminal, durable artefact: a deterministic,
 * tamper-evident bundle identity that binds the campaign's released creative
 * evidence (message pack, rendered leaflet, caption artefacts, supporting
 * outputs) to the exact approved Strategy + Business DNA authority that
 * produced it.
 *
 * Design authority:
 * - Deterministic identity: crp:{campaignId}:{creativeBriefFingerprint}. The
 *   same logical release always derives the same package id, so retries and
 *   re-entries converge on exactly one authoritative package per brief.
 * - Sealed, never mutated: the package is persisted once under
 *   campaigns.workflowContext.creativeReleasePackage (JSON column — no
 *   migration). A re-seal with identical content is a no-op
 *   ("already_present"); a new brief fingerprint produces a new identity and
 *   supersedes the previous package, which remains historical evidence.
 * - Fail closed: missing/stale Strategy authority, missing or stale required
 *   artefacts, failed/generating outputs, or any artefact whose lineage does
 *   not bind to the approved authority all refuse to seal.
 * - Immutable inputs: sealing only reads creative artefacts; it never mutates
 *   posts, assets, or image rows. Previously approved historical artefacts
 *   are untouched.
 *
 * Stream C (distribution) consumes this package as the authoritative creative
 * release identity; see docs/CREATIVE_TO_DISTRIBUTION_CONTRACT.md.
 */

import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  campaigns,
  businesses,
  contentPosts,
  campaignAssets,
  generatedImages,
} from "@db/schema";
import { buildGroundedCreativeBrief } from "./brief-grounding";
import { getStrategyApprovalStatus } from "../workflow/strategy-approval";
import {
  getRecordFingerprint,
  isUsableLeafletUrl,
  isLeafletRecord,
  isTerminalFailureStatus,
  isGeneratingStatus,
} from "./publication-readiness";
import {
  CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY,
} from "./artifact-lineage";
import { logError, logInfo } from "../logger";

export const CREATIVE_RELEASE_PACKAGE_SCHEMA_VERSION = 1 as const;
export const CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY =
  "creativeReleasePackage" as const;

export type CreativeReleaseArtefactKind =
  | "message_pack"
  | "leaflet"
  | "caption_pack"
  | "caption_adaptation"
  | "content_post"
  | "supporting_asset";

export type CreativeReleaseReadinessReason =
  | "campaign_missing"
  | "brief_incomplete"
  | "strategy_authority_missing"
  | "strategy_authority_stale"
  | "message_pack_missing"
  | "message_pack_not_approved"
  | "message_pack_stale"
  | "leaflet_missing"
  | "leaflet_not_rendered"
  | "leaflet_stale"
  | "caption_artefacts_missing"
  | "caption_artefacts_stale"
  | "output_failed"
  | "output_stale"
  | "artefact_lineage_mismatch";

export interface CreativeReleaseArtefactRef {
  readonly kind: CreativeReleaseArtefactKind;
  readonly recordType: "campaign_asset" | "content_post";
  readonly recordId: number;
  readonly title: string;
  readonly creativeBriefFingerprint: string | null;
  readonly lineageFingerprintSha256: string | null;
}

export interface CreativeReleaseStrategyCoordinates {
  readonly strategySnapshotId: string;
  readonly strategyVersion: number;
  readonly businessDnaSnapshotId: string;
  readonly strategyHashSha256: string;
  readonly strategyRunId: number;
  readonly approvalRequestId: number;
  readonly creativeBriefFingerprint: string;
}

export interface CreativeReleasePackage {
  readonly schemaVersion: typeof CREATIVE_RELEASE_PACKAGE_SCHEMA_VERSION;
  readonly packageId: string;
  readonly packageFingerprintSha256: string;
  readonly campaignId: number;
  readonly userId: number;
  readonly creativeBriefFingerprint: string;
  readonly strategy: CreativeReleaseStrategyCoordinates;
  readonly artefacts: readonly CreativeReleaseArtefactRef[];
  /** Governed-campaign rows that carry no lineage/fingerprint evidence. */
  readonly legacyArtefactIds: readonly number[];
  /**
   * Historical rows replaced by a newer authoritative row for the same
   * artefact identity (regeneration/retry of the same operation). They are
   * recorded, never bundled, and never mutated.
   */
  readonly supersededArtefactIds: readonly number[];
  readonly quality: {
    readonly postsIncluded: number;
    readonly assetsIncluded: number;
    readonly renderedLeafletReady: boolean;
  };
  readonly sealedAtIso: string;
  readonly sealedBy: string;
  readonly supersedesPackageId: string | null;
}

// ─── Identity ───────────────────────────────────────────────────────────────

export function deriveCreativeReleasePackageIdentity(
  campaignId: number,
  creativeBriefFingerprint: string
): string {
  if (
    typeof campaignId !== "number" ||
    !Number.isInteger(campaignId) ||
    campaignId <= 0
  ) {
    throw new Error(`Invalid campaignId for release package: ${String(campaignId)}`);
  }
  if (
    typeof creativeBriefFingerprint !== "string" ||
    creativeBriefFingerprint.trim().length === 0
  ) {
    throw new Error("Invalid creativeBriefFingerprint for release package");
  }
  return `crp:${campaignId}:${creativeBriefFingerprint}`;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map(canonicalize).map((v) => JSON.parse(v)));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = JSON.parse(canonicalize(obj[key]));
    }
    return JSON.stringify(sorted);
  }
  return JSON.stringify(value);
}

/**
 * Deterministic content fingerprint of the sealed package. Seal metadata
 * (sealedAtIso, sealedBy, supersedesPackageId) intentionally does not
 * participate: the same evidence under the same authority always produces
 * the same fingerprint regardless of when or who sealed it.
 */
export function computeCreativeReleasePackageFingerprint(
  pkg: Pick<
    CreativeReleasePackage,
    | "schemaVersion"
    | "packageId"
    | "creativeBriefFingerprint"
    | "strategy"
    | "artefacts"
    | "legacyArtefactIds"
    | "supersededArtefactIds"
    | "quality"
  >
): string {
  return createHash("sha256")
    .update(
      canonicalize({
        schemaVersion: pkg.schemaVersion,
        packageId: pkg.packageId,
        creativeBriefFingerprint: pkg.creativeBriefFingerprint,
        strategy: pkg.strategy,
        artefacts: [...pkg.artefacts].sort((a, b) =>
          `${a.recordType}:${a.recordId}`.localeCompare(`${b.recordType}:${b.recordId}`)
        ),
        legacyArtefactIds: [...new Set(pkg.legacyArtefactIds)].sort((a, b) => a - b),
        supersededArtefactIds: [...new Set(pkg.supersededArtefactIds)].sort((a, b) => a - b),
        quality: pkg.quality,
      }),
      "utf8"
    )
    .digest("hex");
}

// ─── Record helpers ─────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readMetadata(record: unknown): Record<string, unknown> {
  const r = asRecord(record);
  if (!r) return {};
  const meta = r.metadata;
  if (meta && typeof meta === "string") {
    try {
      return JSON.parse(meta) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return asRecord(meta) ?? {};
}

function getRecordId(record: unknown): number | null {
  const r = asRecord(record);
  const id = r?.id;
  return typeof id === "number" ? id : null;
}

function getRecordTitle(record: unknown): string {
  const r = asRecord(record);
  const title = r?.title;
  return typeof title === "string" && title.trim() ? title.trim() : "Untitled";
}

function getAssetType(record: unknown): string | null {
  const r = asRecord(record);
  const meta = readMetadata(record);
  const assetType = meta.assetType ?? r?.assetType;
  return typeof assetType === "string" ? assetType : null;
}

interface ExtractedStrategyCoordinates {
  strategySnapshotId: string;
  strategyVersion: number | null;
  businessDnaSnapshotId: string;
  strategyHashSha256: string;
}

/**
 * Resolve the Strategy coordinates an artefact was produced under. Governed
 * artefacts carry them either spread at metadata top level (creative-agent
 * authority spread) or under the persisted lineage metadata key.
 */
function extractStrategyCoordinates(
  record: unknown
): ExtractedStrategyCoordinates | null {
  const meta = readMetadata(record);
  if (
    typeof meta.strategySnapshotId === "string" &&
    typeof meta.businessDnaSnapshotId === "string" &&
    typeof meta.strategyHashSha256 === "string"
  ) {
    return {
      strategySnapshotId: meta.strategySnapshotId,
      strategyVersion:
        typeof meta.strategyVersion === "number" ? meta.strategyVersion : null,
      businessDnaSnapshotId: meta.businessDnaSnapshotId,
      strategyHashSha256: String(meta.strategyHashSha256).toLowerCase(),
    };
  }
  const lineage = asRecord(meta[CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY]);
  const strategy = asRecord(lineage?.strategy);
  if (
    strategy &&
    typeof strategy.strategySnapshotId === "string" &&
    typeof strategy.businessDnaSnapshotId === "string" &&
    typeof strategy.strategyHashSha256 === "string"
  ) {
    return {
      strategySnapshotId: strategy.strategySnapshotId,
      strategyVersion:
        typeof strategy.strategyVersion === "number" ? strategy.strategyVersion : null,
      businessDnaSnapshotId: strategy.businessDnaSnapshotId,
      strategyHashSha256: String(strategy.strategyHashSha256).toLowerCase(),
    };
  }
  return null;
}

function extractLineageFingerprint(record: unknown): string | null {
  const meta = readMetadata(record);
  const lineage = asRecord(meta[CREATIVE_ARTIFACT_LINEAGE_METADATA_KEY]);
  const fingerprint = lineage?.lineageFingerprintSha256;
  return typeof fingerprint === "string" ? fingerprint : null;
}

function coordinatesMatch(
  extracted: ExtractedStrategyCoordinates,
  authority: CreativeReleaseStrategyCoordinates
): boolean {
  return (
    extracted.strategySnapshotId === authority.strategySnapshotId &&
    extracted.businessDnaSnapshotId === authority.businessDnaSnapshotId &&
    extracted.strategyHashSha256 === authority.strategyHashSha256.toLowerCase() &&
    (extracted.strategyVersion === null ||
      extracted.strategyVersion === authority.strategyVersion)
  );
}

// ─── Pure builder ───────────────────────────────────────────────────────────

export interface BuildCreativeReleasePackageInput {
  campaign?: unknown;
  business?: unknown;
  contentPosts?: unknown[];
  campaignAssets?: unknown[];
  generatedImages?: unknown[];
  sealedAtIso: string;
  sealedBy: string;
}

export type CreativeReleaseBuildResult =
  | {
      status: "sealed";
      readonly package: CreativeReleasePackage;
      readonly reasons: readonly [];
    }
  | {
      status: "incomplete";
      readonly reasons: readonly CreativeReleaseReadinessReason[];
      readonly diagnostics: {
        messagePackRecordId: number | null;
        leafletRecordId: number | null;
        captionRecordIds: readonly number[];
        legacyArtefactIds: readonly number[];
        supersededArtefactIds: readonly number[];
      };
    };

function latestByCreatedAt(records: unknown[]): unknown | null {
  return (
    [...records].sort((a, b) => {
      const aTime = new Date(String(asRecord(a)?.createdAt ?? 0)).getTime();
      const bTime = new Date(String(asRecord(b)?.createdAt ?? 0)).getTime();
      return bTime - aTime;
    })[0] ?? null
  );
}

export function buildCreativeReleasePackage(
  input: BuildCreativeReleasePackageInput
): CreativeReleaseBuildResult {
  const reasons: CreativeReleaseReadinessReason[] = [];
  const campaign = asRecord(input.campaign);
  if (!campaign) {
    return {
      status: "incomplete",
      reasons: ["campaign_missing"],
      diagnostics: {
        messagePackRecordId: null,
        leafletRecordId: null,
        captionRecordIds: [],
        legacyArtefactIds: [],
        supersededArtefactIds: [],
      },
    };
  }

  const campaignId = Number(campaign.id);
  const userId = Number(campaign.userId);
  const brief = buildGroundedCreativeBrief({
    campaign,
    business: input.business,
  });
  const currentFingerprint = brief.fingerprint;
  if (!currentFingerprint) {
    reasons.push("brief_incomplete");
  }

  // Approved Strategy authority is the package's root of trust.
  const approval = getStrategyApprovalStatus(input.campaign, input.business);
  if (!approval.lineage) {
    reasons.push("strategy_authority_missing");
  } else if (!approval.isCurrent) {
    reasons.push("strategy_authority_stale");
  }
  const lineage = approval.lineage;
  const authority: CreativeReleaseStrategyCoordinates | null = lineage
    ? {
        strategySnapshotId: lineage.strategySnapshotId,
        strategyVersion: lineage.strategyVersion,
        businessDnaSnapshotId: lineage.businessDnaSnapshotId,
        strategyHashSha256: lineage.strategyHashSha256,
        strategyRunId: lineage.strategyRunId,
        approvalRequestId: lineage.approvalRequestId,
        creativeBriefFingerprint: lineage.creativeBriefFingerprint,
      }
    : null;

  const bound = (record: unknown): boolean => {
    if (!authority) return false;
    const coordinates = extractStrategyCoordinates(record);
    if (!coordinates || !coordinatesMatch(coordinates, authority)) return false;
    const fingerprint = getRecordFingerprint(record);
    return fingerprint === currentFingerprint;
  };

  const artefacts: CreativeReleaseArtefactRef[] = [];
  const legacyArtefactIds: number[] = [];
  const supersededArtefactIds: number[] = [];
  const pushRef = (
    record: unknown,
    kind: CreativeReleaseArtefactKind,
    recordType: "campaign_asset" | "content_post"
  ) => {
    artefacts.push(
      Object.freeze({
        kind,
        recordType,
        recordId: getRecordId(record) ?? 0,
        title: getRecordTitle(record),
        creativeBriefFingerprint: getRecordFingerprint(record),
        lineageFingerprintSha256: extractLineageFingerprint(record),
      })
    );
  };

  // ─── Message architecture: the approved message pack ───
  const messagePacks = (input.campaignAssets ?? []).filter(
    (asset) => getAssetType(asset) === "message_pack"
  );
  const messagePack = latestByCreatedAt(messagePacks);
  let messagePackRecordId: number | null = null;
  if (!messagePack) {
    reasons.push("message_pack_missing");
  } else {
    messagePackRecordId = getRecordId(messagePack);
    const meta = readMetadata(messagePack);
    if (meta.passed !== true) {
      reasons.push("message_pack_not_approved");
    } else if (!bound(messagePack)) {
      reasons.push("artefact_lineage_mismatch");
    } else {
      pushRef(messagePack, "message_pack", "campaign_asset");
    }
  }

  // ─── Visual artefact: rendered marketing leaflet ───
  const leafletCandidates = (input.contentPosts ?? []).filter(
    (post) =>
      isLeafletRecord(post) &&
      typeof asRecord(post)?.campaignId === "number"
  );
  const leaflet = latestByCreatedAt(leafletCandidates);
  let leafletRecordId: number | null = null;
  let renderedLeafletReady = false;
  if (!leaflet) {
    reasons.push("leaflet_missing");
  } else {
    leafletRecordId = getRecordId(leaflet);
    const meta = readMetadata(leaflet);
    const imageStatus = meta.imageStatus;
    const imageUrl = meta.imageUrl;
    if (imageStatus !== "ready" || !isUsableLeafletUrl(imageUrl)) {
      reasons.push("leaflet_not_rendered");
    } else if (!bound(leaflet)) {
      reasons.push("artefact_lineage_mismatch");
    } else {
      renderedLeafletReady = true;
      pushRef(leaflet, "leaflet", "content_post");
    }
  }

  // ─── Caption artefacts ───
  // Exactly one authoritative caption pack per operation: the latest bound
  // caption_pack wins and older retries are superseded, never bundled.
  // caption_adaptations are per-platform variants of one operation: the
  // latest per platform is authoritative.
  const captionPacksAll = (input.campaignAssets ?? []).filter(
    (asset) => getAssetType(asset) === "caption_pack"
  );
  const captionAdaptationsAll = (input.campaignAssets ?? []).filter(
    (asset) => getAssetType(asset) === "caption_adaptation"
  );
  const captionRecordIds: number[] = [];
  if (captionPacksAll.length === 0 && captionAdaptationsAll.length === 0) {
    reasons.push("caption_artefacts_missing");
  } else {
    const latestCaptionPack = latestByCreatedAt(captionPacksAll);
    for (const pack of captionPacksAll) {
      if (pack !== latestCaptionPack) {
        const id = getRecordId(pack);
        if (id !== null) supersededArtefactIds.push(id);
      }
    }
    if (latestCaptionPack) {
      if (!bound(latestCaptionPack)) {
        reasons.push("caption_artefacts_stale");
      } else {
        captionRecordIds.push(getRecordId(latestCaptionPack) ?? 0);
        pushRef(latestCaptionPack, "caption_pack", "campaign_asset");
      }
    }

    const adaptationsByPlatform = new Map<string, unknown>();
    for (const adaptation of [...captionAdaptationsAll].sort((a, b) => {
      const aTime = new Date(String(asRecord(a)?.createdAt ?? 0)).getTime();
      const bTime = new Date(String(asRecord(b)?.createdAt ?? 0)).getTime();
      return aTime - bTime;
    })) {
      const platform = String(
        readMetadata(adaptation).platform ?? ""
      ).toLowerCase();
      const existing = adaptationsByPlatform.get(platform);
      if (existing) {
        const id = getRecordId(existing);
        if (id !== null) supersededArtefactIds.push(id);
      }
      adaptationsByPlatform.set(platform, adaptation);
    }
    for (const adaptation of adaptationsByPlatform.values()) {
      if (!bound(adaptation)) {
        reasons.push("caption_artefacts_stale");
        continue;
      }
      captionRecordIds.push(getRecordId(adaptation) ?? 0);
      pushRef(adaptation, "caption_adaptation", "campaign_asset");
    }
  }

  // ─── Supporting outputs: the latest current row per artefact identity ───
  // Every row claimed by a primary selection (message packs, caption
  // artefacts) is excluded from supporting-output grouping — a superseded
  // caption pack must never re-enter the manifest under another identity.
  const idsOf = (records: unknown[]): number[] =>
    records
      .map((record) => getRecordId(record))
      .filter((id): id is number => id !== null);
  const consumedIds = new Set<number>([
    ...idsOf(messagePacks),
    ...idsOf(captionPacksAll),
    ...idsOf(captionAdaptationsAll),
    ...(messagePackRecordId !== null ? [messagePackRecordId] : []),
    ...(leafletRecordId !== null ? [leafletRecordId] : []),
    ...captionRecordIds,
  ]);

  const groupKeyOf = (record: unknown, recordType: "campaign_asset" | "content_post") => {
    const type =
      getAssetType(record) ??
      (typeof asRecord(record)?.type === "string"
        ? (asRecord(record)!.type as string)
        : "unknown");
    return `${recordType}:${type}`;
  };

  const selectedOutputs = new Map<string, unknown>();
  const groupOutput = (record: unknown, recordType: "campaign_asset" | "content_post") => {
    const id = getRecordId(record);
    if (id === null || consumedIds.has(id)) return;
    const key = groupKeyOf(record, recordType);
    const existing = selectedOutputs.get(key);
    if (!existing) {
      selectedOutputs.set(key, record);
      return;
    }
    const existingTime = new Date(
      String(asRecord(existing)?.createdAt ?? 0)
    ).getTime();
    const newTime = new Date(String(asRecord(record)?.createdAt ?? 0)).getTime();
    const winner = newTime >= existingTime ? record : existing;
    const loser = newTime >= existingTime ? existing : record;
    selectedOutputs.set(key, winner);
    const loserId = getRecordId(loser);
    if (loserId !== null) supersededArtefactIds.push(loserId);
  };

  for (const post of input.contentPosts ?? []) groupOutput(post, "content_post");
  for (const asset of input.campaignAssets ?? []) groupOutput(asset, "campaign_asset");

  const inspectOutput = (record: unknown, recordType: "campaign_asset" | "content_post") => {
    const status = asRecord(record)?.status;
    if (status === "published" || status === "archived") return;
    if (isTerminalFailureStatus(record)) {
      reasons.push("output_failed");
      return;
    }
    if (isGeneratingStatus(record)) {
      reasons.push("output_failed");
      return;
    }
    const fingerprint = getRecordFingerprint(record);
    if (!fingerprint) {
      // Governed-campaign row without lineage evidence: excluded from the
      // package and recorded rather than silently bundled.
      const id = getRecordId(record);
      if (id !== null) legacyArtefactIds.push(id);
      return;
    }
    if (fingerprint !== currentFingerprint) {
      reasons.push("output_stale");
      return;
    }
    if (!bound(record)) {
      reasons.push("artefact_lineage_mismatch");
      return;
    }
    pushRef(record, recordType === "content_post" ? "content_post" : "supporting_asset", recordType);
  };

  for (const [key, record] of selectedOutputs) {
    inspectOutput(record, key.startsWith("content_post:") ? "content_post" : "campaign_asset");
  }

  const uniqueReasons = Array.from(new Set(reasons)) as CreativeReleaseReadinessReason[];
  if (uniqueReasons.length > 0 || !authority || !currentFingerprint) {
    return {
      status: "incomplete",
      reasons: uniqueReasons.length
        ? uniqueReasons
        : ["strategy_authority_missing"],
      diagnostics: {
        messagePackRecordId,
        leafletRecordId,
        captionRecordIds,
        legacyArtefactIds,
        supersededArtefactIds,
      },
    };
  }

  const sealed: CreativeReleasePackage = {
    schemaVersion: CREATIVE_RELEASE_PACKAGE_SCHEMA_VERSION,
    packageId: deriveCreativeReleasePackageIdentity(campaignId, currentFingerprint),
    packageFingerprintSha256: "",
    campaignId,
    userId,
    creativeBriefFingerprint: currentFingerprint,
    strategy: authority,
    artefacts: Object.freeze([...artefacts].sort((a, b) =>
      `${a.recordType}:${a.recordId}`.localeCompare(`${b.recordType}:${b.recordId}`)
    )),
    legacyArtefactIds: Object.freeze([...new Set(legacyArtefactIds)]),
    supersededArtefactIds: Object.freeze([...new Set(supersededArtefactIds)]),
    quality: Object.freeze({
      postsIncluded: artefacts.filter((ref) => ref.recordType === "content_post").length,
      assetsIncluded: artefacts.filter((ref) => ref.recordType === "campaign_asset").length,
      renderedLeafletReady,
    }),
    sealedAtIso: input.sealedAtIso,
    sealedBy: input.sealedBy,
    supersedesPackageId: null,
  };
  const withFingerprint = {
    ...sealed,
    packageFingerprintSha256: computeCreativeReleasePackageFingerprint(sealed),
  };
  return {
    status: "sealed",
    package: Object.freeze(withFingerprint),
    reasons: Object.freeze([]) as readonly [],
  };
}

// ─── Seal / read / verify ───────────────────────────────────────────────────

export function readSealedCreativeReleasePackage(
  campaign: unknown
): CreativeReleasePackage | null {
  const c = asRecord(campaign);
  const context = asRecord(c?.workflowContext);
  const pkg = asRecord(context?.[CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY]);
  if (!pkg || typeof pkg.packageId !== "string") return null;
  return pkg as unknown as CreativeReleasePackage;
}

/**
 * Fail-closed tamper check: re-derives the content fingerprint from the
 * sealed package's own fields. Any mutation of strategy coordinates, artefact
 * refs, or quality evidence after sealing throws.
 */
export function assertCreativeReleasePackageIntact(
  pkg: CreativeReleasePackage
): void {
  if (!pkg || typeof pkg !== "object") {
    throw new Error("Creative release package is missing or malformed");
  }
  if (pkg.schemaVersion !== CREATIVE_RELEASE_PACKAGE_SCHEMA_VERSION) {
    throw new Error("Creative release package has an unsupported schema version");
  }
  const recomputed = computeCreativeReleasePackageFingerprint(pkg);
  if (recomputed !== pkg.packageFingerprintSha256) {
    throw new Error("Creative release package fingerprint mismatch");
  }
}

export type SyncCreativeReleasePackageResult =
  | {
      outcome: "sealed" | "superseded_sealed" | "already_present";
      readonly packageId: string;
      readonly packageFingerprintSha256: string;
      readonly supersedesPackageId: string | null;
    }
  | {
      outcome: "incomplete";
      readonly reasons: readonly CreativeReleaseReadinessReason[];
    };

/**
 * Idempotently seal the campaign's creative release package from durable
 * evidence. Safe to call after every creative pipeline stage completion:
 * sealing converges on exactly one package per (campaign, brief) identity.
 * Never mutates creative artefacts — only the campaign workflow context slot.
 */
export async function syncCreativeReleasePackage({
  userId,
  campaignId,
  sealedBy,
  db,
}: {
  userId: number;
  campaignId: number;
  sealedBy: string;
  db?: any;
}): Promise<SyncCreativeReleasePackageResult> {
  const executor = db ?? getDb();
  const [campaign] = await executor
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)))
    .limit(1);

  if (!campaign) {
    return { outcome: "incomplete", reasons: ["campaign_missing"] };
  }

  let business: unknown = null;
  if (campaign.businessId) {
    [business] = await executor
      .select()
      .from(businesses)
      .where(eq(businesses.id, campaign.businessId))
      .limit(1);
  }

  const [postRows, assetRows, imageRows] = await Promise.all([
    executor
      .select()
      .from(contentPosts)
      .where(and(eq(contentPosts.userId, userId), eq(contentPosts.campaignId, campaignId))),
    executor
      .select()
      .from(campaignAssets)
      .where(and(eq(campaignAssets.userId, userId), eq(campaignAssets.campaignId, campaignId))),
    executor
      .select()
      .from(generatedImages)
      .where(and(eq(generatedImages.userId, userId), eq(generatedImages.campaignId, campaignId))),
  ]);

  const built = buildCreativeReleasePackage({
    campaign,
    business,
    contentPosts: postRows,
    campaignAssets: assetRows,
    generatedImages: imageRows,
    sealedAtIso: new Date().toISOString(),
    sealedBy,
  });

  if (built.status !== "sealed") {
    logInfo("[CreativeReleasePackage] not sealed", {
      campaignId,
      userId,
      reasons: built.reasons,
    });
    return { outcome: "incomplete", reasons: built.reasons };
  }

  const existing = readSealedCreativeReleasePackage(campaign);
  if (
    existing &&
    existing.packageId === built.package.packageId &&
    existing.packageFingerprintSha256 === built.package.packageFingerprintSha256
  ) {
    // Retry / duplicate trigger: identical evidence and authority — the
    // sealed package is reused and the durable record is left untouched.
    return {
      outcome: "already_present",
      packageId: built.package.packageId,
      packageFingerprintSha256: built.package.packageFingerprintSha256,
      supersedesPackageId: existing.supersedesPackageId ?? null,
    };
  }

  const supersedesPackageId =
    existing && existing.packageId !== built.package.packageId
      ? existing.packageId
      : null;
  const sealedPackage = {
    ...built.package,
    supersedesPackageId,
  };

  await executor
    .update(campaigns)
    .set({
      workflowContext: {
        ...(asRecord(campaign.workflowContext) ?? {}),
        [CREATIVE_RELEASE_PACKAGE_CONTEXT_KEY]: sealedPackage,
      } as any,
    })
    .where(eq(campaigns.id, campaignId));

  logInfo("[CreativeReleasePackage] sealed", {
    campaignId,
    userId,
    packageId: sealedPackage.packageId,
    sealedBy,
    supersedesPackageId,
  });

  return {
    outcome: supersedesPackageId ? "superseded_sealed" : "sealed",
    packageId: sealedPackage.packageId,
    packageFingerprintSha256: sealedPackage.packageFingerprintSha256,
    supersedesPackageId,
  };
}

/**
 * Best-effort seal wrapper for pipeline stage completions. Seal bookkeeping
 * must never fail a creative operation, so errors are logged and swallowed.
 */
export async function syncCreativeReleasePackageSafely(input: {
  userId: number;
  campaignId: number | null | undefined;
  sealedBy: string;
  db?: any;
}): Promise<SyncCreativeReleasePackageResult | null> {
  if (
    typeof input.campaignId !== "number" ||
    !Number.isInteger(input.campaignId) ||
    input.campaignId <= 0
  ) {
    return null;
  }
  try {
    return await syncCreativeReleasePackage({
      userId: input.userId,
      campaignId: input.campaignId,
      sealedBy: input.sealedBy,
      db: input.db,
    });
  } catch (err) {
    logError("[CreativeReleasePackage] seal attempt failed", {
      campaignId: input.campaignId,
      userId: input.userId,
      sealedBy: input.sealedBy,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
