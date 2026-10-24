/**
 * Signal attribution (WBS-R5-A A4).
 *
 * Binds an accepted signal to NatForgeAI authority where evidence permits.
 * Attribution is ALWAYS derived server-side from authoritative rows — never
 * from client hints, never guessed:
 *
 *   A. DIRECT        provider object (post id) resolves to a published
 *                    publishing_queue success row owned by the binding's
 *                    tenant, with receipt lineage where a canonical receipt
 *                    exists.
 *   B. BUSINESS      the provider account maps to a business via
 *                    social_integrations, but no publication linkage exists.
 *   C. UNATTRIBUTED  connected account, no publication linkage (unknown post,
 *                    foreign receipt, or no business binding).
 *
 * Fail-closed rules:
 * - A publication match owned by a DIFFERENT tenant never binds: foreign
 *   references simply do not match (unattributed), and a candidate whose
 *   ownership was somehow overridden throws OWNERSHIP_MISMATCH rather than
 *   silently re-binding cross-business.
 * - No receipt, no campaign: lineage fields stay null instead of being
 *   fabricated.
 */

import { eq, and, desc, inArray } from "drizzle-orm";
import {
  publishingQueue,
  auditEvents,
  socialIntegrations,
  type SocialIntegration,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import { SignalContractError } from "./signal-contract";
import { derivePublicationOperationId } from "../integrations/adapters/platform-adapter";

type AttributionDb = ReturnType<typeof getDb>;

export interface AttributionExecutor {
  select: AttributionDb["select"];
}

export interface BindingRef {
  id: number;
  userId: number;
  businessId: number | null;
}

export interface AttributionResult {
  attributionType: "direct" | "business" | "unattributed";
  businessId: number | null;
  sourceCampaignId: number | null;
  /** publication:{platform}:{queueItemId} when directly attributed. */
  sourcePublicationId: string | null;
  /** Durable publication_success audit fingerprint when a receipt exists. */
  sourcePublicationReceiptId: string | null;
}

export const ATTRIBUTION_RECEIPT_SCAN_LIMIT = 50;

/**
 * Resolve the authoritative social_integrations binding for one provider
 * account. Meta surfaces bind by page id / instagram business account id.
 * Returns null when no connected binding owns the account — callers reject
 * fail-closed (unknown tenant/provider authority).
 */
export async function resolveBindingForProviderAccount(
  input: {
    platform: string;
    providerAccountId: string;
    executor?: AttributionExecutor;
  }
): Promise<SocialIntegration | null> {
  const db = input.executor ?? getDb();
  const platformFilter =
    input.platform === "instagram"
      ? (["instagram"] as const)
      : input.platform === "whatsapp"
        ? (["whatsapp"] as const)
        : input.platform === "linkedin"
          ? (["linkedin"] as const)
          : input.platform === "facebook"
            ? (["facebook"] as const)
            : (["facebook", "instagram", "whatsapp", "linkedin"] as const);

  const rows = await db
    .select()
    .from(socialIntegrations)
    .where(
      and(
        eq(socialIntegrations.status, "connected"),
        inArray(socialIntegrations.platform, [...platformFilter])
      )
    )
    .limit(10);

  const match = rows.find(
    (row) =>
      row.pageId === input.providerAccountId ||
      row.instagramBusinessAccountId === input.providerAccountId
  );
  return (match as SocialIntegration | undefined) ?? null;
}

interface PublicationMatch {
  queueItemId: number;
  userId: number;
  campaignId: number | null;
  publishedAt: Date | null;
}

/**
 * Find the published success row for one provider object, scoped to the
 * binding's tenant. Foreign publications (owned by another tenant) simply do
 * not match — they are unattributed external activity, never bound.
 */
async function findPublishedPostMatch(
  db: AttributionExecutor,
  input: { platform: string; externalObjectId: string; userId: number }
): Promise<PublicationMatch | null> {
  const rows = await db
    .select({
      queueItemId: publishingQueue.id,
      userId: publishingQueue.userId,
      campaignId: publishingQueue.campaignId,
      publishedAt: publishingQueue.publishedAt,
    })
    .from(publishingQueue)
    .where(
      and(
        eq(publishingQueue.externalPostId, input.externalObjectId),
        eq(publishingQueue.platform, input.platform),
        eq(publishingQueue.status, "published")
      )
    )
    .limit(10);

  const owned = rows.find((row) => row.userId === input.userId);
  if (!owned) return null;

  // Defensive invariant: a candidate match must belong to the binding's
  // tenant. Reaching this throw means ownership was overridden downstream of
  // the query filter — refuse rather than re-bind cross-business.
  if (owned.userId !== input.userId) {
    throw new SignalContractError(
      "OWNERSHIP_MISMATCH",
      `publication for external object ${input.externalObjectId} is owned by a different tenant`
    );
  }
  return owned;
}

async function findReceiptFingerprint(
  db: AttributionExecutor,
  input: { userId: number; operationId: string }
): Promise<string | null> {
  const rows = await db
    .select({ eventFingerprint: auditEvents.eventFingerprint, metadata: auditEvents.metadata })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "publication_success"),
        eq(auditEvents.userId, input.userId)
      )
    )
    .orderBy(desc(auditEvents.occurredAt))
    .limit(ATTRIBUTION_RECEIPT_SCAN_LIMIT);

  for (const row of rows) {
    const metadata = row.metadata as Record<string, unknown> | null;
    const receipt = metadata?.receipt as Record<string, unknown> | undefined;
    if (receipt && receipt.operationId === input.operationId) {
      return row.eventFingerprint;
    }
  }
  return null;
}

/**
 * Resolve attribution for one validated raw signal against its authoritative
 * binding. Pure derivation: same inputs → same attribution, always.
 */
export async function resolveSignalAttribution(
  input: {
    integration: BindingRef;
    platform: string;
    externalObjectId: string | null;
    executor?: AttributionExecutor;
  }
): Promise<AttributionResult> {
  const db = input.executor ?? getDb();
  const businessId = input.integration.businessId ?? null;

  if (!input.externalObjectId) {
    return {
      attributionType: businessId ? "business" : "unattributed",
      businessId,
      sourceCampaignId: null,
      sourcePublicationId: null,
      sourcePublicationReceiptId: null,
    };
  }

  const match = await findPublishedPostMatch(db, {
    platform: input.platform,
    externalObjectId: input.externalObjectId,
    userId: input.integration.userId,
  });

  if (!match) {
    return {
      attributionType: businessId ? "business" : "unattributed",
      businessId,
      sourceCampaignId: null,
      sourcePublicationId: null,
      sourcePublicationReceiptId: null,
    };
  }

  const operationId = derivePublicationOperationId({
    platform: input.platform,
    queueItemId: match.queueItemId,
  });
  const receiptFingerprint = await findReceiptFingerprint(db, {
    userId: input.integration.userId,
    operationId,
  });

  return {
    attributionType: "direct",
    businessId,
    sourceCampaignId: match.campaignId ?? null,
    sourcePublicationId: operationId,
    sourcePublicationReceiptId: receiptFingerprint,
  };
}
