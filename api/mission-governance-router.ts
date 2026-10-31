/**
 * Mission governance router — R9-F governed mission-governance surface.
 *
 * Narrow, tenant-scoped, authed-only. Clients propose material and reference
 * ids only: no decision, reason codes, risk class, approval state,
 * authorization, fingerprints or policy content may be supplied
 * (strictObject input schemas, contract §11). Evaluation persists the
 * immutable receipt and its audit event in one transaction. This stream
 * never executes mission actions, never plans missions/tasks, never touches
 * campaigns, strategy, budgets, Business DNA, billing/payments/providers/CRM
 * or the workflow engine.
 */

import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  bindMissionGovernanceStoreExecutor,
  createMissionGovernanceBridgeProvider,
} from "./lib/mission-governance/mission-governance-bridge";
import {
  evaluateMissionGovernanceForProposal,
  getMissionGovernanceDecisionForUser,
  getMissionGovernanceOperationsProjectionForUser,
  listMissionGovernanceDecisionsForUser,
  recordMissionGovernanceRecovery,
  requestMissionApprovalChallenge,
  resolveMissionApprovalChallenge,
  revalidateMissionGovernanceDecision,
} from "./lib/mission-governance/mission-governance-service";
import { OtpMissionReviewChallengeGateway } from "./lib/mission-governance/mission-review-authority";
import {
  EvaluateMissionGovernanceInputSchema,
  GetMissionGovernanceDecisionInputSchema,
  ListMissionGovernanceDecisionsInputSchema,
  RecordMissionGovernanceRecoveryInputSchema,
  RequestMissionApprovalChallengeInputSchema,
  ResolveMissionApprovalChallengeInputSchema,
  RevalidateMissionGovernanceDecisionInputSchema,
  MissionGovernanceError,
  type MissionGovernanceErrorCode,
} from "./lib/mission-governance/mission-governance-contract";
import {
  getMissionGovernancePolicy,
  listMissionGovernancePolicies,
} from "./lib/mission-governance/mission-policy";

const NOT_FOUND_CODES: ReadonlySet<MissionGovernanceErrorCode> = new Set([
  "GOVERNANCE_DECISION_NOT_FOUND",
]);

const FORBIDDEN_CODES: ReadonlySet<MissionGovernanceErrorCode> = new Set([
  "OWNERSHIP_MISMATCH",
  "CROSS_TENANT_MISSION",
]);

const CONFLICT_CODES: ReadonlySet<MissionGovernanceErrorCode> = new Set([
  "GOVERNANCE_REPLAY_CONFLICT",
  "POLICY_VERSION_CONFLICT",
]);

const UNAUTHORIZED_CODES: ReadonlySet<MissionGovernanceErrorCode> = new Set([
  "REVIEW_CHALLENGE_INVALID",
]);

