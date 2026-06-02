import { getDb } from "../../queries/connection";
import { subscriptions } from "@db/schema";
import { eq, and, lte, or, isNull } from "drizzle-orm";
import { allocateMonthlyCredits } from "../billing/credit-engine";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Runs daily to allocate monthly credits for active subscriptions whose
 * nextCreditAllocationAt has passed (or was never set).
 */
export async function runDailyCreditRenewal(): Promise<{
  processed: number;
  allocated: number;
  errors: number;
  details: Array<{ userId: number; subscriptionId: number; result: string }>;
}> {
  const db = getDb();
  const now = new Date();

  const dueSubscriptions = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, "active"),
        or(
          isNull(subscriptions.nextCreditAllocationAt),
          lte(subscriptions.nextCreditAllocationAt, now)
        )
      )
    );

  const details: Array<{ userId: number; subscriptionId: number; result: string }> = [];
  let totalAllocated = 0;
  let errors = 0;

  for (const sub of dueSubscriptions) {
    try {
      const { allocated } = await allocateMonthlyCredits(sub.userId);
      totalAllocated += allocated;
      details.push({
        userId: sub.userId,
        subscriptionId: sub.id,
        result: allocated > 0 ? `Allocated ${allocated} credits` : "No credits allocated (already reset or no tier credits)",
      });
      console.log(`[CreditRenewal] Subscription ${sub.id} (user ${sub.userId}): ${allocated} credits allocated`);
    } catch (err: any) {
      errors++;
      details.push({
        userId: sub.userId,
        subscriptionId: sub.id,
        result: `Error: ${err.message}`,
      });
      console.error(`[CreditRenewal] Subscription ${sub.id} (user ${sub.userId}) failed:`, err.message);
    }
  }

  if (dueSubscriptions.length > 0) {
    console.log(
      `[CreditRenewal] Processed ${dueSubscriptions.length} subscriptions. Allocated ${totalAllocated} credits. Errors: ${errors}.`
    );
  }

  return {
    processed: dueSubscriptions.length,
    allocated: totalAllocated,
    errors,
    details,
  };
}

/**
 * Starts a scheduler that runs the daily credit renewal.
 * Runs immediately on startup, then every 24 hours.
 */
export function startCreditRenewalScheduler(): void {
  console.log("[CreditRenewal] Scheduler started — running daily");

  // Run immediately on startup (with slight delay to not block server boot)
  setTimeout(() => {
    runDailyCreditRenewal().catch((err) =>
      console.error("[CreditRenewal] Initial run failed:", err.message)
    );
  }, 5000);

  // Then every 24 hours
  setInterval(() => {
    runDailyCreditRenewal().catch((err) =>
      console.error("[CreditRenewal] Scheduled run failed:", err.message)
    );
  }, ONE_DAY_MS);
}
