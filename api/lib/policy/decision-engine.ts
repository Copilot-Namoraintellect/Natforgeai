/**
 * Policy Decision Engine (WBS-R5-E3).
 *
 * Pure, deterministic evaluation:
 *
 *   action request + authoritative intelligence + business policy
 *   + budget/quota authority + provider capability
 *   -> durable policy decision
 *
 * Guarantees:
 * - fail closed on missing policy, unknown action type, intelligence
 *   binding mismatch and every eligibility gate;
 * - risk can only reduce autonomy (monotone composition of disposition
 *   ceiling and risk mapping; policy validation enforces monotonicity);
 * - social/intelligence content is inert data — injection suspicion only
 *   ever raises risk, never widens authority;
 * - deterministic decision identity: one action request + one policy
 *   version -> one stable policyDecisionId; retries and concurrent
 *   evaluations converge through the durable store's unique insert;
 * - no clock access: the caller supplies `now` explicitly;
 * - no side effects: nothing is charged, sent, reserved or persisted here.
 */

import { createHash } from "crypto";
import {
  deriveCostClass,
  isBillableAction,
  MARKETING_ACTION_TYPES,
  type MarketingActionRequest,
} from "./action-request";
import { classifyActionCeiling, type VersionedBusinessPolicy } from "./policy-model";
import {
  classifyRisk,
  type AuthoritativeIntelligence,
} from "./risk-classification";
import {
  buildBillingIdentity,
  evaluateCostEligibility,
  evaluateRateEligibility,
  type CostAuthoritySnapshot,
  type ProviderRateSnapshot,
  type VolumeAuthoritySnapshot,
} from "./cost-governance";
import {
  DECISION_AUTONOMY_RANK,
  type PolicyDecisionOutcome,
  type PolicyReasonCode,
  type RiskTier,
} from "./policy-types";

/** Server-verified provider capability state for provider-bound actions. */
export interface ProviderCapabilitySnapshot {
  /** Integration ownership + connected status verified server-side. */
  bindingVerified: boolean;
  /** Provider supports this action type on this binding. */
  capabilityAvailable: boolean;
}

export interface PolicyEvaluationInput {
  /** Validated action request. */
  request: MarketingActionRequest;
  /** Server-resolved owning user (tenant scope). */
  userId: number;
  /** Server-resolved active policy; null = missing -> fail closed. */
  policy: VersionedBusinessPolicy | null;
  /** Server-resolved authoritative intelligence. */
  intelligence: AuthoritativeIntelligence;
  cost: CostAuthoritySnapshot;
  volume: VolumeAuthoritySnapshot;
  providerRate: ProviderRateSnapshot;
  /** Required only when the action type requires provider capability. */
  providerCapability: ProviderCapabilitySnapshot | null;
  /** Explicit evaluation clock (ISO 8601). */
  now: string;
}

/** Approval requirement bound to the exact action/policy authority (E6). */
export interface ApprovalBinding {
  policyDecisionId: string;
  actionRequestId: string;
  businessId: number;
  policyVersion: string;
  contextVersion: string;
  riskClass: RiskTier;
  estimatedCostClass: ReturnType<typeof deriveCostClass>;
  billingIdentity: string | null;
  expiresAt: string;
}

/** The durable, immutable policy decision (E3/E7). */
export interface PolicyDecision {
  policyDecisionId: string;
  policyId: string | null;
  policyVersion: string | null;
  businessId: number;
  userId: number;
  actionRequestId: string;
  sourceSignalId: string | null;
  sourceInterpretationId: string | null;
  intelligenceVersion: string | null;
  actionType: string;
  platform: string;
  campaignId: number | null;
  decision: PolicyDecisionOutcome;
  reasonCodes: readonly PolicyReasonCode[];
  riskClass: RiskTier;
  approvalRequired: boolean;
  costEligible: boolean;
  rateEligible: boolean;
  providerEligible: boolean;
  estimatedCostClass: ReturnType<typeof deriveCostClass>;
  estimatedCredits: number;
  billingIdentity: string | null;
  approvalBinding: ApprovalBinding | null;
  /** Bounded snapshot of the thresholds used (explainability, E7). */
  thresholds: Readonly<Record<string, number>>;
  expiresAt: string | null;
  evaluatedAt: string;
  /** Full-input fingerprint for replay/evidence verification. */
  evaluationFingerprint: string;
}

