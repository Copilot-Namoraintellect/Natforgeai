import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ?? "";
}

export const env = {
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
  appId: process.env.APP_ID ?? "",
  appSecret: required("APP_SECRET"),
  isProduction: process.env.NODE_ENV === "production",
  databaseUrl: required("DATABASE_URL"),
  firebaseServiceAccount: required("FIREBASE_SERVICE_ACCOUNT"),
  ownerUnionId: process.env.OWNER_UNION_ID ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiImageModel: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1",
  openaiImageOutputFormat: process.env.OPENAI_IMAGE_OUTPUT_FORMAT ?? "png",
  openaiImageQuality: process.env.OPENAI_IMAGE_QUALITY ?? "high",
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY ?? "",
  smtpHost: process.env.SMTP_HOST ?? "",
  smtpPort: parseInt(process.env.SMTP_PORT || "587"),
  smtpUser: process.env.SMTP_USER ?? "",
  smtpPass: process.env.SMTP_PASS ?? "",
  smtpFromEmail: process.env.SMTP_FROM_EMAIL ?? "",
  smtpFromName: process.env.SMTP_FROM_NAME ?? "",
  sendgridApiKey: process.env.SENDGRID_API_KEY ?? "",
  redisUrl: process.env.REDIS_URL ?? "",
  videoProvider: process.env.VIDEO_PROVIDER ?? "",
  requireTwoFactor: process.env.REQUIRE_TWO_FACTOR !== "false",

  // Social platform OAuth (Meta / LinkedIn)
  metaAppId: process.env.META_APP_ID ?? "",
  metaAppSecret: process.env.META_APP_SECRET ?? "",
  metaRedirectUri:
    process.env.META_REDIRECT_URI ?? "https://natforgeai.com/api/oauth/meta/callback",
  linkedinClientId: process.env.LINKEDIN_CLIENT_ID ?? "",
  linkedinClientSecret: process.env.LINKEDIN_CLIENT_SECRET ?? "",
  linkedinRedirectUri:
    process.env.LINKEDIN_REDIRECT_URI ?? "https://natforgeai.com/api/oauth/linkedin/callback",

  // Video feature flags
  enablePremiumVideo: process.env.ENABLE_PREMIUM_VIDEO === "true",
  enableBasicDraftVideo: process.env.ENABLE_BASIC_DRAFT_VIDEO === "true",

  // Premium template provider feature flags (Phase 2)
  enablePremiumTemplateProvider: process.env.ENABLE_PREMIUM_TEMPLATE_PROVIDER === "true",
  premiumTemplateProvider: process.env.PREMIUM_TEMPLATE_PROVIDER ?? "bannerbear",

  bannerbearApiKey: process.env.BANNERBEAR_API_KEY ?? "",
  bannerbearTemplateRetailProductPromo: process.env.BANNERBEAR_TEMPLATE_RETAIL_PRODUCT_PROMO ?? "",
  bannerbearTemplateServiceBusinessPromo: process.env.BANNERBEAR_TEMPLATE_SERVICE_BUSINESS_PROMO ?? "",
  bannerbearTemplateOfferDiscountCampaign: process.env.BANNERBEAR_TEMPLATE_OFFER_DISCOUNT_CAMPAIGN ?? "",

  templatedIoApiKey: process.env.TEMPLATED_IO_API_KEY ?? "",
  templatedIoTemplateRetailProductPromo: process.env.TEMPLATED_IO_TEMPLATE_RETAIL_PRODUCT_PROMO ?? "",
  templatedIoTemplateServiceBusinessPromo: process.env.TEMPLATED_IO_TEMPLATE_SERVICE_BUSINESS_PROMO ?? "",
  templatedIoTemplateOfferDiscountCampaign: process.env.TEMPLATED_IO_TEMPLATE_OFFER_DISCOUNT_CAMPAIGN ?? "",

  // Creative generation providers
  creatifyApiBaseUrl: process.env.CREATIFY_API_BASE_URL ?? "https://api.creatify.ai",
  creatifyApiId: process.env.CREATIFY_API_ID ?? "",
  creatifyApiKey: process.env.CREATIFY_API_KEY ?? "",
  creatifyWebhookUrl: process.env.CREATIFY_WEBHOOK_URL ?? "",
  heygenApiKey: process.env.HEYGEN_API_KEY ?? "",
  runwayApiKey: process.env.RUNWAY_API_KEY ?? "",

  // Creative generation credit pricing (NatForgeAI internal credits)
  premiumImageCredits: parseInt(process.env.PREMIUM_IMAGE_CREDITS || "10", 10),
  premiumVideoCredits: parseInt(process.env.PREMIUM_VIDEO_CREDITS || "100", 10),
  premiumHeroPackCredits: parseInt(process.env.PREMIUM_HERO_PACK_CREDITS || "120", 10),

  // Provider cost tracking (USD per Creatify credit; 0 = raw credits only)
  creatifyCreditUsd: parseFloat(process.env.CREATIFY_CREDIT_USD || "0"),

  // System AI usage limits (admin/system-level guardrails)
  dailyAiCreditLimit: parseInt(process.env.DAILY_AI_CREDIT_LIMIT || "500", 10),
  monthlyAiCreditLimit: parseInt(process.env.MONTHLY_AI_CREDIT_LIMIT || "5000", 10),
};

// Validate Redis in production
if (env.isProduction && !env.redisUrl) {
  throw new Error("Missing required environment variable: REDIS_URL");
}
