/**
 * Server-side campaign publication-readiness resolver.
 *
 * Phase 2B — server-authoritative gate:
 * - Computes the current creative-brief fingerprint from the persisted campaign
 *   brief (not from workflow state or HTTP 200 responses).
 * - Treats publishable output as stale unless its metadata contains the exact
 *   current creativeBriefFingerprint.
 * - Requires a durable Marketing Leaflet with a usable preview URL, a current
 *   caption/message pack, and current supporting/content output before any
 *   campaign pack can be published.
 * - Enforces the same rule for individual publication/scheduling paths so a
 *   disabled frontend button cannot be bypassed.
 */

import { buildGroundedCreativeBrief } from "./brief-grounding";
import { logInfo, logError } from "../logger";
import { TRPCError } from "@trpc/server";

export type CampaignPublicationReadinessReason =
  | "campaign_missing"
  | "brief_incomplete"
  | "leaflet_missing"
  | "leaflet_stale"
  | "caption_pack_missing"
  | "caption_pack_stale"
  | "selected_output_missing"
  | "selected_output_stale"
  | "approval_pending"
  | "output_failed"
  | "output_stale";

export interface CampaignPublicationReadinessOutput {
  present: boolean;
  current: boolean;
  recordId: number | string | null;
}

export interface CampaignPublicationReadiness {
  ready: boolean;
  currentCreativeBriefFingerprint: string;
  reasons: CampaignPublicationReadinessReason[];
  requiredOutputs: {
    leaflet: CampaignPublicationReadinessOutput;
    captionPack: CampaignPublicationReadinessOutput;
  };
}

export interface CampaignOutputRecord {
  id?: number | string | null | undefined;
  status?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  assetType?: string | null | undefined;
  type?: string | null | undefined;
  url?: string | null | undefined;
}

function asUnknown(value: unknown): any {
  return value as any;
}

function getRecordId(record: unknown): number | string | null {
  const r = asUnknown(record);
  if (r == null) return null;
  if (typeof r.id === "number") return r.id;
  if (typeof r.id === "string") return r.id;
  return null;
}

function getRecordMetadata(record: unknown): Record<string, unknown> {
  const r = asUnknown(record);
  if (!r || typeof r !== "object") return {};
  const meta = (r as Record<string, unknown>).metadata;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) return meta as Record<string, unknown>;
  return {};
}

function getRecordStatus(record: unknown): string | null {
  const r = asUnknown(record);
  if (!r || typeof r !== "object") return null;
  const status = (r as Record<string, unknown>).status;
  return typeof status === "string" ? status : null;
}

export function getRecordFingerprint(record: unknown): string | null {
  const meta = getRecordMetadata(record);
  const value = meta.creativeBriefFingerprint;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isUsableLeafletUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed === "[object Object]") return false;
  if (trimmed.toLowerCase().startsWith("javascript:")) return false;
  // Established renderer-supported forms: absolute http(s) URLs and absolute paths.
  return /^https?:\/\//i.test(trimmed) || trimmed.startsWith("/");
}

export function isLeafletRecord(record: unknown): boolean {
  if (!record || typeof record !== "object") return false;
  const meta = getRecordMetadata(record);
  const r = asUnknown(record);

  // Explicit leaflet identities only. Generic imageSource / provider / aiGenerated
  // are never sufficient on their own.
  const assetType =
    typeof meta.assetType === "string" ? meta.assetType : typeof r.assetType === "string" ? r.assetType : null;
  const assetKind =
    typeof meta.assetKind === "string" ? meta.assetKind : typeof r.assetKind === "string" ? r.assetKind : null;

  if (assetType === "leaflet") return true;
  if (assetKind === "master_campaign_post") return true;
  return false;
}

export function getLeafletOwnUrl(record: unknown): string | undefined {
  if (!isLeafletRecord(record)) return undefined;
  const meta = getRecordMetadata(record);
  const r = asUnknown(record);
  const candidates = [meta.imageUrl, meta.url, r.url, r.imageUrl];
  for (const candidate of candidates) {
    if (isUsableLeafletUrl(candidate)) return candidate;
  }
  return undefined;
}

