// ─── R6-D Nurture / Sales Handoff — tRPC surface ───
//
// Bounded, authed surface. Inputs are ids and bounded options ONLY — never
// decisions, success flags, risk, approval, or billing identity. The service
// is the sole authority; upstream ports are wired here at module scope from
// the governed R5/R6 infrastructure bridges (guarded, fail-closed when
// absent). No transport is wired on this router: dispatch fails closed until
// R6-X configures a truthful transport (contract §10).

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createRouter, authedQuery } from "./middleware";
import { NurtureError } from "./lib/nurture/nurture-contract";
import {
  evaluateNurture,
  dispatchHandoff,
  dispatchNurtureTouch,
  reconcileHandoff,
  getLeadNurtureHandoffView,
  type NurtureServiceDeps,
  type NurtureUpstreamPorts,
} from "./lib/nurture/nurture-service";
import { buildDefaultNurturePolicyConfig, buildNurtureHandoffPolicy } from "./lib/nurture/nurture-policy";
import { getDecisionById, getHandoffById, nurtureTablesAvailable } from "./lib/nurture/nurture-store";
function toTrpcError(err: unknown): TRPCError {
  if (err instanceof NurtureError) {
    const code =
      err.code === "FORBIDDEN"
        ? "FORBIDDEN"
        : err.code === "QUALIFICATION_NOT_FOUND" ||
            err.code === "HANDOFF_NOT_FOUND" ||
            err.code === "DECISION_NOT_FOUND" ||
            err.code === "APPROVAL_NOT_FOUND"
          ? "NOT_FOUND"
          : err.code === "INVALID_NURTURE_INPUT"
            ? "BAD_REQUEST"
            : err.code === "HANDOFF_STATE_CONFLICT" ||
                err.code === "NURTURE_REPLAY_CONFLICT" ||
                err.code === "HANDOFF_REPLAY_CONFLICT" ||
                err.code === "STALE_POLICY_VERSION" ||
                err.code === "EXPIRED_DECISION" ||
                err.code === "APPROVAL_BINDING_MISMATCH" ||
                err.code === "APPROVAL_PENDING" ||
                err.code === "ACTION_REJECTED_BY_HUMAN" ||
                err.code === "DECISION_NOT_EXECUTABLE"
              ? "PRECONDITION_FAILED"
              : "INTERNAL_SERVER_ERROR";
    return new TRPCError({ code, message: err.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: err instanceof Error ? err.message : "Unexpected nurture/handoff failure.",
  });
}

// ─── Upstream port wiring (guarded bridges; fail closed when absent) ───
//
// Production wiring is an R6-X activation slot: the R6-C projection surface,
// R6-A identity projection, R6-F privacy store and R6-E conversion store are
// consumed through their frozen contracts once those streams land. Until
// then every port fails closed with an honest unavailable answer — D never
// guesses authority.

const unavailablePorts: NurtureUpstreamPorts = {
  async getQualificationProjection() {
    throw new NurtureError(
      "QUALIFICATION_NOT_FOUND",
      "QUALIFICATION_NOT_FOUND: qualification authority bridge is not wired in this environment (R6-X activation slot)."
    );
  },
  async getLeadIdentity() {
    throw new NurtureError(
      "OWNERSHIP_MISMATCH",
      "OWNERSHIP_MISMATCH: identity authority bridge is not wired in this environment (R6-X activation slot)."
    );
  },
  async getPrivacyEvidence() {
    // Fail closed: privacy truth is never guessed.
    return { available: false, state: "ACTIVE", explicit: false, retentionDeadlineAt: null, previousState: null, source: null, actorUserId: null, updatedAt: null };
  },
  async listConversionsForLead() {
    return [];
  },
  async getApprovalRequest() {
    return null;
  },
};

function buildDeps(): NurtureServiceDeps {
  return {
    ports: unavailablePorts,
    // No transport wired: dispatch fails closed (contract §10).
  };
}

const EvaluateInputSchema = z.strictObject({
  qualificationId: z.string().min(1).max(96),
  channel: z.enum(["email", "whatsapp", "sms", "crm"]).optional(),
});

const ByIdInputSchema = z.strictObject({
  handoffId: z.string().min(1).max(96),
});

const DecisionByIdInputSchema = z.strictObject({
  nurtureDecisionId: z.string().min(1).max(96),
});

const TouchInputSchema = z.strictObject({
  nurtureDecisionId: z.string().min(1).max(96),
  draft: z.strictObject({
    channel: z.enum(["email", "whatsapp", "sms", "crm"]),
    subject: z.string().max(200).optional(),
    body: z.string().min(1).max(4000),
    cta: z.string().max(200).optional(),
  }),
});

const ViewInputSchema = z.strictObject({
  leadId: z.string().min(1).max(96),
});

export const nurtureRouter = createRouter({
  /** Schema/readiness probe: honest availability of the D tables + ports. */
  status: authedQuery.query(async () => {
    const tablesAvailable = await nurtureTablesAvailable().catch(() => false);
    return {
      contractVersion: "lead-nurture-sales-handoff/v1",
      tablesAvailable,
      defaultPolicyVersion: buildNurtureHandoffPolicy(buildDefaultNurturePolicyConfig()).policyVersion,
      portsWired: false,
      transportConfigured: false,
    };
  }),

  evaluate: authedQuery.input(EvaluateInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await evaluateNurture(buildDeps(), ctx.user.id, input);
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  getDecision: authedQuery.input(DecisionByIdInputSchema).query(async ({ ctx, input }) => {
    try {
      const row = await getDecisionById(ctx.user.id, input.nurtureDecisionId);
      if (!row) throw new NurtureError("DECISION_NOT_FOUND", `DECISION_NOT_FOUND: ${input.nurtureDecisionId}.`);
      return row;
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  getHandoff: authedQuery.input(ByIdInputSchema).query(async ({ ctx, input }) => {
    try {
      const row = await getHandoffById(ctx.user.id, input.handoffId);
      if (!row) throw new NurtureError("HANDOFF_NOT_FOUND", `HANDOFF_NOT_FOUND: ${input.handoffId}.`);
      return row;
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  dispatchHandoff: authedQuery.input(ByIdInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await dispatchHandoff(buildDeps(), ctx.user.id, input);
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  reconcileHandoff: authedQuery.input(ByIdInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await reconcileHandoff(buildDeps(), ctx.user.id, input);
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  dispatchNurtureTouch: authedQuery.input(TouchInputSchema).mutation(async ({ ctx, input }) => {
    try {
      return await dispatchNurtureTouch(buildDeps(), ctx.user.id, input);
    } catch (err) {
      throw toTrpcError(err);
    }
  }),

  /** F-consumable operations view (contract §16). */
  getLeadView: authedQuery.input(ViewInputSchema).query(async ({ ctx, input }) => {
    try {
      return await getLeadNurtureHandoffView(buildDeps(), ctx.user.id, input.leadId);
    } catch (err) {
      throw toTrpcError(err);
    }
  }),
});
