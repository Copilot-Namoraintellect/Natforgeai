/**
 * Premium Leaflet V2 – reusable business fixtures for samples and tests.
 *
 * All fixtures are deterministic and read-only. They are used by the sample
 * generator and by category-wide regression tests.
 */

export interface FixtureBusiness {
  id: number;
  name: string;
  displayName: string;
  logo?: string;
  industry: string;
  location: string;
  phone?: string;
  email?: string;
  website?: string;
  productOrService: string;
  targetCustomer: string;
  brandColors: string[];
  visualStyle: string;
  websiteEvidence?: {
    businessCategory?: string;
    productsServices?: string[];
    targetCustomers?: string[];
    location?: string;
  };
}

export interface FixtureCampaign {
  id: number;
  name: string;
  goal: string;
  primaryOutcome: string;
  targetBuyer: string;
  mainPainPoint: string;
  productOrService: string;
  preferredCta: string;
  offerDetails?: string;
}

export function fixture3At1Newmarket(mock = true): { business: FixtureBusiness; campaign: FixtureCampaign } {
  return {
    business: {
      id: 2,
      name: "3@1 Newmarket",
      displayName: "3@1 Newmarket",
      logo: mock
        ? "https://via.placeholder.com/200x200/0047AB/FFD700?text=3@1"
        : process.env.SAMPLE_3AT1_LOGO_URL || "https://via.placeholder.com/200x200/0047AB/FFD700?text=3@1",
      industry: "Print and courier",
      location: "Newmarket, Alberton",
      phone: mock ? "011 123 9999" : process.env.SAMPLE_3AT1_PHONE || "",
      email: mock ? undefined : process.env.SAMPLE_3AT1_EMAIL || "",
      website: mock ? "https://3at1newmarket.test" : process.env.SAMPLE_3AT1_WEBSITE || "",
      productOrService:
        "Business cards, Flyers, Large format prints, Wall canvas prints, Courier services, Banners, Posters, Custom printing, Laminating, Binding, Copies, Scans",
      targetCustomer: "Small businesses and event planners",
      brandColors: ["#0047AB", "#FFD700", "#DC143C"],
      visualStyle: "modern",
      websiteEvidence: {
        businessCategory: "print and courier",
        productsServices: [
          "Business cards",
          "Flyers",
          "Large format prints",
          "Wall canvas prints",
          "Courier services",
          "Banners",
          "Posters",
          "Custom printing",
          "Laminating",
          "Binding",
          "Copies",
          "Scans",
        ],
      },
    },
    campaign: {
      id: 20,
      name: "Newmarket Print Promo",
      goal: "Leads",
      primaryOutcome: "Get more print orders",
      targetBuyer: "Small business owners",
      mainPainPoint: "Need fast, affordable printing and delivery",
      productOrService: "Printing, Copying, Scanning, Laminating, Binding, Courier",
      preferredCta: "Request a Quote Today",
    },
  };
}

export function fixtureRestaurant(): { business: FixtureBusiness; campaign: FixtureCampaign } {
  return {
    business: {
      id: 3,
      name: "Burger Barn",
      displayName: "Burger Barn",
      logo: "https://via.placeholder.com/200x200/B91C1C/FFFFFF?text=BB",
      industry: "Restaurant",
      location: "Sandton",
      phone: "011 456 7890",
      website: "https://burgerbarn.test",
      productOrService: "Gourmet burgers, Loaded fries, Milkshakes, Wraps, Catering",
      targetCustomer: "Local families and office workers",
      brandColors: ["#B91C1C", "#F97316", "#FACC15"],
      visualStyle: "bold",
    },
    campaign: {
      id: 30,
      name: "Weekend Special",
      goal: "Orders",
      primaryOutcome: "Increase weekend orders",
      targetBuyer: "Local families",
      mainPainPoint: "Boring fast-food options",
      productOrService: "Gourmet burgers, loaded fries, shakes",
      preferredCta: "Order Now",
      offerDetails: "Buy any burger, get a free shake",
    },
  };
}

export function fixtureBeauty(): { business: FixtureBusiness; campaign: FixtureCampaign } {
  return {
    business: {
      id: 4,
      name: "Glow Spa",
      displayName: "Glow Spa",
      logo: "https://via.placeholder.com/200x200/831843/FFFFFF?text=Glow",
      industry: "Beauty salon",
      location: "Rosebank",
      phone: "011 222 3333",
      website: "https://glowspa.test",
      productOrService: "Hair, Nails, Facials, Massage, Makeup",
      targetCustomer: "Busy professionals",
      brandColors: ["#831843", "#DB2777", "#F472B6"],
      visualStyle: "luxury",
    },
    campaign: {
      id: 31,
      name: "Spa Day",
      goal: "Bookings",
      primaryOutcome: "Fill weekend bookings",
      targetBuyer: "Professionals aged 25-45",
      mainPainPoint: "Stress and lack of self-care time",
      productOrService: "Hair, nails, facials, massage",
      preferredCta: "Book Your Appointment",
    },
  };
}

