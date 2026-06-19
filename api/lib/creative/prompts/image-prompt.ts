/**
 * Structured premium marketing image/leaflet prompt builder.
 *
 * OpenAI is used mainly for the premium visual/product composition.
 * NatForgeAI then deterministically overlays the real logo, business name,
 * headline, offer, CTA, service bullets and contact details so the final
 * leaflet is always on-brand and factually accurate.
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
  palette?: { primary: string; secondary: string; accent: string; source: string };
  creativeGuidance?: string;
  refinementInstruction?: string;
}

function sanitize(str?: string | null): string {
  if (!str) return "";
  return str.replace(/\n+/g, " ").trim();
}

function inferServiceCategory(business: any, campaign: any): string {
  const combined = `${business.name || ""} ${business.industry || ""} ${business.productOrService || ""} ${campaign.productOrService || ""} ${campaign.referenceStyle || ""} ${JSON.stringify(business.websiteEvidence || {})}`.toLowerCase();
  if (combined.includes("print") || combined.includes("copy") || combined.includes("courier") || combined.includes("business card") || combined.includes("flyer") || combined.includes("poster") || combined.includes("banner") || combined.includes("branding")) {
    return "print_shop";
  }
  if (
    combined.includes("canvas") ||
    combined.includes("framed poster") ||
    combined.includes("wall art") ||
    combined.includes("art print") ||
    combined.includes("afrocentric") ||
    combined.includes("home decor") ||
    combined.includes("office decor") ||
    combined.includes("interior decor")
  ) {
    return "art_decor";
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
  const { business, campaign, post, creativeType = "leaflet", strongerBrandFit = false, palette, creativeGuidance, refinementInstruction } = opts;

  const savedBrandColors = opts.brandColors?.length
    ? opts.brandColors
    : (business?.brandColors as string[] | undefined) || [];

  const resolvedBrandColors = palette
    ? [palette.primary, palette.secondary, palette.accent, ...savedBrandColors]
    : savedBrandColors;

  const serviceCategory = inferServiceCategory(business, campaign);
  const isPrintShop = serviceCategory === "print_shop";
  const isArtDecor = serviceCategory === "art_decor";

  const layoutType = creativeTypeLabel(creativeType);
  const aspectRatio = getImageAspectRatio(creativeType, post?.platform);

  const preferredCta = sanitize(campaign.preferredCta || post?.cta || "Request a Quote Today");

  const serviceCallouts = isPrintShop
    ? [
        "Business Cards & Flyers",
        "Posters & Banners",
        "Canvas & Photo Prints",
        "Document Copying & Binding",
        "Branding & Stationery",
        "Courier & Delivery",
      ]
    : isArtDecor
    ? [
        "Custom Canvas Prints",
        "Framed Posters",
        "Premium Wall Art",
        "Home & Office Décor",
        "Turn Photos into Art",
      ]
    : [
        sanitize(campaign.productOrService || business?.productOrService || "Your core service"),
      ];

  const textOverlayNote = `TEXT-FREE VISUAL RULES:
- NatForgeAI will overlay the real logo, business name, headline, offer, CTA, service bullets and contact details AFTER generation.
- Therefore DO NOT render the business name, headline, offer, CTA, phone numbers, addresses, websites, emails, prices, QR codes, service bullets or contact details inside the image.
- Keep large clean areas (especially top header, lower-middle offer zone and bottom footer zone) as subtle solid colour or soft texture only, so the text overlay remains perfectly readable.
- Do NOT render any logo, brand mark, or logo-like graphic in the image. The real uploaded logo will be composited in the header by NatForgeAI.
- It is OK and expected to show the product/service visually; just do not add the readable marketing text.`;

  const strongerFitRules = strongerBrandFit
    ? `
STRONGER BRAND FIT — ENFORCE THESE STRICTLY:
- Use the exact business name "${business.name}" in the headline or subheadline (these will be overlaid later; the image itself should still not render text).
- Use the brand colours (${resolvedBrandColors.length ? resolvedBrandColors.join(", ") : "as provided"}) consistently across accent blocks, product tints and background gradients.
- Show concrete products/services, not abstract concepts or generic people shaking hands.
- Use a clear visual composition with sections, not a scattered collage.
- Avoid any vague motivational slogans.`
    : "";

  const userGuidanceBlock = creativeGuidance?.trim()
    ? `
USER CREATIVE DIRECTION (apply these preferences):
${sanitize(creativeGuidance)}`
    : "";

  const refinementBlock = refinementInstruction?.trim()
    ? `
REFINEMENT REQUEST FOR THIS REGENERATION (prioritise this feedback):
${sanitize(refinementInstruction)}`
    : "";

  const domainSpecific = isPrintShop
    ? `
DOMAIN-SPECIFIC DIRECTION (premium print / copy / courier / branding shop):
The image must be a premium, customer-facing visual composition for a local print shop.
Main visual: a clean, modern retail print-service scene or product mockup composition. Show realistic premium printed products tastefully arranged — business cards, flyers, posters, banners, canvas prints, photo prints and branded stationery. A product collage of print items is expected and desirable.
Style: polished retail print-shop design, bold readable placeholder-free zones, generous whitespace where text will be overlaid, premium product photography, modern commercial background.
No flat icons, no clip-art grids, no dashboard layouts, no scattered clipart. No readable text in the image.`
    : isArtDecor
    ? `
DOMAIN-SPECIFIC DIRECTION (art, canvas prints, framed posters & home décor):
The image must be a premium lifestyle visual composition for an art/décor brand.
Main visual: a realistic, aspirational interior scene showing canvas prints, framed posters, gallery walls, artwork and styled home/office décor. Show real products in real rooms, not a grid of icons.
Style: editorial home-décor flyer feel, warm lighting, premium photography, elegant typography-free zones, generous whitespace where text will be overlaid.
No readable text in the image.`
    : "";

  const prompt = `You are a senior graphic designer creating the VISUAL BACKGROUND for a ${layoutType} for a real business.

A. BUSINESS IDENTITY (for visual alignment only — do not write this text in the image)
- Business name: ${business.name}
- Industry: ${business.industry || "Not specified"}
- Location: ${business.location || "Not specified"}
- Brand tone: ${business.brandTone || business.tone || "professional"}
- Brand colours: ${resolvedBrandColors.length ? resolvedBrandColors.join(", ") : "Not specified"}
- Visual style: ${business.visualStyle || "Not specified"}
- Words/phrases to avoid: ${business.avoidWords || campaign.excludedOffers || "None specified"}

B. CAMPAIGN CONTEXT (for visual alignment only)
- Primary outcome: ${campaign.primaryOutcome || "Not specified"}
- Target buyer: ${campaign.targetBuyer || campaign.targetAudience || business.targetCustomer || "Not specified"}
- Main pain point: ${campaign.mainPainPoint || "Not specified"}
- Product/service being promoted: ${campaign.productOrService || business.productOrService || "Not specified"}
- Visual themes to include: ${serviceCallouts.slice(0, 6).join(" | ")}
- Offer (NatForgeAI will overlay this): ${campaign.offerDetails || "None provided"}
- Preferred CTA (NatForgeAI will overlay this): ${preferredCta}
- Excluded offers/words: ${campaign.excludedOffers || business.avoidWords || "None specified"}
- Content style: ${campaign.contentStyle || business.visualStyle || "Not specified"}

C. FORMAT
${layoutType} — aspect ratio ${aspectRatio}, approximately 1080x1350 pixels.

D. OPENAI RESPONSIBILITY — VISUAL / PRODUCT COMPOSITION ONLY
Create a premium visual/product composition that looks like:
- Premium print product mockups (business cards, flyers, posters, banners, canvas/photo prints, branded stationery)
- A polished commercial background or retail print-shop scene
- Clean, modern, professional product showcase
- Strong visual relationship to the actual business category and products/services listed above

E. ${textOverlayNote}

F. DESIGN RULES
- Clean, bold and readable after text overlay. High contrast between background and future text areas.
- Looks like a finished customer leaflet/poster background, not a generic AI art poster or icon grid.
- Do NOT use simple icon-grid layouts, tile layouts, or scattered clipart.
- Do NOT use vague slogans such as "Your vision, our solution", "Transform your brand", "Unleash creativity", "Quality meets efficiency", or similar.
- Do NOT invent phone numbers, addresses, websites, emails, prices, discounts or promotions.
- Do NOT create fake logos, fake social handles, fake QR codes or fake contact details anywhere in the image.
- The real logo, business name and contact details will be overlaid programmatically after generation.
- Use the brand colours consistently but tastefully.
- The visual must clearly relate to the actual business category and products/services listed above.
${domainSpecific}
${strongerFitRules}
${userGuidanceBlock}
${refinementBlock}

G. OUTPUT
Single ${layoutType} background image, ${aspectRatio}, ready for NatForgeAI to overlay the final business text. No readable words in the image.`;

  return prompt.replace(/\n{3,}/g, "\n\n").trim();
}
