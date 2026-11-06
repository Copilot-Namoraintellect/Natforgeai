import { z } from "zod";

export const LEVELS = [
  "DISABLED",
  "LEVEL_1_DECISION_SUPPORT",
  "LEVEL_2_ORCHESTRATED_INTELLIGENCE",
  "LEVEL_3_GOVERNED_AUTONOMY",
  "LEVEL_4_ADVANCED_AUTONOMOUS_OPERATIONS",
] as const;
export const levelSchema = z.enum(LEVELS);
export type Level = z.infer<typeof levelSchema>;
export const rank = (level: Level): number => LEVELS.indexOf(level);
const label = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
export const scopeSchema = z.strictObject({
  tenantId: z.number().int().positive(),
  businessId: z.number().int().positive(),
  capability: label,
  actionClass: label,
});
export type Scope = z.infer<typeof scopeSchema>;
export const scopeKey = (scope: Scope): string =>
  JSON.stringify(scopeSchema.parse(scope));
export const runtimeStateSchema = z.enum([
  "DISABLED",
  "SHADOW",
  "CANARY",
  "ACTIVE",
  "DEGRADED",
  "SAFE_MODE",
  "SUSPENDED",
]);
export const reasonSchema = z.enum([
  "ADMIN_ACTIVATION",
  "ADMIN_ROLLBACK",
  "PROVIDER_DEGRADED",
  "RUNTIME_DEGRADED",
  "MONITORING_DEGRADED",
  "BACKUP_DEGRADED",
  "SECURITY_ANOMALY",
  "HIGH_UNCERTAINTY",
  "EMERGENCY",
  "SUSPEND",
  "REVALIDATED_RESUME",
]);
const canarySchema = z.strictObject({
  providerId: label,
  maxVolume: z.number().int().positive().max(100000),
  percentage: z.number().int().min(1).max(100),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
});
export const policySchema = z
  .strictObject({
    scope: scopeSchema,
    maximumLevel: levelSchema,
    capabilityMaximum: levelSchema,
    actionMaximum: levelSchema,
    effectiveAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    policyVersion: label,
    authoritySource: label,
    releaseId: label,
    canary: canarySchema.nullable(),
    monitoringRequired: z.boolean(),
    backupRequired: z.boolean(),
  })
  .refine(
    p => Date.parse(p.expiresAt) > Date.parse(p.effectiveAt),
    "invalid policy window"
  )
  .refine(
    p =>
      !p.canary ||
      (Date.parse(p.canary.endsAt) > Date.parse(p.canary.startsAt) &&
        Date.parse(p.canary.startsAt) >= Date.parse(p.effectiveAt) &&
        Date.parse(p.canary.endsAt) <= Date.parse(p.expiresAt)),
    "invalid canary window"
  );
export type Policy = z.infer<typeof policySchema>;
export const changeSchema = z.strictObject({
  level: levelSchema,
  state: runtimeStateSchema,
  reason: reasonSchema,
  correlationId: label,
  expectedVersion: z.number().int().nonnegative(),
  policy: policySchema.optional(),
  suspension: z
    .strictObject({
      kind: z.enum([
        "MISSION",
        "CAPABILITY",
        "PROVIDER",
        "EXECUTION",
        "WORKER",
        "SCHEDULER",
      ]),
      reference: label,
    })
    .nullable(),
  killSwitch: z.boolean(),
  skipStageAuthority: label.optional(),
});
export type Change = z.infer<typeof changeSchema>;
export const safetySchema = z.strictObject({
  targetLevel: levelSchema,
  reason: reasonSchema.exclude([
    "ADMIN_ACTIVATION",
    "ADMIN_ROLLBACK",
    "REVALIDATED_RESUME",
  ]),
  correlationId: label,
  expectedVersion: z.number().int().nonnegative(),
});
export type SafetyRequest = z.infer<typeof safetySchema>;
export interface Activation {
  scope: Scope;
  version: number;
  configuredLevel: Level;
  effectiveLevel: Level;
  runtimeState: z.infer<typeof runtimeStateSchema>;
  policy: Policy | null;
  reason: z.infer<typeof reasonSchema>;
  killSwitch: boolean;
  suspension: Change["suspension"];
  canaryUsed: number;
  lastAuthorityChange: string;
  authoritySource: string;
}
export interface ActivationAudit {
  scope: Scope;
  version: number;
  previousLevel: Level;
  newLevel: Level;
  previousState: Activation["runtimeState"];
  newState: Activation["runtimeState"];
  reason: Activation["reason"];
  authoritySource: string;
  actorType: "HUMAN_ADMIN" | "SYSTEM_ADMIN" | "RUNTIME_SAFETY";
  policyVersion: string | null;
  timestamp: string;
  correlationId: string;
  /** Full change fingerprint; never raw client content, credentials or thought. */
  changeHash: string;
}
export interface ActionBinding extends Scope {
  actionId: string;
  missionId: string;
  taskId: string;
  scheduleId: string;
  parametersHash: string;
  governanceDecisionId: string;
  providerId: string;
  providerAccountId: string;
  releaseId: string;
  requiredLevel: Level;
}
/** Trusted server resolver output only; never a client/queue/model payload. */
export interface SafetyEvidence {
  binding: ActionBinding;
  expiresAt: string;
  missionCurrent: boolean;
  taskReady: boolean;
  scheduleReady: boolean;
  governance: "ALLOW" | "REVIEW_REQUIRED" | "BLOCK";
  exactGovernanceConsumable: boolean;
  exactHumanApproval: boolean;
  runtimeSafe: boolean;
  providerSafe: boolean;
  securitySafe: boolean;
  monitoringHealthy: boolean;
  backupHealthy: boolean;
  environmentSafe: boolean;
  providerSuspended: boolean;
  missionSuspended: boolean;
}
export function disabled(scope: Scope): Activation {
  return {
    scope: scopeSchema.parse(scope),
    version: 0,
    configuredLevel: "DISABLED",
    effectiveLevel: "DISABLED",
    runtimeState: "DISABLED",
    policy: null,
    reason: "ADMIN_ROLLBACK",
    killSwitch: false,
    suspension: null,
    canaryUsed: 0,
    lastAuthorityChange: "1970-01-01T00:00:00.000Z",
    authoritySource: "UNCONFIGURED",
  };
}
