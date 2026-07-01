/**
 * One-time cleanup for Campaign #28.
 *
 * Restores the specific, business-approved message pack that was overwritten by
 * a generic AI-refined pack, and marks any generic message_pack records as
 * superseded by the restored pack.
 *
 * Run with:
 *   npx tsx scripts/restore-campaign-28-message-pack.ts
 */

import { restorePreferredMessagePackForCampaign } from "../api/lib/creative/campaign-message-architect";

const CAMPAIGN_ID = 28;
const USER_ID = Number(process.env.RESTORE_USER_ID || 1);

const preferredPack = {
  headline: "Instant payouts for restaurants, delivery platforms and frontline teams",
  subheadline: "Stop waiting for weekly settlement and reconciliation.",
  benefitBullets: [
    "Payouts for restaurants, delivery platforms and frontline teams",
    "Automated tips, commissions and supplier payouts",
    "Approved delivery orders settled without manual reconciliation",
  ],
  cta: "Book a Zuto Hub Demo",
  footerContact: { location: "South Africa" },
  platformCaptions: [],
  validation: { passed: true, score: 90, rejections: [], warnings: [] },
};

(async () => {
  const assetId = await restorePreferredMessagePackForCampaign(CAMPAIGN_ID, USER_ID, preferredPack as any);
  console.log(`Restored preferred message pack for campaign ${CAMPAIGN_ID}: asset ${assetId}`);
})().catch((err) => {
  console.error("Failed to restore preferred message pack:", err);
  process.exit(1);
});
