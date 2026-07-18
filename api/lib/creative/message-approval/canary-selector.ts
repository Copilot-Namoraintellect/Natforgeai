import { createHash } from "crypto";
import type { CreativePipelineV2Mode } from "./contracts";

export interface CanarySelectionScope {
  readonly campaignId: number;
  readonly businessId: number | null;
  readonly userId: number;
}

export interface CanarySelectionResult {
  readonly mode: CreativePipelineV2Mode;
  readonly selected: boolean;
  readonly reason:
    | "mode_off"
    | "mode_shadow"
    | "mode_active_reserved"
    | "mode_unknown"
    | "canary_disabled"
    | "campaign_allowlist"
    | "business_allowlist"
    | "user_allowlist"
    | "percent_bucket"
    | "percent_not_selected"
    | "salt_missing"
    | "non_selected";
  readonly bucket: number | null;
  readonly percent: number;
}

function normalizeMode(raw: string | null | undefined): CreativePipelineV2Mode {
  const value = String(raw ?? "off").toLowerCase().trim();
  if (value === "off" || value === "shadow" || value === "canary" || value === "active") {
    return value;
  }
  return "off";
}

function parseEnabled(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  return false;
}

function parseAllowlist(raw: string | null | undefined): Set<number> {
  if (!raw) return new Set();
  const values = raw
    .split(/[;,\s]+/)
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value));
  return new Set(values);
}

function parsePercent(raw: string | null | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > 100) return 100;
  return Math.floor(parsed);
}

function computeBucket(salt: string, scope: CanarySelectionScope): number {
  const payload = `${salt}|campaign:${scope.campaignId}|business:${scope.businessId ?? 0}|user:${scope.userId}`;
  const hex = createHash("sha256").update(payload, "utf8").digest("hex");
  const first = Number.parseInt(hex.slice(0, 8), 16);
  return first % 100;
}

export function resolveCanarySelection(
  scope: CanarySelectionScope,
  env: NodeJS.ProcessEnv = process.env
): CanarySelectionResult {
  const modeRaw = String(env.CREATIVE_PIPELINE_V2_MODE ?? "off").toLowerCase().trim();
  const mode = normalizeMode(modeRaw);

  if (modeRaw !== "off" && modeRaw !== "shadow" && modeRaw !== "canary" && modeRaw !== "active") {
    return { mode: "off", selected: false, reason: "mode_unknown", bucket: null, percent: 0 };
  }

  if (mode === "off") {
    return { mode, selected: false, reason: "mode_off", bucket: null, percent: 0 };
  }

  if (mode === "active") {
    return { mode: "off", selected: false, reason: "mode_active_reserved", bucket: null, percent: 0 };
  }

  if (mode === "shadow") {
    return { mode, selected: false, reason: "mode_shadow", bucket: null, percent: 0 };
  }

  const enabled = parseEnabled(env.CREATIVE_PIPELINE_V2_CANARY_ENABLED);
  if (!enabled) {
    return { mode, selected: false, reason: "canary_disabled", bucket: null, percent: 0 };
  }

  const campaignAllowlist = parseAllowlist(env.CREATIVE_PIPELINE_V2_CANARY_CAMPAIGN_IDS);
  const businessAllowlist = parseAllowlist(env.CREATIVE_PIPELINE_V2_CANARY_BUSINESS_IDS);
  const userAllowlist = parseAllowlist(env.CREATIVE_PIPELINE_V2_CANARY_USER_IDS);

  if (campaignAllowlist.has(scope.campaignId)) {
    return { mode, selected: true, reason: "campaign_allowlist", bucket: null, percent: 0 };
  }

  if (scope.businessId && businessAllowlist.has(scope.businessId)) {
    return { mode, selected: true, reason: "business_allowlist", bucket: null, percent: 0 };
  }

  if (userAllowlist.has(scope.userId)) {
    return { mode, selected: true, reason: "user_allowlist", bucket: null, percent: 0 };
  }

  const percent = parsePercent(env.CREATIVE_PIPELINE_V2_CANARY_PERCENT);
  const salt = String(env.CREATIVE_PIPELINE_V2_CANARY_SALT ?? "").trim();
  if (!salt) {
    return { mode, selected: false, reason: "salt_missing", bucket: null, percent };
  }

  const bucket = computeBucket(salt, scope);
  if (bucket < percent) {
    return { mode, selected: true, reason: "percent_bucket", bucket, percent };
  }

  return { mode, selected: false, reason: "percent_not_selected", bucket, percent };
}
