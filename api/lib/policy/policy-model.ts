/**
 * Versioned Business Policy Model (WBS-R5-E2).
 *
 * Typed, controlled policy configuration per business. There is deliberately
 * NO arbitrary user scripting: a policy is a closed, validated data shape.
 * Defaults are conservative and fail closed; validation enforces the E4
 * invariant that higher risk can only reduce autonomy.
 *
 * Pure module: no database access, no clock, no I/O. Persistence (the
 * business_policies table + migration artefacts) is a later slice; this
 * module defines the deterministic policy identity those rows carry.
 */

import { createHash } from "crypto";
import {
  MARKETING_ACTION_TYPES,
  MARKETING_PLATFORMS,
  type MarketingActionType,
  type MarketingPlatform,
} from "./action-request";
import {
  DECISION_AUTONOMY_RANK,
  RISK_TIERS,
  type PolicyDecisionOutcome,
  type RiskTier,
} from "./policy-types";

export const POLICY_MODEL_CONTRACT_VERSION = "policy/model@v1";

export type RiskDisposition = Exclude<PolicyDecisionOutcome, "NO_ACTION">;

export const RISK_DISPOSITION_VALUES: readonly RiskDisposition[] = [
  "ALLOW_AUTONOMOUS",
  "REQUIRE_APPROVAL",
  "ESCALATE",
  "DENY",
];

/**
 * Typed business policy configuration. Every knob is enumerated; unknown
 * fields are rejected at build time so policy can never smuggle in
 * uncontrolled behaviour.
 */
export interface BusinessPolicyConfig {
  /**
   * Per-action disposition lists. The three lists must be disjoint; an
   * action in none of them falls back to defaultActionDisposition.
   */
  actions: {
    /** Actions that may run autonomously (still subject to risk + gates). */
    autonomous: MarketingActionType[];
    /** Actions that always need explicit human approval. */
    requireApproval: MarketingActionType[];
    /** Actions that are always denied. */
    prohibited: MarketingActionType[];
  };
  /** Disposition for action types not listed above. */
  defaultActionDisposition: "require_approval" | "deny";
  /** Null = every known platform is channel-eligible unless prohibited. */
  allowedPlatforms: MarketingPlatform[] | null;
  prohibitedPlatforms: MarketingPlatform[];
  /**
   * Business-hour restriction on AUTONOMOUS execution only. Windows are UTC
   * "HH:MM" pairs, evaluated against the explicit evaluation clock — the
   * engine never reads the wall clock itself.
   */
  businessHours: {
    enabled: boolean;
    windows: Array<{ start: string; end: string }>;
  } | null;
  /** Risk-tier -> disposition mapping. Validated monotone non-increasing. */
  riskDispositions: Record<RiskTier, RiskDisposition>;
  /** Confidence floor: below this, autonomy is impossible (risk bumps). */
  minAutonomousConfidence: number;
  /** Bounded autonomous spend. */
  spend: {
    /** Max credits spendable by autonomous actions per UTC day. */
    maxAutonomousCreditsPerDay: number;
    /** Per-action credit ceiling; above this an action is not cost eligible. */
    maxActionCredits: number;
  };
  /** Bounded autonomous volume. */
  volume: {
    /** Max executed policy actions per UTC day (all dispositions). */
    maxActionsPerDay: number;
    /** Max executed policy actions per platform per UTC day. */
    maxActionsPerChannelPerDay: number;
  };
  /** Decision expiry: ALLOW_AUTONOMOUS and approval bindings expire. */
  executionTtlMinutes: number;
}

export class PolicyModelError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PolicyModelError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new PolicyModelError(code, message);
}

const ACTION_TYPE_SET: ReadonlySet<string> = new Set(MARKETING_ACTION_TYPES);
const PLATFORM_SET: ReadonlySet<string> = new Set(MARKETING_PLATFORMS);
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Conservative, fail-closed default policy: nothing is autonomously allowed
 * until a business explicitly opts an action type into autonomy. Used as the
 * seed for new businesses and as the reference for validation.
 */
