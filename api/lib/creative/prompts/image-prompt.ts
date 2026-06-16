/**
 * Structured premium marketing image/leaflet prompt builder.
 * This module produces prompts that turn generic AI posters into
 * practical, customer-facing leaflets grounded in real business details.
 */

export type CreativeType =
  | "leaflet"
  | "poster"
  | "service_menu"
  | "offer_advert"
  | "event_announcement";

interface BuildPromptOpts {
  business: any;
  campaign: any;
  post: any;
  brandColors?: string[];
  creativeType?: CreativeType;
  strongerBrandFit?: boolean;
}

function sanitize(str?: string | null): string {
  if (!str) return "";
  return str.replace(/\n+/g, " ").trim();
}

function inferServiceCategory(business: any, campaign: any): string {
  const combined = `${business.name || ""} ${business.industry || ""} ${business.productOrService || ""} ${campaign.productOrService || ""} ${campaign.referenceStyle || ""}`.toLowerCase();
  if (combined.includes("print") || combined.includes("copy") || combined.includes("courier") || combined.includes("business card") || combined.includes("flyer") || combined.includes("poster") || combined.includes("banner")) {
    return "print_shop";
  }
  return "general";
}

function creativeTypeLabel(type?: CreativeType): string {
  switch (type) {
    case "poster":
      return "social media poster";
    case "service_menu":
      return "service menu / price list";
    case "offer_advert":
      return "offer advert";
    case "event_announcement":
      return "event announcement";
    case "leaflet":
    default:
      return "premium social media leaflet / pamphlet";
  }
}

function aspectRatioForCreativeType(type?: CreativeType): string {
  switch (type) {
    case "poster":
    case "offer_advert":
    case "event_announcement":
      return "1:1";
    case "service_menu":
      return "4:5";
    case "leaflet":
    default:
      return "4:5";
  }
}

export function getImageAspectRatio(type?: CreativeType, platform?: string): string {
  // Leaflets/portrait assets default to portrait; platform can override if explicit.
  if (type && type !== "leaflet") return aspectRatioForCreativeType(type);
  if (!platform) return "4:5";
  const p = platform.toLowerCase();
  if (p.includes("instagram")) return "1:1";
  if (p.includes("facebook")) return "4:5";
  if (p.includes("linkedin")) return "1.91:1";
  if (p.includes("tiktok") || p.includes("reel")) return "9:16";
  if (p.includes("twitter") || p.includes("x")) return "16:9";
  return "4:5";
}