export function findDurableLeafletRecord(
  contentPosts: unknown[] | undefined,
  campaignAssets: unknown[] | undefined,
  generatedImages: unknown[] | undefined
): unknown | null {
  const candidates: unknown[] = [
    ...(contentPosts || []),
    ...(campaignAssets || []),
    ...(generatedImages || []),
  ];

  const leaflets = candidates
    .filter((c) => isLeafletRecord(c) && !!getLeafletOwnUrl(c))
    .sort((a, b) => {
      const aTime = new Date((asUnknown(a).createdAt as string) || 0).getTime();
      const bTime = new Date((asUnknown(b).createdAt as string) || 0).getTime();
      return bTime - aTime;
    });

  return leaflets[0] || null;
}

export function findCaptionPackRecord(campaignAssets: unknown[] | undefined): unknown | null {
  const assets = (campaignAssets || []).filter((a) => {
    const r = asUnknown(a);
    const meta = getRecordMetadata(a);
    const assetType =
      typeof meta.assetType === "string" ? meta.assetType : typeof r.assetType === "string" ? r.assetType : null;
    return assetType === "caption_pack" || assetType === "caption_adaptation";
  });
  return assets.sort((a, b) => {
    const aTime = new Date((asUnknown(a).createdAt as string) || 0).getTime();
    const bTime = new Date((asUnknown(b).createdAt as string) || 0).getTime();
    return bTime - aTime;
  })[0] || null;
}

export function isTerminalFailureStatus(record: unknown): boolean {
  const status = getRecordStatus(record);
  const meta = getRecordMetadata(record);
  if (status === "failed" || status === "cancelled") return true;
  const metaStatus = meta.imageStatus || meta.videoStatus || meta.status;
  if (metaStatus === "failed" || metaStatus === "cancelled") return true;
  return false;
}

export function isGeneratingStatus(record: unknown): boolean {
  const status = getRecordStatus(record);
  const meta = getRecordMetadata(record);
  if (status === "generating" || status === "pending" || status === "running" || status === "queued") return true;
  const metaStatus = meta.imageStatus || meta.videoStatus || meta.status;
  if (metaStatus === "generating" || metaStatus === "pending" || metaStatus === "running" || metaStatus === "queued") return true;
  return false;
}

function isBriefComplete(campaign: unknown): boolean {
  if (!campaign || typeof campaign !== "object") return false;
  const c = campaign as Record<string, unknown>;
  const coreFields = [
    c.productOrService,
    c.targetBuyer,
    c.mainPainPoint,
    c.primaryOutcome,
    c.coreMessage,
  ];
  return coreFields.some((value) => typeof value === "string" && value.trim().length > 0);
}

function hasApprovedLaunchApproval(approvals: unknown[] | undefined): boolean {
  if (!approvals || !Array.isArray(approvals)) return false;
  return approvals.some((a) => {
    const approval = asUnknown(a);
    return (
      approval?.approvalType === "campaign_launch" &&
      (approval?.status === "approved" || approval?.status === "edited")
    );
  });
}

function computeCurrentFingerprint(campaign: unknown, business?: unknown): string {
  try {
    const brief = buildGroundedCreativeBrief({ campaign, business });
    return brief.fingerprint;
  } catch (err) {
    logError("[PublicationReadiness] failed to compute creative brief fingerprint", { error: (err as Error).message });
    return "";
  }
}

export function isOutputCurrent(record: unknown, currentFingerprint: string): boolean {
  if (!currentFingerprint) return false;
  const stored = getRecordFingerprint(record);
  return stored === currentFingerprint;
}

export interface ResolveCampaignPublicationReadinessInput {
  campaign?: unknown;
  business?: unknown;
  contentPosts?: unknown[];
  campaignAssets?: unknown[];
  generatedImages?: unknown[];
  approvals?: unknown[];
  selectedOutput?: {
    record: unknown;
    type: "content_post" | "campaign_asset" | "generated_image";
  };
  /**
   * When true, single-item paths (approve a queue item, schedule, mark posted,
   * publish a single post) also require an approved campaign_launch approval.
   * Approve-only paths should pass false so they do not deadlock on the very
   * approval they are designed to grant to a queue item.
   */
  requireLaunchApproval?: boolean;
}