export class PolicyEvaluationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PolicyEvaluationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new PolicyEvaluationError(code, message);
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    return value;
  }
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function assertNow(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail("INVALID_EVALUATION_CLOCK", `now must be an explicit ISO 8601 timestamp, got ${String(value)}.`);
  }
  return value;
}

/**
 * Deterministic decision identity: one action request + one policy version
 * -> one stable id. Excludes evaluation time and authority snapshots so a
 * legitimate retry converges; a changed request/policy produces a new id.
 */
export function buildPolicyDecisionId(input: {
  actionRequestId: string;
  businessId: number;
  policyVersion: string | null;
  actionType: string;
  platform: string;
  contextVersion: string;
  sourceInterpretationId: string | null;
  intelligenceVersion: string | null;
}): string {
  return `pdec_${sha256(
    canonicalize({
      v: 1,
      actionRequestId: input.actionRequestId,
      businessId: input.businessId,
      policyVersion: input.policyVersion ?? "NO_POLICY",
      actionType: input.actionType,
      platform: input.platform,
      contextVersion: input.contextVersion,
      sourceInterpretationId: input.sourceInterpretationId,
      intelligenceVersion: input.intelligenceVersion,
    })
  ).slice(0, 40)}`;
}

type AutonomyRanked = Exclude<PolicyDecisionOutcome, "NO_ACTION">;

function weakerDisposition(
  a: AutonomyRanked,
  b: AutonomyRanked
): AutonomyRanked {
  return DECISION_AUTONOMY_RANK[a] <= DECISION_AUTONOMY_RANK[b] ? a : b;
}

function utcMinutesOfDay(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) fail("INVALID_EVALUATION_CLOCK", `Unparseable evaluation clock ${iso}.`);
  const d = new Date(ms);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function isWithinBusinessHours(
  windows: Array<{ start: string; end: string }>,
  iso: string
): boolean {
  const t = utcMinutesOfDay(iso);
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
    return h * 60 + m;
  };
  return windows.some(({ start, end }) => {
    const s = toMin(start);
    const e = toMin(end);
    // Window may wrap UTC midnight.
    return s <= e ? t >= s && t <= e : t >= s || t <= e;
  });
}

function addExpiry(now: string, ttlMinutes: number): string {
  return new Date(Date.parse(now) + ttlMinutes * 60_000).toISOString();
}

function buildThresholdsSnapshot(policy: VersionedBusinessPolicy): Record<string, number> {
  const c = policy.config;
  return {
    minAutonomousConfidence: c.minAutonomousConfidence,
    maxAutonomousCreditsPerDay: c.spend.maxAutonomousCreditsPerDay,
    maxActionCredits: c.spend.maxActionCredits,
    maxActionsPerDay: c.volume.maxActionsPerDay,
    maxActionsPerChannelPerDay: c.volume.maxActionsPerChannelPerDay,
    executionTtlMinutes: c.executionTtlMinutes,
  };
}

interface MutableOutcome {
  decision: AutonomyRanked;
  reasonCodes: PolicyReasonCode[];
}

function pushReason(out: MutableOutcome, code: PolicyReasonCode): void {
  if (!out.reasonCodes.includes(code)) out.reasonCodes.push(code);
}

/**
 * Evaluate one marketing action request. Pure and deterministic: identical
 * inputs produce a byte-identical decision (same id, same reasons, same
 * fingerprint).
 */
