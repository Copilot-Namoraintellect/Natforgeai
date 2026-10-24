/**
 * Engagement Planning (WBS-R5-C1/C2/C3 orchestration).
 *
 * Turns one authoritative (signal, interpretation) pair into a governed
 * engagement plan:
 *
 *   C1 canonical action request (identity-bound, fail closed)
 *     → C3 policy evaluation through the REAL R5-E engine (vendored, never
 *       re-implemented: getActivePolicy → authority snapshots →
 *       evaluateMarketingActionPolicy → recordPolicyDecision → governed
 *       approval row → policy_decision audit)
 *     → C2 response generation (only for ALLOW_AUTONOMOUS / REQUIRE_APPROVAL)
 *     → durable execution row (only for executable-in-principle dispositions)
 *
 * DENY / ESCALATE / NO_ACTION decisions produce no execution and no content:
 * their durable authority is the decision row (+ escalation approval row),
 * which the operations projection surfaces. Duplicate planning of the same
 * logical action converges through the E decision scope key and the C
 * execution unique key — replays never duplicate evaluations, approvals,
 * content, or executions.
 */

import { createHash } from "crypto";
import type { MarketingPlatform } from "../policy/action-request";
import type { PolicyDecision } from "../policy/decision-engine";
import { evaluateMarketingActionPolicy } from "../policy/decision-engine";
import type { AuthoritativeIntelligence } from "../policy/risk-classification";
import { getActivePolicy } from "../policy/policy-store";
import {
  recordPolicyDecision,
  type PolicyDecisionDuplicateClassification,
} from "../policy/policy-decision-store";
import {
  resolveCostAuthoritySnapshot,
  resolveVolumeAuthoritySnapshot,
  resolvePeriodAutonomousSpend,
  resolveProviderCapabilitySnapshot,
  resolveProviderRateSnapshot,
} from "../policy/policy-authority-resolver";
import {
  buildMarketingActionApprovalCommand,
  type MarketingActionApprovalCommand,
} from "../policy/marketing-action-approval";
import { buildPolicyDecisionAuditEvent } from "../policy/policy-audit";
import { persistAuditEvent } from "../audit/audit-store";
import { approvalRequests } from "@db/schema";
import { eq } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  buildEngagementActionRequest,
  deriveResponseContextVersion,
  ENGAGEMENT_ACTION_CONTRACT_VERSION,
  type EngagementActionType,
  type EngagementSourceSignal,
  type EngagementSourceInterpretation,
} from "./action-request";
import { deriveAuthoritativeIntelligence, type EngagementInterpretationView } from "./intelligence";
import {
  generateEngagementResponse,
  buildDeterministicEngagementNote,
  type EngagementBrandContext,
} from "./response-generation";
import { persistEngagementResponseContent } from "./response-store";
import {
  assertEngagementCapabilitySupported,
  isEngagementProviderCapable,
  resolveEngagementBinding,
} from "./provider-boundary";
import {
  insertEngagementExecution,
  type EngagementExecutionRecord,
  type EngagementStoreExecutor,
} from "./execution-store";
import type { runAgent } from "../agents/runner";

export const ENGAGEMENT_PLANNING_CONTRACT_VERSION = "engagement/planning@v1";

export class EngagementPlanningError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngagementPlanningError";
    this.code = code;
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface PlanEngagementActionInput {
  userId: number;
  businessId: number;
  signal: EngagementSourceSignal & { contentText?: string | null };
  interpretation: EngagementSourceInterpretation & EngagementInterpretationView;
  actionType: EngagementActionType;
  platform: MarketingPlatform;
  /** Required for provider-capable actions; verified server-side here. */
  integrationId?: number | null;
  /** Explicit external target override; defaults to the signal's external object. */
  externalTarget?: string;
  campaignId?: number | null;
  publicationId?: number | null;
  requestedAt?: string;
  brand: EngagementBrandContext;
  businessDnaSnapshotId?: string | null;
}

export interface EngagementPlan {
  actionRequestId: string;
  responseContextVersion: string;
  decision: PolicyDecision;
  duplicateClassification: PolicyDecisionDuplicateClassification;
  approvalRequestId: number | null;
  responseContentId: string | null;
  responseContentVersion: number | null;
  execution: EngagementExecutionRecord | null;
}

export interface PlanningDeps {
  executor?: EngagementStoreExecutor;
  /** Injected governed runner (tests); defaults to the real runAgent. */
  runModel?: typeof runAgent;
  /** Injected policy-evaluation orchestration (tests); defaults to the real E path. */
  evaluate?: (input: {
    request: ReturnType<typeof buildEngagementActionRequest>;
    userId: number;
    intelligence: AuthoritativeIntelligence;
    businessId: number;
  }) => Promise<{
    decision: PolicyDecision;
    duplicateClassification: PolicyDecisionDuplicateClassification;
    approvalRequestId: number | null;
  }>;
}

