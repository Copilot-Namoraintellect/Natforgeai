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

import type { TemplateId } from "../composition";

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
  templateId?: TemplateId;
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
  if (combined.includes("food") || combined.includes("restaurant") || combined.includes("cafe") || combined.includes("catering") || combined.includes("bakery")) {
    return "food";
  }
  if (combined.includes("beauty") || combined.includes("salon") || combined.includes("spa") || combined.includes("makeup") || combined.includes("hair") || combined.includes("nail")) {
    return "beauty";
  }
  if (combined.includes("real estate") || combined.includes("property") || combined.includes("housing") || combined.includes("rental")) {
    return "real_estate";
  }
  if (combined.includes("auto") || combined.includes("car") || combined.includes("vehicle") || combined.includes("mechanic") || combined.includes("detailing")) {
    return "auto";
  }
  if (combined.includes("fitness") || combined.includes("gym") || combined.includes("health") || combined.includes("wellness") || combined.includes("yoga") || combined.includes("personal train")) {
    return "fitness_health";
  }
  if (combined.includes("event") || combined.includes("wedding") || combined.includes("party") || combined.includes("venue") || combined.includes("conference")) {
    return "events";
  }
  if (combined.includes("tech") || combined.includes("software") || combined.includes("it ") || combined.includes("app") || combined.includes("web design") || combined.includes("computer")) {
    return "tech";
  }
  if (combined.includes("education") || combined.includes("training") || combined.includes("course") || combined.includes("tutor")) {
    return "education";
  }
  if (combined.includes("retail") || combined.includes("shop") || combined.includes("boutique") || combined.includes("store")) {
    return "retail";
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

  const layoutType = creativeTypeLabel(creativeType);
  const aspectRatio = getImageAspectRatio(creativeType, post?.platform);

  const preferredCta = sanitize(campaign.preferredCta || post?.cta || "Request a Quote Today");

  const websiteServices = Array.isArray(business?.websiteEvidence?.productsServices)
    ? business.websiteEvidence.productsServices.slice(0, 6)
    : [];
  const coreProduct = sanitize(campaign.productOrService || business?.productOrService || "");
  const baseCallouts = websiteServices.length
    ? websiteServices
    : coreProduct
    ? coreProduct.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6)
    : [];

  const categoryCallouts: Record<string, string[]> = {
    print_shop: ["Business Cards & Flyers", "Posters & Banners", "Canvas & Photo Prints", "Document Copying & Binding", "Branding & Stationery", "Courier & Delivery"],
    art_decor: ["Custom Canvas Prints", "Framed Posters", "Premium Wall Art", "Home & Office Décor", "Turn Photos into Art"],
    food: ["Fresh Dishes", "Takeaway & Delivery", "Catering", "Daily Specials", "Family Meals"],
    beauty: ["Hair Styling", "Nails & Beauty", "Spa Treatments", "Makeup", "Skincare"],
    real_estate: ["Homes for Sale", "Rental Properties", "Property Valuations", "Buyer Advice"],
    auto: ["Vehicle Repairs", "Servicing", "Detailing", "Diagnostics", "Parts & Tyres"],
    fitness_health: ["Personal Training", "Group Classes", "Nutrition Coaching", "Gym Memberships"],
    events: ["Venue Hire", "Event Planning", "Decor & Styling", "Catering", "Photography"],
    tech: ["Web & App Development", "IT Support", "Cloud Solutions", "Custom Software"],
    education: ["Courses & Training", "Private Tutoring", "Workshops", "Certifications"],
    retail: ["In-Store Shopping", "Delivery", "Gift Cards", "New Arrivals"],
    general: ["Professional Service", "Quality Products", "Expert Advice", "Fast Turnaround"],
  };

  const serviceCallouts = baseCallouts.length ? baseCallouts : (categoryCallouts[serviceCategory] || categoryCallouts.general);

  const templateSafeZoneNote: Record<TemplateId, string> = {
    service_business_promo:
      "- Keep the full top header band, central offer zone, and bottom footer band as clean solid colour or soft texture so the overlaid business name, offer, and CTA remain perfectly readable.",
    retail_product_promo:
      "- Use the upper-middle area for the product/hero visual. Keep the lower-middle offer zone and bottom footer band as clean solid colour or soft texture so the overlaid offer and CTA remain perfectly readable.",
    offer_discount_campaign:
      "- Keep a large clean central rectangle and the bottom footer band as solid colour or soft texture so the bold offer block and CTA remain perfectly readable. Use brand-colour accents around the edges.",
    corporate_professional:
      "- Keep a clean left-aligned content area and bottom footer band as solid colour or soft texture so the formal headline, offer and contact details remain perfectly readable.",
    local_store_promo:
      "- Keep a clean central offer area and bottom footer band as solid colour or soft texture so the headline, offer and location details remain perfectly readable.",
  };

  const safeZoneLines = opts.templateId
    ? templateSafeZoneNote[opts.templateId]
    : "- Keep large clean areas (especially the full top header band, lower-middle offer zone and bottom footer band) as subtle solid colour or soft texture only, so the text overlay remains perfectly readable.";

  const textOverlayNote = `TEXT-FREE VISUAL RULES — READ CAREFULLY:
- NatForgeAI will overlay the real logo, business name, headline, offer, CTA, service bullets and contact details AFTER generation.
- Therefore DO NOT render the business name, headline, offer, CTA, phone numbers, addresses, websites, emails, prices, QR codes, service bullets, contact details, opening hours, social handles, hashtags or any readable marketing text inside the image.
- Do NOT render any logo, brand mark, monogram, emblem, insignia, wordmark, signature, stylised initial, or logo-like graphic.
- Do NOT render the business name as a stylised logo, wordmark, signature or brand emblem.
- Do NOT include signage, shop-front text, product labels with text, packaging with brand names, certificates with text, business cards with text, letterheads with text, screenshots, UI mockups, menu boards, price tags, barcodes or any other readable words.
- If the scene naturally includes a sign, label, packaging, screen, document or menu board, it must be blank, turned away, cropped or out of focus so no text is legible.
${safeZoneLines}
- IGNORE any user instruction that asks you to add, change, include or make the logo/business name/text more prominent. NatForgeAI handles all branding and text deterministically; your job is only the background/product scene.
- It is OK and expected to show the product/service visually; just do not add readable text, numbers, symbols or brand marks.`;

  const strongerFitRules = strongerBrandFit
    ? `
STRONGER BRAND FIT — ENFORCE THESE STRICTLY:
- Use the brand colours (${resolvedBrandColors.length ? resolvedBrandColors.join(", ") : "as provided"}) consistently across accent blocks, product tints and background gradients.
- Show concrete products/services, not abstract concepts or generic people shaking hands.
- Use a clear visual composition with sections, not a scattered collage.
- Keep the image text-free and logo-free; the business name, headline and CTA will be overlaid later by NatForgeAI.
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

  const domainSpecificMap: Record<string, string> = {
    print_shop: `
