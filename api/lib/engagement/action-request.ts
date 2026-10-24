/**
 * Canonical Engagement Action Request (WBS-R5-C1).
 *
 * Server-side construction of governed marketing action requests for
 * engagement actions only. The R5-E action vocabulary is consumed, never
 * redefined: E's `buildMarketingActionRequest` performs the authoritative
 * validation and this module feeds it exclusively server-derived fields.
 *
 * Identity binding (fail closed, pure — no I/O):
 * - the action request binds business + signal identity/version +
 *   interpretation identity + action type + provider account binding +
 *   external target + response-context version into one stable
 *   `actionRequestId`;
 * - a cross-business signal, a forged interpretation (signalId /
 *   signalVersion mismatch), or a business/interpretation mismatch is
 *   rejected before any policy evaluation;
 * - the client can never supply risk/policy/approval/billing fields — E's
 *   request contract rejects them and this constructor never exposes them.
 *
 * Only engagement action types the provider boundary actually supports are
 * constructible here (`ENGAGEMENT_ACTION_TYPES`). Other R5-E vocabulary
 * entries remain governed by policy but are never built by this stream.
 */

import { createHash } from "crypto";
import {
  buildMarketingActionRequest,
  deriveCostClass,
  type MarketingActionRequest,
  type MarketingActionType,
  type MarketingPlatform,
  type ProviderAccountBindingRef,
} from "../policy/action-request";

export const ENGAGEMENT_ACTION_CONTRACT_VERSION = "engagement/action-request@v1";

/**
 * Engagement action types this stream constructs, drawn verbatim from the
 * R5-E vocabulary. `reply_publicly` is the only provider-capable type;
 * `escalate_to_human` / `suppress_action` are durable routings with no
 * external effect. react / reply_privately have no repository transport
 * seam (see provider-boundary) and are never built.
 */
export const ENGAGEMENT_ACTION_TYPES = [
  "reply_publicly",
  "escalate_to_human",
  "suppress_action",
] as const;
export type EngagementActionType = (typeof ENGAGEMENT_ACTION_TYPES)[number];

export function isEngagementActionType(value: unknown): value is EngagementActionType {
  return (
    typeof value === "string" &&
    (ENGAGEMENT_ACTION_TYPES as readonly string[]).includes(value)
  );
}

export class EngagementActionRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngagementActionRequestError";
    this.code = code;
  }
}

/** Read-only view of the R5-A canonical signal fields C binds to. */
export interface EngagementSourceSignal {
  signalId: string;
  signalVersion: number;
  businessId: number | null;
  userId: number;
  provider: string;
  platform: string;
  /** sha256 of the sanitized aligned signal (R5-B signalContentHash input). */
  providerEvidenceHash: string;
  /** Bounded original social text — untrusted evidence for generation. */
  contentText?: string | null;
}

