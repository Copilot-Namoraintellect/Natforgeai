/**
 * Business Policy Store (WBS-R5-E2/E7).
 *
 * Durable persistence for versioned business policies. Every write is
 * server-scoped (businessId + userId are resolved from durable rows, never
 * from client authority). Rows are immutable; policy changes insert a new
 * version and move the active pointer inside one transaction.
 *
 * Executor model follows the R4 audit/reservation stores: the caller passes
 * a drizzle-shaped executor (default getDb() or a transaction client) so
 * multi-step writes commit or roll back as one unit.
 */

import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { businessPolicies, type BusinessPolicyRow } from "@db/schema";
import {
  buildBusinessPolicyConfig,
  buildDefaultPolicyConfig,
  buildPolicyConfigHash,
  buildVersionedPolicy,
  type BusinessPolicyConfig,
  type VersionedBusinessPolicy,
} from "./policy-model";

type Db = ReturnType<typeof getDb>;

export interface PolicyStoreExecutor {
  select: Db["select"];
  insert: Db["insert"];
  update: Db["update"];
}

export type { VersionedBusinessPolicy, BusinessPolicyConfig };

export class PolicyStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PolicyStoreError";
    this.code = code;
  }
}

function toVersioned(row: BusinessPolicyRow): VersionedBusinessPolicy {
  return buildVersionedPolicy(
    Number(row.businessId),
    row.version,
    buildBusinessPolicyConfig(row.config)
  );
}

/** Resolve the active policy for a business; null when none exists. */
export async function getActivePolicy(
  businessId: number,
  executor: PolicyStoreExecutor = getDb()
): Promise<VersionedBusinessPolicy | null> {
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new PolicyStoreError("INVALID_POLICY_IDENTITY", `businessId must be a positive integer, got ${String(businessId)}.`);
  }
  const rows = await executor
    .select()
    .from(businessPolicies)
    .where(and(eq(businessPolicies.businessId, businessId), eq(businessPolicies.isActive, true)))
    .orderBy(desc(businessPolicies.version))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return toVersioned(row);
}

/** Resolve a specific policy version; null when absent. */
export async function getPolicyByVersion(
  businessId: number,
  version: number,
  executor: PolicyStoreExecutor = getDb()
): Promise<VersionedBusinessPolicy | null> {
  const rows = await executor
    .select()
    .from(businessPolicies)
    .where(and(eq(businessPolicies.businessId, businessId), eq(businessPolicies.version, version)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return toVersioned(row);
}

/**
 * Persist a new policy version and move the active pointer in one
 * transaction. The version must be exactly current+1 (monotonic authority);
 * a conflicting concurrent write fails closed on the unique index.
 */
export async function activatePolicyVersion(input: {
  userId: number;
  businessId: number;
  config: BusinessPolicyConfig;
  executor?: PolicyStoreExecutor;
  asOf?: string;
}): Promise<VersionedBusinessPolicy> {
  const { userId, businessId, config } = input;
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new PolicyStoreError("INVALID_POLICY_IDENTITY", `userId must be a positive integer, got ${String(userId)}.`);
  }
  if (!Number.isInteger(businessId) || businessId <= 0) {
    throw new PolicyStoreError("INVALID_POLICY_IDENTITY", `businessId must be a positive integer, got ${String(businessId)}.`);
  }
  const validated = buildBusinessPolicyConfig(config);

  const write = async (executor: PolicyStoreExecutor) => {
    const existing = await executor
      .select({ version: businessPolicies.version })
      .from(businessPolicies)
      .where(eq(businessPolicies.businessId, businessId))
      .orderBy(desc(businessPolicies.version))
      .limit(1);
    const nextVersion = (existing[0]?.version ?? 0) + 1;
    const policy = buildVersionedPolicy(businessId, nextVersion, validated);

    // Deactivate the previous active row, then insert the new version.
    await executor
      .update(businessPolicies)
      .set({ isActive: false })
      .where(and(eq(businessPolicies.businessId, businessId), eq(businessPolicies.isActive, true)));
    await executor.insert(businessPolicies).values({
      policyId: policy.policyId,
      businessId,
      userId,
      version: nextVersion,
      policyVersion: policy.policyVersion,
      configHash: buildPolicyConfigHash(validated),
      config: validated as unknown as Record<string, unknown>,
      isActive: true,
    });
    return policy;
  };

  // Default path: run the deactivate+insert as one atomic unit. Test fakes
  // (explicit executor) run the two-step write directly.
  if (!input.executor) {
    return getDb().transaction(write);
  }
  return write(input.executor);
}

/**
 * Adopt the built-in conservative default policy for a business (creates
 * version 1). Idempotent: when the active policy already equals the default,
 * the existing policy is returned unchanged.
 */
export async function adoptDefaultPolicy(input: {
  userId: number;
  businessId: number;
  executor?: PolicyStoreExecutor & { transaction?: Db["transaction"] };
}): Promise<VersionedBusinessPolicy> {
  const active = await getActivePolicy(input.businessId, input.executor ?? getDb());
  const defaultConfig = buildDefaultPolicyConfig();
  if (active && buildPolicyConfigHash(active.config) === buildPolicyConfigHash(defaultConfig)) {
    return active;
  }
  return activatePolicyVersion({ ...input, config: defaultConfig });
}