export function buildDefaultPolicyConfig(): BusinessPolicyConfig {
  return {
    actions: {
      autonomous: [],
      requireApproval: [
        "reply_publicly",
        "reply_privately",
        "react",
        "nurture_candidate",
        "schedule_follow_up",
        "create_opportunity_candidate",
      ],
      prohibited: [],
    },
    defaultActionDisposition: "require_approval",
    allowedPlatforms: null,
    prohibitedPlatforms: [],
    businessHours: null,
    riskDispositions: {
      low: "ALLOW_AUTONOMOUS",
      medium: "REQUIRE_APPROVAL",
      high: "ESCALATE",
      critical: "ESCALATE",
    },
    minAutonomousConfidence: 0.6,
    spend: {
      maxAutonomousCreditsPerDay: 20,
      maxActionCredits: 20,
    },
    volume: {
      maxActionsPerDay: 50,
      maxActionsPerChannelPerDay: 20,
    },
    executionTtlMinutes: 15,
  };
}

function assertActionList(value: unknown, field: string): MarketingActionType[] {
  if (!Array.isArray(value)) fail("INVALID_POLICY_CONFIG", `${field} must be an array.`);
  const seen = new Set<string>();
  const out: MarketingActionType[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !ACTION_TYPE_SET.has(item)) {
      fail("INVALID_POLICY_CONFIG", `${field} contains unsupported action type ${JSON.stringify(item)}.`);
    }
    if (seen.has(item)) fail("INVALID_POLICY_CONFIG", `${field} contains duplicate action type "${item}".`);
    seen.add(item);
    out.push(item as MarketingActionType);
  }
  return out;
}

function assertPlatformList(value: unknown, field: string): MarketingPlatform[] {
  if (!Array.isArray(value)) fail("INVALID_POLICY_CONFIG", `${field} must be an array.`);
  const out: MarketingPlatform[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !PLATFORM_SET.has(item)) {
      fail("INVALID_POLICY_CONFIG", `${field} contains unsupported platform ${JSON.stringify(item)}.`);
    }
    out.push(item as MarketingPlatform);
  }
  return out;
}

function assertPositiveInt(value: unknown, field: string, max = 1_000_000): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > max) {
    fail("INVALID_POLICY_CONFIG", `${field} must be a positive integer <= ${max}, got ${String(value)}.`);
  }
  return value;
}

function assertConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail("INVALID_POLICY_CONFIG", `minAutonomousConfidence must be a number in [0, 1], got ${String(value)}.`);
  }
  return value;
}

function assertBusinessHours(value: unknown): BusinessPolicyConfig["businessHours"] {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_POLICY_CONFIG", "businessHours must be an object or null.");
  }
  const raw = value as Record<string, unknown>;
  const enabled = raw.enabled === true;
  if (!Array.isArray(raw.windows) || raw.windows.length === 0) {
    fail("INVALID_POLICY_CONFIG", "businessHours.windows must be a non-empty array.");
  }
  const windows = raw.windows.map((w) => {
    if (typeof w !== "object" || w === null) fail("INVALID_POLICY_CONFIG", "businessHours window must be an object.");
    const win = w as Record<string, unknown>;
    if (typeof win.start !== "string" || !HH_MM.test(win.start)) {
      fail("INVALID_POLICY_CONFIG", `businessHours window start must be "HH:MM" UTC, got ${JSON.stringify(win.start)}.`);
    }
    if (typeof win.end !== "string" || !HH_MM.test(win.end)) {
      fail("INVALID_POLICY_CONFIG", `businessHours window end must be "HH:MM" UTC, got ${JSON.stringify(win.end)}.`);
    }
    return { start: win.start, end: win.end };
  });
  return { enabled, windows };
}