async function persistMarketingActionApprovalRow(
  command: MarketingActionApprovalCommand,
  executor: EngagementStoreExecutor
): Promise<number> {
  try {
    const result = await executor
      .insert(approvalRequests)
      .values({
        userId: command.userId,
        campaignId: command.campaignId,
        approvalType: command.approvalType,
        title: command.title,
        description: command.description,
        aiRecommendation: command.aiRecommendation,
        riskLevel: command.riskLevel,
        status: "pending",
        idempotencyKey: command.idempotencyKey,
        context: command.context as unknown as Record<string, unknown>,
      });
    const insertId = (result as unknown as { insertId?: number | string }).insertId;
    if (insertId != null) return Number(insertId);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const message = (err as { message?: string })?.message ?? "";
    if (code !== "ER_DUP_ENTRY" && !/Duplicate entry/i.test(message)) throw err;
  }
  const [existing] = (await executor
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.idempotencyKey, command.idempotencyKey))
    .limit(1)) as Array<{ id: number }>;
  if (!existing) {
    throw new EngagementPlanningError(
      "APPROVAL_REPLAY_UNRESOLVED",
      "Approval persistence conflict could not be resolved."
    );
  }
  return existing.id;
}

async function auditDecision(decision: PolicyDecision): Promise<void> {
  try {
    const event = buildPolicyDecisionAuditEvent({ decision, occurredAt: decision.evaluatedAt });
    await persistAuditEvent(event);
  } catch (err) {
    console.error(
      `[Engagement] Failed to persist policy_decision audit for ${decision.policyDecisionId}:`,
      (err as Error)?.message
    );
  }
}

/** The real R5-E evaluation path — identical orchestration to E's router. */
async function evaluateWithPolicyEngine(input: {
  request: ReturnType<typeof buildEngagementActionRequest>;
  userId: number;
  intelligence: AuthoritativeIntelligence;
  businessId: number;
  executor?: EngagementStoreExecutor;
}): Promise<{
  decision: PolicyDecision;
  duplicateClassification: PolicyDecisionDuplicateClassification;
  approvalRequestId: number | null;
}> {
  const policy = await getActivePolicy(input.businessId, input.executor);
  const [cost, volume, providerCapability, providerRate, periodAutonomousSpend] =
    await Promise.all([
      resolveCostAuthoritySnapshot(input.userId),
      resolveVolumeAuthoritySnapshot(input.businessId, input.request.platform),
      resolveProviderCapabilitySnapshot({
        userId: input.userId,
        businessId: input.businessId,
        request: input.request,
      }),
      resolveProviderRateSnapshot(input.request),
      resolvePeriodAutonomousSpend(input.businessId),
    ]);
  cost.periodAutonomousSpend = periodAutonomousSpend;

  const decision = evaluateMarketingActionPolicy({
    request: input.request,
    userId: input.userId,
    policy,
    intelligence: input.intelligence,
    cost,
    volume,
    providerRate,
    providerCapability,
    now: new Date().toISOString(),
  });

  const recorded = await recordPolicyDecision(decision, input.executor);
  let approvalRequestId: number | null = null;
  if (recorded.duplicateClassification === "none") {
    if (recorded.decision.decision === "REQUIRE_APPROVAL" && recorded.decision.approvalBinding) {
      const command = buildMarketingActionApprovalCommand({
        decision: recorded.decision,
        userId: input.userId,
        mode: "approval",
      });
      approvalRequestId = await persistMarketingActionApprovalRow(
        command,
        (input.executor ?? (getDb() as unknown as EngagementStoreExecutor)) as EngagementStoreExecutor
      );
    } else if (recorded.decision.decision === "ESCALATE") {
      const command = buildMarketingActionApprovalCommand({
        decision: recorded.decision,
        userId: input.userId,
        mode: "escalation",
      });
      approvalRequestId = await persistMarketingActionApprovalRow(
        command,
        (input.executor ?? (getDb() as unknown as EngagementStoreExecutor)) as EngagementStoreExecutor
      );
    }
  }

  await auditDecision(recorded.decision);
  return {
    decision: recorded.decision,
    duplicateClassification: recorded.duplicateClassification,
    approvalRequestId,
  };
}

/**
 * Plan one governed engagement action end to end. Idempotent: same logical
 * action → same actionRequestId → converged decision/content/execution.
 */
