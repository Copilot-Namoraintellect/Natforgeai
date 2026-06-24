import type { subscriptionTiers } from "@db/schema";

export interface AudienceAgentAccessResult {
  allowed: boolean;
  reason?: string;
}

export interface AudienceAgentTier {
  audienceAgent: boolean | null | undefined;
}

export type Tier = typeof subscriptionTiers.$inferSelect;

// TEMPORARY (2026-06-23): allow a specific test account to use Audience Intelligence
// regardless of subscription tier. Remove once testing is complete.
// Account: mothepane.tshabalala@gmail.com (userId 14)
const TEMP_AUDIENCE_INTELLIGENCE_USER_IDS = new Set<number>([14]);

export function canUseAudienceAgent(
  tier: AudienceAgentTier | null | undefined,
  userRole: string | undefined | null
): AudienceAgentAccessResult {
  // Admins can always run Audience Intelligence for testing/support.
  if (userRole === "admin") {
    return { allowed: true };
  }

  if (!tier) {
    return { allowed: false, reason: "No active subscription found." };
  }

  if (!tier.audienceAgent) {
    return {
      allowed: false,
      reason: "Audience Intelligence is available on Growth and Enterprise plans.",
    };
  }

  return { allowed: true };
}

export async function checkAudienceAgentAccess(
  userId: number,
  userRole: string | undefined | null
): Promise<AudienceAgentAccessResult> {
  // Temporary test-account bypass (see TEMP_AUDIENCE_INTELLIGENCE_USER_IDS above).
  if (TEMP_AUDIENCE_INTELLIGENCE_USER_IDS.has(userId)) {
    return { allowed: true };
  }

  // Dynamic import keeps this module free of top-level DB dependencies,
  // so the pure eligibility helper can be unit-tested without resolving @db/schema.
  const { getUserTier } = await import("../subscription");
  const tier = await getUserTier(userId);
  return canUseAudienceAgent(tier, userRole);
}
