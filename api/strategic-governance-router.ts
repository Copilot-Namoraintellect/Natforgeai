/**
 * Strategic governance router — R8-F governed strategic-intelligence
 * governance surface.
 *
 * Narrow, tenant-scoped, authed-only. Clients propose material and reference
 * ids only: no decision, reason codes, risk class, confidence class, source
 * trust class, approval state or policy content may be supplied
 * (strictObject input schemas, contract §9). Evaluation persists the
 * immutable decision and its audit event in one transaction. This stream
 * never executes strategic recommendations, never touches campaigns, strategy,
 * budgets, Business DNA, billing/payments/providers/CRM, and never becomes
 * the strategic-reasoning engine (charter F7).
 */

import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import {
  bindStrategicGovernanceStoreExecutor,
  createStrategicGovernanceBridgeProvider,
} from "./lib/strategic-governance/strategic-governance-bridge";
import {
  evaluateStrategicGovernanceForProposal,
  getStrategicGovernanceDecisionForUser,
  getStrategicGovernanceOperationsProjectionForUser,
  listStrategicGovernanceDecisionsForUser,
  recordStrategicGovernanceRecovery,
  requestStrategicApprovalChallenge,
  resolveStrategicApprovalChallenge,
  revalidateStrategicGovernanceDecision,
} from "./lib/strategic-governance/strategic-governance-service";
import { OtpStrategicReviewChallengeGateway } from "./lib/strategic-governance/strategic-review-authority";
import {
  EvaluateStrategicGovernanceInputSchema,
  GetStrategicGovernanceDecisionInputSchema,
  ListStrategicGovernanceDecisionsInputSchema,
  RecordStrategicGovernanceRecoveryInputSchema,
  RequestStrategicApprovalChallengeInputSchema,
  ResolveStrategicApprovalChallengeInputSchema,
  RevalidateStrategicGovernanceDecisionInputSchema,
  StrategicGovernanceError,
  type StrategicGovernanceErrorCode,
} from "./lib/strategic-governance/strategic-governance-contract";
import {
  getStrategicGovernancePolicy,
  listStrategicGovernancePolicies,
} from "./lib/strategic-governance/strategic-policy";

const NOT_FOUND_CODES: ReadonlySet<StrategicGovernanceErrorCode> = new Set([
  "GOVERNANCE_DECISION_NOT_FOUND",
]);

const FORBIDDEN_CODES: ReadonlySet<StrategicGovernanceErrorCode> = new Set([
  "OWNERSHIP_MISMATCH",
  "CROSS_TENANT_PROPOSAL",
  "CROSS_TENANT_EVIDENCE",
]);

const CONFLICT_CODES: ReadonlySet<StrategicGovernanceErrorCode> = new Set([
  "GOVERNANCE_REPLAY_CONFLICT",
  "POLICY_VERSION_CONFLICT",
]);

const UNAUTHORIZED_CODES: ReadonlySet<StrategicGovernanceErrorCode> = new Set([
  "REVIEW_CHALLENGE_INVALID",
]);

/** Maps the governance error taxonomy onto stable tRPC codes (fail closed). */
export function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof StrategicGovernanceError) {
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
    message: err instanceof Error ? err.message : "internal strategic governance error",
  });
}