/** Maps the governance error taxonomy onto stable tRPC codes (fail closed). */
export function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof MissionGovernanceError) {
    if (NOT_FOUND_CODES.has(err.code)) {
      return new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (FORBIDDEN_CODES.has(err.code)) {
      return new TRPCError({ code: "FORBIDDEN", message: err.message });
    }
    if (CONFLICT_CODES.has(err.code)) {
      return new TRPCError({ code: "CONFLICT", message: err.message });
    }
    if (UNAUTHORIZED_CODES.has(err.code)) {
      return new TRPCError({ code: "UNAUTHORIZED", message: err.message });
    }
    // Stale/tampered/unknown-version/invalid/unavailable inputs are
    // caller-correctable precondition failures — never guessed, never served.
    return new TRPCError({ code: "PRECONDITION_FAILED", message: err.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : "internal mission governance error",
  });
}

export const missionGovernanceRouter = createRouter({
  /**
   * One governed evaluation (F1 target flow). Deterministic: same
   * authoritative inputs ⇒ same governanceDecisionId ⇒ durable convergence;
   * replay returns the existing receipt (idempotent_replay) with zero extra
   * audit events. The approval ledger is untouched here; REVIEW_REQUIRED
   * decisions carry their binding and the caller routes them to the Approval
   * Centre (approvalType "mission_action").
   */
  evaluate: authedQuery
    .input(EvaluateMissionGovernanceInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createMissionGovernanceBridgeProvider(db, ctx.user.id);
      try {
        return await db.transaction(async (tx) =>
          evaluateMissionGovernanceForProposal(
            { userId: ctx.user.id, proposal: input.proposal, policyVersion: input.policyVersion },
            { provider },
            bindMissionGovernanceStoreExecutor(tx)
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  get: authedQuery
    .input(GetMissionGovernanceDecisionInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getMissionGovernanceDecisionForUser(
          { userId: ctx.user.id, governanceDecisionId: input.governanceDecisionId },
          bindMissionGovernanceStoreExecutor(getDb())
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Immutable receipt history (filters optional), oldest-first. */
  listDecisions: authedQuery
    .input(ListMissionGovernanceDecisionsInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listMissionGovernanceDecisionsForUser(
          {
            userId: ctx.user.id,
            businessId: input.businessId,
            missionRef: input.missionRef,
            decision: input.decision,
          },
          bindMissionGovernanceStoreExecutor(getDb())
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Truthful read-only operations projection (F8). */
  getOperationsProjection: authedQuery
    .input(ListMissionGovernanceDecisionsInputSchema.pick({ businessId: true }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createMissionGovernanceBridgeProvider(db, ctx.user.id);
      try {
        return await getMissionGovernanceOperationsProjectionForUser(
          { userId: ctx.user.id, businessId: input.businessId },
          { provider },
          bindMissionGovernanceStoreExecutor(db)
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Downstream contract seam: re-evaluate a stored receipt against the
   * CURRENT policy + authority state using fresh proposal material. The
   * stored receipt is never mutated; the caller receives the current
   * evaluation and must persist a new governed decision if it differs.
   * R9-D/E call this immediately before any material effect.
   */
  revalidate: authedQuery
    .input(RevalidateMissionGovernanceDecisionInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createMissionGovernanceBridgeProvider(db, ctx.user.id);
      try {
        return await revalidateMissionGovernanceDecision(
          {
            userId: ctx.user.id,
            governanceDecisionId: input.governanceDecisionId,
            proposal: input.proposal,
          },
          { provider },
          bindMissionGovernanceStoreExecutor(db)
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * F4/F5: issue an out-of-band human-presence (email OTP) challenge bound to
   * an existing REVIEW_REQUIRED decision. The decision is re-read for this
   * tenant first; a challenge is never issued for an ALLOW/BLOCK/absent
   * decision. An autonomous agent holding the tenant session cannot observe
   * the emailed code, so it cannot self-authorize.
   */
  requestApprovalChallenge: authedQuery
    .input(RequestMissionApprovalChallengeInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createMissionGovernanceBridgeProvider(db, ctx.user.id);
      const reviewGateway = new OtpMissionReviewChallengeGateway(db);
      try {
        return await requestMissionApprovalChallenge(
          {
            userId: ctx.user.id,
            governanceDecisionId: input.governanceDecisionId,
            req: ctx.req,
          },
          { provider, reviewGateway },
          bindMissionGovernanceStoreExecutor(db)
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * F4/F5: verify the out-of-band challenge for a REVIEW_REQUIRED decision.
   * Fails closed when verification is absent, invalid, expired, consumed, or
   * was issued to a different actor. Successful verification proves
   * independent human presence for the approval act; the approval row itself
   * is then authorized through the Approval Centre under
   * validateMissionApprovalAuthorizable.
   */
  resolveApprovalChallenge: authedQuery
    .input(ResolveMissionApprovalChallengeInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createMissionGovernanceBridgeProvider(db, ctx.user.id);
      const reviewGateway = new OtpMissionReviewChallengeGateway(db);
      try {
        return await resolveMissionApprovalChallenge(
          {
            userId: ctx.user.id,
            governanceDecisionId: input.governanceDecisionId,
            challengeToken: input.challengeToken,
            code: input.code,
          },
          { provider, reviewGateway },
          bindMissionGovernanceStoreExecutor(db)
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Narrow recovery (F8): record a closed-vocabulary operator action against
   * an existing decision. AUDIT-ONLY — the immutable receipt is never mutated
   * and no execution state changes. There is deliberately no
   * forceAllow/forceApprove/setApproved/overridePolicy.
   */
  recordRecovery: authedQuery
    .input(RecordMissionGovernanceRecoveryInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createMissionGovernanceBridgeProvider(db, ctx.user.id);
      try {
        return await db.transaction(async (tx) =>
          recordMissionGovernanceRecovery(
            {
              userId: ctx.user.id,
              governanceDecisionId: input.governanceDecisionId,
              action: input.action,
              note: input.note,
            },
            { provider },
            bindMissionGovernanceStoreExecutor(tx)
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** The conservative default policy + all registered policy versions. */
  getPolicy: authedQuery.query(() => ({
    policy: getMissionGovernancePolicy(),
    availableVersions: listMissionGovernancePolicies(),
  })),
});