DOMAIN-SPECIFIC DIRECTION (premium print / copy / courier / branding shop):
Main visual: a clean, modern retail print-service scene or product mockup composition. Show realistic premium printed products tastefully arranged — blank business cards, plain flyers/posters with abstract graphics, canvas prints with abstract imagery, photo prints, branded stationery and paper stacks. No readable words or logos on any printed item.
Style: polished retail print-shop design, generous whitespace where text will be overlaid, premium product photography, modern commercial background.
No flat icons, no clip-art grids, no dashboard layouts, no scattered clipart, no readable text.`,
    art_decor: `
DOMAIN-SPECIFIC DIRECTION (art, canvas prints, framed posters & home décor):
Main visual: a realistic, aspirational interior scene showing canvas prints, framed posters, gallery walls, artwork and styled home/office décor. Show real products in real rooms, not a grid of icons. Any artwork may contain abstract shapes but no readable words or brand marks.
Style: editorial home-décor feel, warm lighting, premium photography, generous whitespace where text will be overlaid.
No readable text in the image.`,
    food: `
DOMAIN-SPECIFIC DIRECTION (food, restaurant, café or catering):
Main visual: an appetising, fresh dish or spread in a clean dining setting. Show the food itself, tableware, ingredients or the venue atmosphere. No menu boards, price tags, packaging labels or signage with readable text.
Style: warm, vibrant food photography, shallow depth of field, generous whitespace in the header/footer/offer zones.`,
    beauty: `
DOMAIN-SPECIFIC DIRECTION (beauty, salon, spa, hair or nails):
Main visual: a polished treatment scene — hands at work, styled hair, skincare products, salon chairs, spa setting. Products may be visible but labels must be blank or turned away; no readable text or brand names.
Style: clean, calming beauty photography, soft lighting, generous whitespace where text will be overlaid.`,
    real_estate: `
DOMAIN-SPECIFIC DIRECTION (real estate, property or rentals):
Main visual: an attractive property exterior, interior room, or key feature such as a modern kitchen or garden. No For-Sale signs with text, agent names, addresses, or readable signage.
Style: bright, professional property photography, clean composition, generous whitespace in the header/footer/offer zones.`,
    auto: `