export const strategicGovernanceRouter = createRouter({
  /**
   * One governed evaluation (F1 target flow). Deterministic: same
   * authoritative inputs ⇒ same governanceDecisionId ⇒ durable convergence;
   * replay returns the existing decision (idempotent_replay) with zero extra
   * audit events. The approval ledger is untouched here; REVIEW_REQUIRED
   * decisions carry their binding and the caller routes them to the Approval
   * Centre (approvalType "strategic_recommendation").
   */
  evaluate: authedQuery
    .input(EvaluateStrategicGovernanceInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createStrategicGovernanceBridgeProvider(db, ctx.user.id);
      try {
        return await db.transaction(async (tx) =>
          evaluateStrategicGovernanceForProposal(
            { userId: ctx.user.id, proposal: input.proposal, policyVersion: input.policyVersion },
            { provider },
            bindStrategicGovernanceStoreExecutor(tx)
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  get: authedQuery
    .input(GetStrategicGovernanceDecisionInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getStrategicGovernanceDecisionForUser(
          { userId: ctx.user.id, governanceDecisionId: input.governanceDecisionId },
          bindStrategicGovernanceStoreExecutor(getDb())
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Immutable decision history (filters optional), oldest-first. */
  listDecisions: authedQuery
    .input(ListStrategicGovernanceDecisionsInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listStrategicGovernanceDecisionsForUser(
          {
            userId: ctx.user.id,
            businessId: input.businessId,
            proposalId: input.proposalId,
            decision: input.decision,
          },
          bindStrategicGovernanceStoreExecutor(getDb())
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Truthful read-only operations projection (F8). */
  getOperationsProjection: authedQuery
    .input(ListStrategicGovernanceDecisionsInputSchema.pick({ businessId: true }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createStrategicGovernanceBridgeProvider(db, ctx.user.id);
      try {
        return await getStrategicGovernanceOperationsProjectionForUser(
          { userId: ctx.user.id, businessId: input.businessId },
          { provider },
          bindStrategicGovernanceStoreExecutor(db)
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Downstream contract seam: re-evaluate a stored decision against the
   * CURRENT policy + authority state using fresh proposal material. The stored
   * decision is never mutated; the caller receives the current evaluation and
   * must persist a new governed decision if it differs. R8-D/E and R9 call
   * this immediately before any material effect.
   */
  revalidate: authedQuery
    .input(RevalidateStrategicGovernanceDecisionInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createStrategicGovernanceBridgeProvider(db, ctx.user.id);
      try {
        return await revalidateStrategicGovernanceDecision(
          {
            userId: ctx.user.id,
            governanceDecisionId: input.governanceDecisionId,
            proposal: input.proposal,
          },
          { provider },
          bindStrategicGovernanceStoreExecutor(db)
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * F5: issue an out-of-band human-presence (email OTP) challenge bound to an
   * existing REVIEW_REQUIRED decision. The decision is re-read for this tenant
   * first; a challenge is never issued for an ALLOW/BLOCK/absent decision. An
   * autonomous agent holding the tenant session cannot observe the emailed
   * code, so it cannot self-authorize.
   */
  requestApprovalChallenge: authedQuery
    .input(RequestStrategicApprovalChallengeInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createStrategicGovernanceBridgeProvider(db, ctx.user.id);
      const reviewGateway = new OtpStrategicReviewChallengeGateway(db);
      try {
        return await requestStrategicApprovalChallenge(
          {
            userId: ctx.user.id,
            governanceDecisionId: input.governanceDecisionId,
            req: ctx.req,
          },
          { provider, reviewGateway },
          bindStrategicGovernanceStoreExecutor(db)
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * F5: verify the out-of-band challenge for a REVIEW_REQUIRED decision. Fails
   * closed when verification is absent, invalid, expired, consumed, or was
   * issued to a different actor. Successful verification proves independent
   * human presence for the approval act; the approval row itself is then
   * authorized through the Approval Centre under validateStrategicApprovalAuthorizable.
   */
  resolveApprovalChallenge: authedQuery
    .input(ResolveStrategicApprovalChallengeInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createStrategicGovernanceBridgeProvider(db, ctx.user.id);
      const reviewGateway = new OtpStrategicReviewChallengeGateway(db);
      try {
        return await resolveStrategicApprovalChallenge(
          {
            userId: ctx.user.id,
            governanceDecisionId: input.governanceDecisionId,
            challengeToken: input.challengeToken,
            code: input.code,
          },
          { provider, reviewGateway },
          bindStrategicGovernanceStoreExecutor(db)
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Narrow recovery (F8): record a closed-vocabulary operator action against
   * an existing decision. AUDIT-ONLY — the immutable decision is never mutated
   * and no execution state changes. There is deliberately no
   * forceAllow/forceApprove/setApproved/overridePolicy.
   */
  recordRecovery: authedQuery
    .input(RecordStrategicGovernanceRecoveryInputSchema)
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const provider = createStrategicGovernanceBridgeProvider(db, ctx.user.id);
      try {
        return await db.transaction(async (tx) =>
          recordStrategicGovernanceRecovery(
            {
              userId: ctx.user.id,
              governanceDecisionId: input.governanceDecisionId,
              action: input.action,
              note: input.note,
            },
            { provider },
            bindStrategicGovernanceStoreExecutor(tx)
          )
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** The conservative default policy + all registered policy versions. */
  getPolicy: authedQuery.query(() => ({
    policy: getStrategicGovernancePolicy(),
    availableVersions: listStrategicGovernancePolicies(),
  })),
});
