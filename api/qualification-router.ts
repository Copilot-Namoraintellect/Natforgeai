/**
 * Qualification router — R6-C governed lead-qualification surface.
 *
 * Narrow, tenant-scoped, authed-only. Clients reference ids only: no
 * decision, reason codes, confidence, review outcome, policy content, or
 * identity may be supplied (strictObject input schemas, contract §14.3).
 * Every mutation runs inside one transaction spanning the R6-C tables and
 * the audit ledger; upstream evidence arrives through the bridge provider
 * and is re-validated at the C seams. This stream never performs outreach,
 * CRM mutation, conversion, or billing.
 */

import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  bindQualificationStoreExecutor,
  createQualificationBridgeProvider,
} from "./lib/qualification/qualification-bridge";
import {
  OtpReviewChallengeGateway,
  type ReviewChallengeGateway,
} from "./lib/qualification/qualification-review-authority";
import {
  evaluateQualificationForLead,
  getHandoffProjectionForUser,
  getQualificationForUser,
  getQualificationHistory,
  listQualificationReviews,
  requestReviewResolution,
  resolveQualificationReview,
} from "./lib/qualification/qualification-service";
import {
  EvaluateQualificationInputSchema,
  GetQualificationHandoffInputSchema,
  GetQualificationInputSchema,
  ListQualificationHistoryInputSchema,
  ListQualificationReviewsInputSchema,
  QualificationError,
  RequestReviewResolutionInputSchema,
  ResolveQualificationReviewInputSchema,
  type QualificationErrorCode,
} from "./lib/qualification/qualification-contract";
import {
  getQualificationPolicy,
  listQualificationPolicies,
} from "./lib/qualification/qualification-policy";

const NOT_FOUND_CODES: ReadonlySet<QualificationErrorCode> = new Set([
  "LEAD_NOT_FOUND",
  "SCORE_NOT_FOUND",
  "QUALIFICATION_NOT_FOUND",
  "REVIEW_NOT_FOUND",
]);

const FORBIDDEN_CODES: ReadonlySet<QualificationErrorCode> = new Set([
  "OWNERSHIP_MISMATCH",
  "REVIEW_AUTHORIZATION_BINDING_MISMATCH",
]);

const CONFLICT_CODES: ReadonlySet<QualificationErrorCode> = new Set([
  "REVIEW_STALE_BINDING",
  "REVIEW_ALREADY_RESOLVED",
  "QUALIFICATION_REPLAY_CONFLICT",
  "POLICY_VERSION_CONFLICT",
]);

/** Maps the qualification error taxonomy onto stable tRPC codes (fail closed). */
export function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof QualificationError) {
    if (NOT_FOUND_CODES.has(err.code)) {
      return new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (FORBIDDEN_CODES.has(err.code)) {
      return new TRPCError({ code: "FORBIDDEN", message: err.message });
    }
    if (CONFLICT_CODES.has(err.code)) {
      return new TRPCError({ code: "CONFLICT", message: err.message });
    }
    // Stale/tampered/unknown-version/invalid/upstream-unavailable inputs are
    // caller-correctable precondition failures — never guessed, never served.
    return new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : "internal qualification error",
  });
}

export const qualificationRouter = createRouter({
  /**
   * One governed evaluation (contract §8–§12). Deterministic: same
   * authoritative inputs ⇒ same qualificationId ⇒ durable convergence;
   * replay returns the existing decision (idempotent_replay).
   */
  evaluate: authedQuery.input(EvaluateQualificationInputSchema).mutation(async ({ ctx, input }) => {
    const db = getDb();
    const provider = createQualificationBridgeProvider(db, ctx.user.id);
    try {
      return await db.transaction(async (tx) =>
        evaluateQualificationForLead(
          { userId: ctx.user.id, ...input },
          { provider },
          bindQualificationStoreExecutor(tx)
        )
      );
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  get: authedQuery.input(GetQualificationInputSchema).query(async ({ ctx, input }) => {
    try {
      return await getQualificationForUser(
        { userId: ctx.user.id, qualificationId: input.qualificationId },
        bindQualificationStoreExecutor(getDb())
      );
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /** Immutable decision history for a lead, oldest-first (contract §12). */
  listHistory: authedQuery.input(ListQualificationHistoryInputSchema).query(async ({ ctx, input }) => {
    try {
      return await getQualificationHistory(
        { userId: ctx.user.id, leadId: input.leadId },
        bindQualificationStoreExecutor(getDb())
      );
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  listReviews: authedQuery.input(ListQualificationReviewsInputSchema).query(async ({ ctx, input }) => {
    try {
      return await listQualificationReviews(
        { userId: ctx.user.id, leadId: input.leadId, status: input.status },
        bindQualificationStoreExecutor(getDb())
      );
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /**
   * Issues the independent human-review challenge for a pending review
   * (contract §10). The 6-digit code is emailed out of band; the returned
   * challengeToken is bound to this review and must be presented with the
   * code at resolveReview. A verified session alone can request (the request
   * only delivers a code) but can never resolve.
   */
  requestReviewResolution: authedQuery
    .input(RequestReviewResolutionInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createQualificationBridgeProvider(db, ctx.user.id);
      const challengeGateway: ReviewChallengeGateway = new OtpReviewChallengeGateway(db);
      try {
        return await db.transaction(async (tx) =>
          requestReviewResolution(
            { userId: ctx.user.id, reviewId: input.reviewId, req: ctx.req },
            { provider, challengeGateway },
            bindQualificationStoreExecutor(tx)
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Governed review resolution (contract §10) with independent human
   * authentication. Exactly one resolution per review, tx-atomic with its
   * audit event; the immutable decision is never mutated. A bare verified
   * session cannot resolve: the review-bound out-of-band challenge must be
   * presented and is durably consumed by the OTP gateway.
   */
  resolveReview: authedQuery
    .input(ResolveQualificationReviewInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createQualificationBridgeProvider(db, ctx.user.id);
      const challengeGateway: ReviewChallengeGateway = new OtpReviewChallengeGateway(db);
      try {
        return await db.transaction(async (tx) =>
          resolveQualificationReview(
            { userId: ctx.user.id, ...input },
            { provider, challengeGateway },
            bindQualificationStoreExecutor(tx)
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** The safe R6-D handoff projection (contract §13) — exact closed key set. */
  getHandoffProjection: authedQuery
    .input(GetQualificationHandoffInputSchema)
    .query(async ({ ctx, input }) => {
      const provider = createQualificationBridgeProvider(getDb(), ctx.user.id);
      try {
        return await getHandoffProjectionForUser(
          { userId: ctx.user.id, qualificationId: input.qualificationId },
          { provider },
          bindQualificationStoreExecutor(getDb())
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** The conservative default policy + all registered policy versions. */
  getPolicy: authedQuery.query(() => ({
    policy: getQualificationPolicy(),
    availableVersions: listQualificationPolicies(),
  })),
});
