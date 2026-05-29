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
  website: varchar("website", { length: 255 }),
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
  startDate: date("startDate"),
  endDate: date("endDate"),
  strategy: text("strategy"),
  personas: json("personas"),
  contentCalendar: json("contentCalendar"),
  adConcepts: json("adConcepts"),
  funnelStages: json("funnelStages"),
  offers: json("offers"),
  ctaStrategy: text("ctaStrategy"),
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
  prompt: text("prompt").notNull(),
  url: text("url").notNull(),
  aspectRatio: varchar("aspectRatio", { length: 10 }).default("1:1"),
  style: varchar("style", { length: 100 }),
  status: mysqlEnum("status", ["pending", "completed", "failed"])
    .default("pending")
    .notNull(),
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
