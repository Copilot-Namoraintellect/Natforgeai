/**
 * Dev/QA helper: top up (or deduct) credits for a user.
 *
 * Usage:
 *   npx tsx scripts/top-up-credits.ts <userId> <amount> [description]
 *
 * Examples:
 *   npx tsx scripts/top-up-credits.ts 42 1000 "QA reset"
 *   npx tsx scripts/top-up-credits.ts 42 -50 "QA deduction"
 */

import { adminAdjustCredits } from "../api/lib/billing/credit-engine";

async function main() {
  const [userIdRaw, amountRaw, ...descriptionParts] = process.argv.slice(2);
  const userId = Number(userIdRaw);
  const amount = Number(amountRaw);
  const description = descriptionParts.join(" ") || "Dev/QA credit top-up";

  if (!Number.isFinite(userId) || userId <= 0) {
    console.error("Invalid userId. Usage: npx tsx scripts/top-up-credits.ts <userId> <amount> [description]");
    process.exit(1);
  }
  if (!Number.isFinite(amount) || amount === 0) {
    console.error("Invalid amount. Usage: npx tsx scripts/top-up-credits.ts <userId> <amount> [description]");
    process.exit(1);
  }

  try {
    const result = await adminAdjustCredits({
      userId,
      amount,
      description,
      adminUserId: 0,
    });
    console.log(`✅ Adjusted credits for user ${userId} by ${amount}. New balance: ${result.newBalance}`);
  } catch (err: any) {
    console.error("❌ Failed to adjust credits:", err.message);
    process.exit(1);
  }
}

main();
