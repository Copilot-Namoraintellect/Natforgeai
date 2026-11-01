/**
 * Pre-flight secret scan. A backup set is aborted (never shipped) if any
 * payload matches a secret pattern. Scans bytes only — the caller decides
 * what to do with a hit (the harness aborts and alerts).
 */

export interface SecretFinding {
  pattern: string;
  /** 1-based line number. */
  line: number;
  /** Redacted excerpt (≤ 60 chars, secret portion masked). */
  excerpt: string;
}

export interface SecretScanResult {
  clean: boolean;
  findings: SecretFinding[];
}

interface PatternDef {
  name: string;
  re: RegExp;
  /** Redact everything after this marker within the match. */
  maskFrom?: RegExp;
}

const PATTERNS: PatternDef[] = [
  { name: "AWS_ACCESS_KEY_ID", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "PRIVATE_KEY_BLOCK", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "OPENAI_API_KEY", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "JWT_BEARER", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    name: "MYSQL_DSN_WITH_PASSWORD",
    re: /mysql:\/\/[^\s:/@]+:[^\s@]+@/,
  },
  {
    name: "ENV_SECRET_ASSIGNMENT",
    re: /^\s*(APP_SECRET|SMTP_PASS|OPENAI_API_KEY|META_APP_SECRET|LINKEDIN_CLIENT_SECRET|CREATIFY_API_KEY|BANNERBEAR_API_KEY|TEMPLATED_IO_API_KEY|FIREBASE_SERVICE_ACCOUNT)\s*=\s*\S+.{0,}/m,
    maskFrom: /^\s*[A-Z_0-9]+\s*=\s*/,
  },
  { name: "FIREBASE_PRIVATE_KEY_FIELD", re: /"private_key"\s*:\s*"-----BEGIN/ },
  { name: "GENERIC_PASSWORD_ASSIGNMENT", re: /^\s*(DB_PASSWORD|DATABASE_PASSWORD|MYSQL_PASSWORD|REDIS_PASSWORD)\s*=\s*\S+/m, maskFrom: /^\s*[A-Z_0-9]+\s*=\s*/ },
];

function maskExcerpt(line: string, def: PatternDef): string {
  let cut = line;
  if (def.maskFrom) {
    const m = cut.match(def.maskFrom);
    if (m && m.index !== undefined) {
      cut = cut.slice(0, m.index + m[0].length) + "********";
    }
  }
  return cut.replace(/[^\x20-\x7e]/g, "?").slice(0, 60);
}

/** Scan text content. `source` labels findings (e.g. a relative path). */
export function scanText(content: string, source = "<buffer>"): SecretScanResult {
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 4096) {
      // Very long lines: scan in chunks to avoid regex backtracking surprises.
      for (const def of PATTERNS) {
        if (def.re.test(line)) {
          findings.push({ pattern: def.name, line: i + 1, excerpt: maskExcerpt(line.slice(0, 200), def) });
          break;
        }
      }
      continue;
    }
    for (const def of PATTERNS) {
      if (def.re.test(line)) {
        findings.push({ pattern: def.name, line: i + 1, excerpt: maskExcerpt(line, def) });
        break;
      }
    }
  }
  return { clean: findings.length === 0, findings: findings.map((f) => ({ ...f, pattern: `${source}:${f.pattern}` })) };
}

/** Scan a binary buffer (decoded as latin1 so byte positions survive). */
export function scanBuffer(buf: Buffer, source = "<buffer>"): SecretScanResult {
  return scanText(buf.toString("latin1"), source);
}
