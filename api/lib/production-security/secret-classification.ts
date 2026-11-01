/**
 * R10-F — Secret classification (code form of the F2 taxonomy).
 *
 * Every runtime secret variable is assigned exactly one closed class; every
 * class lists its permitted reader service identities. This module is the
 * single authority both the secret broker and the security tests consume —
 * documentation (docs/contracts/production-security-configuration-contract.md)
 * and code cannot drift because tests assert this map covers env.ts.
 *
 * Rules:
 *  - Classes and readers are CLOSED vocabularies.
 *  - `agent-runtime` appears in NO reader list: agents never receive secrets.
 *  - BREAK_GLASS_SECRET has an empty runtime reader set by design: break-glass
 *    is human-console-only (see F8); no service identity may read it.
 *  - classifyEnvVar is deterministic and total: unknown names fail closed as
 *    APPLICATION_SECRET (most restrictive default readers).
 */

export const SECRET_CLASSES = [
  "PUBLIC_CONFIGURATION",
  "APPLICATION_SECRET",
  "DATABASE_SECRET",
  "PROVIDER_SECRET",
  "DEPLOYMENT_SECRET",
  "INFRASTRUCTURE_SECRET",
  "BACKUP_SECRET",
  "BREAK_GLASS_SECRET",
] as const;

export type SecretClass = (typeof SECRET_CLASSES)[number];

export const SERVICE_IDENTITIES = [
  "web-api",
  "worker",
  "scheduler",
  "migration-admin",
  "backup",
  "monitoring",
  "deployment",
  "provider-adapter",
  "agent-runtime",
] as const;

export type ServiceIdentity = (typeof SERVICE_IDENTITIES)[number];

/**
 * Permitted readers per secret class (least privilege). The application
 * runtime classes (web-api/worker/scheduler) never include infrastructure
 * admin, deployment, backup or break-glass authority — the application
 * runtime must not automatically hold infrastructure-admin privilege (F4).
 */
export const SECRET_CLASS_READERS: Readonly<Record<SecretClass, readonly ServiceIdentity[]>> = {
  PUBLIC_CONFIGURATION: [
    "web-api",
    "worker",
    "scheduler",
    "migration-admin",
    "backup",
    "monitoring",
    "deployment",
    "provider-adapter",
    "agent-runtime",
  ],
  APPLICATION_SECRET: ["web-api", "worker", "scheduler"],
  DATABASE_SECRET: ["web-api", "worker", "scheduler", "migration-admin"],
  PROVIDER_SECRET: ["web-api", "worker", "provider-adapter"],
  INFRASTRUCTURE_SECRET: ["web-api", "worker", "scheduler", "monitoring", "migration-admin"],
  DEPLOYMENT_SECRET: ["deployment"],
  BACKUP_SECRET: ["backup"],
  BREAK_GLASS_SECRET: [],
};

/** Deterministic env-var → class mapping. Longest/most specific wins. */
const CLASSIFIERS: ReadonlyArray<readonly [RegExp, SecretClass]> = [
  [/^(DATABASE_URL|MYSQL_URL|DB_URL|READ_ONLY_DATABASE_URL)$/i, "DATABASE_SECRET"],
  [/^REDIS_URL$/i, "INFRASTRUCTURE_SECRET"],
  [/^(GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_|GCP_|GCLOUD_)/i, "DEPLOYMENT_SECRET"],
  [/^BACKUP_[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD)/i, "BACKUP_SECRET"],
  [/^(BREAK_GLASS|EMERGENCY)[A-Z_]*$/i, "BREAK_GLASS_SECRET"],
  [/^APP_SECRET$/i, "APPLICATION_SECRET"],
  [/^(TOKEN_ENCRYPTION_KEY|FACEBOOK_WEBHOOK_VERIFY_TOKEN|OWNER_UNION_ID)$/i, "APPLICATION_SECRET"],
  [
    /(_API_KEY|_SECRET|_PASS|_PASSWORD|_PRIVATE_KEY|_CLIENT_SECRET|_SERVICE_ACCOUNT|WEBHOOK_SECRET|_TOKEN|_KEY|CREDENTIAL)$/i,
    "PROVIDER_SECRET",
  ],
];

const PUBLIC_CONFIGURATION_RE =
  /^(_?VITE_|PORT$|NODE_ENV$|PUBLIC_APP_URL$|APP_PUBLIC_URL$|BASE_URL$|APP_ID$|PHASE$|ENABLE_|REQUIRE_TWO_FACTOR$|PREMIUM_|CREATIVE_|POST_LIVE_|SOCIAL_LISTENING_|ENGAGEMENT_PROVIDER_|FREE_AI_|IMAGE_RENDER_|RENDERED_|QUALITY_|VISUAL_|HYBRID_|SMTP_FROM|SMTP_HOST|SMTP_PORT|SMTP_SECURE|OPENAI_IMAGE_|CREATIFY_CREDIT|CREATIFY_API_BASE_URL|CREATIFY_WEBHOOK_URL|DAILY_AI_|MONTHLY_AI_|AI_PROVIDER_TIMEOUT_MS|LIVE_EXECUTION$|TERMINAL_REPLAY_|WBS|NATFORGE_|KEEP_|CLEAN_|RESTORE_|SAMPLE_|DOTENV|OWNER_UNION_ID|KIMI_|VITE)/i;

/**
 * Classify an environment variable name. Browser-exposed VITE_ names are
 * public by construction (checked first); then the classified patterns;
 * then known non-secret config; unknown names fail closed to
 * APPLICATION_SECRET.
 */
export function classifyEnvVar(name: string): SecretClass {
  const key = name.trim();
  if (/^_?VITE_/i.test(key)) return "PUBLIC_CONFIGURATION";
  for (const [re, cls] of CLASSIFIERS) {
    if (re.test(key)) return cls;
  }
  if (PUBLIC_CONFIGURATION_RE.test(key)) return "PUBLIC_CONFIGURATION";
  return "APPLICATION_SECRET";
}

/** True when reader may read secrets of class cls. */
export function mayRead(reader: ServiceIdentity, cls: SecretClass): boolean {
  return SECRET_CLASS_READERS[cls].includes(reader);
}
