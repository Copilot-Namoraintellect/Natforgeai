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

// ─── Business DNA Snapshots (BI authority) ───
// Immutable canonical BusinessDNASnapshot rows. Once inserted, the governed
// snapshot JSON is the durable historical authority; it is never rebuilt from
// the mutable businesses row.
export const businessDnaSnapshots = mysqlTable(
  "business_dna_snapshots",
  {
    id: serial("id").primaryKey(),
    snapshotId: varchar("snapshotId", { length: 128 }).notNull().unique(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    version: int("version").notNull(),
    evidenceHashSha256: varchar("evidenceHashSha256", { length: 64 }).notNull(),
    businessName: varchar("businessName", { length: 255 }).notNull(),
    industry: varchar("industry", { length: 100 }).notNull(),
    primaryOffering: text("primaryOffering").notNull(),
    // Full canonical BusinessDNASnapshot payload (governed structured fields).
    snapshot: json("snapshot").notNull(),
    // Explicit caller-provided capture authority (never generated here).
    capturedAt: timestamp("capturedAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    businessIdIdx: index("bdna_business_id_idx").on(table.businessId),
    userIdIdx: index("bdna_user_id_idx").on(table.userId),
    evidenceHashIdx: index("bdna_evidence_hash_idx").on(table.evidenceHashSha256),
    capturedAtIdx: index("bdna_captured_at_idx").on(table.capturedAt),
  })
);

export type BusinessDnaSnapshotRow = typeof businessDnaSnapshots.$inferSelect;
export type InsertBusinessDnaSnapshotRow = typeof businessDnaSnapshots.$inferInsert;

export const strategySnapshots = mysqlTable(
  "strategy_snapshots",
  {
    id: serial("id").primaryKey(),
    snapshotId: varchar("snapshotId", { length: 128 }).notNull().unique(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }).notNull(),
    strategyRunId: bigint("strategyRunId", { mode: "number", unsigned: true }).notNull().unique(),
    businessDnaSnapshotId: varchar("businessDnaSnapshotId", { length: 128 }).notNull(),
    version: int("version").notNull(),
    creativeBriefFingerprint: varchar("creativeBriefFingerprint", { length: 128 }).notNull(),
    strategyHashSha256: varchar("strategyHashSha256", { length: 64 }).notNull(),
    snapshot: json("snapshot").notNull(),
    capturedAt: timestamp("capturedAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    campaignIdIdx: index("strategy_snapshot_campaign_id_idx").on(table.campaignId),
    businessIdIdx: index("strategy_snapshot_business_id_idx").on(table.businessId),
    businessDnaSnapshotIdIdx: index("strategy_snapshot_bdna_snapshot_id_idx").on(
      table.businessDnaSnapshotId
    ),
    strategyHashIdx: index("strategy_snapshot_hash_idx").on(table.strategyHashSha256),
    campaignVersionUniqueIdx: uniqueIndex("strategy_snapshot_campaign_version_uidx").on(
      table.campaignId,
      table.version
    ),
  })
);

export type StrategySnapshotRow = typeof strategySnapshots.$inferSelect;
export type InsertStrategySnapshotRow = typeof strategySnapshots.$inferInsert;

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
    "publication_pending",
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
export const analytics = mysqlTable(
  "analytics",
  {
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
    /**
     * Deterministic identity of a provider-observed metric row
     * (`obs:` + SHA-256 over campaign/platform/externalPostId/metricType/date).
     * NULL for manually recorded rows. Unique so observation retries and
     * replays upsert instead of duplicating durable metrics.
     */
    observationId: varchar("observationId", { length: 191 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    observationIdIdx: uniqueIndex("analytics_observation_id_idx").on(table.observationId),
  })
);

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
    "interpretation",
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
    // B2B-2A: durable result linkage + replay snapshot. All nullable so legacy
    // rows remain valid and never appear replayable. No foreign key, matching
    // repository convention; ownership is enforced in query predicates.
    generatedImageId: bigint("generatedImageId", { mode: "number", unsigned: true }),
    resultImageUrl: text("resultImageUrl"),
    resultProvider: varchar("resultProvider", { length: 50 }),
    resultProviderJobId: varchar("resultProviderJobId", { length: 255 }),
    resultCreditsCharged: int("resultCreditsCharged"),
    resultQualityTier: varchar("resultQualityTier", { length: 50 }),
    resultQualityLabel: text("resultQualityLabel"),
    resultIsDraft: boolean("resultIsDraft"),
    completedAt: timestamp("completedAt"),
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
    generatedImageIdUnique: uniqueIndex("irc_generated_image_idx").on(table.generatedImageId),
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
    // WBS-R5-E: governed marketing-action approvals/escalations bound to an
    // exact policy decision + policy version + context fingerprint.
    "marketing_action",
    // WBS-R6-D: governed sales-handoff approvals bound to the exact handoff
    // identity + qualification fingerprint + policy version + content snapshot.
    "sales_handoff",
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
  /**
   * Durable replay authority for idempotent approval creation. For
   * sensitive_reply approvals this is the WBS14A hashed event key (never the
   * raw provider event key). Nullable; unique when present.
   */
  idempotencyKey: varchar("idempotencyKey", { length: 255 }),
  /**
   * Structured, domain-neutral lineage/metadata for the approval (e.g.
   * sensitive_reply provenance: contract version, thread, sentiment).
   */
  context: json("context"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => ({
  idempotencyKeyUnique: uniqueIndex("approval_requests_idempotency_key_idx").on(
    table.idempotencyKey
  ),
}));

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
  // Durable governance storage (WBS13.4): governed rows persist the immutable
  // PublishPackage envelope here (see api/lib/publish/publish-package-queue-store.ts).
  // Legacy rows keep metadata null. Updates on this row must preserve the
  // publishPackage keys — they are governance state, not scratch metadata.
  metadata: json("metadata"),
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
    /**
     * One interest signal per campaign + actor: the aggregation upsert in
     * audience/ingest relies on this unique key so repeated ingest cycles
     * refresh the signal instead of accumulating duplicate actor rows.
     */
    campaignActorUniqueIdx: uniqueIndex("cis_campaign_actor_uidx").on(
      table.campaignId,
      table.externalIdentifier
    ),
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
  dedupKey: varchar("dedupKey", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
},
(table) => ({
  // Idempotency guard for inbound processing retries: one durable record per
  // (thread, event dedup key). MySQL unique indexes allow multiple NULLs, so
  // manually composed messages (no dedupKey) are unaffected.
  threadDedupIdx: uniqueIndex("conversation_messages_thread_dedup_idx").on(
    table.threadId,
    table.dedupKey
  ),
})
);

export type ConversationMessage = typeof conversationMessages.$inferSelect;

// ─── Engagement Webhook Events (inbound ingestion audit + idempotency) ───
//
// Processing lifecycle (crash-recovery hardened):
//   received → processing → completed | escalated
//                    └────→ failed (retryable on redelivery / explicit recovery)
// Legacy rows may still carry: accepted (processed, terminal), error
// (terminal under the pre-recovery semantics), rejected, duplicate.
export const engagementWebhookEvents = mysqlTable(
  "engagement_webhook_events",
  {
    id: serial("id").primaryKey(),
    provider: varchar("provider", { length: 50 }).notNull(),
    externalEventId: varchar("externalEventId", { length: 255 }).notNull(),
    eventType: varchar("eventType", { length: 50 }).notNull(),
    status: mysqlEnum("status", [
      "accepted",
      "duplicate",
      "rejected",
      "escalated",
      "error",
      "received",
      "processing",
      "completed",
      "failed",
    ])
      .default("received")
      .notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }),
    integrationId: bigint("integrationId", { mode: "number", unsigned: true }),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
    threadId: bigint("threadId", { mode: "number", unsigned: true }),
    actorId: varchar("actorId", { length: 255 }),
    payloadSummary: json("payloadSummary"),
    error: text("error"),
    // Processing lease: only the holder of a healthy (unexpired) claim may
    // invoke Engagement processing for this event.
    claimedAt: timestamp("claimedAt"),
    claimExpiresAt: timestamp("claimExpiresAt"),
    completedAt: timestamp("completedAt"),
    retryCount: int("retryCount").default(0).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    lastSeenAt: timestamp("lastSeenAt"),
  },
  (table) => ({
    providerEventIdx: uniqueIndex(
      "engagement_webhook_events_provider_event_idx"
    ).on(table.provider, table.externalEventId),
  })
);

export type EngagementWebhookEvent = typeof engagementWebhookEvents.$inferSelect;
export type InsertEngagementWebhookEvent =
  typeof engagementWebhookEvents.$inferInsert;

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

// ─── Learning Records ───
// Phase 1 Learning engine output. Additive to optimisation_logs: stores a
// structured, evidence-backed learning record with full lineage
// (source observations, evaluation version, window, provenance) and a
// unique idempotency key so the same evaluation window/version executes once.
// Phase 1 never auto-applies recommendations; governance JSON pins autoApply=false.
export const learningRecords = mysqlTable(
  "learning_records",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }).notNull(),
    evaluationVersion: varchar("evaluationVersion", { length: 64 }).notNull(),
    windowStart: date("windowStart").notNull(),
    windowEnd: date("windowEnd").notNull(),
    idempotencyKey: varchar("idempotencyKey", { length: 255 }).notNull(),
    objectiveSummary: text("objectiveSummary").notNull(),
    kpiAssessment: json("kpiAssessment").notNull(),
    performanceFacts: json("performanceFacts").notNull(),
    positivePatterns: json("positivePatterns").notNull(),
    negativePatterns: json("negativePatterns").notNull(),
    confidence: mysqlEnum("confidence", ["low", "medium", "high"]).notNull(),
    evidence: json("evidence").notNull(),
    recommendedAdjustments: json("recommendedAdjustments").notNull(),
    governance: json("governance").notNull(),
    sourceObservations: json("sourceObservations").notNull(),
    provenance: json("provenance").notNull(),
    status: mysqlEnum("status", ["recorded"]).default("recorded").notNull(),
    evaluatedAt: timestamp("evaluatedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    idempotencyKeyIdx: uniqueIndex("lr_idempotency_key_idx").on(table.idempotencyKey),
    campaignIdx: index("lr_campaign_idx").on(table.campaignId),
    userCampaignIdx: index("lr_user_campaign_idx").on(table.userId, table.campaignId),
  })
);

export type LearningRecord = typeof learningRecords.$inferSelect;

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
    "interpretation",
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

