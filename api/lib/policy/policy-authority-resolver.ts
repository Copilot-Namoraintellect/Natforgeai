/**
 * Server-Side Policy Authority Resolver (WBS-R5-E5/E7).
 *
 * Resolves the injected authority snapshots the decision engine needs from
 * durable R4/R5-E authorities. Everything here is server-side: ownership is
 * derived from durable rows, never from client input. The provider rate
 * state has no durable authority yet (no live provider calls in this
 * stream); it resolves to not-limited and is the documented hook for the
 * future provider-rate authority.
 */

import { eq, and, gte, sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import { creditWallets, aiUsage, creditReservations, socialIntegrations } from "@db/schema";
import { env } from "../env";
import { getSystemSetting } from "../system-settings";
import {
  countExecutableDecisionsSince,
  countChannelDecisionsSince,
  sumAutonomousCreditsSince,
} from "./policy-decision-store";
import type { CostAuthoritySnapshot, VolumeAuthoritySnapshot, ProviderRateSnapshot } from "./cost-governance";
import type { ProviderCapabilitySnapshot } from "./decision-engine";
import type { MarketingActionRequest } from "./action-request";

async function getSystemAiLimits(): Promise<{ daily: number; monthly: number }> {
  const [dailyRaw, monthlyRaw] = await Promise.all([
    getSystemSetting("daily_ai_credit_limit"),
    getSystemSetting("monthly_ai_credit_limit"),
  ]);
  const daily = dailyRaw ? parseInt(dailyRaw, 10) : env.dailyAiCreditLimit;
  const monthly = monthlyRaw ? parseInt(monthlyRaw, 10) : env.monthlyAiCreditLimit;
  return {
    daily: Number.isFinite(daily) && daily > 0 ? daily : env.dailyAiCreditLimit,
    monthly: Number.isFinite(monthly) && monthly > 0 ? monthly : env.monthlyAiCreditLimit,
  };
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Financial authority snapshot for one business owner. Balance comes from
 * the durable wallet; availability is net of open reservations; spend comes
 * from the durable AI usage ledger.
 */
export async function resolveCostAuthoritySnapshot(userId: number): Promise<CostAuthoritySnapshot> {
  const db = getDb();
  const now = new Date();
  const dayStart = utcDayStart(now);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [dailyRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${aiUsage.creditsDeducted}), 0)` })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), gte(aiUsage.createdAt, dayStart)));

  const [monthlyRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${aiUsage.creditsDeducted}), 0)` })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), gte(aiUsage.createdAt, monthStart)));

  const [wallet] = await db
    .select({ balance: creditWallets.balance, spendLimit: creditWallets.spendLimit })
    .from(creditWallets)
    .where(eq(creditWallets.userId, userId))
    .limit(1);

  const [reservationRow] = await db
    .select({ total: sql<number>`COALESCE(SUM(${creditReservations.reservedAmount}), 0)` })
    .from(creditReservations)
    .where(and(eq(creditReservations.userId, userId), eq(creditReservations.state, "reserved")));

  const systemLimits = await getSystemAiLimits();

  return {
    walletBalance: Number(wallet?.balance ?? 0),
    openReservationCredits: Number(reservationRow?.total ?? 0),
    dailySpend: Number(dailyRow?.total ?? 0),
    monthlySpend: Number(monthlyRow?.total ?? 0),
    dailySystemLimit: systemLimits.daily,
    monthlySystemLimit: systemLimits.monthly,
    walletSpendLimit: wallet?.spendLimit === null || wallet?.spendLimit === undefined ? null : Number(wallet.spendLimit),
    periodAutonomousSpend: 0, // caller overlays the policy-ledger aggregate
  };
}

/** Volume authority snapshot from the durable policy decision ledger. */
export async function resolveVolumeAuthoritySnapshot(
  businessId: number,
  platform: string
): Promise<VolumeAuthoritySnapshot> {
  const dayStartIso = utcDayStart(new Date()).toISOString();
  const [actionsExecutedToday, channelCount] = await Promise.all([
    countExecutableDecisionsSince(businessId, dayStartIso),
    countChannelDecisionsSince(businessId, platform, dayStartIso),
  ]);
  return {
    actionsExecutedToday,
    channelActionsToday: { [platform]: channelCount },
  };
}

/** Autonomous spend overlay from the durable decision ledger. */
export async function resolvePeriodAutonomousSpend(businessId: number): Promise<number> {
  return sumAutonomousCreditsSince(businessId, utcDayStart(new Date()).toISOString());
}

/**
 * Provider capability resolution for a request's binding, strictly
 * server-side. Conservative fixed capability map: an action is available
 * only on platforms known to support it. Missing/disconnected/mismatched
 * bindings fail closed (bindingVerified=false).
 */
const PLATFORM_ACTION_CAPABILITIES: Readonly<Record<string, ReadonlySet<string>>> = {
  reply_publicly: new Set(["facebook", "instagram", "linkedin", "twitter", "tiktok"]),
  reply_privately: new Set(["instagram", "facebook", "whatsapp", "email"]),
  react: new Set(["facebook", "instagram", "linkedin", "twitter", "tiktok"]),
  nurture_candidate: new Set(["email", "whatsapp", "instagram", "facebook"]),
};

export async function resolveProviderCapabilitySnapshot(input: {
  userId: number;
  businessId: number;
  request: MarketingActionRequest;
}): Promise<ProviderCapabilitySnapshot> {
  const binding = input.request.providerAccountBinding;
  if (binding === null) {
    return { bindingVerified: false, capabilityAvailable: false };
  }
  const db = getDb();
  const [integration] = await db
    .select({
      userId: socialIntegrations.userId,
      businessId: socialIntegrations.businessId,
      status: socialIntegrations.status,
      platform: socialIntegrations.platform,
    })
    .from(socialIntegrations)
    .where(eq(socialIntegrations.id, binding.integrationId))
    .limit(1);

  if (!integration) {
    return { bindingVerified: false, capabilityAvailable: false };
  }
  const ownerMatches = Number(integration.userId) === input.userId;
  const businessMatches =
    integration.businessId === null || Number(integration.businessId) === input.businessId;
  const platformMatches = integration.platform === binding.platform;
  const connected = integration.status === "connected";
  const bindingVerified = ownerMatches && businessMatches && platformMatches && connected;

  const capabilityAvailable =
    PLATFORM_ACTION_CAPABILITIES[input.request.actionType]?.has(input.request.platform) === true;

  return { bindingVerified, capabilityAvailable };
}

/**
 * Provider rate-limit state. No durable authority exists in this stream and
 * no live provider may be invoked, so the state resolves to not-limited;
 * the policy volume caps remain fully enforced from the decision ledger.
 */
export async function resolveProviderRateSnapshot(_request: MarketingActionRequest): Promise<ProviderRateSnapshot> {
  return { rateLimited: false, rateLimitReason: null };
}
