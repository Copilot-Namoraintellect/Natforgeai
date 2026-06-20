/**
 * Refund credits for image generations tied to a specific campaign.
 *
 * Useful when poor-quality or fallback outputs were incorrectly charged during testing.
 *
 * Usage:
 *   npx tsx scripts/refund-campaign-credits.ts <campaignId> [--dry-run]
 *
 * Examples:
 *   npx tsx scripts/refund-campaign-credits.ts 27 --dry-run
 *   npx tsx scripts/refund-campaign-credits.ts 27
 */

import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { generatedImages } from "../db/schema";
import { eq, and, gt } from "drizzle-orm";
import { adminAdjustCredits } from "../api/lib/billing/credit-engine";

async function main() {
  const [campaignIdRaw, flag] = process.argv.slice(2);
  const campaignId = Number(campaignIdRaw);
  const dryRun = flag === "--dry-run";

  if (!Number.isFinite(campaignId) || campaignId <= 0) {
    console.error("Invalid campaignId. Usage: npx tsx scripts/refund-campaign-credits.ts <campaignId> [--dry-run]");
    process.exit(1);
  }

  const db = getDb();

  const rows = await db
    .select()
    .from(generatedImages)
    .where(and(eq(generatedImages.campaignId, campaignId), gt(generatedImages.creditsCharged, 0)));

  if (rows.length === 0) {
    console.log(`No charged image generations found for campaign ${campaignId}.`);
    return;
  }

  const byUser = new Map<number, number>();
  for (const row of rows) {
    byUser.set(row.userId, (byUser.get(row.userId) || 0) + (row.creditsCharged || 0));
  }

  console.log(`Found ${rows.length} charged generation(s) for campaign ${campaignId}:`);
  for (const row of rows) {
    const score = (row.metadata as any)?.qualityScore ?? "unknown";
    const fallback = (row.metadata as any)?.fallbackUsed ?? (row.metadata as any)?.usingFallback ?? false;
    console.log(`  id=${row.id} userId=${row.userId} credits=${row.creditsCharged} score=${score} fallback=${fallback} createdAt=${row.createdAt}`);
  }
  console.log("Total refunds by user:");
  for (const [userId, total] of byUser.entries()) {
    console.log(`  userId=${userId} refund=${total} credits`);
  }

  if (dryRun) {
    console.log("\nDry run complete. No credits were changed.");
    return;
  }

  for (const [userId, total] of byUser.entries()) {
    await adminAdjustCredits({
      userId,
      amount: total,
      description: `Refund for Campaign #${campaignId} failed/poor-quality image generations`,
      adminUserId: 0,
    });
    console.log(`Refunded ${total} credits to user ${userId}.`);
  }

  // Mark rows as refunded in metadata without changing the completed status.
  const now = new Date().toISOString();
  for (const row of rows) {
    const metadata = (row.metadata as Record<string, any>) || {};
    await db
      .update(generatedImages)
      .set({
        metadata: {
          ...metadata,
          refundedAt: now,
          refundReason: `Campaign #${campaignId} poor-quality/fallback refund`,
        },
      })
      .where(eq(generatedImages.id, row.id));
  }

  console.log(`\nRefund complete for campaign ${campaignId}.`);
}

main().catch((err: any) => {
  console.error("Refund failed:", err.message);
  process.exit(1);
});