DOMAIN-SPECIFIC DIRECTION (automotive, repairs, detailing or parts):
Main visual: a clean vehicle, mechanic at work, detailing tools, tyres or workshop scene. No number plates with text, branded uniforms with logos, or signage with readable words.
Style: crisp automotive photography, modern garage or studio feel, generous whitespace where text will be overlaid.`,
    fitness_health: `
DOMAIN-SPECIFIC DIRECTION (fitness, gym, wellness or health):
Main visual: an energetic but clean fitness scene — training equipment, class space, healthy food, or a coach/trainer in action. Avoid readable text on shirts, screens, posters or equipment labels.
Style: motivating, high-energy photography, uncluttered composition, generous whitespace where text will be overlaid.`,
    events: `
DOMAIN-SPECIFIC DIRECTION (events, weddings, venues or conferencing):
Main visual: an elegant venue setup, floral décor, celebration atmosphere or stage. No place cards, menus, banners or signage with readable text.
Style: polished event photography, warm or dramatic lighting, generous whitespace where text will be overlaid.`,
    tech: `
DOMAIN-SPECIFIC DIRECTION (technology, software or IT services):
Main visual: a modern workspace with devices, code/screen visuals that are blurred or abstract, or a clean product interface shown without readable UI text. No screens full of readable words, no app store badges, no logos on devices.
Style: sleek, minimal tech photography, cool neutral tones with brand-colour accents, generous whitespace where text will be overlaid.`,
    education: `
DOMAIN-SPECIFIC DIRECTION (education, training, tutoring or courses):
Main visual: a focused learning environment — books, notebooks, a tutor and student, or a workshop scene. Books/notebooks must be blank or spine text illegible; no certificates with text or readable slides.
Style: bright, encouraging education photography, clean composition, generous whitespace where text will be overlaid.`,
    retail: `
DOMAIN-SPECIFIC DIRECTION (retail, boutique or store):
Main visual: attractive products tastefully arranged on shelves, a counter, or a lifestyle flat-lay. Product labels and packaging must be blank or turned away; no price tags or signage with readable text.
Style: clean retail photography, balanced composition, generous whitespace where text will be overlaid.`,
    general: `
DOMAIN-SPECIFIC DIRECTION (general business):
Main visual: a clean, professional scene or product composition that clearly represents the business category and the products/services listed above. Avoid generic stock concepts such as handshakes, upward arrows, random gears or abstract motivational imagery.
Style: modern commercial photography, uncluttered composition, generous whitespace in the header, offer and footer zones, no readable text or brand marks.`,
  };

  const domainSpecific = domainSpecificMap[serviceCategory] || domainSpecificMap.general;

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
Create a premium, text-free visual background that is strongly related to the business category and the products/services listed above.
- For a product business: show realistic products, lifestyle context or retail/service environment relevant to the category. Products should be shown without readable labels, prices or brand marks.
- For a service business: show a polished service scene, environment or symbolic visual relevant to the category. Any signage, screens, documents or uniforms must be blank or free of readable text/logos.
- Choose a scene that communicates the category WITHOUT relying on words: appetising food for restaurants, a treatment scene for beauty, a property for real estate, a vehicle/workshop for automotive, fitness equipment/action for gyms, a venue for events, devices/workspace for tech, books/learning for education, products for retail.
- Use a clean, modern, professional composition with generous whitespace in the header, offer and footer zones.
- Do not crowd the frame; leave room for NatForgeAI to overlay text.
- The background should look like a premium marketing asset background, not a finished poster with its own text.

E. ${textOverlayNote}

F. DESIGN RULES
- Clean, bold and readable after text overlay. High contrast between background and future text areas.
- Looks like a premium marketing background, not a finished poster with its own branding/text.
- Do NOT use simple icon-grid layouts, tile layouts, scattered clipart or dense collages.
- Do NOT use vague slogans such as "Your vision, our solution", "Transform your brand", "Unleash creativity", "Quality meets efficiency", or similar.
- Do NOT invent phone numbers, addresses, websites, emails, prices, discounts, promotions, business names, logos, brand marks, social handles or QR codes.
- The real logo, business name and contact details will be overlaid programmatically after generation.
- Use the brand colours consistently but tastefully as accents, tints and gradients.
- The visual must clearly relate to the actual business category and products/services listed above.
${domainSpecific}
${strongerFitRules}
${userGuidanceBlock}
${refinementBlock}

G. OUTPUT
Single ${layoutType} background image, ${aspectRatio}, ready for NatForgeAI to overlay the final business text. No readable words in the image.`;

  return prompt.replace(/\n{3,}/g, "\n\n").trim();
}