export function evaluateMarketingActionPolicy(input: PolicyEvaluationInput): PolicyDecision {
  const now = assertNow(input.now);
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    fail("INVALID_EVALUATION_INPUT", `userId must be a positive integer, got ${String(input.userId)}.`);
  }
  const request = input.request;
  if (typeof request !== "object" || request === null) {
    fail("INVALID_EVALUATION_INPUT", "request must be a validated MarketingActionRequest.");
  }

  const baseIdentity = {
    actionRequestId: request.actionRequestId,
    businessId: request.businessId,
    actionType: request.actionType,
    platform: request.platform,
    contextVersion: request.contextVersion,
    sourceInterpretationId: request.sourceInterpretationId,
  };

  const derivedCostClass = deriveCostClass(
    (MARKETING_ACTION_TYPES as readonly string[]).includes(request.actionType)
      ? request.actionType
      : "observe_only"
  );

  // --- Fail-closed pre-checks ------------------------------------------------
  const unknownAction = !(MARKETING_ACTION_TYPES as readonly string[]).includes(request.actionType);
  if (unknownAction) {
    return finalize({
      input,
      now,
      decisionId: buildPolicyDecisionId({ ...baseIdentity, policyVersion: input.policy?.policyVersion ?? null, intelligenceVersion: null }),
      policy: input.policy,
      decision: "DENY",
      reasonCodes: ["UNKNOWN_ACTION_TYPE"],
      riskClass: "high",
      intelligenceVersion: null,
      estimatedCostClass: "none",
      estimatedCredits: 0,
      billingIdentity: null,
      approvalBinding: null,
      costEligible: false,
      rateEligible: false,
      providerEligible: false,
      thresholds: input.policy ? buildThresholdsSnapshot(input.policy) : {},
      expiresAt: null,
    });
  }

  if (input.policy === null) {
    return finalize({
      input,
      now,
      decisionId: buildPolicyDecisionId({ ...baseIdentity, policyVersion: null, intelligenceVersion: input.intelligence.intelligenceVersion }),
      policy: null,
      decision: "DENY",
      reasonCodes: ["POLICY_MISSING"],
      riskClass: "high",
      intelligenceVersion: input.intelligence.intelligenceVersion,
      estimatedCostClass: "none",
      estimatedCredits: 0,
      billingIdentity: null,
      approvalBinding: null,
      costEligible: false,
      rateEligible: false,
      providerEligible: false,
      thresholds: {},
      expiresAt: null,
    });
  }

  const policy = input.policy;
  const intelligence = input.intelligence;

  if (
    request.sourceInterpretationId !== null &&
    intelligence.sourceInterpretationId !== request.sourceInterpretationId
  ) {
    return finalize({
      input,
      now,
      decisionId: buildPolicyDecisionId({ ...baseIdentity, policyVersion: policy.policyVersion, intelligenceVersion: intelligence.intelligenceVersion }),
      policy,
      decision: "DENY",
      reasonCodes: ["INTELLIGENCE_BINDING_MISMATCH"],
      riskClass: "high",
      intelligenceVersion: intelligence.intelligenceVersion,
      estimatedCostClass: derivedCostClass,
      estimatedCredits: 0,
      billingIdentity: null,
      approvalBinding: null,
      costEligible: false,
      rateEligible: false,
      providerEligible: false,
      thresholds: buildThresholdsSnapshot(policy),
      expiresAt: null,
    });
  }

  // --- Risk classification (E4) ----------------------------------------------
  const classification = classifyRisk(intelligence, policy.config.minAutonomousConfidence);
  const riskClass = classification.riskClass;

  // --- Suppression: durable no-op --------------------------------------------
  if (request.actionType === "suppress_action") {
    return finalize({
      input,
      now,
      decisionId: buildPolicyDecisionId({ ...baseIdentity, policyVersion: policy.policyVersion, intelligenceVersion: intelligence.intelligenceVersion }),
      policy,
      decision: "NO_ACTION",
      reasonCodes: ["SUPPRESSION_REQUESTED", ...classification.factors],
      riskClass,
      intelligenceVersion: intelligence.intelligenceVersion,
      estimatedCostClass: "none",
      estimatedCredits: 0,
      billingIdentity: null,
      approvalBinding: null,
      costEligible: true,
      rateEligible: true,
      providerEligible: true,
      thresholds: buildThresholdsSnapshot(policy),
      expiresAt: null,
    });
  }

  // --- Base disposition: ceiling x risk mapping -------------------------------
  const out: MutableOutcome = { decision: "DENY", reasonCodes: [] };
  const ceiling = classifyActionCeiling(policy.config, request.actionType);
  const riskDisposition = policy.config.riskDispositions[riskClass];

  if (ceiling === "prohibited") {
    out.decision = "DENY";
    pushReason(out, "ACTION_PROHIBITED_BY_POLICY");
  } else if (ceiling === "unlisted") {
    if (policy.config.defaultActionDisposition === "deny") {
      out.decision = "DENY";
      pushReason(out, "ACTION_DEFAULTED_TO_DENY");
    } else {
      out.decision = weakerDisposition(riskDisposition, "REQUIRE_APPROVAL");
      pushReason(out, "ACTION_DEFAULTED_TO_APPROVAL");
    }
  } else if (ceiling === "require_approval") {
    out.decision = weakerDisposition(riskDisposition, "REQUIRE_APPROVAL");
    pushReason(out, "ACTION_REQUIRES_APPROVAL_BY_POLICY");
  } else {
    out.decision = riskDisposition;
  }

  if (out.decision === "ALLOW_AUTONOMOUS") {
    pushReason(out, "ACTION_ALLOWED_BY_POLICY");
  } else if (out.decision === "REQUIRE_APPROVAL" && riskDisposition === "REQUIRE_APPROVAL" && ceiling === "autonomous") {
    pushReason(out, "APPROVAL_REQUIRED_BY_RISK");
  } else if (out.decision === "ESCALATE") {
    pushReason(out, riskClass === "critical" ? "CRITICAL_RISK_ESCALATION" : "ESCALATED_BY_RISK");
  }
  for (const factor of classification.factors) pushReason(out, factor);

  if (request.estimatedCostClass !== derivedCostClass) {
    pushReason(out, "COST_CLASS_DECLARATION_MISMATCH");
  }

  // --- Gates ------------------------------------------------------------------
  // Channel restrictions deny outright (monotone: never widens).
  if (policy.config.prohibitedPlatforms.includes(request.platform as never)) {
    out.decision = "DENY";
    pushReason(out, "CHANNEL_PROHIBITED_BY_POLICY");
  } else if (
    policy.config.allowedPlatforms !== null &&
    !policy.config.allowedPlatforms.includes(request.platform as never)
  ) {
    out.decision = "DENY";
    pushReason(out, "CHANNEL_NOT_IN_ALLOWED_LIST");
  }

  // Business hours narrow autonomy (allow -> approval), never deny outright.
  if (policy.config.businessHours?.enabled && out.decision === "ALLOW_AUTONOMOUS") {
    if (!isWithinBusinessHours(policy.config.businessHours.windows, now)) {
      out.decision = "REQUIRE_APPROVAL";
      pushReason(out, "OUTSIDE_BUSINESS_HOURS");
    }
  }

  const billable = isBillableAction(request.actionType);
  const cost = evaluateCostEligibility({
    request,
    billable,
    policySpend: policy.config.spend,
    cost: input.cost,
  });
  const rate = evaluateRateEligibility({
    platform: request.platform,
    policyVolume: policy.config.volume,
    volume: input.volume,
    providerRate: input.providerRate,
  });

  let providerEligible = true;
  const requiresProvider =
    request.actionType === "reply_publicly" ||
    request.actionType === "reply_privately" ||
    request.actionType === "react" ||
    request.actionType === "nurture_candidate";
  if (requiresProvider) {
    if (!input.providerCapability || !input.providerCapability.bindingVerified) {
      providerEligible = false;
      pushReason(out, "PROVIDER_BINDING_MISMATCH");
    } else if (!input.providerCapability.capabilityAvailable) {
      providerEligible = false;
      pushReason(out, "PROVIDER_CAPABILITY_UNAVAILABLE");
    }
  }

  // Eligibility failures deny executable dispositions (escalations stay
  // escalations — a human sees them regardless).
  if (out.decision === "ALLOW_AUTONOMOUS" || out.decision === "REQUIRE_APPROVAL") {
    if (!providerEligible) {
      out.decision = "DENY";
    } else if (!cost.costEligible) {
      out.decision = "DENY";
      for (const c of cost.reasonCodes) pushReason(out, c);
    } else if (!rate.rateEligible) {
      out.decision = "DENY";
      for (const c of rate.reasonCodes) pushReason(out, c);
    }
  }

  const decisionId = buildPolicyDecisionId({
    ...baseIdentity,
    policyVersion: policy.policyVersion,
    intelligenceVersion: intelligence.intelligenceVersion,
  });

  // Billing identity exists only for decisions that can actually settle a
  // charge: denied, escalated and suppressed actions are non-billable by
  // construction and carry no billing identity at all.
  const billingIdentity =
    out.decision === "ALLOW_AUTONOMOUS" || out.decision === "REQUIRE_APPROVAL"
      ? buildBillingIdentity(request, derivedCostClass)
      : null;

  const approvalBinding: ApprovalBinding | null =
    out.decision === "REQUIRE_APPROVAL"
      ? {
          policyDecisionId: decisionId,
          actionRequestId: request.actionRequestId,
          businessId: request.businessId,
          policyVersion: policy.policyVersion,
          contextVersion: request.contextVersion,
          riskClass,
          estimatedCostClass: derivedCostClass,
          billingIdentity,
          expiresAt: addExpiry(now, policy.config.executionTtlMinutes),
        }
      : null;

  return finalize({
    input,
    now,
    decisionId,
    policy,
    decision: out.decision,
    reasonCodes: out.reasonCodes,
    riskClass,
    intelligenceVersion: intelligence.intelligenceVersion,
    estimatedCostClass: derivedCostClass,
    estimatedCredits:
      out.decision === "ALLOW_AUTONOMOUS" || out.decision === "REQUIRE_APPROVAL"
        ? cost.estimatedCredits
        : 0,
    billingIdentity,
    approvalBinding,
    costEligible: cost.costEligible,
    rateEligible: rate.rateEligible,
    providerEligible,
    thresholds: buildThresholdsSnapshot(policy),
    expiresAt:
      out.decision === "ALLOW_AUTONOMOUS" || out.decision === "REQUIRE_APPROVAL"
        ? addExpiry(now, policy.config.executionTtlMinutes)
        : null,
  });
}

