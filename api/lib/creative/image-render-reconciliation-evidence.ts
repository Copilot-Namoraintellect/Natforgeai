import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  contentPosts,
  creditTransactions,
  generatedImages,
  imageRenderClaims,
} from "@db/schema";
import { buildImageRenderDeductionKey } from "./image-render-claim";
import type {
  ImageRenderReconciliationEvidence,
  UpstreamRecoveryClassification,
} from "./image-render-reconciliation-classifier";

// ─── Dormant read-only reconciliation evidence collector (Slice C4B) ───
//
// Collects the exact durable evidence required by the already-committed C4A
// pure reconciliation classifier. This module performs READ-ONLY lookups by
// exact immutable identity only: the claim row by its full attempt identity,
// the generated image by the claim's exact linked id, the content post by its
// exact id, and the deduction ledger row by the exact deterministic
// idempotency key. It never classifies, never repairs, never infers
// (no latest/nearest/timestamp/campaign/job/url discovery), performs zero
// usage-ledger reads, and has ZERO production callers. The C4A classifier is
// never invoked here; only its TYPE shape is imported (erased at compile
// time).
//
// matchesClaimSnapshot is defined by EXACT equality of exactly these durable
// fields: claim.resultImageUrl vs image url, claim.resultProvider vs image
// provider, normalized-null claim.resultProviderJobId vs image providerJobId,
// and claim.resultCreditsCharged vs image creditsCharged. Quality
// tier/label/isDraft are intentionally NOT part of snapshot validity: the
// generated-image metadata structure does not provide them reliably enough,
// and guessing is forbidden.

export interface ImageRenderReconciliationEvidenceInput {
  upstream: UpstreamRecoveryClassification;
  claimId: number;
  userId: number;
  contentPostId: number;
  requestAttemptKey: string;
  intentFingerprint: string;
  deductionKey: string;
}

export interface ImageRenderReconciliationClaimRow {
  readonly generatedImageId: number | null;
  readonly resultImageUrl: string | null;
  readonly resultProvider: string | null;
  readonly resultProviderJobId: string | null;
  readonly resultCreditsCharged: number | null;
  readonly resultQualityTier: string | null;
  readonly resultQualityLabel: string | null;
  readonly resultIsDraft: boolean | null;
  readonly completedAt: Date | null;
}

export interface ImageRenderReconciliationGeneratedImageRow {
  readonly id: number;
  readonly userId: number;
  readonly contentPostId: number | null;
  readonly provider: string | null;
  readonly providerJobId: string | null;
  readonly url: string;
  readonly creditsCharged: number | null;
  readonly metadata: unknown;
}

export interface ImageRenderReconciliationContentPostRow {
  readonly id: number;
  readonly metadata: unknown;
}

export interface ImageRenderReconciliationDeductionRow {
  readonly id: number;
  readonly userId: number;
  readonly type: string;
  readonly amount: number;
  readonly idempotencyKey: string | null;
}

/**
 * Read-only executor seam: exactly four exact-identity reads. No generic
 * database handle, no transaction, no write surface.
 */
export interface ImageRenderReconciliationEvidenceExecutor {
  findExactClaim(
    args: Omit<ImageRenderReconciliationEvidenceInput, "upstream">
  ): Promise<ImageRenderReconciliationClaimRow | null>;
  findGeneratedImageById(args: {
    id: number;
  }): Promise<ImageRenderReconciliationGeneratedImageRow | null>;
  findContentPostById(args: {
    id: number;
  }): Promise<ImageRenderReconciliationContentPostRow | null>;
  findDeductionByKey(args: {
    deductionKey: string;
  }): Promise<ImageRenderReconciliationDeductionRow | null>;
}

