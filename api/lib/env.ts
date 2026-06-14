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
};

// Validate Redis in production
if (env.isProduction && !env.redisUrl) {
  throw new Error("Missing required environment variable: REDIS_URL");
}
