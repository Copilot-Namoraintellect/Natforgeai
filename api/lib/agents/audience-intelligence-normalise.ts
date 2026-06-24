export interface OutreachAngle {
  channel: "email" | "instagram_dm" | "facebook_dm" | "linkedin_dm" | "whatsapp" | "sms";
  hook: string;
  cta: string;
  expectedOutcome: string;
}

export interface DiscoveredProfile {
  handle: string;
  platform: string;
  displayName: string | null;
  followerCount: number | null;
  relevanceScore: number;
  whyRelevant: string;
  suggestedAngle: string;
}

export interface ScoredLead {
  externalIdentifier: string;
  platform: string;
  handle: string | null;
  displayName: string | null;
  score: number;
  confidence: "low" | "medium" | "high";
  signals: string[];
  recommendedAction: "reach_out" | "nurture" | "ignore";
  explanation: string;
  outreachAngles: OutreachAngle[];
}

export interface ContentResonance {
  theme: string;
  engagementLevel: "low" | "medium" | "high";
  insight: string;
}

export interface AudienceIntelligenceOutput {
  noData?: boolean;
  executiveSummary: string;
  discoveredProfiles: DiscoveredProfile[];
  scoredLeads: ScoredLead[];
  contentResonance: ContentResonance[];
  nextSteps: string[];
}

function normaliseString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normaliseNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normaliseNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function normaliseOutreachAngle(angle: unknown): OutreachAngle {
  if (!angle || typeof angle !== "object") {
    return { channel: "email", hook: "", cta: "", expectedOutcome: "" };
  }
  const a = angle as Record<string, unknown>;
  const validChannels = ["email", "instagram_dm", "facebook_dm", "linkedin_dm", "whatsapp", "sms"] as const;
  const channel = validChannels.includes(a.channel as OutreachAngle["channel"])
    ? (a.channel as OutreachAngle["channel"])
    : "email";
  return {
    channel,
    hook: normaliseString(a.hook),
    cta: normaliseString(a.cta),
    expectedOutcome: normaliseString(a.expectedOutcome),
  };
}

function normaliseScoredLead(lead: unknown): ScoredLead {
  if (!lead || typeof lead !== "object") {
    return {
      externalIdentifier: "",
      platform: "",
      handle: null,
      displayName: null,
      score: 0,
      confidence: "low",
      signals: [],
      recommendedAction: "ignore",
      explanation: "",
      outreachAngles: [],
    };
  }
  const l = lead as Record<string, unknown>;
  const validConfidences = ["low", "medium", "high"] as const;
  const confidence = validConfidences.includes(l.confidence as ScoredLead["confidence"])
    ? (l.confidence as ScoredLead["confidence"])
    : "low";
  const validActions = ["reach_out", "nurture", "ignore"] as const;
  const recommendedAction = validActions.includes(l.recommendedAction as ScoredLead["recommendedAction"])
    ? (l.recommendedAction as ScoredLead["recommendedAction"])
    : "ignore";
  return {
    externalIdentifier: normaliseString(l.externalIdentifier),
    platform: normaliseString(l.platform),
    handle: normaliseNullableString(l.handle),
    displayName: normaliseNullableString(l.displayName),
    score: typeof l.score === "number" ? Math.min(100, Math.max(0, l.score)) : 0,
    confidence,
    signals: Array.isArray(l.signals) ? l.signals.map(normaliseString) : [],
    recommendedAction,
    explanation: normaliseString(l.explanation),
    outreachAngles: Array.isArray(l.outreachAngles)
      ? l.outreachAngles.map(normaliseOutreachAngle)
      : [],
  };
}

function normaliseDiscoveredProfile(profile: unknown): DiscoveredProfile {
  if (!profile || typeof profile !== "object") {
    return {
      handle: "",
      platform: "",
      displayName: null,
      followerCount: null,
      relevanceScore: 0,
      whyRelevant: "",
      suggestedAngle: "",
    };
  }
  const p = profile as Record<string, unknown>;
  return {
    handle: normaliseString(p.handle),
    platform: normaliseString(p.platform),
    displayName: normaliseNullableString(p.displayName),
    followerCount: normaliseNumber(p.followerCount),
    relevanceScore: typeof p.relevanceScore === "number" ? p.relevanceScore : 0,
    whyRelevant: normaliseString(p.whyRelevant),
    suggestedAngle: normaliseString(p.suggestedAngle),
  };
}

function normaliseContentResonance(item: unknown): ContentResonance {
  if (!item || typeof item !== "object") {
    return { theme: "", engagementLevel: "low", insight: "" };
  }
  const i = item as Record<string, unknown>;
  const validLevels = ["low", "medium", "high"] as const;
  return {
    theme: normaliseString(i.theme),
    engagementLevel: validLevels.includes(i.engagementLevel as ContentResonance["engagementLevel"])
      ? (i.engagementLevel as ContentResonance["engagementLevel"])
      : "low",
    insight: normaliseString(i.insight),
  };
}

export function normaliseOutput(raw: unknown): AudienceIntelligenceOutput {
  if (!raw || typeof raw !== "object") {
    return {
      executiveSummary: "",
      discoveredProfiles: [],
      scoredLeads: [],
      contentResonance: [],
      nextSteps: [],
    };
  }
  const r = raw as Record<string, unknown>;
  return {
    executiveSummary: normaliseString(r.executiveSummary),
    discoveredProfiles: Array.isArray(r.discoveredProfiles)
      ? r.discoveredProfiles.map(normaliseDiscoveredProfile)
      : [],
    scoredLeads: Array.isArray(r.scoredLeads)
      ? r.scoredLeads.map(normaliseScoredLead)
      : [],
    contentResonance: Array.isArray(r.contentResonance)
      ? r.contentResonance.map(normaliseContentResonance)
      : [],
    nextSteps: Array.isArray(r.nextSteps) ? r.nextSteps.map(normaliseString) : [],
  };
}