function assertRiskDispositions(value: unknown): Record<RiskTier, RiskDisposition> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("INVALID_POLICY_CONFIG", "riskDispositions must be an object keyed by risk tier.");
  }
  const raw = value as Record<string, unknown>;
  const dispositions = {} as Record<RiskTier, RiskDisposition>;
  for (const tier of RISK_TIERS) {
    const d = raw[tier];
    if (typeof d !== "string" || !(RISK_DISPOSITION_VALUES as readonly string[]).includes(d)) {
      fail(
        "INVALID_POLICY_CONFIG",
        `riskDispositions.${tier} must be one of ${RISK_DISPOSITION_VALUES.join(", ")}; got ${JSON.stringify(d)}.`
      );
    }
    dispositions[tier] = d as RiskDisposition;
  }
  // E4 hard invariant: higher risk can only reduce autonomy, never expand it.
  for (let i = 1; i < RISK_TIERS.length; i++) {
    const lower = RISK_TIERS[i - 1];
    const higher = RISK_TIERS[i];
    if (DECISION_AUTONOMY_RANK[dispositions[higher]] > DECISION_AUTONOMY_RANK[dispositions[lower]]) {
      fail(
        "POLICY_RISK_MONOTONICITY_VIOLATION",
        `riskDispositions.${higher} (${dispositions[higher]}) grants more autonomy than ${lower} (${dispositions[lower]}); higher risk can only reduce autonomy.`
      );
    }
  }
  // CRITICAL always requires immediate human handling: never autonomous, never
  // approval-deferred machine execution.
  if (dispositions.critical === "ALLOW_AUTONOMOUS" || dispositions.critical === "REQUIRE_APPROVAL") {
    fail("POLICY_RISK_MONOTONICITY_VIOLATION", `riskDispositions.critical must be ESCALATE or DENY, got ${dispositions.critical}.`);
  }
  return dispositions;
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

/**
 * Validate a policy configuration and fail closed on any unsupported,
 * contradictory or autonomy-widening input. Pure; returns a frozen config.
 */
export function buildBusinessPolicyConfig(input: unknown): BusinessPolicyConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("INVALID_POLICY_CONFIG", "Policy config must be a structured object.");
  }
  const raw = input as Record<string, unknown>;
  const actionsRaw = raw.actions;
  if (typeof actionsRaw !== "object" || actionsRaw === null || Array.isArray(actionsRaw)) {
    fail("INVALID_POLICY_CONFIG", "actions must be an object with autonomous/requireApproval/prohibited arrays.");
  }
  const a = actionsRaw as Record<string, unknown>;
  const autonomous = assertActionList(a.autonomous ?? [], "actions.autonomous");
  const requireApproval = assertActionList(a.requireApproval ?? [], "actions.requireApproval");
  const prohibited = assertActionList(a.prohibited ?? [], "actions.prohibited");

  const sets = [new Set(autonomous), new Set(requireApproval), new Set(prohibited)];
  for (let i = 0; i < sets.length; i++) {
    for (const t of sets[i]) {
      if (sets.some((s, j) => j !== i && s.has(t))) {
        fail("INVALID_POLICY_CONFIG", `Action type "${t}" appears in more than one disposition list.`);
      }
    }
  }

  const defaultActionDisposition = raw.defaultActionDisposition;
  if (defaultActionDisposition !== "require_approval" && defaultActionDisposition !== "deny") {
    fail("INVALID_POLICY_CONFIG", `defaultActionDisposition must be "require_approval" or "deny".`);
  }

  const allowedPlatforms =
    raw.allowedPlatforms === null || raw.allowedPlatforms === undefined
      ? null
      : assertPlatformList(raw.allowedPlatforms, "allowedPlatforms");
  const prohibitedPlatforms = assertPlatformList(raw.prohibitedPlatforms ?? [], "prohibitedPlatforms");
  for (const p of prohibitedPlatforms) {
    if (allowedPlatforms !== null && allowedPlatforms.includes(p)) {
      fail("INVALID_POLICY_CONFIG", `Platform "${p}" cannot be both allowed and prohibited.`);
    }
  }

  const businessHours = assertBusinessHours(raw.businessHours);
  const riskDispositions = assertRiskDispositions(raw.riskDispositions);

  const spendRaw = raw.spend;
  if (typeof spendRaw !== "object" || spendRaw === null || Array.isArray(spendRaw)) {
    fail("INVALID_POLICY_CONFIG", "spend must be an object.");
  }
  const s = spendRaw as Record<string, unknown>;
  const volumeRaw = raw.volume;
  if (typeof volumeRaw !== "object" || volumeRaw === null || Array.isArray(volumeRaw)) {
    fail("INVALID_POLICY_CONFIG", "volume must be an object.");
  }
  const v = volumeRaw as Record<string, unknown>;

  const config: BusinessPolicyConfig = {
    actions: { autonomous, requireApproval, prohibited },
    defaultActionDisposition,
    allowedPlatforms,
    prohibitedPlatforms,
    businessHours,
    riskDispositions,
    minAutonomousConfidence: assertConfidence(raw.minAutonomousConfidence),
    spend: {
      maxAutonomousCreditsPerDay: assertPositiveInt(s.maxAutonomousCreditsPerDay, "spend.maxAutonomousCreditsPerDay"),
      maxActionCredits: assertPositiveInt(s.maxActionCredits, "spend.maxActionCredits"),
    },
    volume: {
      maxActionsPerDay: assertPositiveInt(v.maxActionsPerDay, "volume.maxActionsPerDay"),
      maxActionsPerChannelPerDay: assertPositiveInt(v.maxActionsPerChannelPerDay, "volume.maxActionsPerChannelPerDay"),
    },
    executionTtlMinutes: assertPositiveInt(raw.executionTtlMinutes, "executionTtlMinutes", 24 * 60),
  };

  return deepFreeze(config);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Deterministic content hash of a validated config. */
