/**
 * .env redaction → configuration *inventory*. The backup captures which
 * keys exist and which non-secret values they carry — never the secrets.
 *
 * Value policy:
 *  - empty             → ""  (unchanged)
 *  - "true"/"false"    → kept (flags are not secrets)
 *  - integer           → kept (small config numbers are not secrets)
 *  - URL without userinfo → kept
 *  - everything else   → "<redacted>"
 */

export interface EnvInventoryEntry {
  key: string;
  value: string;
  redacted: boolean;
}

export interface EnvInventory {
  generatedBy: "r10-g-redact-env";
  schemaVersion: 1;
  entryCount: number;
  entries: EnvInventoryEntry[];
}

const SAFE_KEY_RE = /^(ENABLE_[A-Z_0-9]+|[A-Z_0-9]+_MODE|[A-Z_0-9]+_INTERVAL_MS|[A-Z_0-9]+_LEASE_SECONDS|[A-Z_0-9]+_HEARTBEAT_INTERVAL_SECONDS|[A-Z_0-9]+_CANARY_PERCENT|[A-Z_0-9]+_CREDIT_USD|[A-Z_0-9]+_CREDITS|DAILY_AI_CREDIT_LIMIT|MONTHLY_AI_CREDIT_LIMIT|POST_LIVE_LIFECYCLE_INTERVAL_MS|PREMIUM_TEMPLATE_PROVIDER|SMTP_HOST|SMTP_PORT|SMTP_SECURE|SMTP_FROM|SMTP_USER|PUBLIC_APP_URL|META_REDIRECT_URI|LINKEDIN_REDIRECT_URI|CREATIFY_API_BASE_URL|CREATIFY_WEBHOOK_URL|VIDEO_PROVIDER|OPENAI_IMAGE_MODEL|OPENAI_IMAGE_OUTPUT_FORMAT|OPENAI_IMAGE_QUALITY)$/;

function isUrlWithoutUserinfo(v: string): boolean {
  try {
    const u = new URL(v);
    return !u.username && !u.password;
  } catch {
    return false;
  }
}

export function classifyEnvValue(key: string, value: string): { value: string; redacted: boolean } {
  if (value === "") return { value, redacted: false };
  if (value === "true" || value === "false") return { value, redacted: false };
  if (/^-?\d+$/.test(value) && value.length <= 10) return { value, redacted: false };
  if (isUrlWithoutUserinfo(value)) return { value, redacted: false };
  if (SAFE_KEY_RE.test(key)) {
    // Key name is on the allow-list of known non-secret carriers; still never
    // pass through URLs with credentials or long tokens.
    if (/mysql:\/\//.test(value) || /:\/\//.test(value)) {
      const u = value.match(/^([a-z]+):\/\//);
      if (u && /[^/]*@/.test(value)) return { value: "<redacted>", redacted: true };
      return { value, redacted: false };
    }
    if (value.length > 80) return { value: "<redacted>", redacted: true };
    return { value, redacted: false };
  }
  return { value: "<redacted>", redacted: true };
}

export function redactEnv(content: string): EnvInventory {
  const entries: EnvInventoryEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.replace(/^["']|["']$/g, "");
    entries.push({ key, ...classifyEnvValue(key, value) });
  }
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return {
    generatedBy: "r10-g-redact-env",
    schemaVersion: 1,
    entryCount: entries.length,
    entries,
  };
}