export function resolveCampaignPublicationReadiness(
  input: ResolveCampaignPublicationReadinessInput
): CampaignPublicationReadiness {
  const { campaign, business, contentPosts, campaignAssets, generatedImages, approvals, selectedOutput, requireLaunchApproval } = input;
  const reasons: CampaignPublicationReadinessReason[] = [];
  const isSingleMode = !!selectedOutput;

  // One-off content support: if a selected output is not linked to any campaign,
  // it is outside the scope of the campaign-readiness gate and is allowed.
  if (selectedOutput?.record && typeof selectedOutput.record === "object") {
    const recordCampaignId = asUnknown(selectedOutput.record).campaignId;
    if (recordCampaignId == null || recordCampaignId === undefined) {
      return {
        ready: true,
        currentCreativeBriefFingerprint: "",
        reasons: [],
        requiredOutputs: {
          leaflet: { present: false, current: false, recordId: null },
          captionPack: { present: false, current: false, recordId: null },
        },
      };
    }
  }

  if (!campaign || typeof campaign !== "object") {
    reasons.push("campaign_missing");
    return {
      ready: false,
      currentCreativeBriefFingerprint: "",
      reasons,
      requiredOutputs: {
        leaflet: { present: false, current: false, recordId: null },
        captionPack: { present: false, current: false, recordId: null },
      },
    };
  }

  const currentFingerprint = computeCurrentFingerprint(campaign, business);

  if (!isBriefComplete(campaign)) {
    reasons.push("brief_incomplete");
  }

  // ─── Single-item mode (individual publish / schedule / mark posted) ───
  if (isSingleMode) {
    const { record } = selectedOutput;
    if (!record || typeof record !== "object") {
      reasons.push("selected_output_missing");
    } else {
      if (isTerminalFailureStatus(record)) {
        reasons.push("output_failed");
      } else if (isGeneratingStatus(record)) {
        reasons.push("output_failed");
      } else if (!isOutputCurrent(record, currentFingerprint)) {
        reasons.push("selected_output_stale");
      }
    }

    // Final publication / scheduling of a campaign-linked post requires the
    // campaign launch approval, but the queue-item approval step must not.
    if (requireLaunchApproval && !hasApprovedLaunchApproval(approvals)) {
      reasons.push("approval_pending");
    }

    const uniqueReasons = Array.from(new Set(reasons));
    const ready = uniqueReasons.length === 0;
    logInfo("[PublicationReadiness] resolved single-item", {
      ready,
      currentCreativeBriefFingerprint: currentFingerprint,
      reasons: uniqueReasons,
      requireLaunchApproval,
    });
    return {
      ready,
      currentCreativeBriefFingerprint: currentFingerprint,
      reasons: uniqueReasons,
      requiredOutputs: {
        leaflet: { present: false, current: false, recordId: null },
        captionPack: { present: false, current: false, recordId: null },
      },
    };
  }

  // ─── Pack mode (publishCampaignPack) ───

  // Durable Marketing Leaflet
  const leafletRecord = findDurableLeafletRecord(contentPosts, campaignAssets, generatedImages);
  const leafletPresent = !!leafletRecord;
  const leafletCurrent = leafletPresent && isOutputCurrent(leafletRecord, currentFingerprint);
  if (!leafletPresent) {
    reasons.push("leaflet_missing");
  } else if (!leafletCurrent) {
    reasons.push("leaflet_stale");
  }

  // Caption / Message Pack
  const captionPackRecord = findCaptionPackRecord(campaignAssets);
  const captionPackPresent = !!captionPackRecord;
  const captionPackCurrent = captionPackPresent && isOutputCurrent(captionPackRecord, currentFingerprint);
  if (!captionPackPresent) {
    reasons.push("caption_pack_missing");
  } else if (!captionPackCurrent) {
    reasons.push("caption_pack_stale");
  }

  // Included outputs (content posts + campaign assets)
  const includedOutputs = [...(contentPosts || []), ...(campaignAssets || [])];
  for (const output of includedOutputs) {
    if (!output || typeof output !== "object") continue;
    const r = asUnknown(output);
    const meta = getRecordMetadata(output);

    const status = getRecordStatus(output);
    if (status === "published" || status === "archived") {
      if (isTerminalFailureStatus(output)) {
        reasons.push("output_failed");
      }
      continue;
    }

    // Skip the leaflet and caption pack themselves — they are checked above.
    const isLeaflet = isLeafletRecord(output);
    const assetType =
      typeof meta.assetType === "string" ? meta.assetType : typeof r.assetType === "string" ? r.assetType : null;
    const isCaption = assetType === "caption_pack" || assetType === "caption_adaptation";
    if (isLeaflet || isCaption) continue;

    if (isTerminalFailureStatus(output)) {
      reasons.push("output_failed");
      continue;
    }
    if (isGeneratingStatus(output)) {
      reasons.push("output_failed");
      continue;
    }

    if (!isOutputCurrent(output, currentFingerprint)) {
      reasons.push("output_stale");
    }
  }

  // Launch approval
  if (!hasApprovedLaunchApproval(approvals)) {
    reasons.push("approval_pending");
  }

  const uniqueReasons = Array.from(new Set(reasons));
  const ready = uniqueReasons.length === 0;

  logInfo("[PublicationReadiness] resolved pack", {
    ready,
    currentCreativeBriefFingerprint: currentFingerprint,
    reasons: uniqueReasons,
    leafletRecordId: getRecordId(leafletRecord),
    captionPackRecordId: getRecordId(captionPackRecord),
  });

  return {
    ready,
    currentCreativeBriefFingerprint: currentFingerprint,
    reasons: uniqueReasons,
    requiredOutputs: {
      leaflet: {
        present: leafletPresent,
        current: leafletCurrent,
        recordId: getRecordId(leafletRecord),
      },
      captionPack: {
        present: captionPackPresent,
        current: captionPackCurrent,
        recordId: getRecordId(captionPackRecord),
      },
    },
  };
}

