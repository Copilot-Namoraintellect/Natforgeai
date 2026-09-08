import {
  mysqlTable,
  mysqlEnum,
  serial,
  varchar,
  text,
  timestamp,
  int,
  bigint,
  json,
  boolean,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

// ─── Users ───
export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  // For Kimi OAuth (legacy) or Google OAuth
  unionId: varchar("unionId", { length: 255 }),
  // For Google OAuth specifically
  googleId: varchar("googleId", { length: 255 }),
  // For Firebase Auth
  firebaseUid: varchar("firebaseUid", { length: 255 }),
  // Username for local auth
  username: varchar("username", { length: 255 }),
  // Email (unique for local auth users)
  email: varchar("email", { length: 320 }),
  // Password hash for local auth (bcrypt)
  passwordHash: varchar("passwordHash", { length: 255 }),
  // Auth type to distinguish login methods
  authType: mysqlEnum("authType", ["local", "google", "kimi", "firebase"]).default("local"),
  name: varchar("name", { length: 255 }),
  avatar: text("avatar"),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  lastSignInAt: timestamp("lastSignInAt").defaultNow().notNull(),
  onboardingComplete: boolean("onboardingComplete").default(false).notNull(),
  // TODO: 2FA is scaffolded but not implemented.
  // Required pieces for a dedicated 2FA phase:
  // - TOTP secret generation
  // - QR code setup
  // - Encrypted secret storage
  // - Backup codes
  // - Login challenge screen
  // - Rate limiting
  // - Recovery flow
  // - Settings UI to enable/disable 2FA
  twoFactorEnabled: boolean("twoFactorEnabled").default(false).notNull(),
  twoFactorMethod: varchar("twoFactorMethod", { length: 20 }),
  // Legacy field. Prefer emailVerifiedAt for account verification and
  // lastTwoFactorVerifiedAt for login-2FA verification.
  twoFactorVerifiedAt: timestamp("twoFactorVerifiedAt"),
  emailVerifiedAt: timestamp("emailVerifiedAt"),
  lastTwoFactorVerifiedAt: timestamp("lastTwoFactorVerifiedAt"),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Subscription Tiers ───
export const subscriptionTiers = mysqlTable("subscription_tiers", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 50 }).notNull().unique(),
  description: text("description"),
  priceUsd: int("priceUsd").notNull(),
  billingCycle: mysqlEnum("billingCycle", ["monthly", "yearly"]).default("monthly").notNull(),
  maxCampaigns: int("maxCampaigns").default(10),
  maxLeads: int("maxLeads").default(100),
  maxContent: int("maxContent").default(50),
  maxAutomations: int("maxAutomations").default(3),
  maxResults: int("maxResults").default(5),
  aiGeneration: boolean("aiGeneration").default(false),
  analytics: boolean("analytics").default(false),
  teamMembers: int("teamMembers").default(1),
  features: json("features"),
  strategyAgent: boolean("strategyAgent").default(false).notNull(),
  creativeAgent: boolean("creativeAgent").default(false).notNull(),
  audienceAgent: boolean("audienceAgent").default(false).notNull(),
  distributionAgent: boolean("distributionAgent").default(false).notNull(),
  engagementAgent: boolean("engagementAgent").default(false).notNull(),
  salesAgent: boolean("salesAgent").default(false).notNull(),
  optimisationAgent: boolean("optimisationAgent").default(false).notNull(),
  approvalCentre: boolean("approvalCentre").default(false).notNull(),
  autonomousMode: boolean("autonomousMode").default(false).notNull(),
  monthlyCredits: int("monthlyCredits").default(0).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  isDefault: boolean("isDefault").default(false),
  displayOrder: int("displayOrder").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type SubscriptionTier = typeof subscriptionTiers.$inferSelect;