function finalize(args: {
  input: PolicyEvaluationInput;
  now: string;
  decisionId: string;
  policy: VersionedBusinessPolicy | null;
  decision: PolicyDecisionOutcome;
  reasonCodes: readonly PolicyReasonCode[];
  riskClass: RiskTier;
  intelligenceVersion: string | null;
  estimatedCostClass: ReturnType<typeof deriveCostClass>;
  estimatedCredits: number;
  billingIdentity: string | null;
  approvalBinding: ApprovalBinding | null;
  costEligible: boolean;
  rateEligible: boolean;
  providerEligible: boolean;
  thresholds: Record<string, number>;
  expiresAt: string | null;
}): PolicyDecision {
  const request = args.input.request;
  // Canonical fingerprint input uses raw request fields (the UNKNOWN_ACTION
  // path cannot re-validate through buildMarketingActionRequest).
  const requestMaterial = {
    actionRequestId: request.actionRequestId,
    businessId: request.businessId,
    sourceSignalId: request.sourceSignalId,
    sourceInterpretationId: request.sourceInterpretationId,
    actionType: request.actionType,
    platform: request.platform,
    campaignId: request.campaignId,
    publicationId: request.publicationId,
    contextVersion: request.contextVersion,
  };
  const evaluationFingerprint = sha256(
    canonicalize({
      v: 1,
      decisionId: args.decisionId,
      decision: args.decision,
      reasonCodes: args.reasonCodes,
      riskClass: args.riskClass,
      request: requestMaterial,
      policyVersion: args.policy?.policyVersion ?? null,
      intelligenceVersion: args.intelligenceVersion,
      costEligible: args.costEligible,
      rateEligible: args.rateEligible,
      providerEligible: args.providerEligible,
    })
  );

  return Object.freeze({
    policyDecisionId: args.decisionId,
    policyId: args.policy?.policyId ?? null,
    policyVersion: args.policy?.policyVersion ?? null,
    businessId: request.businessId,
    userId: args.input.userId,
    actionRequestId: request.actionRequestId,
    sourceSignalId: request.sourceSignalId,
    sourceInterpretationId: request.sourceInterpretationId,
    intelligenceVersion: args.intelligenceVersion,
    actionType: request.actionType,
    platform: request.platform,
    campaignId: request.campaignId,
    decision: args.decision,
    reasonCodes: Object.freeze([...args.reasonCodes]) as readonly PolicyReasonCode[],
    riskClass: args.riskClass,
    approvalRequired: args.decision === "REQUIRE_APPROVAL",
    costEligible: args.costEligible,
    rateEligible: args.rateEligible,
    providerEligible: args.providerEligible,
    estimatedCostClass: args.estimatedCostClass,
    estimatedCredits: args.estimatedCredits,
    billingIdentity: args.billingIdentity,
    approvalBinding: args.approvalBinding ? Object.freeze({ ...args.approvalBinding }) : null,
    thresholds: Object.freeze({ ...args.thresholds }),
    expiresAt: args.expiresAt,
    evaluatedAt: args.now,
    evaluationFingerprint,
  });
}
