/**
 * Safely removes Audience Intelligence test rows for a specific user/campaign.
 * Defaults to the test account userId=14 / campaignId=27.
 *
 * Run with:
 *   CLEAN_USER_ID=14 CLEAN_CAMPAIGN_ID=27 npx tsx scripts/clean-audience-intelligence-test-data.ts
 */
import "dotenv/config";
import { createConnection } from "mysql2/promise";

const userId = Number(process.env.CLEAN_USER_ID ?? 14);
const campaignId = Number(process.env.CLEAN_CAMPAIGN_ID ?? 27);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

async function main() {
  const connection = await createConnection(databaseUrl);

  try {
    console.log(`Cleaning Audience Intelligence test data for userId=${userId} campaignId=${campaignId}`);

    const tables = [
      { name: "outreach_recommendations", where: "userId = ? AND campaignId = ?" },
      { name: "lead_scores", where: "userId = ? AND campaignId = ?" },
      { name: "campaign_interest_signals", where: "userId = ? AND campaignId = ?" },
      { name: "social_engagement_events", where: "userId = ? AND campaignId = ?" },
      { name: "social_profiles", where: "userId = ? AND campaignId = ?" },
      { name: "agent_runs", where: "userId = ? AND campaignId = ? AND agentType = 'audience'" },
    ];

    for (const { name, where } of tables) {
      const [countResult] = await connection.execute<{ "count(*)": number }[]>(
        `SELECT count(*) FROM \`${name}\` WHERE ${where}`,
        [userId, campaignId]
      );
      const before = (countResult?.[0] as any)?.["count(*)"] ?? 0;
      console.log(`  ${name}: ${before} row(s) before cleanup`);
    }

    // Delete in dependency order.
    await connection.execute("DELETE FROM `outreach_recommendations` WHERE userId = ? AND campaignId = ?", [
      userId,
      campaignId,
    ]);
    await connection.execute("DELETE FROM `lead_scores` WHERE userId = ? AND campaignId = ?", [userId, campaignId]);
    await connection.execute("DELETE FROM `campaign_interest_signals` WHERE userId = ? AND campaignId = ?", [
      userId,
      campaignId,
    ]);
    await connection.execute("DELETE FROM `social_engagement_events` WHERE userId = ? AND campaignId = ?", [
      userId,
      campaignId,
    ]);
    await connection.execute("DELETE FROM `social_profiles` WHERE userId = ? AND campaignId = ?", [userId, campaignId]);
    await connection.execute(
      "DELETE FROM `agent_runs` WHERE userId = ? AND campaignId = ? AND agentType = 'audience'",
      [userId, campaignId]
    );

    // Remove auto-created leads discovered by the audience agent for this campaign.
    await connection.execute(
      "DELETE FROM `leads` WHERE userId = ? AND campaignId = ? AND JSON_EXTRACT(customFields, '$.discoveredBy') = 'audience_intelligence_agent'",
      [userId, campaignId]
    );

    console.log("Cleanup complete.");
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
