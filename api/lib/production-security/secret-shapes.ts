/**
 * R10-F — Secret-shape detection.
 *
 * Deterministic, pure detection of secret-shaped string values. Used by:
 *  - the model-payload guard (prompt/context exclusion, output screening);
 *  - the cross-surface redaction module (logs / errors / callbacks /
 *    diagnostics);
 *  - the repository secret scan (scripts/secret-scan.mjs mirrors these ids).
 *
 * Rules:
 *  - Pattern ids form a CLOSED vocabulary; add new shapes only with tests.
 *  - Every pattern is word-boundary anchored so prose such as
 *    "Risk-Intelligence" or "desk-webhook-signature" never matches.
 *  - No entropy heuristic is used on the fail-closed path: only explicit
 *    vendor shapes, credential URLs and credential blocks match. This keeps
 *    false positives (hashes, upstream ids) at zero on the guard path.
 *  - Synthetic fixtures only are ever tested; no real secret is embedded here.
 */

export const SECRET_SHAPE_IDS = [
  "OPENAI_KEY",
  "GOOGLE_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_KEY_FIELD",
  "GITHUB_PAT",
  "GITLAB_PAT",
  "SLACK_TOKEN",
  "STRIPE_SECRET_KEY",
  "PRIVATE_KEY_BLOCK",
  "BEARER_TOKEN",
  "BASIC_AUTH_URL",
  "DATABASE_DSN",
  "JWT",
] as const;

export type SecretShapeId = (typeof SECRET_SHAPE_IDS)[number];

interface SecretShapePattern {
  readonly id: SecretShapeId;
  readonly re: RegExp;
}

const BOUNDARY_BEFORE = String.raw`(?<![A-Za-z0-9])`;

export const SECRET_SHAPE_PATTERNS: readonly SecretShapePattern[] = [
  { id: "OPENAI_KEY", re: new RegExp(BOUNDARY_BEFORE + String.raw`sk-[a-zA-Z0-9_-]{16,}`, "g") },
  { id: "GOOGLE_API_KEY", re: new RegExp(BOUNDARY_BEFORE + String.raw`AIza[0-9A-Za-z_-]{20,}`, "g") },
  { id: "AWS_ACCESS_KEY_ID", re: new RegExp(BOUNDARY_BEFORE + String.raw`AKIA[0-9A-Z]{16}(?![A-Za-z0-9])`, "g") },
  {
    id: "AWS_SECRET_KEY_FIELD",
    re: /(?:aws.{0,12}secret.{0,4}(?:access)?key|secretAccessKey)["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{32,}/gi,
  },
  { id: "GITHUB_PAT", re: new RegExp(BOUNDARY_BEFORE + String.raw`gh[psour]_[a-zA-Z0-9]{20,}`, "g") },
  { id: "GITLAB_PAT", re: new RegExp(BOUNDARY_BEFORE + String.raw`glpat-[a-zA-Z0-9_-]{16,}`, "g") },
  { id: "SLACK_TOKEN", re: new RegExp(BOUNDARY_BEFORE + String.raw`xox[baprs]-[a-zA-Z0-9-]{10,}`, "g") },
  { id: "STRIPE_SECRET_KEY", re: new RegExp(BOUNDARY_BEFORE + String.raw`(?:sk|rk)_live_[a-zA-Z0-9]{16,}`, "g") },
  // Header line + base64 material: a bare header (a public constant) does
  // not match, so allowlisting the header is never required.
  {
    id: "PRIVATE_KEY_BLOCK",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{16,}/g,
  },
  { id: "BEARER_TOKEN", re: /Bearer\s+[a-zA-Z0-9._-]{24,}/g },
  // user:password@host URL userinfo with any non-trivial password. Deliberately
  // LOOSER than the repository scan's placeholder vocabulary: on the
  // fail-closed guard/redact path, over-masking a placeholder is safe while
  // under-masking a credential is not. Placeholder tolerance lives only in
  // scripts/secret-scan.mjs.
  {
    id: "DATABASE_DSN",
    re: /(?:mysql|postgres(?:ql)?|mariadb|redis):\/\/[^\s:/]{1,64}:[^\s@]{2,}@[^\s"'`)]+/gi,
  },
  {
    id: "BASIC_AUTH_URL",
    re: /(?<![a-z0-9.+_-])(?!(?:mysql|mariadb|postgres|postgresql|redis):\/\/)[a-z][a-z0-9+.-]*:\/\/[^\s/:]{1,64}:[^\s@]{2,}@[^\s"'`)]+/gi,
  },
  { id: "JWT", re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
] as const;

/**
 * Return the sorted, de-duplicated list of secret-shape ids found in value.
 * Pure; never throws; O(len(patterns) * len(value)).
 */
export function detectSecretShapes(value: string): SecretShapeId[] {
  if (typeof value !== "string" || value.length === 0) return [];
  const found = new Set<SecretShapeId>();
  for (const { id, re } of SECRET_SHAPE_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(value)) found.add(id);
  }
  return Array.from(found).sort();
}

/** True when the string contains at least one secret-shaped value. */
export function containsSecretShape(value: string): boolean {
  return detectSecretShapes(value).length > 0;
}

/**
 * Replace every secret-shaped run inside value with mask (default "***"),
 * preserving surrounding text. Used for in-place redaction of larger strings
 * (log lines, error messages) where context readability matters.
 */
export function maskSecretShapes(value: string, mask: string = "***"): string {
  if (typeof value !== "string" || value.length === 0) return value;
  let out = value;
  for (const { re } of SECRET_SHAPE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, mask);
  }
  return out;
}