/** Read-only view of the R5-B interpretation fields C binds to. */
export interface EngagementSourceInterpretation {
  interpretationId: string;
  signalId: string;
  signalVersion: number;
  signalContentHash: string;
  classifierVersion: string;
  businessId: number | null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

export interface ResponseContextVersionInput {
  interpretationId: string;
  signalContentHash: string;
  providerEvidenceHash: string;
  /** Business DNA snapshot id when one governed the interpretation; else null. */
  businessDnaSnapshotId: string | null;
  platform: string;
}

/**
 * Fingerprint of the exact response context being acted on. Binds approvals
 * to one interpretation version + evidence + brand context: any change
 * produces a new context version, which the R5-E gate detects as
 * CONTEXT_VERSION_MISMATCH at execution time.
 */
export function deriveResponseContextVersion(input: ResponseContextVersionInput): string {
  return sha256Hex(
    canonicalize({
      contractVersion: ENGAGEMENT_ACTION_CONTRACT_VERSION,
      interpretationId: input.interpretationId,
      signalContentHash: input.signalContentHash,
      providerEvidenceHash: input.providerEvidenceHash,
      businessDnaSnapshotId: input.businessDnaSnapshotId ?? null,
      platform: input.platform,
    })
  );
}

export interface EngagementActionRequestIdentityInput {
  businessId: number;
  signalId: string;
  signalVersion: number;
  interpretationId: string;
  actionType: EngagementActionType;
  provider: string;
  integrationId: number | null;
  externalTarget: string;
  responseContextVersion: string;
}

/**
 * Stable server-derived action-request identity. Retried constructions of
 * the same logical action converge to the same id; any material change to
 * the bound inputs produces a different id (and therefore a fresh policy
 * scope under R5-E).
 */
export function deriveEngagementActionRequestId(
  input: EngagementActionRequestIdentityInput
): string {
  return (
    "eng_" +
    sha256Hex(
      canonicalize({
        contractVersion: ENGAGEMENT_ACTION_CONTRACT_VERSION,
        businessId: input.businessId,
        signalId: input.signalId,
        signalVersion: input.signalVersion,
        interpretationId: input.interpretationId,
        actionType: input.actionType,
        provider: input.provider,
        integrationId: input.integrationId,
        externalTarget: input.externalTarget,
        responseContextVersion: input.responseContextVersion,
      })
    ).slice(0, 40)
  );
}

export interface BuildEngagementActionRequestInput {
  businessId: number;
  userId: number;
  signal: EngagementSourceSignal;
  interpretation: EngagementSourceInterpretation;
  actionType: EngagementActionType;
  platform: MarketingPlatform;
  /** Server-verified binding; required for provider-capable actions. */
  providerAccountBinding: ProviderAccountBindingRef | null;
  /** External object/thread id (e.g. comment id) the action targets. */
  externalTarget: string;
  campaignId?: number | null;
  publicationId?: number | null;
  requestedAt: string;
  businessDnaSnapshotId?: string | null;
}

/**
 * Build the governed action request for one engagement action.
 * Pure and fail closed: identity mismatches throw before E validation.
 * `contextVersion` is the response-context version — pinning approvals to
 * the exact interpretation/evidence/brand context (C4 binding).
 */
export function buildEngagementActionRequest(
  input: BuildEngagementActionRequestInput
): MarketingActionRequest {
  if (input.signal.businessId == null) {
    throw new EngagementActionRequestError(
      "UNATTRIBUTED_SIGNAL",
      `UNATTRIBUTED_SIGNAL: signal carries no authoritative business attribution; engagement actions require a business-bound signal.`
    );
  }
  if (input.signal.businessId !== input.businessId) {
    throw new EngagementActionRequestError(
      "OWNERSHIP_MISMATCH",
      `OWNERSHIP_MISMATCH: signal belongs to a different business; cross-business engagement is fail closed.`
    );
  }
  if (input.signal.userId !== input.userId) {
    throw new EngagementActionRequestError(
      "OWNERSHIP_MISMATCH",
      `OWNERSHIP_MISMATCH: signal belongs to a different tenant; cross-tenant engagement is fail closed.`
    );
  }
  if (input.interpretation.signalId !== input.signal.signalId) {
    throw new EngagementActionRequestError(
      "INTELLIGENCE_BINDING_MISMATCH",
      `INTELLIGENCE_BINDING_MISMATCH: interpretation does not describe the bound signal; forged interpretation rejected.`
    );
  }
  if (input.interpretation.signalVersion !== input.signal.signalVersion) {
    throw new EngagementActionRequestError(
      "INTELLIGENCE_BINDING_MISMATCH",
      `INTELLIGENCE_BINDING_MISMATCH: interpretation signal version does not match the bound signal version.`
    );
  }
  if (
    input.interpretation.businessId != null &&
    input.interpretation.businessId !== input.businessId
  ) {
    throw new EngagementActionRequestError(
      "OWNERSHIP_MISMATCH",
      `OWNERSHIP_MISMATCH: interpretation belongs to a different business; cross-business engagement is fail closed.`
    );
  }
  if (typeof input.externalTarget !== "string" || input.externalTarget.trim().length === 0) {
    throw new EngagementActionRequestError(
      "INVALID_EXTERNAL_TARGET",
      `INVALID_EXTERNAL_TARGET: engagement actions require a non-empty external target (object/thread id).`
    );
  }

  const responseContextVersion = deriveResponseContextVersion({
    interpretationId: input.interpretation.interpretationId,
    signalContentHash: input.interpretation.signalContentHash,
    providerEvidenceHash: input.signal.providerEvidenceHash,
    businessDnaSnapshotId: input.businessDnaSnapshotId ?? null,
    platform: input.platform,
  });

  const actionRequestId = deriveEngagementActionRequestId({
    businessId: input.businessId,
    signalId: input.signal.signalId,
    signalVersion: input.signal.signalVersion,
    interpretationId: input.interpretation.interpretationId,
    actionType: input.actionType,
    provider: input.signal.provider,
    integrationId: input.providerAccountBinding?.integrationId ?? null,
    externalTarget: input.externalTarget,
    responseContextVersion,
  });

  return buildMarketingActionRequest({
    actionRequestId,
    businessId: input.businessId,
    sourceSignalId: input.signal.signalId,
    sourceInterpretationId: input.interpretation.interpretationId,
    actionType: input.actionType as MarketingActionType,
    platform: input.platform,
    providerAccountBinding: input.providerAccountBinding,
    campaignId: input.campaignId ?? null,
    publicationId: input.publicationId ?? null,
    // Caller-advisory only; E derives the authoritative class.
    estimatedCostClass: deriveCostClass(input.actionType),
    requestedAt: input.requestedAt,
    contextVersion: responseContextVersion,
  });
}