// ─── Subscriptions ───
export const subscriptions = mysqlTable("subscriptions", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  tierId: bigint("tierId", { mode: "number", unsigned: true }).notNull(),
  status: mysqlEnum("status", ["active", "trialing", "past_due", "cancelled", "expired"]).default("trialing").notNull(),
  trialEndsAt: timestamp("trialEndsAt"),
  currentPeriodStart: timestamp("currentPeriodStart").defaultNow().notNull(),
  currentPeriodEnd: timestamp("currentPeriodEnd"),
  paymentMethod: mysqlEnum("paymentMethod", ["stripe", "paypal", "bank_transfer", "manual"]),
  paymentReference: varchar("paymentReference", { length: 255 }),
  cancelledAt: timestamp("cancelledAt"),
  cancelAtPeriodEnd: boolean("cancelAtPeriodEnd").default(false),
  lastCreditAllocationAt: timestamp("lastCreditAllocationAt"),
  nextCreditAllocationAt: timestamp("nextCreditAllocationAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type Subscription = typeof subscriptions.$inferSelect;

// ─── Payments ───
export const payments = mysqlTable("payments", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  subscriptionId: bigint("subscriptionId", { mode: "number", unsigned: true }),
  amount: int("amount").notNull(), // in cents (USD)
  currency: varchar("currency", { length: 3 }).default("USD").notNull(),
  status: mysqlEnum("status", ["pending", "completed", "failed", "refunded", "disputed"]).default("pending").notNull(),
  paymentMethod: mysqlEnum("paymentMethod", ["stripe", "paypal", "bank_transfer", "manual", "crypto"]),
  paymentReference: varchar("paymentReference", { length: 255 }),
  description: text("description"),
  paidAt: timestamp("paidAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Payment = typeof payments.$inferSelect;

// ─── Banking Details (Admin) ───
export const bankingDetails = mysqlTable("banking_details", {
  id: serial("id").primaryKey(),
  adminUserId: bigint("adminUserId", { mode: "number", unsigned: true }).notNull(),
  accountName: varchar("accountName", { length: 255 }),
  bankName: varchar("bankName", { length: 255 }),
  accountNumber: varchar("accountNumber", { length: 100 }),
  accountType: mysqlEnum("accountType", ["checking", "savings", "business"]).default("business"),
  branchCode: varchar("branchCode", { length: 50 }),
  swiftCode: varchar("swiftCode", { length: 50 }),
  iban: varchar("iban", { length: 100 }),
  routingNumber: varchar("routingNumber", { length: 100 }),
  // For Stripe/PayPal integration
  stripeAccountId: varchar("stripeAccountId", { length: 255 }),
  paypalEmail: varchar("paypalEmail", { length: 320 }),
  // For crypto
  cryptoWalletAddress: varchar("cryptoWalletAddress", { length: 255 }),
  cryptoNetwork: varchar("cryptoNetwork", { length: 50 }),
  isDefault: boolean("isDefault").default(false),
  isActive: boolean("isActive").default(true),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type BankingDetail = typeof bankingDetails.$inferSelect;

// ─── Businesses ───
export const businesses = mysqlTable("businesses", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  industry: varchar("industry", { length: 100 }),
  location: varchar("location", { length: 255 }),
  targetAudience: text("targetAudience"),
  tone: varchar("tone", { length: 50 }).default("professional"),
  logo: text("logo"),
  email: varchar("email", { length: 255 }),
  website: varchar("website", { length: 500 }),
  productOrService: text("productOrService"),
  targetCustomer: text("targetCustomer"),
  monthlyBudget: int("monthlyBudget"),
  brandTone: varchar("brandTone", { length: 50 }),
  brandColors: json("brandColors"),
  visualStyle: varchar("visualStyle", { length: 50 }),
  brandVoiceNotes: text("brandVoiceNotes"),
  avoidWords: text("avoidWords"),
  mainGoal: text("mainGoal"),
  socialLinks: json("socialLinks"),
  whatsappNumber: varchar("whatsappNumber", { length: 50 }),
  preferredPlatforms: text("preferredPlatforms"),
  premiumContentPreferences: text("premiumContentPreferences"),
  websiteEvidence: json("websiteEvidence"),
  hasProductVideos: boolean("hasProductVideos").default(false),
  onboardingComplete: boolean("onboardingComplete").default(false).notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type Business = typeof businesses.$inferSelect;

// ─── Campaigns ───
export const campaigns = mysqlTable("campaigns", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  businessId: bigint("businessId", { mode: "number", unsigned: true }),
  name: varchar("name", { length: 255 }).notNull(),
  goal: varchar("goal", { length: 255 }).notNull(),
  status: mysqlEnum("status", ["draft", "active", "paused", "completed"])
    .default("draft")
    .notNull(),
  targetAudience: text("targetAudience"),
  coreMessage: text("coreMessage"),
  platforms: text("platforms"),
  budget: int("budget"),
  // Campaign brief precision fields
  primaryOutcome: text("primaryOutcome"),
  targetBuyer: text("targetBuyer"),
  mainPainPoint: text("mainPainPoint"),
  productOrService: text("productOrService"),
  offerDetails: text("offerDetails"),
  preferredCta: text("preferredCta"),
  excludedOffers: text("excludedOffers"),
  referenceStyle: text("referenceStyle"),
  contentStyle: varchar("contentStyle", { length: 50 }),
  startDate: date("startDate"),
  endDate: date("endDate"),
  strategy: text("strategy"),
  personas: json("personas"),
  contentCalendar: json("contentCalendar"),
  adConcepts: json("adConcepts"),
  funnelStages: json("funnelStages"),
  offers: json("offers"),
  ctaStrategy: text("ctaStrategy"),
  workflowState: mysqlEnum("workflowState", [
    "business_onboarding",
    "strategy_pending",
    "strategy_generated",
    "strategy_approved",
    "creatives_generating",
    "creatives_ready",
    "audience_generating",
    "audience_ready",
    "schedule_generated",
    "launch_approval_required",
    "campaign_live",
    "engagement_active",
    "leads_converting",
    "optimisation_active",
    "completed",
  ])
    .default("business_onboarding")
    .notNull(),
  workflowContext: json("workflowContext"),
  strategyDocument: text("strategyDocument"),
  autoPublish: boolean("autoPublish").default(false).notNull(),
  approvalMode: mysqlEnum("approvalMode", ["assisted", "autonomous"])
    .default("assisted")
    .notNull(),
  aiGenerated: boolean("aiGenerated").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type Campaign = typeof campaigns.$inferSelect;

// ─── Content Posts ───
export const contentPosts = mysqlTable("content_posts", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
  businessId: bigint("businessId", { mode: "number", unsigned: true }),
  title: varchar("title", { length: 255 }).notNull(),
  type: mysqlEnum("type", [
    "social_post",
    "ad_copy",
    "email",
    "script",
    "blog",
    "story",
    "video_concept",
    "reel_script",
    "carousel_ad",
    "whatsapp_promo",
    "lead_gen_ad",
    "launch_pack",
  ]).notNull(),
  platform: varchar("platform", { length: 50 }),
  hook: text("hook"),
  caption: text("caption"),
  cta: text("cta"),
  headline: text("headline"),
  body: text("body"),
  hashtags: text("hashtags"),
  visualPrompt: text("visualPrompt"),
  status: mysqlEnum("status", ["draft", "scheduled", "published", "archived"])
    .default("draft")
    .notNull(),
  scheduledFor: timestamp("scheduledFor"),
  publishedAt: timestamp("publishedAt"),
  engagementScore: int("engagementScore"),
  aiGenerated: boolean("aiGenerated").default(true).notNull(),
  metadata: json("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type ContentPost = typeof contentPosts.$inferSelect;

// ─── Leads ───
export const leads = mysqlTable("leads", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  businessId: bigint("businessId", { mode: "number", unsigned: true }),
  campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 320 }),
  phone: varchar("phone", { length: 50 }),
  company: varchar("company", { length: 255 }),
  jobTitle: varchar("jobTitle", { length: 100 }),
  source: varchar("source", { length: 100 }),
  status: mysqlEnum("status", [
    "new",
    "contacted",
    "qualified",
    "proposal",
    "negotiation",
    "won",
    "lost",
  ])
    .default("new")
    .notNull(),
  score: int("score").default(0),
  notes: text("notes"),
  lastContact: timestamp("lastContact"),
  nextFollowUp: timestamp("nextFollowUp"),
  customFields: json("customFields"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type Lead = typeof leads.$inferSelect;

// ─── Lead Activities ───
export const leadActivities = mysqlTable("lead_activities", {
  id: serial("id").primaryKey(),
  leadId: bigint("leadId", { mode: "number", unsigned: true }).notNull(),
  type: mysqlEnum("type", [
    "note",
    "call",
    "email",
    "meeting",
    "task",
    "status_change",
  ]).notNull(),
  description: text("description").notNull(),
  createdBy: bigint("createdBy", { mode: "number", unsigned: true }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type LeadActivity = typeof leadActivities.$inferSelect;

// ─── Schedules ───
export const schedules = mysqlTable("schedules", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  contentPostId: bigint("contentPostId", { mode: "number", unsigned: true }),
  campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
  businessId: bigint("businessId", { mode: "number", unsigned: true }),
  title: varchar("title", { length: 255 }).notNull(),
  platform: varchar("platform", { length: 50 }).notNull(),
  scheduledDate: date("scheduledDate").notNull(),
  scheduledTime: varchar("scheduledTime", { length: 10 }),
  timezone: varchar("timezone", { length: 50 }).default("UTC"),
  contentType: mysqlEnum("contentType", [
    "educational",
    "promotional",
    "engagement",
    "awareness",
    "conversion",
  ]).default("educational"),
  status: mysqlEnum("status", ["draft", "scheduled", "posted", "failed"])
    .default("draft")
    .notNull(),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type Schedule = typeof schedules.$inferSelect;

// ─── Automations ───
export const automations = mysqlTable("automations", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  businessId: bigint("businessId", { mode: "number", unsigned: true }),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  trigger: mysqlEnum("trigger", [
    "new_lead",
    "new_message",
    "new_purchase",
    "form_submit",
    "schedule",
    "manual",
  ]).notNull(),
  actions: json("actions").notNull(),
  isActive: boolean("isActive").default(false).notNull(),
  runCount: int("runCount").default(0),
  lastRun: timestamp("lastRun"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type Automation = typeof automations.$inferSelect;

// ─── Analytics ───
export const analytics = mysqlTable("analytics", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
  businessId: bigint("businessId", { mode: "number", unsigned: true }),
  metricType: mysqlEnum("metricType", [
    "impressions",
    "clicks",
    "conversions",
    "leads",
    "revenue",
    "engagement",
    "followers",
    "reach",
  ]).notNull(),
  platform: varchar("platform", { length: 50 }),
  value: int("value").default(0),
  date: date("date").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Analytics = typeof analytics.$inferSelect;

// ─── Templates ───
export const templates = mysqlTable("templates", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }),
  name: varchar("name", { length: 255 }).notNull(),
  category: mysqlEnum("category", [
    "strategy",
    "content",
    "ads",
    "design",
    "video",
    "targeting",
    "scheduling",
    "chatbot",
    "crm",
    "automation",
  ]).notNull(),
  description: text("description"),
  prompt: text("prompt").notNull(),
  variables: json("variables"),
  isDefault: boolean("isDefault").default(false).notNull(),
  isFavorite: boolean("isFavorite").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type Template = typeof templates.$inferSelect;

// ─── Generated Images ───
export const generatedImages = mysqlTable("generated_images", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
  businessId: bigint("businessId", { mode: "number", unsigned: true }),
  contentPostId: bigint("contentPostId", { mode: "number", unsigned: true }),
  provider: varchar("provider", { length: 50 }).default("openai"),
  providerJobId: varchar("providerJobId", { length: 255 }),
  prompt: text("prompt").notNull(),
  url: text("url").notNull(),
  aspectRatio: varchar("aspectRatio", { length: 10 }).default("1:1"),
  style: varchar("style", { length: 100 }),
  status: mysqlEnum("status", ["pending", "completed", "failed"])
    .default("pending")
    .notNull(),
  creditsCharged: int("creditsCharged").default(0),
  providerCostUsd: int("providerCostUsd").default(0),
  metadata: json("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type GeneratedImage = typeof generatedImages.$inferSelect;

// ─── User Usage (for freemium tracking) ───
export const userUsage = mysqlTable("user_usage", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull().unique(),
  campaignsCreated: int("campaignsCreated").default(0),
  successfulResults: int("successfulResults").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type UserUsage = typeof userUsage.$inferSelect;

// ─── Agent Runs ───
export const agentRuns = mysqlTable("agent_runs", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
  agentType: mysqlEnum("agentType", [
    "strategy",
    "creative",
    "audience",
    "distribution",
    "engagement",
    "sales",
    "optimisation",
  ]).notNull(),
  status: mysqlEnum("status", ["pending", "running", "completed", "failed"])
    .default("pending")
    .notNull(),
  input: json("input"),
  output: json("output"),
  error: text("error"),
  startedAt: timestamp("startedAt"),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type AgentRun = typeof agentRuns.$inferSelect;

// ─── Creative Generation Claims ───
// Atomic acquisition layer for creative-generation operations.
// Active claims are identified by a nullable unique key; terminal claims clear it.
export const creativeGenerationClaims = mysqlTable(
  "creative_generation_claims",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }).notNull(),
    operationSource: varchar("operationSource", { length: 32 }).notNull(),
    operationReferenceId: bigint("operationReferenceId", {
      mode: "number",
      unsigned: true,
    }),
    activeClaimKey: varchar("activeClaimKey", { length: 255 }),
    ownerToken: varchar("ownerToken", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["running", "completed", "failed"])
      .default("running")
      .notNull(),
    heartbeatAt: timestamp("heartbeatAt"),
    leaseExpiresAt: timestamp("leaseExpiresAt"),
    releasedAt: timestamp("releasedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    activeClaimKeyUnique: uniqueIndex("cgc_active_claim_key_idx").on(table.activeClaimKey),
    operationSourceReferenceUnique: uniqueIndex("cgc_op_source_reference_idx").on(
      table.operationSource,
      table.operationReferenceId
    ),
    userCampaignIdx: index("cgc_user_campaign_idx").on(table.userId, table.campaignId),
    statusLeaseIdx: index("cgc_status_lease_idx").on(table.status, table.leaseExpiresAt),
  })
);

export type CreativeGenerationClaim = typeof creativeGenerationClaims.$inferSelect;
export type InsertCreativeGenerationClaim = typeof creativeGenerationClaims.$inferInsert;

export const imageRenderClaims = mysqlTable(
  "image_render_claims",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    contentPostId: bigint("contentPostId", { mode: "number", unsigned: true }).notNull(),
    activeClaimKey: varchar("activeClaimKey", { length: 191 }),
    ownerToken: varchar("ownerToken", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["running", "completed", "failed"])
      .default("running")
      .notNull(),
    leaseExpiresAt: timestamp("leaseExpiresAt").notNull(),
    requestAttemptKey: varchar("requestAttemptKey", { length: 64 }),
    intentFingerprint: varchar("intentFingerprint", { length: 64 }),
    deductionKey: varchar("deductionKey", { length: 191 }),
    deductionRecorded: boolean("deductionRecorded").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    activeClaimKeyUnique: uniqueIndex("irc_active_claim_key_idx").on(table.activeClaimKey),
    requestAttemptKeyUnique: uniqueIndex("irc_request_attempt_key_idx").on(
      table.requestAttemptKey
    ),
    deductionKeyIdx: index("irc_deduction_key_idx").on(table.deductionKey),
    userPostIdx: index("irc_user_post_idx").on(table.userId, table.contentPostId),
  })
);

export type ImageRenderClaim = typeof imageRenderClaims.$inferSelect;
export type InsertImageRenderClaim = typeof imageRenderClaims.$inferInsert;

// ─── Approval Requests ───
export const approvalRequests = mysqlTable("approval_requests", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
  approvalType: mysqlEnum("approvalType", [
    "campaign_launch",
    "budget_increase",
    "sensitive_reply",
    "high_value_proposal",
    "ad_spend",
    "shutdown",
    "brand_risk",
    "strategy_review",
  ]).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  aiRecommendation: text("aiRecommendation"),
  riskLevel: mysqlEnum("riskLevel", ["low", "medium", "high"]).notNull(),
  status: mysqlEnum("status", ["pending", "approved", "rejected", "edited"])
    .default("pending")
    .notNull(),
  approvedAt: timestamp("approvedAt"),
  rejectedAt: timestamp("rejectedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ApprovalRequest = typeof approvalRequests.$inferSelect;

// ─── Campaign Assets ───
export const campaignAssets = mysqlTable("campaign_assets", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  campaignId: bigint("campaignId", { mode: "number", unsigned: true }).notNull(),
  assetType: mysqlEnum("assetType", [
    "image",
    "video_script",
    "carousel",
    "ad_copy",
    "caption",
    "caption_adaptation",
    "caption_pack",
    "hashtag_set",
    "cta_variant",
    "email_copy",
    "whatsapp_copy",
    "video_concept",
    "reel_script",
    "carousel_ad",
    "whatsapp_promo",
    "lead_gen_ad",
    "launch_pack",
    "message_pack",
  ]).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  url: text("url"),
  prompt: text("prompt"),
  status: mysqlEnum("status", ["generating", "ready", "approved", "rejected"])
    .default("generating")
    .notNull(),
  metadata: json("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type CampaignAsset = typeof campaignAssets.$inferSelect;

// ─── Publishing Queue ───
export const publishingQueue = mysqlTable("publishing_queue", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  campaignId: bigint("campaignId", { mode: "number", unsigned: true }).notNull(),
  contentPostId: bigint("contentPostId", { mode: "number", unsigned: true }),
  integrationId: bigint("integrationId", { mode: "number", unsigned: true }),
  platform: varchar("platform", { length: 50 }).notNull(),
  scheduledAt: timestamp("scheduledAt"),
  status: mysqlEnum("status", [
    "draft",
    "pending_approval",
    "approved",
    "published",
    "failed",
    "safety_blocked",
    "retrying",
  ])
    .default("draft")
    .notNull(),
  approvalRequired: boolean("approvalRequired").default(false).notNull(),
  publishedAt: timestamp("publishedAt"),
  externalPostId: text("externalPostId"),
  // Retry logic
  retryCount: int("retryCount").default(0).notNull(),
  maxRetries: int("maxRetries").default(3).notNull(),
  nextRetryAt: timestamp("nextRetryAt"),
  lastError: text("lastError"),
  // Content safety
  safetyStatus: mysqlEnum("safetyStatus", ["pending", "low", "medium", "high"]),
  safetyReasons: json("safetyReasons"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PublishingQueueItem = typeof publishingQueue.$inferSelect;

// ─── Social Integrations ───
export const socialIntegrations = mysqlTable(
  "social_integrations",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    platform: mysqlEnum("platform", [
      "facebook",
      "instagram",
      "linkedin",
      "tiktok",
      "twitter",
      "whatsapp",
      "email",
    ]).notNull(),
    accountName: varchar("accountName", { length: 255 }),
    accessTokenEncrypted: text("accessTokenEncrypted"),
    refreshTokenEncrypted: text("refreshTokenEncrypted"),
    pageId: varchar("pageId", { length: 255 }),
    pageAccessTokenEncrypted: text("pageAccessTokenEncrypted"),
    instagramBusinessAccountId: varchar("instagramBusinessAccountId", { length: 255 }),
    permissions: json("permissions"),
    status: mysqlEnum("status", ["connected", "expired", "disconnected"])
      .default("disconnected")
      .notNull(),
    lastSyncAt: timestamp("lastSyncAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  }
);

export type SocialIntegration = typeof socialIntegrations.$inferSelect;

// ─── Social Profiles (permissioned / owned account audiences) ───
export const socialProfiles = mysqlTable(
  "social_profiles",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
    platform: mysqlEnum("platform", [
      "facebook_page",
      "instagram_account",
      "linkedin_page",
      "tiktok_account",
      "twitter_account",
    ]).notNull(),
    externalId: varchar("externalId", { length: 255 }).notNull(),
    handle: varchar("handle", { length: 255 }),
    displayName: varchar("displayName", { length: 255 }),
    url: text("url"),
    followerCount: int("followerCount").default(0),
    category: varchar("category", { length: 255 }),
    location: varchar("location", { length: 255 }),
    profilePictureUrl: text("profilePictureUrl"),
    lastSyncedAt: timestamp("lastSyncedAt"),
    metadata: json("metadata"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    userPlatformExternalIdx: uniqueIndex("user_platform_external_idx").on(
      table.userId,
      table.platform,
      table.externalId
    ),
    userCampaignIdx: index("sp_user_campaign_idx").on(table.userId, table.campaignId),
  })
);

export type SocialProfile = typeof socialProfiles.$inferSelect;

// ─── Social Engagement Events (official API events only) ───
export const socialEngagementEvents = mysqlTable(
  "social_engagement_events",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
    platform: mysqlEnum("platform", [
      "facebook",
      "instagram",
      "linkedin",
      "tiktok",
      "twitter",
    ]).notNull(),
    socialProfileId: bigint("socialProfileId", { mode: "number", unsigned: true }),
    externalProfileId: varchar("externalProfileId", { length: 255 }).notNull(),
    externalContentId: varchar("externalContentId", { length: 255 }),
    dedupHash: varchar("dedupHash", { length: 64 }).notNull(),
    eventType: mysqlEnum("eventType", [
      "follow",
      "like",
      "comment",
      "share",
      "message",
      "click",
      "save",
      "post_interaction",
    ]).notNull(),
    actorHandle: varchar("actorHandle", { length: 255 }),
    actorDisplayName: varchar("actorDisplayName", { length: 255 }),
    actorExternalId: varchar("actorExternalId", { length: 255 }),
    messageText: text("messageText"),
    eventTimestamp: timestamp("eventTimestamp").notNull(),
    metadata: json("metadata"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    profileEventIdx: index("see_profile_event_idx").on(
      table.socialProfileId,
      table.eventTimestamp
    ),
    userCampaignIdx: index("see_user_campaign_idx").on(table.userId, table.campaignId),
    dedupHashIdx: uniqueIndex("see_dedup_hash_idx").on(table.dedupHash),
  })
);

export type SocialEngagementEvent = typeof socialEngagementEvents.$inferSelect;

// ─── Campaign Interest Signals (aggregated per campaign / actor) ───
export const campaignInterestSignals = mysqlTable(
  "campaign_interest_signals",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }).notNull(),
    socialProfileId: bigint("socialProfileId", { mode: "number", unsigned: true }),
    externalIdentifier: varchar("externalIdentifier", { length: 255 }).notNull(),
    signalType: mysqlEnum("signalType", ["engagement", "follow", "message", "click"])
      .notNull()
      .default("engagement"),
    strength: int("strength").default(0).notNull(),
    sourceEventIds: json("sourceEventIds"),
    contextSnippet: text("contextSnippet"),
    detectedAt: timestamp("detectedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    campaignIdentifierIdx: index("cis_campaign_identifier_idx").on(
      table.campaignId,
      table.externalIdentifier
    ),
    userCampaignIdx: index("cis_user_campaign_idx").on(table.userId, table.campaignId),
  })
);

export type CampaignInterestSignal = typeof campaignInterestSignals.$inferSelect;

// ─── Lead Scores (AI + rule-based scoring output) ───
export const leadScores = mysqlTable(
  "lead_scores",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }).notNull(),
    leadId: bigint("leadId", { mode: "number", unsigned: true }),
    socialProfileId: bigint("socialProfileId", { mode: "number", unsigned: true }),
    externalIdentifier: varchar("externalIdentifier", { length: 255 }).notNull(),
    platform: varchar("platform", { length: 50 }).notNull(),
    handle: varchar("handle", { length: 255 }),
    displayName: varchar("displayName", { length: 255 }),
    score: int("score").default(0).notNull(),
    confidence: mysqlEnum("confidence", ["low", "medium", "high"])
      .default("medium")
      .notNull(),
    signalsSummary: json("signalsSummary"),
    explanation: text("explanation"),
    recommendedAction: mysqlEnum("recommendedAction", ["reach_out", "nurture", "ignore"])
      .default("nurture")
      .notNull(),
    scoredAt: timestamp("scoredAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    campaignScoreIdx: index("ls_campaign_score_idx").on(table.campaignId, table.score),
    userCampaignIdx: index("ls_user_campaign_idx").on(table.userId, table.campaignId),
    externalIdx: index("ls_external_idx").on(
      table.userId,
      table.campaignId,
      table.externalIdentifier
    ),
  })
);

export type LeadScore = typeof leadScores.$inferSelect;

// ─── Outreach Recommendations (AI next-best-action) ───
export const outreachRecommendations = mysqlTable(
  "outreach_recommendations",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }).notNull(),
    leadScoreId: bigint("leadScoreId", { mode: "number", unsigned: true }).notNull(),
    leadId: bigint("leadId", { mode: "number", unsigned: true }),
    channel: mysqlEnum("channel", [
      "email",
      "instagram_dm",
      "facebook_dm",
      "linkedin_dm",
      "whatsapp",
      "sms",
    ]).notNull(),
    angle: text("angle"),
    personalisedHook: text("personalisedHook"),
    cta: text("cta"),
    expectedOutcome: text("expectedOutcome"),
    priority: int("priority").default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    acceptedAt: timestamp("acceptedAt"),
    dismissedAt: timestamp("dismissedAt"),
  },
  (table) => ({
    leadScoreIdx: index("or_lead_score_idx").on(table.leadScoreId),
    userCampaignIdx: index("or_user_campaign_idx").on(table.userId, table.campaignId),
  })
);

export type OutreachRecommendation = typeof outreachRecommendations.$inferSelect;

// ─── Conversation Threads ───
export const conversationThreads = mysqlTable("conversation_threads", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
  leadId: bigint("leadId", { mode: "number", unsigned: true }),
  platform: varchar("platform", { length: 50 }).notNull(),
  externalThreadId: varchar("externalThreadId", { length: 255 }).notNull(),
  status: mysqlEnum("status", ["open", "ai_handled", "escalated", "closed"])
    .default("open")
    .notNull(),
  aiHandled: boolean("aiHandled").default(false).notNull(),
  escalationRequired: boolean("escalationRequired").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ConversationThread = typeof conversationThreads.$inferSelect;

// ─── Conversation Messages ───
export const conversationMessages = mysqlTable("conversation_messages", {
  id: serial("id").primaryKey(),
  threadId: bigint("threadId", { mode: "number", unsigned: true }).notNull(),
  senderType: mysqlEnum("senderType", ["lead", "ai", "user"]).notNull(),
  messageText: text("messageText").notNull(),
  aiGenerated: boolean("aiGenerated").default(false).notNull(),
  sentiment: mysqlEnum("sentiment", [
    "positive",
    "neutral",
    "negative",
    "urgent",
  ]),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ConversationMessage = typeof conversationMessages.$inferSelect;

// ─── Optimisation Logs ───
export const optimisationLogs = mysqlTable("optimisation_logs", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  campaignId: bigint("campaignId", { mode: "number", unsigned: true }).notNull(),
  summary: text("summary").notNull(),
  recommendedActions: json("recommendedActions"),
  appliedActions: json("appliedActions"),
  performanceSnapshot: json("performanceSnapshot"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type OptimisationLog = typeof optimisationLogs.$inferSelect;

// ─── AI Usage ───
export const aiUsage = mysqlTable("ai_usage", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
  agentType: mysqlEnum("agentType", [
    "strategy",
    "creative",
    "audience",
    "distribution",
    "engagement",
    "sales",
    "optimisation",
    "safety_check",
    "image_generation",
    "video_generation",
  ]).notNull(),
  model: varchar("model", { length: 50 }).notNull(),
  promptTokens: int("promptTokens").default(0).notNull(),
  completionTokens: int("completionTokens").default(0).notNull(),
  totalTokens: int("totalTokens").default(0).notNull(),
  actualCostUsd: int("actualCostUsd").default(0).notNull(), // stored in cents * 10000 (e.g. 0.01 USD = 10000)
  estimatedCostUsd: int("estimatedCostUsd").default(0).notNull(), // same precision
  creditsDeducted: int("creditsDeducted").default(0).notNull(),
  metadata: json("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type AiUsage = typeof aiUsage.$inferSelect;

// ─── Credit Wallets ───
export const creditWallets = mysqlTable("credit_wallets", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull().unique(),
  balance: int("balance").default(0).notNull(),
  lifetimeEarned: int("lifetimeEarned").default(0).notNull(),
  lifetimeSpent: int("lifetimeSpent").default(0).notNull(),
  monthlyAllocation: int("monthlyAllocation").default(0).notNull(),
  monthlyResetAt: timestamp("monthlyResetAt"),
  spendLimit: int("spendLimit"), // null = unlimited
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type CreditWallet = typeof creditWallets.$inferSelect;

// ─── Credit Transactions ───
export const creditTransactions = mysqlTable("credit_transactions", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  walletId: bigint("walletId", { mode: "number", unsigned: true }).notNull(),
  type: mysqlEnum("type", [
    "subscription_allocation",
    "purchase",
    "agent_deduction",
    "publishing_deduction",
    "image_generation",
    "video_generation",
    "refund",
    "admin_adjustment",
    "rollover",
  ]).notNull(),
  amount: int("amount").notNull(), // positive = credit added, negative = credit spent
  balanceAfter: int("balanceAfter").notNull(),
  description: text("description"),
  metadata: json("metadata"),
  idempotencyKey: varchar("idempotencyKey", { length: 255 }).unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type CreditTransaction = typeof creditTransactions.$inferSelect;

// ─── Video Render Jobs ───
export const videoRenderJobs = mysqlTable("video_render_jobs", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  campaignId: bigint("campaignId", { mode: "number", unsigned: true }).notNull(),
  contentPostId: bigint("contentPostId", { mode: "number", unsigned: true }),
  provider: varchar("provider", { length: 50 }).default("placeholder").notNull(),
  renderJobId: varchar("renderJobId", { length: 255 }),
  providerLinkId: varchar("providerLinkId", { length: 255 }),
  creditsCharged: int("creditsCharged").default(0),
  providerCostUsd: int("providerCostUsd").default(0),
  renderStatus: mysqlEnum("renderStatus", [
    "queued",
    "rendering",
    "completed",
    "failed",
    "cancelled",
  ])
    .default("queued")
    .notNull(),
  videoUrl: text("videoUrl"),
  thumbnailUrl: text("thumbnailUrl"),
  errorMessage: text("errorMessage"),
  creditCost: int("creditCost").default(0).notNull(),
  requestedAt: timestamp("requestedAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
  createdBy: bigint("createdBy", { mode: "number", unsigned: true }).notNull(),
  metadata: json("metadata"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type VideoRenderJob = typeof videoRenderJobs.$inferSelect;

// ─── Two-Factor Challenges ───
export const twoFactorChallenges = mysqlTable("two_factor_challenges", {
  id: serial("id").primaryKey(),
  userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
  challengeToken: varchar("challengeToken", { length: 255 }).notNull().unique(),
  otpHash: varchar("otpHash", { length: 255 }).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  attempts: int("attempts").default(0).notNull(),
  maxAttempts: int("maxAttempts").default(5).notNull(),
  consumedAt: timestamp("consumedAt"),
  purpose: varchar("purpose", { length: 50 }).default("login_2fa").notNull(),
  sentToEmail: varchar("sentToEmail", { length: 320 }).notNull(),
  ipAddress: varchar("ipAddress", { length: 45 }),
  userAgent: text("userAgent"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type TwoFactorChallenge = typeof twoFactorChallenges.$inferSelect;

// ─── System Alerts ───
export const systemAlerts = mysqlTable("system_alerts", {
  id: serial("id").primaryKey(),
  severity: mysqlEnum("severity", ["critical", "warning", "info"]).notNull(),
  category: mysqlEnum("category", [
    "publishing",
    "queue",
    "worker",
    "redis",
    "openai",
    "billing",
    "system",
  ]).notNull(),
  message: text("message").notNull(),
  details: json("details"),
  resolvedAt: timestamp("resolvedAt"),
  acknowledgedAt: timestamp("acknowledgedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type SystemAlert = typeof systemAlerts.$inferSelect;

// ─── System Settings ───
export const systemSettings = mysqlTable("system_settings", {
  settingKey: varchar("settingKey", { length: 128 }).primaryKey(),
  settingValue: text("settingValue").notNull(),
  description: text("description"),
  updatedAt: timestamp("updatedAt")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export type SystemSetting = typeof systemSettings.$inferSelect;