// ─── Credit Reservations ───
// Durable persistence for the governed reservation state machine defined in
// api/lib/billing/credit-reservation.ts (WBS 4F / Wave 2 / WBS8A/B).
// reserved -> settled | released; both terminal, mutually exclusive.
export const creditReservations = mysqlTable(
  "credit_reservations",
  {
    id: serial("id").primaryKey(),
    // sha256 hex of the canonical identity payload; authoritative unique guard.
    reservationId: varchar("reservationId", { length: 64 }).notNull().unique(),
    // Reservation claim key; an external idempotency key wins when supplied.
    idempotencyKey: varchar("idempotencyKey", { length: 255 }).notNull().unique(),
    reservationReference: varchar("reservationReference", { length: 255 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
    workflowOperationId: varchar("workflowOperationId", { length: 64 }),
    workflowAttemptId: varchar("workflowAttemptId", { length: 64 }),
    stageId: varchar("stageId", { length: 128 }),
    artifactId: varchar("artifactId", { length: 128 }),
    packageId: varchar("packageId", { length: 128 }),
    agentType: varchar("agentType", { length: 64 }),
    model: varchar("model", { length: 128 }),
    provider: varchar("provider", { length: 64 }),
    reservedAmount: int("reservedAmount").notNull(),
    settledAmount: int("settledAmount"),
    state: mysqlEnum("state", ["reserved", "settled", "released"])
      .default("reserved")
      .notNull(),
    reason: text("reason").notNull(),
    settleKey: varchar("settleKey", { length: 255 }),
    releaseKey: varchar("releaseKey", { length: 255 }),
    releaseReason: text("releaseReason"),
    reservedAt: timestamp("reservedAt").defaultNow().notNull(),
    settledAt: timestamp("settledAt"),
    releasedAt: timestamp("releasedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    userCampaignIdx: index("cr_user_campaign_idx").on(table.userId, table.campaignId),
    // Durable authority for the WBS8A rule that a user's natural reservation
    // reference binds to exactly one reservation identity; the store rereads
    // by this pair after a duplicate-key error instead of trusting any
    // select-before-insert observation.
    userReferenceUnique: uniqueIndex("cr_user_reference_idx").on(
      table.userId,
      table.reservationReference
    ),
    workflowIdx: index("cr_workflow_idx").on(
      table.workflowOperationId,
      table.workflowAttemptId
    ),
    stageIdx: index("cr_stage_idx").on(table.stageId),
    stateIdx: index("cr_state_idx").on(table.state),
  })
);

export type CreditReservationRecord = typeof creditReservations.$inferSelect;
export type InsertCreditReservationRecord = typeof creditReservations.$inferInsert;

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

// ─── Queue Terminal Failures ───
// Durable dead-letter evidence for BullMQ jobs that reached a terminal state
// (UnrecoverableError or exhausted retry attempts). Queue-level evidence only:
// publishing_queue, agent_runs and creative claim records keep their own
// recovery responsibilities.
export const queueTerminalFailures = mysqlTable(
  "queue_terminal_failures",
  {
    id: serial("id").primaryKey(),
    failureKey: varchar("failureKey", { length: 255 }).notNull(),
    queueName: mysqlEnum("queueName", ["publishing", "content_generation"]).notNull(),
    bullmqJobId: varchar("bullmqJobId", { length: 191 }).notNull(),
    terminalReason: mysqlEnum("terminalReason", ["unrecoverable", "retries_exhausted"])
      .notNull(),
    attemptsMade: int("attemptsMade").notNull(),
    attemptsConfigured: int("attemptsConfigured").notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
    publishingQueueItemId: bigint("publishingQueueItemId", {
      mode: "number",
      unsigned: true,
    }),
    agentRunId: bigint("agentRunId", { mode: "number", unsigned: true }),
    errorName: varchar("errorName", { length: 128 }),
    errorCode: varchar("errorCode", { length: 64 }),
    errorSummary: text("errorSummary"),
    failedAt: timestamp("failedAt").notNull(),
    status: mysqlEnum("status", ["open"]).default("open").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    failureKeyUnique: uniqueIndex("qtf_failure_key_idx").on(table.failureKey),
    queueJobIdx: index("qtf_queue_job_idx").on(table.queueName, table.bullmqJobId),
    userIdIdx: index("qtf_user_id_idx").on(table.userId),
    campaignIdIdx: index("qtf_campaign_id_idx").on(table.campaignId),
    statusIdx: index("qtf_status_idx").on(table.status),
    failedAtIdx: index("qtf_failed_at_idx").on(table.failedAt),
  })
);

export type QueueTerminalFailure = typeof queueTerminalFailures.$inferSelect;

// ─── Queue Replay Requests ───
// Durable operator replay-request authority (WBS9D1). Records replay intent
// only — no queue mutation happens in this slice; the queue-specific replay
// executor arrives in WBS9D2. Immutable terminal-failure evidence above is
// never updated by replay activity.
export const queueReplayRequests = mysqlTable(
  "queue_replay_requests",
  {
    id: serial("id").primaryKey(),
    replayKey: varchar("replayKey", { length: 255 }).notNull(),
    terminalFailureId: bigint("terminalFailureId", { mode: "number", unsigned: true }).notNull(),
    failureKey: varchar("failureKey", { length: 255 }).notNull(),
    queueName: mysqlEnum("queueName", ["publishing", "content_generation"]).notNull(),
    originalBullmqJobId: varchar("originalBullmqJobId", { length: 191 }).notNull(),
    requestedByUserId: bigint("requestedByUserId", { mode: "number", unsigned: true }).notNull(),
    reason: text("reason"),
    status: mysqlEnum("status", ["requested", "claimed", "enqueued", "resolved", "failed"])
      .default("requested")
      .notNull(),
    replayMode: mysqlEnum("replayMode", ["publishing_requeue", "content_domain_recovery"]).notNull(),
    replayBullmqJobId: varchar("replayBullmqJobId", { length: 191 }),
    // Durable content-recovery binding (WBS9D2B): correlates THIS replay
    // request with the exact re-armed creative-generation claim. Only a
    // SHA-256 fingerprint of the ownerToken is stored — never the raw token.
    contentRecoveryClaimId: bigint("contentRecoveryClaimId", {
      mode: "number",
      unsigned: true,
    }),
    contentRecoveryOwnerTokenHash: varchar("contentRecoveryOwnerTokenHash", { length: 64 }),
    contentRecoveryPreparedAt: timestamp("contentRecoveryPreparedAt"),
    claimedAt: timestamp("claimedAt"),
    enqueuedAt: timestamp("enqueuedAt"),
    resolvedAt: timestamp("resolvedAt"),
    failedAt: timestamp("failedAt"),
    lastErrorSummary: text("lastErrorSummary"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    replayKeyUnique: uniqueIndex("qrr_replay_key_idx").on(table.replayKey),
    terminalFailureIdx: index("qrr_terminal_failure_idx").on(table.terminalFailureId),
    failureKeyIdx: index("qrr_failure_key_idx").on(table.failureKey),
    queueNameIdx: index("qrr_queue_name_idx").on(table.queueName),
    statusIdx: index("qrr_status_idx").on(table.status),
    requestedByIdx: index("qrr_requested_by_idx").on(table.requestedByUserId),
  })
);

export type QueueReplayRequest = typeof queueReplayRequests.$inferSelect;

// ─── Queue Replay Active Claims ───
// Durable mutual-exclusion guard for replay claims. terminalFailureId ALONE
// is the primary/unique authority: at most one replay request per terminal
// failure may be actively claimed/enqueuing at a time, enforced by the
// database unique constraint (not by pre-reads). Released when a request
// resolves or fails.
export const queueReplayActiveClaims = mysqlTable("queue_replay_active_claims", {
  terminalFailureId: bigint("terminalFailureId", { mode: "number", unsigned: true }).primaryKey(),
  replayRequestId: bigint("replayRequestId", { mode: "number", unsigned: true }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type QueueReplayActiveClaim = typeof queueReplayActiveClaims.$inferSelect;

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

// ─── Audit Events ───
// Durable WBS7B store for canonical WBS7A audit envelopes. Correlation
// identifiers are searchable first-class columns so material decisions can be
// reconstructed by lineage. No secrets or raw request bodies are stored; the
// JSON metadata column only ever holds WBS7A-sanitized structured metadata.
export const auditEvents = mysqlTable(
  "audit_events",
  {
    id: serial("id").primaryKey(),
    // SHA-256 of the canonical WBS7A envelope; unique so exact replay is
    // idempotent at the database level.
    eventFingerprint: varchar("eventFingerprint", { length: 64 }).notNull(),
    schemaVersion: int("schemaVersion").notNull(),
    eventType: varchar("eventType", { length: 64 }).notNull(),
    // ISO 8601 from the event itself, stored verbatim as text so no timezone
    // conversion can alter it; createdAt (below) records persistence time.
    occurredAt: varchar("occurredAt", { length: 32 }).notNull(),
    userId: int("userId").notNull(),
    campaignId: int("campaignId"),
    businessId: int("businessId"),
    workflowOperationId: varchar("workflowOperationId", { length: 64 }),
    workflowAttemptId: varchar("workflowAttemptId", { length: 64 }),
    approvalRequestId: int("approvalRequestId"),
    // Subject identifiers: the envelope allows string or numeric identifiers;
    // they are normalized to text for a single searchable column.
    artifactId: varchar("artifactId", { length: 128 }),
    packageId: varchar("packageId", { length: 128 }),
    contentId: varchar("contentId", { length: 128 }),
    source: varchar("source", { length: 32 }).notNull(),
    outcome: varchar("outcome", { length: 32 }).notNull(),
    metadata: json("metadata").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    eventFingerprintUnique: uniqueIndex("ae_fingerprint_idx").on(table.eventFingerprint),
    userIdx: index("ae_user_idx").on(table.userId),
    campaignIdx: index("ae_campaign_idx").on(table.campaignId),
    workflowOperationIdx: index("ae_workflow_operation_idx").on(table.workflowOperationId),
    approvalRequestIdx: index("ae_approval_request_idx").on(table.approvalRequestId),
    eventTypeIdx: index("ae_event_type_idx").on(table.eventType),
    occurredAtIdx: index("ae_occurred_at_idx").on(table.occurredAt),
  })
);

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type InsertAuditEventRow = typeof auditEvents.$inferInsert;

// ─── Social Signals (WBS-R5-A canonical listening evidence) ───
//
// One immutable, replay-safe canonical row per logical provider event. This is
// the governed evidence layer consumed by R5-B/R5-C/R5-D; see
// docs/contracts/social-signal-contract.md. Ingestion/normalization only — no
// sentiment, scoring, or business-action interpretation happens here.
//
// Exact-once: the unique natural key (provider, providerAccountId,
// externalEventId) makes one logical provider event durable exactly once at
// the database level; signalKey is the deterministic server-derived identity
// derived from that same triple (see api/lib/social-listening/signal-contract.ts).
// Rows are immutable after acceptance — there is no update path.
export const socialSignals = mysqlTable(
  "social_signals",
  {
    id: serial("id").primaryKey(),
    // Deterministic server-derived identity:
    //   "sigv1:" + sha256(provider | providerAccountId | externalEventId)
    // Minted only by the server; clients can never supply or influence it.
    signalKey: varchar("signalKey", { length: 64 }).notNull(),
    // Authoritative tenant/business context, bound from social_integrations
    // and (for direct attribution) publication receipts — never from the client.
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    // Provider family + surface (e.g. meta/facebook, meta/instagram,
    // linkedin/linkedin). Unknown providers/platforms fail closed before here.
    provider: varchar("provider", { length: 32 }).notNull(),
    platform: varchar("platform", { length: 32 }).notNull(),
    // The authoritative binding the signal was accepted under.
    integrationId: bigint("integrationId", { mode: "number", unsigned: true }).notNull(),
    // Provider-side account (page id / account id) the event arrived on.
    providerAccountId: varchar("providerAccountId", { length: 255 }).notNull(),
    // Provider event identity (message mid, comment id, poll event id...).
    externalEventId: varchar("externalEventId", { length: 255 }).notNull(),
    // Provider object the event refers to (post id), and its parent
    // (thread/parent comment) where the provider supplies one.
    externalObjectId: varchar("externalObjectId", { length: 255 }),
    parentExternalObjectId: varchar("parentExternalObjectId", { length: 255 }),
    signalType: mysqlEnum("signalType", [
      "comment",
      "reply",
      "mention",
      "reaction",
      "direct_message",
      "repost",
      "follow",
      "unfollow",
      "campaign_response",
      "inbound_message",
      "unknown",
    ]).notNull(),
    // Provider event time (safe-converted) and server acceptance time.
    occurredAt: timestamp("occurredAt").notNull(),
    observedAt: timestamp("observedAt").notNull(),
    // Authoritative lineage where evidence permits (never fabricated):
    // DIRECT attribution fills these from the publication receipt /
    // publishing_queue success row the provider object resolves to.
    sourceCampaignId: bigint("sourceCampaignId", { mode: "number", unsigned: true }),
    sourcePublicationId: varchar("sourcePublicationId", { length: 255 }),
    sourcePublicationReceiptId: varchar("sourcePublicationReceiptId", { length: 128 }),
    // Opaque provider actor reference + bounded display name (PII minimized;
    // no emails/phones are retained from provider payloads).
    actorReference: varchar("actorReference", { length: 255 }),
    actorDisplayName: varchar("actorDisplayName", { length: 255 }),
    // Provider perma-reference (comment URL etc.) and bounded sanitized
    // textual evidence (see contract for the justification and bound).
    contentReference: varchar("contentReference", { length: 255 }),
    contentText: text("contentText"),
    // sha256 over the canonical provider evidence fragment accepted at
    // ingestion; proves the durable evidence is byte-stable under replay.
    providerEvidenceHash: varchar("providerEvidenceHash", { length: 64 }).notNull(),
    // direct = provider object maps to a known NatForgeAI publication receipt;
    // business = provider account maps to a business only;
    // unattributed = connected account but no publication linkage.
    attributionType: mysqlEnum("attributionType", ["direct", "business", "unattributed"])
      .notNull()
      .default("unattributed"),
    // Readiness of the evidence row. R5-A accepts exactly once; downstream
    // streams derive their own state and must not mutate this row.
    status: mysqlEnum("status", ["accepted"]).notNull().default("accepted"),
    ingestionVersion: int("ingestionVersion").notNull().default(1),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    // Exact-once natural identity: one logical provider event, one row,
    // enforced at the database level (concurrent inserts race to one row).
    naturalKeyUnique: uniqueIndex("ss_natural_key_uidx").on(
      table.provider,
      table.providerAccountId,
      table.externalEventId
    ),
    signalKeyUnique: uniqueIndex("ss_signal_key_uidx").on(table.signalKey),
    userObservedIdx: index("ss_user_observed_idx").on(table.userId, table.observedAt),
    integrationOccurredIdx: index("ss_integration_occurred_idx").on(
      table.integrationId,
      table.occurredAt
    ),
    campaignIdx: index("ss_campaign_idx").on(table.sourceCampaignId),
  })
);

export type SocialSignal = typeof socialSignals.$inferSelect;
export type InsertSocialSignal = typeof socialSignals.$inferInsert;

// ─── Social Listening States (per-binding checkpoint + operational status) ───
//
// Durable, restart-safe listening progress and operational visibility for one
// social_integrations binding (WBS-R5-A A5/A6). Operational counters only —
// canonical evidence lives exclusively in social_signals.
export const socialListeningStates = mysqlTable(
  "social_listening_states",
  {
    id: serial("id").primaryKey(),
    // One listening state per authoritative binding.
    integrationId: bigint("integrationId", { mode: "number", unsigned: true }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    provider: varchar("provider", { length: 32 }).notNull(),
    platform: varchar("platform", { length: 32 }).notNull(),
    providerAccountId: varchar("providerAccountId", { length: 255 }).notNull(),
    // How this binding is listened to; unsupported bindings fail closed.
    mechanism: mysqlEnum("mechanism", ["webhook", "polling", "unsupported"]).notNull(),
    status: mysqlEnum("status", ["active", "blocked", "unsupported", "stale"])
      .notNull()
      .default("active"),
    // Opaque provider cursor/checkpoint for polling; monotonic per provider.
    cursor: varchar("cursor", { length: 255 }),
    cursorUpdatedAt: timestamp("cursorUpdatedAt"),
    lastSuccessAt: timestamp("lastSuccessAt"),
    lastFailureAt: timestamp("lastFailureAt"),
    lastFailureClass: mysqlEnum("lastFailureClass", [
      "AUTO_RECOVER",
      "OPERATOR_ACTION",
      "FAIL_CLOSED",
    ]),
    lastFailureCode: varchar("lastFailureCode", { length: 64 }),
    lastFailureReason: varchar("lastFailureReason", { length: 255 }),
    acceptedCount: int("acceptedCount").notNull().default(0),
    duplicateCount: int("duplicateCount").notNull().default(0),
    rejectedCount: int("rejectedCount").notNull().default(0),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    integrationUnique: uniqueIndex("sls_integration_uidx").on(table.integrationId),
    userIdx: index("sls_user_idx").on(table.userId),
  })
);

export type SocialListeningState = typeof socialListeningStates.$inferSelect;
export type InsertSocialListeningState = typeof socialListeningStates.$inferInsert;
// ─── Social Interpretations (R5-B) ───
// Immutable intent & sentiment interpretation records (contract §4/§5).
// One row per logical interpretation: interpretationId is globally unique and
// (businessId, signalId, signalVersion, classifierVersion) pins exactly one
// accepted interpretation per signal version per classifier. The full
// canonical record is stored in `record`; identity columns exist so replay,
// tamper detection and owner-scoped reads never parse JSON.
export const socialInterpretations = mysqlTable(
  "social_interpretations",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    // Null = unattributed tenant-scoped interpretation (R5-A attribution
    // without a bound business); participates in the identity unique key as
    // SQL NULL, so distinct null-business signals never collide on it.
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    signalId: varchar("signalId", { length: 128 }).notNull(),
    signalVersion: int("signalVersion").notNull(),
    signalContentHash: varchar("signalContentHash", { length: 64 }).notNull(),
    classifierVersion: varchar("classifierVersion", { length: 64 }).notNull(),
    interpretationId: varchar("interpretationId", { length: 64 }).notNull(),
    modelOrRuleSource: mysqlEnum("modelOrRuleSource", ["RULE", "MODEL"]).notNull(),
    intent: varchar("intent", { length: 48 }).notNull(),
    sentiment: varchar("sentiment", { length: 24 }).notNull(),
    urgency: varchar("urgency", { length: 16 }).notNull(),
    relevance: varchar("relevance", { length: 24 }).notNull(),
    overallConfidence: varchar("overallConfidence", { length: 16 }).notNull(),
    recommendedHandling: varchar("recommendedHandling", { length: 48 }).notNull(),
    // Null on the non-billable RULE path (contract §13).
    billingIdentity: varchar("billingIdentity", { length: 80 }),
    record: json("record").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("social_interpretation_identity_uidx").on(t.interpretationId),
    uniqueIndex("social_interpretation_signal_classifier_uidx").on(
      t.businessId,
      t.signalId,
      t.signalVersion,
      t.classifierVersion
    ),
    index("social_interpretation_user_idx").on(t.userId),
    index("social_interpretation_signal_idx").on(t.signalId),
  ]
);

export type SocialInterpretationRow = typeof socialInterpretations.$inferSelect;
// ─── Business Policies (WBS-R5-E2) ───
// Versioned, typed policy authority per business. Rows are immutable once
// written: a config change inserts a new version and moves the active
// pointer. policyId is deterministic per business; policyVersion binds any
// policy decision to exactly one config hash.
export const businessPolicies = mysqlTable(
  "business_policies",
  {
    id: serial("id").primaryKey(),
    // Deterministic per business: pol_<sha256(businessId)[:16]>.
    policyId: varchar("policyId", { length: 32 }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    // Monotonic version number per policyId.
    version: int("version").notNull(),
    // v<version>-<configHash[:12]>; binds decisions to exact authority.
    policyVersion: varchar("policyVersion", { length: 64 }).notNull(),
    configHash: varchar("configHash", { length: 64 }).notNull(),
    // Validated BusinessPolicyConfig JSON (typed, no scripting).
    config: json("config").notNull(),
    isActive: boolean("isActive").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    policyVersionUnique: uniqueIndex("bp_policy_version_idx").on(table.policyId, table.version),
    businessIdx: index("bp_business_idx").on(table.businessId),
    activeIdx: index("bp_active_idx").on(table.policyId, table.isActive),
  })
);

export type BusinessPolicyRow = typeof businessPolicies.$inferSelect;
export type InsertBusinessPolicyRow = typeof businessPolicies.$inferInsert;

// ─── Policy Decisions (WBS-R5-E3/E7) ───
// Durable, immutable policy decisions. The deterministic policyDecisionId is
// the unique convergence anchor: one action request + one policy version ->
// one stable decision. Rows carry explainability (reasonCodes, thresholds,
// gate outcomes) and never store raw social content or secrets — only
// opaque references (signal/interpretation ids, fingerprints).
export const policyDecisions = mysqlTable(
  "policy_decisions",
  {
    id: serial("id").primaryKey(),
    // Deterministic: pdec_<sha256(...)[:40]>; unique convergence anchor.
    policyDecisionId: varchar("policyDecisionId", { length: 48 }).notNull(),
    policyId: varchar("policyId", { length: 32 }),
    policyVersion: varchar("policyVersion", { length: 64 }),
    businessId: bigint("businessId", { mode: "number", unsigned: true }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    actionRequestId: varchar("actionRequestId", { length: 128 }).notNull(),
    // "<actionRequestId>|<policyVersion ?? NO_POLICY>" — durable unique
    // scope so duplicate/concurrent evaluations converge to one row.
    decisionScopeKey: varchar("decisionScopeKey", { length: 200 }).notNull(),
    actionType: varchar("actionType", { length: 32 }).notNull(),
    platform: varchar("platform", { length: 32 }).notNull(),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
    sourceSignalId: varchar("sourceSignalId", { length: 128 }),
    sourceInterpretationId: varchar("sourceInterpretationId", { length: 128 }),
    intelligenceVersion: varchar("intelligenceVersion", { length: 128 }),
    decision: varchar("decision", { length: 24 }).notNull(),
    reasonCodes: json("reasonCodes").notNull(),
    riskClass: varchar("riskClass", { length: 16 }).notNull(),
    approvalRequired: boolean("approvalRequired").default(false).notNull(),
    costEligible: boolean("costEligible").default(false).notNull(),
    rateEligible: boolean("rateEligible").default(false).notNull(),
    providerEligible: boolean("providerEligible").default(false).notNull(),
    estimatedCostClass: varchar("estimatedCostClass", { length: 16 }).notNull(),
    estimatedCredits: int("estimatedCredits").default(0).notNull(),
    // One logical billable action -> one stable billing identity.
    billingIdentity: varchar("billingIdentity", { length: 48 }),
    // ApprovalBinding JSON for REQUIRE_APPROVAL decisions.
    approvalBinding: json("approvalBinding"),
    // Bounded snapshot of the thresholds used at evaluation time.
    thresholds: json("thresholds").notNull(),
    expiresAt: timestamp("expiresAt"),
    // ISO 8601 stored verbatim (like audit_events.occurredAt).
    evaluatedAt: varchar("evaluatedAt", { length: 32 }).notNull(),
    evaluationFingerprint: varchar("evaluationFingerprint", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    decisionIdUnique: uniqueIndex("pd_decision_id_idx").on(table.policyDecisionId),
    scopeUnique: uniqueIndex("pd_scope_idx").on(table.decisionScopeKey),
    businessIdx: index("pd_business_idx").on(table.businessId),
    userIdx: index("pd_user_idx").on(table.userId),
    campaignIdx: index("pd_campaign_idx").on(table.campaignId),
    decisionIdx: index("pd_decision_idx").on(table.decision),
    evaluatedAtIdx: index("pd_evaluated_idx").on(table.evaluatedAt),
  })
);

export type PolicyDecisionRow = typeof policyDecisions.$inferSelect;
export type InsertPolicyDecisionRow = typeof policyDecisions.$inferInsert;

// ─── Engagement Response Contents (WBS-R5-C2) ───
// Governed, immutable AI response content for an engagement action.
// responseContentId is deterministic (server-derived from actionRequestId +
// interpretationId + responseContextVersion) so retried generation converges
// to one durable row and one billing identity. Content is bounded at the
// contract layer (platform max); social source text is never stored here —
// only the generated response bound to its authoritative interpretation.
export const engagementResponseContents = mysqlTable(
  "engagement_response_contents",
  {
    id: serial("id").primaryKey(),
    // Deterministic: egen_<sha256(...)[:40]>; unique per logical generation.
    responseContentId: varchar("responseContentId", { length: 64 }).notNull(),
    // Content version within one responseContentId (approval binding pins it).
    version: int("version").notNull(),
    // sha256 of the accepted content — the context fingerprint ingredient.
    contentHash: varchar("contentHash", { length: 64 }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    actionRequestId: varchar("actionRequestId", { length: 128 }).notNull(),
    interpretationId: varchar("interpretationId", { length: 128 }).notNull(),
    platform: varchar("platform", { length: 32 }).notNull(),
    actionType: varchar("actionType", { length: 32 }).notNull(),
    // Bounded generated text (platform max enforced at contract layer).
    content: text("content").notNull(),
    // accepted = executable-bound content; internal_note = non-executable
    // deterministic note (escalation/no-action routing evidence).
    status: varchar("status", { length: 24 }).notNull(),
    model: varchar("model", { length: 64 }),
    promptTokens: int("promptTokens"),
    completionTokens: int("completionTokens"),
    // Caller-stable generation billing identity (engen:...); exact-once
    // through the governed agent-run reservation path.
    billingIdentity: varchar("billingIdentity", { length: 128 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    contentVersionUnique: uniqueIndex("erc_content_version_idx").on(
      table.responseContentId,
      table.version
    ),
    businessIdx: index("erc_business_idx").on(table.businessId),
    actionRequestIdx: index("erc_action_request_idx").on(table.actionRequestId),
  })
);

export type EngagementResponseContentRow = typeof engagementResponseContents.$inferSelect;
export type InsertEngagementResponseContentRow = typeof engagementResponseContents.$inferInsert;

// ─── Engagement Executions (WBS-R5-C6) ───
// Durable exact-once execution authority for governed engagement actions.
// One row per actionRequestId (unique). The conditional claim on
// (status, claim lease) is the single concurrency authority; the durable
// receipt is the terminal evidence. policy/approval staleness is re-checked
// at execution time through the R5-E gate — this table records outcomes,
// never authority.
export const engagementExecutions = mysqlTable(
  "engagement_executions",
  {
    id: serial("id").primaryKey(),
    // Deterministic: eex_<sha256(...)[:40]>.
    executionId: varchar("executionId", { length: 64 }).notNull(),
    // One execution per governed action request — the convergence anchor.
    actionRequestId: varchar("actionRequestId", { length: 128 }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    signalId: varchar("signalId", { length: 128 }).notNull(),
    signalVersion: int("signalVersion").notNull(),
    interpretationId: varchar("interpretationId", { length: 128 }).notNull(),
    policyDecisionId: varchar("policyDecisionId", { length: 48 }).notNull(),
    approvalRequestId: int("approvalRequestId"),
    responseContentId: varchar("responseContentId", { length: 64 }).notNull(),
    responseContentVersion: int("responseContentVersion").notNull(),
    provider: varchar("provider", { length: 16 }).notNull(),
    platform: varchar("platform", { length: 32 }).notNull(),
    actionType: varchar("actionType", { length: 32 }).notNull(),
    // social_integrations row id (opaque binding identity — never tokens).
    integrationId: bigint("integrationId", { mode: "number", unsigned: true }),
    // External object/thread id being replied to.
    externalTarget: varchar("externalTarget", { length: 255 }).notNull(),
    // pending_claim | executing | pending_retry | succeeded | failed_retryable |
    // failed_terminal | ambiguous | blocked | never_execute | internal_only
    status: varchar("status", { length: 24 }).notNull(),
    attempt: int("attempt").default(0).notNull(),
    maxRetries: int("maxRetries").default(3).notNull(),
    // Stable provider operation identity (eop_:...) — unique so a replayed
    // logical operation can never produce two provider effects.
    providerOperationIdentity: varchar("providerOperationIdentity", { length: 64 }),
    claimedAt: timestamp("claimedAt"),
    claimExpiresAt: timestamp("claimExpiresAt"),
    nextRetryAt: timestamp("nextRetryAt"),
    // none | needed | in_progress | resolved
    reconciliationState: varchar("reconciliationState", { length: 24 }).notNull(),
    // transient | permanent | ambiguous | governance | unsupported
    failureClass: varchar("failureClass", { length: 24 }),
    // Held billing reservation (execution settlement authority). Deterministic
    // per billing identity; recorded so crash/reconcile paths settle at most once.
    billingReservationId: varchar("billingReservationId", { length: 64 }),
    lastError: varchar("lastError", { length: 512 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => ({
    actionRequestUnique: uniqueIndex("ee_action_request_idx").on(table.actionRequestId),
    operationIdentityUnique: uniqueIndex("ee_operation_identity_idx").on(
      table.providerOperationIdentity
    ),
    businessIdx: index("ee_business_idx").on(table.businessId),
    statusIdx: index("ee_status_idx").on(table.status),
    reconciliationIdx: index("ee_reconciliation_idx").on(table.reconciliationState),
  })
);

export type EngagementExecutionRow = typeof engagementExecutions.$inferSelect;
export type InsertEngagementExecutionRow = typeof engagementExecutions.$inferInsert;

// ─── Engagement Receipts (WBS-R5-C7) ───
// Immutable evidence of an external engagement effect. One row per
// execution (unique executionId) and per provider operation identity, so
// crash-after-provider-success replay converges to the existing row with
// zero duplicate provider effects. Carries opaque identity references only
// (ids, hashes, bounded external references) — never provider tokens,
// secrets, or raw social content.
export const engagementReceipts = mysqlTable(
  "engagement_receipts",
  {
    id: serial("id").primaryKey(),
    // Deterministic: erec_<sha256(...)[:40]>.
    engagementReceiptId: varchar("engagementReceiptId", { length: 64 }).notNull(),
    executionId: varchar("executionId", { length: 64 }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    signalId: varchar("signalId", { length: 128 }).notNull(),
    interpretationId: varchar("interpretationId", { length: 128 }).notNull(),
    actionRequestId: varchar("actionRequestId", { length: 128 }).notNull(),
    policyDecisionId: varchar("policyDecisionId", { length: 48 }).notNull(),
    approvalRequestId: int("approvalRequestId"),
    responseContentId: varchar("responseContentId", { length: 64 }).notNull(),
    responseContentVersion: int("responseContentVersion").notNull(),
    provider: varchar("provider", { length: 16 }).notNull(),
    // Provider account binding as opaque identity (integration row id) —
    // token material lives only in social_integrations and is never copied.
    integrationId: bigint("integrationId", { mode: "number", unsigned: true }),
    providerAccountRef: varchar("providerAccountRef", { length: 255 }),
    externalTarget: varchar("externalTarget", { length: 255 }).notNull(),
    providerOperationIdentity: varchar("providerOperationIdentity", { length: 64 }).notNull(),
    // Bounded provider acknowledgement reference (comment id etc.), safe subset.
    providerExternalReceipt: varchar("providerExternalReceipt", { length: 512 }),
    // ISO 8601 verbatim.
    executedAt: varchar("executedAt", { length: 32 }).notNull(),
    // succeeded
    status: varchar("status", { length: 24 }).notNull(),
    // none | resolved
    reconciliationState: varchar("reconciliationState", { length: 24 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    receiptIdUnique: uniqueIndex("er_receipt_id_idx").on(table.engagementReceiptId),
    executionUnique: uniqueIndex("er_execution_idx").on(table.executionId),
    operationIdentityUnique: uniqueIndex("er_operation_identity_idx").on(
      table.providerOperationIdentity
    ),
    businessIdx: index("er_business_idx").on(table.businessId),
    signalIdx: index("er_signal_idx").on(table.signalId),
  })
);

export type EngagementReceiptRow = typeof engagementReceipts.$inferSelect;
export type InsertEngagementReceiptRow = typeof engagementReceipts.$inferInsert;
// ─── R5-D Opportunity Candidates ───
// Durable evidence-backed opportunity candidates (pre-lead marketing/business
// signals). Identity is deterministic and server-derived: opportunityKey =
// sha256(canonicalJson(threadCoordinates)) with tenantUserId INSIDE the
// coordinates, so cross-tenant collision/correlation is impossible. The raw
// external actor reference is never stored — actorKey is a keyed hash only.
// See docs/contracts/opportunity-candidate-contract.md. Provisional migration
// 0030_opportunity_detection_foundation (R5-X owns canonical sequencing).
export const opportunityCandidates = mysqlTable(
  "opportunity_candidates",
  {
    id: serial("id").primaryKey(),
    // "opp1:" + 64-hex thread identity; server-minted only.
    opportunityId: varchar("opportunityId", { length: 69 }).notNull(),
    // 64-hex thread coordinates hash (tenant-anchored).
    opportunityKey: varchar("opportunityKey", { length: 64 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    opportunityType: mysqlEnum("opportunityType", [
      "purchase_interest",
      "service_enquiry",
      "demo_or_consultation_interest",
      "partnership_interest",
      "repeat_interest",
      "retention_risk",
      "churn_risk",
      "referral_or_advocacy",
      "unresolved_complaint_opportunity",
      "support_to_sales_transition",
      "unknown",
    ]).notNull(),
    opportunityStatus: mysqlEnum("opportunityStatus", [
      "candidate",
      "strengthening",
      "weak",
      "suppressed",
      "expired",
      "escalated",
      "handed_off_to_r6",
    ]).notNull(),
    confidenceClass: mysqlEnum("confidenceClass", ["LOW", "MEDIUM", "HIGH", "UNKNOWN"]).notNull(),
    evidenceStrength: mysqlEnum("evidenceStrength", ["LOW", "MEDIUM", "HIGH", "UNKNOWN"]).notNull(),
    urgency: mysqlEnum("urgency", ["low", "normal", "high", "critical"]).notNull(),
    topic: varchar("topic", { length: 48 }),
    topicKey: varchar("topicKey", { length: 64 }).notNull(),
    actorKey: varchar("actorKey", { length: 64 }).notNull(),
    threadKey: varchar("threadKey", { length: 64 }).notNull(),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
    publicationId: varchar("publicationId", { length: 255 }),
    provider: mysqlEnum("provider", ["meta", "linkedin", "twitter", "tiktok"]),
    // Always null in R5-D storage (privacy minimization; actorKey is the hash).
    externalActorReference: varchar("externalActorReference", { length: 255 }),
    firstEvidence: json("firstEvidence").notNull(),
    latestEvidence: json("latestEvidence").notNull(),
    // ISO 8601 provider event times, stored verbatim as text.
    firstObservedAt: varchar("firstObservedAt", { length: 32 }).notNull(),
    lastObservedAt: varchar("lastObservedAt", { length: 32 }).notNull(),
    evidenceCount: int("evidenceCount").notNull(),
    contradictionCount: int("contradictionCount").notNull(),
    detectorRulesVersion: varchar("detectorRulesVersion", { length: 64 }).notNull(),
    classifierVersions: json("classifierVersions").notNull(),
    // Optimistic CAS guard for guarded state transitions.
    version: int("version").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
    statusChangedAt: timestamp("statusChangedAt").defaultNow().notNull(),
    handedOffAt: timestamp("handedOffAt"),
  },
  (table) => ({
    // One logical opportunity thread → one durable candidate (D4).
    userOpportunityUnique: uniqueIndex("oc_user_opportunity_uidx").on(
      table.userId,
      table.opportunityKey
    ),
    userStatusIdx: index("oc_user_status_idx").on(table.userId, table.opportunityStatus),
    userActorIdx: index("oc_user_actor_idx").on(table.userId, table.actorKey),
    userThreadIdx: index("oc_user_thread_idx").on(table.userId, table.threadKey),
  })
);

export type OpportunityCandidateRow = typeof opportunityCandidates.$inferSelect;
export type InsertOpportunityCandidateRow = typeof opportunityCandidates.$inferInsert;

// ─── R5-D Opportunity Evidence (immutable, append-only) ───
// One interpretation contributes to at most one candidate (or one suppression);
// engagement receipts (R5-C seam) enrich an existing candidate only. No update
// path — evidenceHash proves byte-stability; drift fails closed.
export const opportunityEvidence = mysqlTable(
  "opportunity_evidence",
  {
    id: serial("id").primaryKey(),
    candidateId: bigint("candidateId", { mode: "number", unsigned: true }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    interpretationId: varchar("interpretationId", { length: 64 }).notNull(),
    signalId: varchar("signalId", { length: 128 }).notNull(),
    signalVersion: int("signalVersion").notNull(),
    kind: mysqlEnum("kind", ["signal_interpretation", "engagement_receipt"]).notNull(),
    engagementReceiptId: varchar("engagementReceiptId", { length: 128 }),
    opportunityTypeAtEvaluation: mysqlEnum("opportunityTypeAtEvaluation", [
      "purchase_interest",
      "service_enquiry",
      "demo_or_consultation_interest",
      "partnership_interest",
      "repeat_interest",
      "retention_risk",
      "churn_risk",
      "referral_or_advocacy",
      "unresolved_complaint_opportunity",
      "support_to_sales_transition",
      "unknown",
    ]).notNull(),
    // Immutable copies of the R5-B labels as evaluated.
    intent: varchar("intent", { length: 32 }).notNull(),
    overallConfidence: varchar("overallConfidence", { length: 16 }).notNull(),
    relevance: varchar("relevance", { length: 32 }).notNull(),
    sentiment: varchar("sentiment", { length: 16 }).notNull(),
    urgency: mysqlEnum("urgency", ["low", "normal", "high", "critical"]).notNull(),
    sourceCampaignId: bigint("sourceCampaignId", { mode: "number", unsigned: true }),
    occurredAt: varchar("occurredAt", { length: 32 }).notNull(),
    contributesToStrength: boolean("contributesToStrength").notNull(),
    evidenceHash: varchar("evidenceHash", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    // Replay/concurrency anchor: one signal interpretation contributes at most
    // once per kind (a signal row plus, optionally, one engagement-receipt row
    // sharing the interpretationId).
    interpretationKindUnique: uniqueIndex("oe_interpretation_kind_uidx").on(
      table.interpretationId,
      table.kind
    ),
    // Exactly-once enrichment anchor for R5-C receipts (NULLs distinct in MySQL).
    receiptUnique: uniqueIndex("oe_receipt_uidx").on(table.engagementReceiptId),
    candidateIdx: index("oe_candidate_idx").on(table.candidateId),
  })
);

export type OpportunityEvidenceRow = typeof opportunityEvidence.$inferSelect;
export type InsertOpportunityEvidenceRow = typeof opportunityEvidence.$inferInsert;

// ─── R5-D Opportunity Suppressions (durable evaluation rejections) ───
// Spam/irrelevant/risk-gated/policy-gated evaluations land here — never in
// candidates. Keyed unique by interpretationId so replays converge and floods
// are bounded per interpretation. Thread coordinates enable R9/R10
// thread-history aggregation.
export const opportunitySuppressions = mysqlTable(
  "opportunity_suppressions",
  {
    id: serial("id").primaryKey(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    interpretationId: varchar("interpretationId", { length: 64 }).notNull(),
    signalId: varchar("signalId", { length: 128 }).notNull(),
    reason: mysqlEnum("reason", [
      "SAFETY_ESCALATION",
      "RISK_GATED",
      "POLICY_SUPPRESSED",
      "NOT_OPPORTUNITY_SIGNAL",
      "INSUFFICIENT_CLASSIFICATION",
      "NO_OPPORTUNITY_CLASSIFICATION",
      "LOW_RELEVANCE",
      "FLOOD_GUARDED",
    ]).notNull(),
    detail: varchar("detail", { length: 255 }),
    actorKey: varchar("actorKey", { length: 64 }),
    threadKey: varchar("threadKey", { length: 64 }),
    intent: varchar("intent", { length: 32 }).notNull(),
    occurredAt: varchar("occurredAt", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    interpretationUnique: uniqueIndex("os_interpretation_uidx").on(table.interpretationId),
    userThreadIdx: index("os_user_thread_idx").on(table.userId, table.threadKey),
    userReasonIdx: index("os_user_reason_idx").on(table.userId, table.reason),
  })
);

export type OpportunitySuppressionRow = typeof opportunitySuppressions.$inferSelect;
export type InsertOpportunitySuppressionRow = typeof opportunitySuppressions.$inferInsert;

// ─── R5-D Opportunity Handoffs (durable exact-once R6 envelopes) ───
// Unique (userId, opportunityId) → exactly-once; replay returns the existing
// envelope. References + bounded labels only: no social text, no raw actor
// references, no model reasoning. R5-D never creates the R6 lead.
export const opportunityHandoffs = mysqlTable(
  "opportunity_handoffs",
  {
    id: serial("id").primaryKey(),
    handoffId: varchar("handoffId", { length: 69 }).notNull(),
    opportunityId: varchar("opportunityId", { length: 69 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    envelope: json("envelope").notNull(),
    evidenceSnapshotHash: varchar("evidenceSnapshotHash", { length: 64 }).notNull(),
    handedOffAt: timestamp("handedOffAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    opportunityUnique: uniqueIndex("oh_user_opportunity_uidx").on(table.userId, table.opportunityId),
    handoffIdIdx: uniqueIndex("oh_handoff_id_idx").on(table.handoffId),
  })
);

export type OpportunityHandoffRow = typeof opportunityHandoffs.$inferSelect;
export type InsertOpportunityHandoffRow = typeof opportunityHandoffs.$inferInsert;


// ─── R6-A Lead Identities (canonical lead identity authority) ───
// Deterministic tenant-anchored identity derived ONLY from R5 opportunity
// handoff envelopes + verified hashed linking keys. Hash-only identity:
// no raw email/phone/handles/text/tokens anywhere. Unique (userId,
// identityKey) + (userId, leadId) → DB-authoritative convergence; linking-key
// uniques make verified key ownership single-writer. R6-A never creates
// leads/lead_activities/lead_scores rows and never touches R5 tables.
export const IDENTITY_TYPE_VALUES = [
  "provider_actor",
  "email_hash",
  "phone_hash",
  "authenticated_customer_reference",
  "crm_external_reference",
  "anonymous_thread",
  "unknown",
] as const;

export const IDENTITY_STATUS_VALUES = [
  "active",
  "anonymous",
  "partially_identified",
  "resolved",
  "conflicting",
  "suppressed",
  "merged",
  "archived",
] as const;

export const IDENTITY_CONFIDENCE_VALUES = ["unknown", "low", "medium", "high"] as const;

export const leadIdentities = mysqlTable(
  "lead_identities",
  {
    id: serial("id").primaryKey(),
    leadId: varchar("leadId", { length: 69 }).notNull(),
    identityKey: varchar("identityKey", { length: 64 }).notNull(),
    contractVersion: varchar("contractVersion", { length: 40 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    primaryIdentityType: mysqlEnum("primaryIdentityType", IDENTITY_TYPE_VALUES).notNull(),
    identityStatus: mysqlEnum("identityStatus", IDENTITY_STATUS_VALUES).notNull(),
    identityConfidence: mysqlEnum("identityConfidence", IDENTITY_CONFIDENCE_VALUES).notNull(),
    externalActorReferenceHash: varchar("externalActorReferenceHash", { length: 64 }),
    provider: mysqlEnum("provider", ["meta", "linkedin", "twitter", "tiktok"]),
    emailIdentityHash: varchar("emailIdentityHash", { length: 64 }),
    phoneIdentityHash: varchar("phoneIdentityHash", { length: 64 }),
    customerReferenceHash: varchar("customerReferenceHash", { length: 64 }),
    sourceOpportunityId: varchar("sourceOpportunityId", { length: 69 }).notNull(),
    sourceHandoffId: varchar("sourceHandoffId", { length: 69 }).notNull(),
    canonicalLeadId: varchar("canonicalLeadId", { length: 69 }),
    firstObservedAt: varchar("firstObservedAt", { length: 32 }).notNull(),
    lastObservedAt: varchar("lastObservedAt", { length: 32 }).notNull(),
    provenanceCount: int("provenanceCount").notNull().default(1),
    identityEvidenceCount: int("identityEvidenceCount").notNull().default(0),
    version: int("version").notNull().default(1),
    statusChangedAt: timestamp("statusChangedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    userIdentityUnique: uniqueIndex("li_user_identity_uidx").on(table.userId, table.identityKey),
    userLeadUnique: uniqueIndex("li_user_lead_uidx").on(table.userId, table.leadId),
    userEmailUnique: uniqueIndex("li_user_email_uidx").on(table.userId, table.emailIdentityHash),
    userPhoneUnique: uniqueIndex("li_user_phone_uidx").on(table.userId, table.phoneIdentityHash),
    userCustomerRefUnique: uniqueIndex("li_user_custref_uidx").on(table.userId, table.customerReferenceHash),
    userStatusIdx: index("li_user_status_idx").on(table.userId, table.identityStatus),
  })
);

export type LeadIdentityRow = typeof leadIdentities.$inferSelect;
export type InsertLeadIdentityRow = typeof leadIdentities.$inferInsert;

// ─── R6-A Lead Identity Provenance (immutable, append-only evidence lineage) ───
// kind = opportunity_handoff: unique (userId, handoffId) is the exact-once
// R5 handoff consumption anchor. kind = identity_evidence: verified hashed
// linking keys. kind = merge / conflict: immutable authority records.
// evidenceHash is a deterministic content hash of the entry.
export const LEAD_PROVENANCE_KIND_VALUES = [
  "opportunity_handoff",
  "identity_evidence",
  "merge",
  "conflict",
] as const;

export const leadIdentityProvenance = mysqlTable(
  "lead_identity_provenance",
  {
    id: serial("id").primaryKey(),
    leadRowId: bigint("leadRowId", { mode: "number", unsigned: true }).notNull(),
    leadId: varchar("leadId", { length: 69 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    kind: mysqlEnum("kind", LEAD_PROVENANCE_KIND_VALUES).notNull(),
    handoffId: varchar("handoffId", { length: 69 }),
    opportunityId: varchar("opportunityId", { length: 69 }),
    provider: mysqlEnum("provider", ["meta", "linkedin", "twitter", "tiktok"]),
    campaignId: bigint("campaignId", { mode: "number", unsigned: true }),
    publicationId: varchar("publicationId", { length: 128 }),
    evidenceType: varchar("evidenceType", { length: 40 }),
    evidenceHash: varchar("evidenceHash", { length: 64 }).notNull(),
    envelopeHash: varchar("envelopeHash", { length: 64 }),
    occurredAt: varchar("occurredAt", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userHandoffUnique: uniqueIndex("lip_user_handoff_uidx").on(table.userId, table.handoffId),
    userKindHashUnique: uniqueIndex("lip_user_kind_hash_uidx").on(table.userId, table.kind, table.evidenceHash),
    leadRowIdx: index("lip_lead_row_idx").on(table.leadRowId),
  })
);

export type LeadIdentityProvenanceRow = typeof leadIdentityProvenance.$inferSelect;
export type InsertLeadIdentityProvenanceRow = typeof leadIdentityProvenance.$inferInsert;

// ─── R6-A Lead Identity Merges (immutable deterministic merge authority) ───
// Merge happens ONLY via authoritative linking evidence (§8 of the lead
// identity contract). No generic merge-anything endpoint exists.
export const leadIdentityMerges = mysqlTable(
  "lead_identity_merges",
  {
    id: serial("id").primaryKey(),
    mergeId: varchar("mergeId", { length: 69 }).notNull(),
    mergeHash: varchar("mergeHash", { length: 64 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    canonicalLeadId: varchar("canonicalLeadId", { length: 69 }).notNull(),
    absorbedLeadId: varchar("absorbedLeadId", { length: 69 }).notNull(),
    linkingEvidenceType: mysqlEnum("linkingEvidenceType", [
      "email_hash",
      "phone_hash",
      "authenticated_customer_reference",
      "crm_external_reference",
    ]).notNull(),
    linkingEvidenceHash: varchar("linkingEvidenceHash", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userMergeUnique: uniqueIndex("lim_user_merge_uidx").on(table.userId, table.mergeId),
    userPairUnique: uniqueIndex("lim_user_pair_uidx").on(table.userId, table.canonicalLeadId, table.absorbedLeadId),
    userHashUnique: uniqueIndex("lim_user_hash_uidx").on(table.userId, table.mergeHash),
  })
);

export type LeadIdentityMergeRow = typeof leadIdentityMerges.$inferSelect;
export type InsertLeadIdentityMergeRow = typeof leadIdentityMerges.$inferInsert;

// ─── R6-F Lead Privacy Governance (operational privacy state per lead) ───
// F-owned durable home for lead suppression / restriction / retention state.
// One current state per lead (leadId unique). Governance-mutated only through
// the admin operator surface; every transition is CAS-guarded, provenance-
// stamped and audit-ledgered. Migration artefact 0034 (created, NOT executed)
// — runtime code also bridges this table behind a guarded information-schema
// check so pre-migration environments degrade to "unavailable" instead of
// erroring. No PII columns: references and closed-vocabulary labels only.
export const leadPrivacyStates = mysqlTable(
  "lead_privacy_states",
  {
    id: serial("id").primaryKey(),
    leadId: bigint("leadId", { mode: "number", unsigned: true }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    privacyState: mysqlEnum("privacyState", [
      "ACTIVE",
      "SUPPRESSED",
      "RESTRICTED",
      "RETENTION_PENDING",
      "RETENTION_EXPIRED",
      "ARCHIVED",
    ])
      .default("ACTIVE")
      .notNull(),
    previousState: mysqlEnum("previousState", [
      "ACTIVE",
      "SUPPRESSED",
      "RESTRICTED",
      "RETENTION_PENDING",
      "RETENTION_EXPIRED",
      "ARCHIVED",
    ]),
    reason: varchar("reason", { length: 500 }),
    retentionDeadlineAt: timestamp("retentionDeadlineAt"),
    source: varchar("source", { length: 32 }).default("operator").notNull(),
    actorUserId: bigint("actorUserId", { mode: "number", unsigned: true }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    leadUnique: uniqueIndex("lps_lead_uidx").on(table.leadId),
    userIdx: index("lps_user_idx").on(table.userId),
    businessIdx: index("lps_business_idx").on(table.businessId),
    stateIdx: index("lps_state_idx").on(table.privacyState),
  })
);

export type LeadPrivacyStateRow = typeof leadPrivacyStates.$inferSelect;
export type InsertLeadPrivacyStateRow = typeof leadPrivacyStates.$inferInsert;

// ─── R6-B: Lead Scoring ───
// Immutable, append-only authoritative lead score records (one lead + one
// evidence snapshot + one scoring version → one score identity). History is
// the ordered row set per lead; there is no update or delete path. References
// are opaque (no social text, no actor PII). Provisional migration
// 0034_lead_scoring_foundation (artefacts only — not executed; R6-X owns
// canonical sequencing). Distinct from the legacy `lead_scores` table (R4
// audience-intelligence pipeline) — never shared.

export const leadScoreSnapshots = mysqlTable(
  "lead_score_snapshots",
  {
    id: serial("id").primaryKey(),
    // "lsc1:" + 64-hex deterministic score identity (server-minted only).
    leadScoreId: varchar("leadScoreId", { length: 69 }).notNull(),
    // "lss1:" + 64-hex deterministic evidence snapshot identity.
    evidenceSnapshotId: varchar("evidenceSnapshotId", { length: 69 }).notNull(),
    scoreContractVersion: varchar("scoreContractVersion", { length: 64 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    leadId: bigint("leadId", { mode: "number", unsigned: true }).notNull(),
    // R6-A seam version binding (lead-identity-seam/v1 until R6-A publishes).
    leadIdentityVersion: varchar("leadIdentityVersion", { length: 96 }).notNull(),
    scoringVersion: varchar("scoringVersion", { length: 64 }).notNull(),
    featureVersion: varchar("featureVersion", { length: 64 }).notNull(),
    // sha256 over the canonical evidence manifest (tamper-evident).
    evidenceSnapshotHash: varchar("evidenceSnapshotHash", { length: 64 }).notNull(),
    // Bounded manifest: references + closed labels only, sorted deterministically.
    evidenceManifest: json("evidenceManifest").notNull(),
    overallScore: int("overallScore").notNull(),
    scoreBand: mysqlEnum("scoreBand", ["VERY_LOW", "LOW", "MEDIUM", "HIGH", "VERY_HIGH"]).notNull(),
    scoreConfidence: mysqlEnum("scoreConfidence", ["LOW", "MEDIUM", "HIGH", "UNKNOWN"]).notNull(),
    fitScore: int("fitScore").notNull(),
    intentScore: int("intentScore").notNull(),
    engagementScore: int("engagementScore").notNull(),
    recencyScore: int("recencyScore").notNull(),
    opportunityScore: int("opportunityScore").notNull(),
    // Exact server-owned weights applied (inspectability; clients never supply).
    componentWeights: json("componentWeights").notNull(),
    // Bounded closed-vocabulary reason codes (≤ 8).
    reasonCodes: json("reasonCodes").notNull(),
    computedAt: timestamp("computedAt").defaultNow().notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    // Exact-once convergence anchor: one score per (lead, evidence snapshot,
    // scoring version). Duplicate/concurrent scoring replays the existing row.
    convergenceUnique: uniqueIndex("lss_convergence_uidx").on(
      table.userId,
      table.leadId,
      table.evidenceSnapshotHash,
      table.scoringVersion
    ),
    leadScoreIdUnique: uniqueIndex("lss_score_id_uidx").on(table.leadScoreId),
    snapshotIdIdx: index("lss_snapshot_id_idx").on(table.evidenceSnapshotId),
    userLeadIdx: index("lss_user_lead_idx").on(table.userId, table.leadId),
  })
);

export type LeadScoreSnapshotRow = typeof leadScoreSnapshots.$inferSelect;
export type InsertLeadScoreSnapshotRow = typeof leadScoreSnapshots.$inferInsert;

// ─── R6-E Conversion Events ───
// Durable conversion/outcome records: evidence of a business outcome (purchase,
// subscription, refund...) bound to a tenant + business with provenance lineage
// (opportunity / engagement / signal / campaign / publication references only —
// never causation claims). Identity is deterministic and server-derived:
// conversionKey = sha256(canonicalJson({tenantUserId, sourceSystem,
// externalConversionId})) so cross-tenant collision/correlation is impossible
// and provider retries converge on one durable row. Initial outcomeStatus is
// derived server-side from the source trust registry; clients can never supply
// trust class, outcome status, identity or evidence hash. Reversal rows
// (refund/cancellation/reversal) carry reversesConversionId and mint one
// deterministic lifecycle event on the target. Monetary value is integer minor
// units (signed for reversals); evidenceHash proves byte-stability.
export const conversionEvents = mysqlTable(
  "conversion_events",
  {
    id: serial("id").primaryKey(),
    // "cnv1:" + 64-hex identity; server-minted only.
    conversionId: varchar("conversionId", { length: 69 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }).notNull(),
    leadId: bigint("leadId", { mode: "number", unsigned: true }),
    leadIdentityVersion: varchar("leadIdentityVersion", { length: 64 }),
    externalConversionId: varchar("externalConversionId", { length: 191 }).notNull(),
    sourceSystem: varchar("sourceSystem", { length: 32 }).notNull(),
    // Server-derived from the source-system trust registry (never client-supplied).
    sourceTrustClass: varchar("sourceTrustClass", { length: 24 }).notNull(),
    conversionType: varchar("conversionType", { length: 32 }).notNull(),
    // Provider event time and server acceptance time, ISO 8601 verbatim.
    occurredAt: varchar("occurredAt", { length: 32 }).notNull(),
    observedAt: varchar("observedAt", { length: 32 }).notNull(),
    // Integer minor units; SIGNED so reversal rows may carry negative amounts.
    amount: bigint("amount", { mode: "number" }),
    currency: varchar("currency", { length: 3 }),
    outcomeStatus: varchar("outcomeStatus", { length: 16 }).notNull(),
    // Set only on reversal rows (refund/cancellation/reversal); references the
    // conversion row that this row reverses. Never a reversal-of-a-reversal.
    reversesConversionId: varchar("reversesConversionId", { length: 69 }),
    sourceOpportunityId: varchar("sourceOpportunityId", { length: 69 }),
    sourceEngagementReceiptId: varchar("sourceEngagementReceiptId", { length: 64 }),
    sourceSignalId: varchar("sourceSignalId", { length: 64 }),
    sourceCampaignId: bigint("sourceCampaignId", { mode: "number", unsigned: true }),
    sourcePublicationId: bigint("sourcePublicationId", { mode: "number", unsigned: true }),
    evidenceReference: varchar("evidenceReference", { length: 255 }),
    // sha256 over the canonical immutable core; drift fails closed.
    evidenceHash: varchar("evidenceHash", { length: 64 }).notNull(),
    // Optimistic CAS guard for guarded outcome-status transitions.
    version: int("version").notNull().default(1),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    conversionIdUnique: uniqueIndex("ce_conversion_id_uidx").on(table.conversionId),
    // Exact-once natural identity: one logical provider conversion per tenant +
    // source system, enforced at the database level (retries converge).
    naturalKeyUnique: uniqueIndex("ce_natural_key_uidx").on(
      table.userId,
      table.sourceSystem,
      table.externalConversionId
    ),
    userBusinessIdx: index("ce_user_business_idx").on(table.userId, table.businessId),
    userLeadIdx: index("ce_user_lead_idx").on(table.userId, table.leadId),
    userOccurredIdx: index("ce_user_occurred_idx").on(table.userId, table.occurredAt),
    userReversesIdx: index("ce_user_reverses_idx").on(table.userId, table.reversesConversionId),
  })
);

export type ConversionEventRow = typeof conversionEvents.$inferSelect;
export type InsertConversionEventRow = typeof conversionEvents.$inferInsert;

// ─── R6-E Conversion Lifecycle Events (immutable, append-only) ───
// One deterministic row per outcome lifecycle fact on a conversion
// (confirmation/reversal/refund/cancellation/dispute/correction). Identity is
// server-derived: lifecycleEventId = "clf1:" + sha256(canonicalJson(...)); the
// (conversionId, externalLifecycleId) pair is the provider-retry convergence
// anchor (NULL external ids are distinct per house convention). Rows are
// immutable — there is no update path.
export const conversionLifecycleEvents = mysqlTable(
  "conversion_lifecycle_events",
  {
    id: serial("id").primaryKey(),
    // "clf1:" + 64-hex identity; server-minted only.
    lifecycleEventId: varchar("lifecycleEventId", { length: 70 }).notNull(),
    conversionId: varchar("conversionId", { length: 69 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    lifecycleType: varchar("lifecycleType", { length: 16 }).notNull(),
    // Target outcome status for this lifecycle fact.
    outcomeStatus: varchar("outcomeStatus", { length: 16 }).notNull(),
    amount: bigint("amount", { mode: "number" }),
    currency: varchar("currency", { length: 3 }),
    externalLifecycleId: varchar("externalLifecycleId", { length: 191 }),
    occurredAt: varchar("occurredAt", { length: 32 }).notNull(),
    reasonCode: varchar("reasonCode", { length: 64 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    eventIdUnique: uniqueIndex("cle_event_id_uidx").on(table.lifecycleEventId),
    // Provider-retry convergence anchor; NULLs distinct in MySQL.
    externalUnique: uniqueIndex("cle_external_uidx").on(table.conversionId, table.externalLifecycleId),
    userConversionIdx: index("cle_user_conversion_idx").on(table.userId, table.conversionId),
  })
);

export type ConversionLifecycleEventRow = typeof conversionLifecycleEvents.$inferSelect;
export type InsertConversionLifecycleEventRow = typeof conversionLifecycleEvents.$inferInsert;

// ─── R6-C Lead Qualifications (governed deterministic decision authority) ───
// Immutable, insert-only qualification decisions. Unique (userId,
// qualificationId) is the exact-once convergence anchor: retries/concurrent
// duplicates re-read the committed row and converge (idempotent_replay).
// References + hashes + closed vocabularies only — no PII, no raw evidence.
// Provisional migration 0034_lead_qualification_autonomy (artefacts only —
// NOT executed; see docs/recovery/r6-c-unexecuted-migrations.md; R6-X owns
// canonical sequencing).
export const leadQualifications = mysqlTable(
  "lead_qualifications",
  {
    id: serial("id").primaryKey(),
    qualificationId: varchar("qualificationId", { length: 69 }).notNull(),
    contractVersion: varchar("contractVersion", { length: 40 }).notNull(),
    engineVersion: varchar("engineVersion", { length: 64 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    leadId: varchar("leadId", { length: 69 }).notNull(),
    leadIdentityVersion: varchar("leadIdentityVersion", { length: 96 }).notNull(),
    identityReference: varchar("identityReference", { length: 64 }).notNull(),
    leadScoreId: varchar("leadScoreId", { length: 69 }).notNull(),
    scoringVersion: varchar("scoringVersion", { length: 64 }).notNull(),
    scoreContentHash: varchar("scoreContentHash", { length: 64 }).notNull(),
    qualificationPolicyVersion: varchar("qualificationPolicyVersion", { length: 96 }).notNull(),
    evidenceSnapshotHash: varchar("evidenceSnapshotHash", { length: 64 }).notNull(),
    evidenceSnapshot: json("evidenceSnapshot").notNull(),
    decision: mysqlEnum("decision", [
      "QUALIFIED",
      "NOT_QUALIFIED",
      "REVIEW_REQUIRED",
      "INSUFFICIENT_EVIDENCE",
      "BLOCKED",
    ]).notNull(),
    reasonCodes: json("reasonCodes").notNull(),
    confidenceScore: int("confidenceScore").notNull(),
    reviewRequired: boolean("reviewRequired").notNull(),
    evaluatedAt: varchar("evaluatedAt", { length: 32 }).notNull(),
    validUntil: varchar("validUntil", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("lqd_convergence_uidx").on(t.userId, t.qualificationId),
    index("lqd_user_lead_idx").on(t.userId, t.leadId),
    index("lqd_user_business_idx").on(t.userId, t.businessId),
  ]
);

export type LeadQualificationsRow = typeof leadQualifications.$inferSelect;
export type InsertLeadQualificationsRow = typeof leadQualifications.$inferInsert;

// ─── R6-C Lead Qualification Reviews (one governed review per decision) ───
// Exactly one review per decision: unique (userId, reviewId) + (userId,
// qualificationId). Resolution is optimistic-CAS guarded (version) — a review
// resolves at most once and never mutates the immutable decision. Bound to
// the exact decision via decisionBindingHash; drift ⇒ REVIEW_STALE_BINDING.
export const leadQualificationReviews = mysqlTable(
  "lead_qualification_reviews",
  {
    id: serial("id").primaryKey(),
    reviewId: varchar("reviewId", { length: 69 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    leadId: varchar("leadId", { length: 69 }).notNull(),
    qualificationId: varchar("qualificationId", { length: 69 }).notNull(),
    decisionBindingHash: varchar("decisionBindingHash", { length: 64 }).notNull(),
    status: mysqlEnum("status", ["pending", "progress_authorized", "progression_rejected"]).notNull(),
    triggerReasonCodes: json("triggerReasonCodes").notNull(),
    resolvedBy: bigint("resolvedBy", { mode: "number", unsigned: true }),
    resolvedAt: varchar("resolvedAt", { length: 32 }),
    resolutionReason: varchar("resolutionReason", { length: 500 }),
    // Independent human-review authority (§10 blocker closure): the
    // outstanding out-of-band challenge bound to this review (issued by
    // requestReviewResolution, cleared on resolution). Never authoritative
    // on its own — the OTP challenge row is the durable single-use proof.
    pendingChallengeToken: varchar("pendingChallengeToken", { length: 255 }),
    challengeExpiresAt: varchar("challengeExpiresAt", { length: 32 }),
    version: int("version").notNull().default(1),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("lqr_review_uidx").on(t.userId, t.reviewId),
    uniqueIndex("lqr_qualification_uidx").on(t.userId, t.qualificationId),
    index("lqr_user_lead_idx").on(t.userId, t.leadId),
  ]
);

export type LeadQualificationReviewsRow = typeof leadQualificationReviews.$inferSelect;
export type InsertLeadQualificationReviewsRow = typeof leadQualificationReviews.$inferInsert;

// ─── R6-D Nurture / Sales Handoff — governed decision authority ───
// Provisional migration 0034_nurture_sales_handoff_autonomy (artefact only,
// NOT executed; R6-X owns canonical sequencing). Immutable after acceptance:
// corrections are new decisions. No PII, no message text — ids/hashes/closed
// labels/timestamps only. See docs/contracts/lead-nurture-sales-handoff-contract.md.
export const nurtureHandoffDecisions = mysqlTable(
  "nurture_handoff_decisions",
  {
    id: serial("id").primaryKey(),
    // "nd1:" + 64-hex deterministic decision identity; server-minted only.
    nurtureDecisionId: varchar("nurtureDecisionId", { length: 69 }).notNull(),
    // 64-hex world-state hash (tenant-anchored; contract §1).
    decisionKey: varchar("decisionKey", { length: 64 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    // R6-A canonical identity reference ("lid1:…").
    leadId: varchar("leadId", { length: 69 }).notNull(),
    // R6-C qualification reference ("lqu1:…") + exact consumed projection binding.
    qualificationId: varchar("qualificationId", { length: 69 }).notNull(),
    qualificationFingerprint: varchar("qualificationFingerprint", { length: 64 }).notNull(),
    qualificationPolicyVersion: varchar("qualificationPolicyVersion", { length: 96 }).notNull(),
    // F privacy state at decision time (re-read at execution; contract §4).
    privacyState: mysqlEnum("privacyState", [
      "ACTIVE",
      "SUPPRESSED",
      "RESTRICTED",
      "RETENTION_PENDING",
      "RETENTION_EXPIRED",
      "ARCHIVED",
    ]).notNull(),
    privacyStateUpdatedAt: varchar("privacyStateUpdatedAt", { length: 32 }),
    policyVersion: varchar("policyVersion", { length: 112 }).notNull(),
    decision: mysqlEnum("decision", [
      "NURTURE",
      "SALES_HANDOFF",
      "WAIT",
      "REVIEW_REQUIRED",
      "BLOCKED",
      "NO_ACTION",
    ]).notNull(),
    // Closed vocabulary (NURTURE_REASON_CODES), ≤ 8 per record.
    reasonCodes: json("reasonCodes").notNull(),
    channel: mysqlEnum("channel", ["email", "whatsapp", "sms", "crm"]),
    provider: varchar("provider", { length: 32 }),
    approvalRequired: boolean("approvalRequired").notNull(),
    approvalRequestId: bigint("approvalRequestId", { mode: "number", unsigned: true }),
    // Populated when the decision is bound to a handoff identity.
    handoffId: varchar("handoffId", { length: 69 }),
    conversionStopped: boolean("conversionStopped").notNull(),
    occurredAt: varchar("occurredAt", { length: 32 }).notNull(),
    validUntil: varchar("validUntil", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    decisionIdUnique: uniqueIndex("nhd_decision_id_uidx").on(table.nurtureDecisionId),
    userDecisionKeyUnique: uniqueIndex("nhd_user_decision_key_uidx").on(table.userId, table.decisionKey),
    userLeadIdx: index("nhd_user_lead_idx").on(table.userId, table.leadId),
    userQualificationIdx: index("nhd_user_qualification_idx").on(table.userId, table.qualificationId),
  })
);

export type NurtureHandoffDecisionRow = typeof nurtureHandoffDecisions.$inferSelect;
export type InsertNurtureHandoffDecisionRow = typeof nurtureHandoffDecisions.$inferInsert;

// ─── R6-D Sales Handoffs — exact-once handoff identity + lifecycle ───
export const salesHandoffs = mysqlTable(
  "sales_handoffs",
  {
    id: serial("id").primaryKey(),
    // "sh1:" + 64-hex exact-once handoff identity (contract §8).
    handoffId: varchar("handoffId", { length: 69 }).notNull(),
    handoffKey: varchar("handoffKey", { length: 64 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    leadId: varchar("leadId", { length: 69 }).notNull(),
    qualificationId: varchar("qualificationId", { length: 69 }).notNull(),
    nurtureDecisionId: varchar("nurtureDecisionId", { length: 69 }).notNull(),
    qualificationFingerprint: varchar("qualificationFingerprint", { length: 64 }).notNull(),
    handoffPolicyVersion: varchar("handoffPolicyVersion", { length: 112 }).notNull(),
    // Draft-content snapshot hash (approval binding; never raw text).
    contentSnapshotHash: varchar("contentSnapshotHash", { length: 64 }).notNull(),
    handoffStatus: mysqlEnum("handoffStatus", [
      "PREPARED",
      "APPROVAL_REQUIRED",
      "APPROVED",
      "DISPATCH_PENDING",
      "DISPATCHED",
      "ACKNOWLEDGED",
      "FAILED",
      "BLOCKED",
      "CANCELLED",
    ])
      .default("PREPARED")
      .notNull(),
    approvalRequestId: bigint("approvalRequestId", { mode: "number", unsigned: true }),
    // Bounded reason code on failure/blocking — never raw payloads.
    lastError: varchar("lastError", { length: 64 }),
    // Optimistic CAS guard for lifecycle transitions.
    version: int("version").notNull(),
    preparedAt: varchar("preparedAt", { length: 32 }).notNull(),
    dispatchedAt: varchar("dispatchedAt", { length: 32 }),
    acknowledgedAt: varchar("acknowledgedAt", { length: 32 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => ({
    handoffIdUnique: uniqueIndex("sh_handoff_id_uidx").on(table.handoffId),
    userHandoffKeyUnique: uniqueIndex("sh_user_handoff_key_uidx").on(table.userId, table.handoffKey),
    userLeadIdx: index("sh_user_lead_idx").on(table.userId, table.leadId),
    userStatusIdx: index("sh_user_status_idx").on(table.userId, table.handoffStatus),
  })
);

export type SalesHandoffRow = typeof salesHandoffs.$inferSelect;
export type InsertSalesHandoffRow = typeof salesHandoffs.$inferInsert;

// ─── R6-D Handoff Dispatch Receipts — append-only execution evidence ───
export const handoffDispatchReceipts = mysqlTable(
  "handoff_dispatch_receipts",
  {
    id: serial("id").primaryKey(),
    // "hd1:" + 64-hex transport idempotency identity (contract §11).
    executionIdentity: varchar("executionIdentity", { length: 69 }).notNull(),
    handoffId: varchar("handoffId", { length: 69 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    attemptSeq: int("attemptSeq").notNull(),
    outcome: mysqlEnum("outcome", ["ACCEPTED", "REJECTED", "FAILURE"]).notNull(),
    // Bounded acknowledgement label; fake transports label themselves.
    providerAck: varchar("providerAck", { length: 255 }),
    occurredAt: varchar("occurredAt", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    executionIdentityUnique: uniqueIndex("hdr_execution_identity_uidx").on(table.executionIdentity),
    userHandoffIdx: index("hdr_user_handoff_idx").on(table.userId, table.handoffId),
  })
);

export type HandoffDispatchReceiptRow = typeof handoffDispatchReceipts.$inferSelect;
export type InsertHandoffDispatchReceiptRow = typeof handoffDispatchReceipts.$inferInsert;

// ─── R6-D Nurture Touch Records — append-only, exact-once touches ───
export const nurtureTouchRecords = mysqlTable(
  "nurture_touch_records",
  {
    id: serial("id").primaryKey(),
    // "nt1:" + 64-hex exact-once touch identity (contract §7).
    touchIdentity: varchar("touchIdentity", { length: 69 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    businessId: bigint("businessId", { mode: "number", unsigned: true }),
    leadId: varchar("leadId", { length: 69 }).notNull(),
    nurtureDecisionId: varchar("nurtureDecisionId", { length: 69 }).notNull(),
    channel: mysqlEnum("channel", ["email", "whatsapp", "sms", "crm"]).notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    // Deterministic sequence number derived from durable rows only.
    touchSeq: int("touchSeq").notNull(),
    outcome: mysqlEnum("outcome", ["ACCEPTED", "REJECTED", "FAILURE"]).notNull(),
    providerAck: varchar("providerAck", { length: 255 }),
    touchedAt: varchar("touchedAt", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    userTouchIdentityUnique: uniqueIndex("ntr_user_touch_identity_uidx").on(table.userId, table.touchIdentity),
    userLeadChannelIdx: index("ntr_user_lead_channel_idx").on(table.userId, table.leadId, table.channel),
  })
);

export type NurtureTouchRecordRow = typeof nurtureTouchRecords.$inferSelect;
export type InsertNurtureTouchRecordRow = typeof nurtureTouchRecords.$inferInsert;

// ─── WBS-R7-D: Experimentation Engine ───
// (provisional, stream-local; migration 0035_r7_d_experimentation — NOT
// executed; R7-X owns canonical convergence. See
// docs/recovery/r7-d-unexecuted-migrations.md and
// docs/contracts/experimentation-contract.md)

export const EXPERIMENT_DESIGN_TYPE_VALUES = ["A_B", "MULTI_ARM"] as const;
export const EXPERIMENT_STATUS_VALUES = [
  "DRAFT",
  "GOVERNANCE_REQUIRED",
  "APPROVAL_REQUIRED",
  "READY",
  "ACTIVE",
  "PAUSED",
  "STOPPED",
  "COMPLETED",
  "INVALIDATED",
  "CANCELLED",
] as const;

export const experiments = mysqlTable(
  "experiments",
  {
    id: serial("id").primaryKey(),
    // "exp1:" + 64-hex deterministic experiment identity (contract §3).
    experimentId: varchar("experimentId", { length: 69 }).notNull(),
    // "hyp1:" + 64-hex deterministic hypothesis identity (contract §3).
    hypothesisId: varchar("hypothesisId", { length: 69 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    // Server-resolved from the bound learning — never client-supplied.
    businessId: bigint("businessId", { mode: "number", unsigned: true }).notNull(),
    // Opaque lrn1: reference into R7-C learning authority.
    learningId: varchar("learningId", { length: 69 }).notNull(),
    statement: varchar("statement", { length: 1024 }).notNull(),
    designType: mysqlEnum("designType", EXPERIMENT_DESIGN_TYPE_VALUES).notNull(),
    dimension: varchar("dimension", { length: 24 }).notNull(),
    controlDefinition: json("controlDefinition").notNull(),
    treatmentDefinitions: json("treatmentDefinitions").notNull(),
    allocationPolicy: json("allocationPolicy").notNull(),
    primaryMetric: json("primaryMetric").notNull(),
    secondaryMetrics: json("secondaryMetrics").notNull(),
    guardrails: json("guardrails").notNull(),
    minimumSamplePerArm: int("minimumSamplePerArm").notNull(),
    durationDays: int("durationDays").notNull(),
    // Observation window — set at activation, immutable thereafter (§8).
    startAt: varchar("startAt", { length: 32 }),
    endAt: varchar("endAt", { length: 32 }),
    // Pinned at activation; immutable thereafter (§7).
    assignmentVersion: varchar("assignmentVersion", { length: 64 }),
    status: mysqlEnum("status", EXPERIMENT_STATUS_VALUES).notNull().default("DRAFT"),
    // ogd1: governance reference; approval request reference (§6).
    governanceDecisionId: varchar("governanceDecisionId", { length: 69 }),
    approvalReference: varchar("approvalReference", { length: 64 }),
    designHash: varchar("designHash", { length: 64 }).notNull(),
    // "exr1:" result reference once concluded (§10).
    resultId: varchar("resultId", { length: 69 }),
    recordHash: varchar("recordHash", { length: 64 }).notNull(),
    // Untrusted, non-authoritative model-assisted draft (§5).
    narrativeDraft: text("narrativeDraft"),
    version: int("version").notNull().default(1),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    experimentIdUnique: uniqueIndex("exp_experiment_id_uidx").on(table.experimentId),
    naturalKeyUnique: uniqueIndex("exp_natural_key_uidx").on(
      table.userId,
      table.learningId,
      table.hypothesisId,
      table.designHash
    ),
    userBusinessIdx: index("exp_user_business_idx").on(table.userId, table.businessId),
    userStatusIdx: index("exp_user_status_idx").on(table.userId, table.status),
  })
);

export type ExperimentRow = typeof experiments.$inferSelect;
export type InsertExperimentRow = typeof experiments.$inferInsert;

export const EXPERIMENT_LIFECYCLE_EVENT_VALUES = [
  "creation",
  "governance",
  "approval",
  "activation",
  "pause",
  "resume",
  "stop",
  "completion",
  "invalidation",
  "cancellation",
] as const;

export const experimentLifecycleEvents = mysqlTable(
  "experiment_lifecycle_events",
  {
    id: serial("id").primaryKey(),
    // "exl1:" + 64-hex deterministic lifecycle fact identity (§11).
    experimentLifecycleEventId: varchar("experimentLifecycleEventId", { length: 70 }).notNull(),
    experimentId: varchar("experimentId", { length: 69 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    lifecycleType: mysqlEnum("lifecycleType", EXPERIMENT_LIFECYCLE_EVENT_VALUES).notNull(),
    fromStatus: varchar("fromStatus", { length: 24 }).notNull(),
    toStatus: varchar("toStatus", { length: 24 }).notNull(),
    reasonCode: varchar("reasonCode", { length: 191 }),
    occurredAt: varchar("occurredAt", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    eventIdUnique: uniqueIndex("exl_event_id_uidx").on(table.experimentLifecycleEventId),
    userExperimentIdx: index("exl_user_experiment_idx").on(table.userId, table.experimentId),
  })
);

export type ExperimentLifecycleEventRow = typeof experimentLifecycleEvents.$inferSelect;
export type InsertExperimentLifecycleEventRow = typeof experimentLifecycleEvents.$inferInsert;

export const EXPERIMENT_ARM_VALUES = ["CONTROL", "TREATMENT"] as const;

export const experimentAssignments = mysqlTable(
  "experiment_assignments",
  {
    id: serial("id").primaryKey(),
    // "exa1:" + 64-hex deterministic assignment identity (§7).
    assignmentId: varchar("assignmentId", { length: 69 }).notNull(),
    experimentId: varchar("experimentId", { length: 69 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    // sha256 of the opaque subject reference — raw subject/PII never persists.
    subjectKey: varchar("subjectKey", { length: 64 }).notNull(),
    arm: mysqlEnum("arm", EXPERIMENT_ARM_VALUES).notNull(),
    armIndex: int("armIndex").notNull(),
    assignmentHash: varchar("assignmentHash", { length: 64 }).notNull(),
    assignedAt: varchar("assignedAt", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    assignmentUnique: uniqueIndex("exa_assignment_uidx").on(table.userId, table.experimentId, table.subjectKey),
    experimentIdx: index("exa_experiment_idx").on(table.userId, table.experimentId),
  })
);

export type ExperimentAssignmentRow = typeof experimentAssignments.$inferSelect;
export type InsertExperimentAssignmentRow = typeof experimentAssignments.$inferInsert;

export const experimentOutcomeEvidence = mysqlTable(
  "experiment_outcome_evidence",
  {
    id: serial("id").primaryKey(),
    // "exe1:" + 64-hex deterministic evidence binding identity (§9).
    evidenceId: varchar("evidenceId", { length: 69 }).notNull(),
    experimentId: varchar("experimentId", { length: 69 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    // Opaque out1: / atr1: source references (§9).
    outcomeId: varchar("outcomeId", { length: 69 }).notNull(),
    attributionId: varchar("attributionId", { length: 69 }),
    subjectKey: varchar("subjectKey", { length: 64 }).notNull(),
    armIndex: int("armIndex").notNull(),
    outcomeStatus: varchar("outcomeStatus", { length: 16 }).notNull(),
    outcomeType: varchar("outcomeType", { length: 32 }).notNull(),
    // Value snapshot at bind time — results are reproducible without re-reading
    // the upstream outcome authority.
    valueType: varchar("valueType", { length: 16 }).notNull(),
    amountMinor: bigint("amountMinor", { mode: "number" }),
    occurredAt: varchar("occurredAt", { length: 32 }).notNull(),
    evidenceHash: varchar("evidenceHash", { length: 64 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    evidenceUnique: uniqueIndex("exe_evidence_uidx").on(table.userId, table.experimentId, table.outcomeId),
    experimentIdx: index("exe_experiment_idx").on(table.userId, table.experimentId),
  })
);

export type ExperimentOutcomeEvidenceRow = typeof experimentOutcomeEvidence.$inferSelect;
export type InsertExperimentOutcomeEvidenceRow = typeof experimentOutcomeEvidence.$inferInsert;

export const EXPERIMENT_RESULT_VERDICT_VALUES = [
  "INSUFFICIENT_EVIDENCE",
  "DIRECTIONAL_SIGNAL",
  "SUPPORTED_DIFFERENCE",
  "NO_MEANINGFUL_DIFFERENCE",
  "INVALID_EXPERIMENT",
] as const;

export const experimentResults = mysqlTable(
  "experiment_results",
  {
    id: serial("id").primaryKey(),
    // "exr1:" + 64-hex deterministic result identity (§10).
    resultId: varchar("resultId", { length: 69 }).notNull(),
    experimentId: varchar("experimentId", { length: 69 }).notNull(),
    userId: bigint("userId", { mode: "number", unsigned: true }).notNull(),
    calculationVersion: varchar("calculationVersion", { length: 48 }).notNull(),
    verdict: mysqlEnum("verdict", EXPERIMENT_RESULT_VERDICT_VALUES).notNull(),
    confidenceClass: varchar("confidenceClass", { length: 24 }).notNull(),
    primaryMetric: json("primaryMetric").notNull(),
    armSummaries: json("armSummaries").notNull(),
    comparisons: json("comparisons").notNull(),
    evidenceCounts: json("evidenceCounts").notNull(),
    limitations: json("limitations").notNull(),
    conclusion: varchar("conclusion", { length: 1024 }).notNull(),
    evidenceFingerprint: varchar("evidenceFingerprint", { length: 64 }).notNull(),
    resultHash: varchar("resultHash", { length: 64 }).notNull(),
    calculatedAt: varchar("calculatedAt", { length: 32 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => ({
    resultIdUnique: uniqueIndex("exr_result_uidx").on(table.resultId),
    resultNaturalUnique: uniqueIndex("exr_natural_uidx").on(
      table.userId,
      table.experimentId,
      table.calculationVersion
    ),
    experimentIdx: index("exr_experiment_idx").on(table.userId, table.experimentId),
  })
);

export type ExperimentResultRow = typeof experimentResults.$inferSelect;
export type InsertExperimentResultRow = typeof experimentResults.$inferInsert;