export function buildPublicationReadinessErrorMessage(result: CampaignPublicationReadiness): string {
  if (result.ready) return "Campaign is ready to publish.";

  const messages: Record<CampaignPublicationReadinessReason, string> = {
    campaign_missing: "Campaign not found.",
    brief_incomplete: "Campaign brief is incomplete. Update the campaign brief before publishing.",
    leaflet_missing: "Marketing Leaflet is missing. Generate a Marketing Leaflet from the current brief before publishing.",
    leaflet_stale: "Marketing Leaflet is stale. Regenerate it from the current brief before publishing.",
    caption_pack_missing: "Caption pack is missing. Generate captions from the current brief before publishing.",
    caption_pack_stale: "Caption pack is stale. Regenerate it from the current brief before publishing.",
    selected_output_missing: "Selected output does not exist.",
    selected_output_stale: "Selected output is stale. Regenerate it from the current brief before publishing.",
    approval_pending: "Campaign launch approval is pending. Complete the approval before publishing.",
    output_failed: "One or more campaign outputs are failed, cancelled, or still generating. Review and regenerate them before publishing.",
    output_stale: "One or more campaign outputs are stale relative to the current brief. Regenerate them before publishing.",
  };

  const joined = result.reasons.map((reason) => messages[reason]).filter(Boolean).join(" ");
  return joined || "This campaign cannot be published right now.";
}

export function assertCampaignPublicationReadiness(result: CampaignPublicationReadiness): void {
  if (result.ready) return;

  // Missing campaign or selected output is an ownership/existence issue, not a
  // readiness precondition. Use NOT_FOUND so we do not leak another user's
  // campaign details through different status codes.
  if (result.reasons.includes("campaign_missing") || result.reasons.includes("selected_output_missing")) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: buildPublicationReadinessErrorMessage(result),
      cause: { reasons: result.reasons, currentCreativeBriefFingerprint: result.currentCreativeBriefFingerprint },
    });
  }

  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: buildPublicationReadinessErrorMessage(result),
    cause: { reasons: result.reasons, currentCreativeBriefFingerprint: result.currentCreativeBriefFingerprint },
  });
}