export type ImageRenderReconciliationEvidenceCollectionResult =
  | { status: "collected"; evidence: ImageRenderReconciliationEvidence }
  | {
      status: "blocked";
      reason: "claim_lookup_failed" | "claim_not_found_or_identity_mismatch";
    };

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function assertValidPositiveId(value: unknown, name: string): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid ${name}: ${String(value)}` });
  }
}

function assertValidInput(input: ImageRenderReconciliationEvidenceInput): void {
  if (!input || typeof input !== "object") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid input: expected an object" });
  }
  assertValidPositiveId(input.claimId, "claimId");
  assertValidPositiveId(input.userId, "userId");
  assertValidPositiveId(input.contentPostId, "contentPostId");
  if (
    typeof input.requestAttemptKey !== "string" ||
    !SHA256_HEX_PATTERN.test(input.requestAttemptKey)
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid requestAttemptKey: expected 64-character lowercase SHA-256 hex",
    });
  }
  if (
    typeof input.intentFingerprint !== "string" ||
    !SHA256_HEX_PATTERN.test(input.intentFingerprint)
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid intentFingerprint: expected 64-character lowercase SHA-256 hex",
    });
  }
  if (
    typeof input.deductionKey !== "string" ||
    input.deductionKey.length === 0 ||
    input.deductionKey.length > 191
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid deductionKey: expected 1-191 characters",
    });
  }
  if (input.deductionKey !== buildImageRenderDeductionKey(input.requestAttemptKey)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid deductionKey: does not match the derived attempt identity",
    });
  }
}

function nullEqual(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

function isUsablePositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

function asMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Dormant collector. Read order: exact claim → exact generated image (only
 * when the claim links one) → exact content post → exact deduction row.
 * Claim failure/no-match is terminal; other read failures normalize that
 * dimension to lookup_failed while the remaining independent reads continue.
 * No retry, no polling, no reread, no mutation.
 */
export async function collectImageRenderReconciliationEvidence(
  input: ImageRenderReconciliationEvidenceInput,
  executor?: ImageRenderReconciliationEvidenceExecutor
): Promise<ImageRenderReconciliationEvidenceCollectionResult> {
  assertValidInput(input);
  const deps = executor ?? createDefaultImageRenderReconciliationEvidenceExecutor();

  let claim: ImageRenderReconciliationClaimRow | null;
  try {
    claim = await deps.findExactClaim({
      claimId: input.claimId,
      userId: input.userId,
      contentPostId: input.contentPostId,
      requestAttemptKey: input.requestAttemptKey,
      intentFingerprint: input.intentFingerprint,
      deductionKey: input.deductionKey,
    });
  } catch {
    return Object.freeze({ status: "blocked", reason: "claim_lookup_failed" }) as ImageRenderReconciliationEvidenceCollectionResult;
  }
  if (!claim) {
    return Object.freeze({
      status: "blocked",
      reason: "claim_not_found_or_identity_mismatch",
    }) as ImageRenderReconciliationEvidenceCollectionResult;
  }

  let imageRow: ImageRenderReconciliationGeneratedImageRow | null = null;
  let generatedImage: ImageRenderReconciliationEvidence["generatedImage"];
  if (claim.generatedImageId === null) {
    generatedImage = { kind: "absent" };
  } else {
    let imageLookupFailed = false;
    try {
      imageRow = await deps.findGeneratedImageById({ id: claim.generatedImageId });
    } catch {
      imageLookupFailed = true;
    }
    generatedImage = imageLookupFailed
      ? { kind: "lookup_failed" }
      : imageRow === null
        ? { kind: "absent" }
        : {
            kind: "present",
            matchesClaimGeneratedImageId: imageRow.id === claim.generatedImageId,
            matchesUser: imageRow.userId === input.userId,
            matchesContentPost: imageRow.contentPostId === input.contentPostId,
            matchesClaimSnapshot:
              claim.resultImageUrl === imageRow.url &&
              claim.resultProvider === imageRow.provider &&
              nullEqual(claim.resultProviderJobId, imageRow.providerJobId) &&
              claim.resultCreditsCharged === imageRow.creditsCharged,
          };
  }

  let contentPost: ImageRenderReconciliationEvidence["contentPost"];
  try {
    const postRow = await deps.findContentPostById({ id: input.contentPostId });
    if (!postRow) {
      contentPost = { kind: "mismatch" };
    } else {
      const metadata = asMetadata(postRow.metadata);
      const currentVersionId = metadata.currentVersionId;
      const imageCurrentVersionId = metadata.imageCurrentVersionId;
      const bothLinksAbsent =
        (currentVersionId === null || currentVersionId === undefined) &&
        (imageCurrentVersionId === null || imageCurrentVersionId === undefined);

      if (claim.generatedImageId === null) {
        contentPost =
          !isUsablePositiveInteger(currentVersionId) &&
          !isUsablePositiveInteger(imageCurrentVersionId)
            ? { kind: "no_generated_image_link" }
            : { kind: "mismatch" };
      } else if (bothLinksAbsent) {
        contentPost = { kind: "no_generated_image_link" };
      } else if (
        currentVersionId === claim.generatedImageId &&
        imageCurrentVersionId === claim.generatedImageId &&
        metadata.imageStatus === "ready" &&
        (generatedImage.kind !== "present" ||
          (metadata.imageUrl === imageRow!.url &&
            metadata.imageProvider === imageRow!.provider &&
            nullEqual(metadata.imageJobId, imageRow!.providerJobId))) &&
        (typeof claim.resultCreditsCharged !== "number" ||
          metadata.imageCreditsCharged === claim.resultCreditsCharged)
      ) {
        contentPost = { kind: "matches_generated_image" };
      } else {
        contentPost = { kind: "mismatch" };
      }
    }
  } catch {
    contentPost = { kind: "lookup_failed" };
  }

  let deduction: ImageRenderReconciliationEvidence["deduction"];
  try {
    const row = await deps.findDeductionByKey({ deductionKey: input.deductionKey });
    if (!row) {
      deduction = { kind: "absent" };
    } else {
      const expectedCreditsMatch =
        claim.resultCreditsCharged === null
          ? ("unknown" as const)
          : row.userId === input.userId &&
            row.type === "image_generation" &&
            row.amount === -claim.resultCreditsCharged &&
            row.idempotencyKey === input.deductionKey;
      deduction = {
        kind: "present",
        exactAttemptKeyMatch: row.idempotencyKey === input.deductionKey,
        expectedCreditsMatch,
      };
    }
  } catch {
    deduction = { kind: "lookup_failed" };
  }

  const evidence = Object.freeze({
    upstream: input.upstream,
    resultCreditsCharged: claim.resultCreditsCharged,
    generatedImage,
    contentPost,
    deduction,
    usageObservation: "not_checked",
  } satisfies ImageRenderReconciliationEvidence);

  return Object.freeze({ status: "collected", evidence }) as ImageRenderReconciliationEvidenceCollectionResult;
}

/**
 * Default read-only executor. The database client is obtained lazily — only
 * when a read actually runs — so importing this module performs zero database
 * work.
 */
export function createDefaultImageRenderReconciliationEvidenceExecutor(): ImageRenderReconciliationEvidenceExecutor {
  let client: ReturnType<typeof getDb> | null = null;
  const db = () => {
    if (!client) {
      client = getDb();
    }
    return client;
  };

  return {
    async findExactClaim(args) {
      const [row] = await db()
        .select({
          generatedImageId: imageRenderClaims.generatedImageId,
          resultImageUrl: imageRenderClaims.resultImageUrl,
          resultProvider: imageRenderClaims.resultProvider,
          resultProviderJobId: imageRenderClaims.resultProviderJobId,
          resultCreditsCharged: imageRenderClaims.resultCreditsCharged,
          resultQualityTier: imageRenderClaims.resultQualityTier,
          resultQualityLabel: imageRenderClaims.resultQualityLabel,
          resultIsDraft: imageRenderClaims.resultIsDraft,
          completedAt: imageRenderClaims.completedAt,
        })
        .from(imageRenderClaims)
        .where(
          and(
            eq(imageRenderClaims.id, args.claimId),
            eq(imageRenderClaims.userId, args.userId),
            eq(imageRenderClaims.contentPostId, args.contentPostId),
            eq(imageRenderClaims.requestAttemptKey, args.requestAttemptKey),
            eq(imageRenderClaims.intentFingerprint, args.intentFingerprint),
            eq(imageRenderClaims.deductionKey, args.deductionKey)
          )
        )
        .limit(1);
      return row ?? null;
    },
    async findGeneratedImageById(args) {
      const [row] = await db()
        .select({
          id: generatedImages.id,
          userId: generatedImages.userId,
          contentPostId: generatedImages.contentPostId,
          provider: generatedImages.provider,
          providerJobId: generatedImages.providerJobId,
          url: generatedImages.url,
          creditsCharged: generatedImages.creditsCharged,
          metadata: generatedImages.metadata,
        })
        .from(generatedImages)
        .where(eq(generatedImages.id, args.id))
        .limit(1);
      return row ?? null;
    },
    async findContentPostById(args) {
      const [row] = await db()
        .select({ id: contentPosts.id, metadata: contentPosts.metadata })
        .from(contentPosts)
        .where(eq(contentPosts.id, args.id))
        .limit(1);
      return row ?? null;
    },
    async findDeductionByKey(args) {
      const [row] = await db()
        .select({
          id: creditTransactions.id,
          userId: creditTransactions.userId,
          type: creditTransactions.type,
          amount: creditTransactions.amount,
          idempotencyKey: creditTransactions.idempotencyKey,
        })
        .from(creditTransactions)
        .where(eq(creditTransactions.idempotencyKey, args.deductionKey))
        .limit(1);
      return row ?? null;
    },
  };
}
