/**
 * One-time cleanup for Campaign #23 (3@1 Newmarket / Alberton).
 *
 * Restores the validated, business-specific message pack that was overwritten by
 * a weak/generic AI-refined pack, and marks any generic message_pack records as
 * superseded by the restored pack.
 *
 * Run with:
 *   npx tsx scripts/restore-campaign-23-message-pack.ts
 */

import { restorePreferredMessagePackForCampaign } from "../api/lib/creative/campaign-message-architect";

const CAMPAIGN_ID = 23;
const USER_ID = Number(process.env.RESTORE_USER_ID || 1);

const preferredPack = {
  headline: "Printing, Courier and Business Services in Alberton",
  subheadline:
    "Get wall canvas prints, large format printing, courier services, flyers, banners, posters, business cards and custom printing from 3@1 Newmarket.",
  benefitBullets: [
    "Print marketing material, posters, banners and business cards for your next promotion.",
    "Create wall canvas prints, photo prints and large format displays for home or business use.",
    "Send documents and parcels with convenient courier services from 3@1 Newmarket.",
  ],
  cta: "Request a Quote from 3@1 Newmarket",
  footerContact: { location: "Alberton" },
  platformCaptions: [],
  validation: { passed: true, score: 95, rejections: [], warnings: [] },
};

(async () => {
  const assetId = await restorePreferredMessagePackForCampaign(
    CAMPAIGN_ID,
    USER_ID,
    preferredPack as any
  );
  console.log(`Restored preferred message pack for campaign ${CAMPAIGN_ID}: asset ${assetId}`);
})().catch((err) => {
  console.error("Failed to restore preferred message pack:", err);
  process.exit(1);
});