export async function planEngagementAction(
  input: PlanEngagementActionInput,
  deps?: PlanningDeps
): Promise<EngagementPlan> {
  const executor = deps?.executor ?? (getDb() as unknown as EngagementStoreExecutor);

  // Surface validation: the action platform must be the signal's platform —
  // a reply never acts on a different surface than the evidence it binds to.
  if (input.signal.platform !== input.platform) {
    throw new EngagementPlanningError(
      "PLATFORM_MISMATCH",
      `Action platform ${input.platform} does not match the signal platform ${input.signal.platform}.`
    );
  }

  const providerCapable = isEngagementProviderCapable(input.actionType);

  // Server-side binding verification BEFORE the request is built — the
  // binding reference carries the verified external account ref, and a
  // forged/drifted/cross-business binding fails closed here.
  let bindingRef: {
    integrationId: number;
    platform: MarketingPlatform;
    externalAccountRef: string | null;
  } | null = null;
  let bindingProvider: string | null = null;
  if (providerCapable) {
    if (input.integrationId == null) {
      throw new EngagementPlanningError(
        "INVALID_PROVIDER_BINDING",
        "Provider-capable engagement actions require a provider account binding."
      );
    }
    const capability = assertEngagementCapabilitySupported({
      actionType: input.actionType,
      platform: input.platform,
    });
    const binding = await resolveEngagementBinding(
      {
        integrationId: input.integrationId,
        businessId: input.businessId,
        userId: input.userId,
        platform: input.platform,
      },
      executor
    );
    void capability;
    bindingRef = {
      integrationId: binding.integrationId,
      platform: input.platform,
      externalAccountRef: binding.providerAccountRef,
    };
    bindingProvider = binding.provider;
  }

  const responseContextVersion = deriveResponseContextVersion({
    interpretationId: input.interpretation.interpretationId,
    signalContentHash: input.interpretation.signalContentHash,
    providerEvidenceHash: input.signal.providerEvidenceHash,
    businessDnaSnapshotId: input.businessDnaSnapshotId ?? null,
    platform: input.platform,
  });

  const externalTarget = input.externalTarget ?? "";
  const request = buildEngagementActionRequest({
    businessId: input.businessId,
    userId: input.userId,
    signal: input.signal,
    interpretation: input.interpretation,
    actionType: input.actionType,
    platform: input.platform,
    providerAccountBinding: bindingRef,
    externalTarget,
    campaignId: input.campaignId ?? null,
    publicationId: input.publicationId ?? null,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
    businessDnaSnapshotId: input.businessDnaSnapshotId ?? null,
  });

  const intelligence = deriveAuthoritativeIntelligence({
    interpretation: input.interpretation,
  });

  const evaluation = deps?.evaluate
    ? await deps.evaluate({ request, userId: input.userId, intelligence, businessId: input.businessId })
    : await evaluateWithPolicyEngine({
        request,
        userId: input.userId,
        intelligence,
        businessId: input.businessId,
        executor,
      });

  const { decision } = evaluation;
  const executableDisposition =
    decision.decision === "ALLOW_AUTONOMOUS" || decision.decision === "REQUIRE_APPROVAL";

  // C2: generation only for executable-in-principle dispositions.
  let responseContentId: string | null = null;
  let responseContentVersion: number | null = null;
  if (executableDisposition) {
    if (input.actionType === "reply_publicly") {
      const generated = await generateEngagementResponse(
        {
          userId: input.userId,
          businessId: input.businessId,
          actionRequestId: request.actionRequestId,
          actionType: input.actionType,
          platform: input.platform,
          responseContextVersion,
          interpretation: input.interpretation,
          socialText: input.signal.contentText ?? null,
          brand: input.brand,
        },
        deps?.runModel ? { runModel: deps.runModel } : undefined
      );
      responseContentId = generated.responseContentId;
      responseContentVersion = generated.version;
    } else {
      // escalate_to_human / suppress_action: deterministic non-executable note.
      const note = buildDeterministicEngagementNote({
        actionType: input.actionType,
        interpretation: input.interpretation,
        responseContextVersion,
        userId: input.userId,
        businessId: input.businessId,
        actionRequestId: request.actionRequestId,
        platform: input.platform,
      });
      await persistEngagementResponseContent(note, executor);
      responseContentId = note.responseContentId;
      responseContentVersion = note.version;
    }
  }

  // Durable execution row only for executable dispositions.
  let execution: EngagementExecutionRecord | null = null;
  if (executableDisposition && responseContentId) {
    const executionId =
      "eex_" + sha256Hex(`${ENGAGEMENT_ACTION_CONTRACT_VERSION}:${request.actionRequestId}`).slice(0, 40);
    const { record } = await insertEngagementExecution(
      {
        executionId,
        actionRequestId: request.actionRequestId,
        businessId: input.businessId,
        userId: input.userId,
        signalId: input.signal.signalId,
        signalVersion: input.signal.signalVersion,
        interpretationId: input.interpretation.interpretationId,
        policyDecisionId: decision.policyDecisionId,
        approvalRequestId: evaluation.approvalRequestId,
        responseContentId,
        responseContentVersion: responseContentVersion ?? 1,
        provider: providerCapable ? bindingProvider ?? "meta" : "none",
        platform: input.platform,
        actionType: input.actionType,
        integrationId: bindingRef?.integrationId ?? null,
        externalTarget,
        status: "pending_claim",
        attempt: 0,
        maxRetries: 3,
        reconciliationState: "none",
      },
      executor
    );
    execution = record;
  }

  return {
    actionRequestId: request.actionRequestId,
    responseContextVersion,
    decision,
    duplicateClassification: evaluation.duplicateClassification,
    approvalRequestId: evaluation.approvalRequestId,
    responseContentId,
    responseContentVersion,
    execution,
  };
}