export function buildPremiumImagePrompt(opts: BuildPromptOpts): string {
  const { business, campaign, post, creativeType = "leaflet", strongerBrandFit = false } = opts;

  const brandColors = opts.brandColors?.length
    ? opts.brandColors
    : (business?.brandColors as string[] | undefined) || [];

  const serviceCategory = inferServiceCategory(business, campaign);
  const isPrintShop = serviceCategory === "print_shop";

  const layoutType = creativeTypeLabel(creativeType);
  const aspectRatio = getImageAspectRatio(creativeType, post?.platform);

  const headline =
    campaign.offerDetails && !campaign.offerDetails.toLowerCase().includes("none")
      ? `${business.name} — ${campaign.offerDetails}`
      : campaign.primaryOutcome || post?.title || `${business.name}`;

  const subheadline =
    campaign.mainPainPoint
      ? `Solving: ${campaign.mainPainPoint}`
      : campaign.coreMessage || post?.hook || "";

  const offerBlock = campaign.offerDetails
    ? `Offer badge (only if user provided): "${sanitize(campaign.offerDetails)}"`
    : "No offer provided — do NOT invent discounts, percentages, free trials or limited-time promotions.";

  const preferredCta = sanitize(campaign.preferredCta || post?.cta || "Request a Quote Today");

  const serviceCallouts = isPrintShop
    ? [
        "Printing & Copying",
        "Business Cards & Flyers",
        "Posters & Banners",
        "Courier Services",
        "Graduation Gifts",
        "Document Support",
        "Photo Prints",
        "Branding & Stationery",
      ]
    : [
        sanitize(campaign.productOrService || business?.productOrService || "Your core service"),
      ];

  const benefitCallouts = isPrintShop
    ? [
        "Fast turnaround",
        "Professional quality",
        "Order online or via WhatsApp",
        "Convenient service point",
      ]
    : [
        "Clear value",
        "Professional quality",
        "Easy to get started",
      ];

  const logoSection = business?.logo
    ? `A real logo will be overlaid after generation. Leave a clean, mostly empty top-left header area for the logo. Do NOT draw a logo icon, fake emblem or recreate the logo in the image.`
    : "No logo provided — leave a clean top header area; the business name will be added by NatForgeAI after generation. Do NOT invent a logo icon.";

  const strongerFitRules = strongerBrandFit
    ? `
STRONGER BRAND FIT — ENFORCE THESE STRICTLY:
- Use the exact business name "${business.name}" in the headline or subheadline.
- Use the brand colours (${brandColors.length ? brandColors.join(", ") : "as provided"}) consistently across headings, CTA and accent blocks.
- Show concrete products/services, not abstract concepts or generic people shaking hands.
- Use a clear leaflet layout with sections, not a scattered collage.
- Reinforce the offer/CTA above everything else.
- Avoid any vague motivational slogans.`
    : "";

  const domainSpecific = isPrintShop
    ? `
DOMAIN-SPECIFIC DIRECTION (print / copy / courier shop):
The image must look like a finished customer-facing leaflet for a local print shop such as 3@1 Newmarket.
Headline idea: "Winter Printing & Business Support Specials" (adapt to the campaign context).
Subheadline idea: "Print, courier and brand your business without the hassle."
Main visual: a professional, organised collage showing business cards, flyers, posters, banners, courier parcels, branded stationery, graduation gifts, photo prints and office documents.
Service callouts to include: ${serviceCallouts.join(", ")}.
Benefit callouts: ${benefitCallouts.join(", ")}.
CTA: "${preferredCta}".
Style: clean, modern retail print-shop leaflet. Bold readable text, good spacing, professional photos/illustrations of real print products.`
    : "";

  const prompt = `You are a senior graphic designer creating a ${layoutType} for a real business.

A. BUSINESS IDENTITY
- Business name: ${business.name}
- Industry: ${business.industry || "Not specified"}
- Location: ${business.location || "Not specified"}
- Website: ${business.website || "Not specified"}
- WhatsApp: ${business.whatsappNumber || "Not specified"}
- Email: ${business.email || "Not specified"}
- Brand tone: ${business.brandTone || business.tone || "professional"}
- Brand colours: ${brandColors.length ? brandColors.join(", ") : "Not specified"}
- Visual style: ${business.visualStyle || "Not specified"}
- Brand voice notes: ${business.brandVoiceNotes || "Not specified"}
- Words/phrases to avoid: ${business.avoidWords || campaign.excludedOffers || "None specified"}
${logoSection}

B. CAMPAIGN CONTEXT
- Campaign name: ${campaign.name || post?.title || "Not specified"}
- Primary outcome: ${campaign.primaryOutcome || "Not specified"}
- Target buyer: ${campaign.targetBuyer || campaign.targetAudience || business.targetCustomer || "Not specified"}
- Main pain point: ${campaign.mainPainPoint || "Not specified"}
- Product/service being promoted: ${campaign.productOrService || business.productOrService || "Not specified"}
- Preferred CTA: ${preferredCta}
${offerBlock}
- Excluded offers/words: ${campaign.excludedOffers || business.avoidWords || "None specified"}
- Reference style: ${campaign.referenceStyle || "Not specified"}
- Content style: ${campaign.contentStyle || business.visualStyle || "Not specified"}

C. LAYOUT TYPE
${layoutType} — portrait social media leaflet, aspect ratio ${aspectRatio}, approximately 1080x1350 pixels.

D. REQUIRED LAYOUT SECTIONS
1. Clean top header area — reserved for the real logo + business name (added after generation).
2. Strong headline: "${sanitize(headline)}"
3. Short subheadline: "${sanitize(subheadline)}"
4. Hero service/product collage (real products/services, no abstract concepts).
5. Offer badge — ONLY if an offer was provided above. Otherwise omit.
6. 5–6 service callouts: ${serviceCallouts.slice(0, 6).join(" | ")}
7. 3–4 customer benefit callouts: ${benefitCallouts.slice(0, 4).join(" | ")}
8. Prominent CTA text: "${preferredCta}"
9. Clean bottom footer area — reserved for real contact details and CTA (added after generation).

E. DESIGN RULES
- Clean, bold and readable. High contrast text.
- Looks like a finished customer leaflet/poster, not a generic AI art poster.
- Do NOT use vague slogans such as "Your vision, our solution", "Transform your brand", "Unleash creativity", "Quality meets efficiency", or similar.
- Do NOT invent phone numbers, addresses, websites, emails, prices, discounts or promotions.
- Do NOT create fake logos, fake social handles, fake QR codes or fake contact details anywhere in the image.
- The real logo, business name and contact details will be overlaid programmatically after generation.
- Keep the top header and bottom footer areas mostly clean (subtle solid background or texture only) so the logo and text overlay remain readable.
- Use the business name only where it helps the headline; avoid crowding the reserved header/footer zones.
- Keep text large enough to read on mobile social feeds.
- Use the brand colours consistently but tastefully.
${domainSpecific}
${strongerFitRules}

F. OUTPUT
Single ${layoutType} image, ${aspectRatio} portrait, ready to post on LinkedIn, Facebook and Instagram.`;

  return prompt.replace(/\n{3,}/g, "\n\n").trim();
}