export function fixtureCleaning(): { business: FixtureBusiness; campaign: FixtureCampaign } {
  return {
    business: {
      id: 5,
      name: "Sparkle Cleaners",
      displayName: "Sparkle Cleaners",
      logo: "https://via.placeholder.com/200x200/0F766E/FFFFFF?text=SC",
      industry: "Cleaning",
      location: "Centurion",
      phone: "012 345 6789",
      website: "https://sparkleclean.test",
      productOrService: "Office cleaning, Home deep-cleaning, Carpet cleaning, Window cleaning",
      targetCustomer: "Office managers",
      brandColors: ["#0F766E", "#14B8A6", "#F59E0B"],
      visualStyle: "friendly",
    },
    campaign: {
      id: 32,
      name: "Spring Clean",
      goal: "Leads",
      primaryOutcome: "Book more deep cleans",
      targetBuyer: "Office managers",
      mainPainPoint: "Inconsistent cleaning staff",
      productOrService: "Office cleaning, home deep-cleaning, carpet cleaning",
      preferredCta: "Book a Deep Clean",
      offerDetails: "First deep clean 20% off",
    },
  };
}

export function fixturePlumber(): { business: FixtureBusiness; campaign: FixtureCampaign } {
  return {
    business: {
      id: 6,
      name: "Leak Fix",
      displayName: "Leak Fix Plumbers",
      logo: "https://via.placeholder.com/200x200/1E3A8A/FFFFFF?text=LF",
      industry: "Plumbing",
      location: "Pretoria East",
      phone: "012 999 0000",
      website: "https://leakfix.test",
      productOrService: "Leak repair, Pipe installation, Geyser repair, Emergency plumbing",
      targetCustomer: "Homeowners",
      brandColors: ["#1E3A8A", "#3B82F6", "#F59E0B"],
      visualStyle: "bold",
    },
    campaign: {
      id: 33,
      name: "Emergency plumbing",
      goal: "Leads",
      primaryOutcome: "Get emergency call-outs",
      targetBuyer: "Homeowners",
      mainPainPoint: "Burst pipes and leaks after hours",
      productOrService: "Leak repair, pipe installation, emergency plumbing",
      preferredCta: "Call Now",
    },
  };
}

export function fixtureRetail(): { business: FixtureBusiness; campaign: FixtureCampaign } {
  return {
    business: {
      id: 7,
      name: "The Boutique",
      displayName: "The Boutique",
      logo: "https://via.placeholder.com/200x200/4338CA/FFFFFF?text=TB",
      industry: "Retail",
      location: "Cape Town",
      phone: "021 111 2222",
      website: "https://theboutique.test",
      productOrService: "Clothing, Shoes, Accessories, Gifts",
      targetCustomer: "Fashion-conscious women",
      brandColors: ["#4338CA", "#6366F1", "#EC4899"],
      visualStyle: "modern",
    },
    campaign: {
      id: 34,
      name: "Summer Sale",
      goal: "Sales",
      primaryOutcome: "Drive in-store traffic",
      targetBuyer: "Women aged 25-40",
      mainPainPoint: "High prices for quality fashion",
      productOrService: "Clothing, shoes, accessories",
      preferredCta: "Shop Now",
      offerDetails: "30% off selected items",
    },
  };
}

export function fixtureProfessional(): { business: FixtureBusiness; campaign: FixtureCampaign } {
  return {
    business: {
      id: 8,
      name: "Strategy First",
      displayName: "Strategy First Consulting",
      logo: "https://via.placeholder.com/200x200/1E3A8A/FFFFFF?text=SF",
      industry: "Consulting",
      location: "Johannesburg",
      phone: "011 777 8888",
      website: "https://strategyfirst.test",
      productOrService: "Business strategy, Financial planning, Coaching, Advisory",
      targetCustomer: "SME owners",
      brandColors: ["#1E3A8A", "#334155", "#F59E0B"],
      visualStyle: "modern",
    },
    campaign: {
      id: 35,
      name: "Strategy Sprint",
      goal: "Leads",
      primaryOutcome: "Book strategy consultations",
      targetBuyer: "SME owners",
      mainPainPoint: "Unclear growth direction",
      productOrService: "Business strategy, financial planning, coaching",
      preferredCta: "Book a Consultation",
    },
  };
}

export function fixtureTraining(): { business: FixtureBusiness; campaign: FixtureCampaign } {
  return {
    business: {
      id: 9,
      name: "Skill Up",
      displayName: "Skill Up Academy",
      logo: "https://via.placeholder.com/200x200/065F46/FFFFFF?text=SU",
      industry: "Training",
      location: "Durban",
      phone: "031 444 5555",
      website: "https://skillup.test",
      productOrService: "Leadership courses, Workshops, Certifications, Online training",
      targetCustomer: "Working professionals",
      brandColors: ["#065F46", "#10B981", "#F59E0B"],
      visualStyle: "friendly",
    },
    campaign: {
      id: 36,
      name: "Q3 Intake",
      goal: "Enrolments",
      primaryOutcome: "Fill Q3 leadership course",
      targetBuyer: "Managers and team leads",
      mainPainPoint: "Lack of practical leadership skills",
      productOrService: "Leadership courses, workshops, certifications",
      preferredCta: "Enrol Today",
    },
  };
}

export const ALL_FIXTURES = {
  "3at1": fixture3At1Newmarket,
  restaurant: fixtureRestaurant,
  beauty: fixtureBeauty,
  cleaning: fixtureCleaning,
  plumber: fixturePlumber,
  retail: fixtureRetail,
  professional: fixtureProfessional,
  training: fixtureTraining,
};