export function buildPolicyConfigHash(config: BusinessPolicyConfig): string {
  return createHash("sha256").update(canonicalize(config), "utf8").digest("hex");
}

/**
 * Deterministic policy identity for a business: stable across versions, so
 * decision lineage can always be traced to one logical policy authority.
 */
export function buildPolicyId(businessId: number): string {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    fail("INVALID_POLICY_IDENTITY", `businessId must be a positive integer, got ${String(businessId)}.`);
  }
  return `pol_${createHash("sha256").update(`natforge-policy:${businessId}`, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * Versioned policy identity: any config change produces a new version
 * string, so stale authorities are detectable (E6/E8 case 11/21).
 */
export function buildPolicyVersion(config: BusinessPolicyConfig, version: number): string {
  if (!Number.isInteger(version) || version <= 0) {
    fail("INVALID_POLICY_IDENTITY", `version must be a positive integer, got ${String(version)}.`);
  }
  return `v${version}-${buildPolicyConfigHash(config).slice(0, 12)}`;
}

/** A validated, versioned policy ready for engine evaluation. */
export interface VersionedBusinessPolicy {
  policyId: string;
  businessId: number;
  version: number;
  policyVersion: string;
  config: BusinessPolicyConfig;
}

export function buildVersionedPolicy(
  businessId: number,
  version: number,
  config: BusinessPolicyConfig
): VersionedBusinessPolicy {
  return deepFreeze({
    policyId: buildPolicyId(businessId),
    businessId,
    version,
    policyVersion: buildPolicyVersion(config, version),
    config,
  });
}

/** Disposition ceiling an action type allows before risk mapping. */
export type ActionDispositionCeiling = "autonomous" | "require_approval" | "prohibited" | "unlisted";

export function classifyActionCeiling(
  config: BusinessPolicyConfig,
  actionType: MarketingActionType
): ActionDispositionCeiling {
  if (config.actions.prohibited.includes(actionType)) return "prohibited";
  if (config.actions.autonomous.includes(actionType)) return "autonomous";
  if (config.actions.requireApproval.includes(actionType)) return "require_approval";
  return "unlisted";
}
