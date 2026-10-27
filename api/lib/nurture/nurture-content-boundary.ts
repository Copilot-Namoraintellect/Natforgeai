// ─── R6-D Nurture / Sales Handoff — generated-content boundary (contract D4) ───
//
// PURE module: model output is DRAFT CONTENT ONLY. This is the single safety
// gate every generated nurture/handoff draft must pass before a governed
// execution seam may carry it:
//
//   - strict structured schema (closed keys, bounded lengths);
//   - no protected/sensitive trait references;
//   - no secret/credential-shaped material;
//   - injection-pattern scanning (embedded instructions are inert text);
//   - no direct send capability: the validated draft carries no transport,
//     no provider, no credentials — execution is server-side only.
//
// A draft can never invoke a provider tool by itself: the transport seam
// accepts only server-built DispatchContent (buildDispatchContent), never raw
// model output. No I/O, no clock, no database access.

import { z } from "zod";
import { sha256Hex, canonicalJson } from "./nurture-identity";
import { NURTURE_CHANNELS, type NurtureChannel } from "./nurture-contract";

export const NURTURE_CONTENT_BOUNDARY_VERSION = "nurture-content-boundary/v1" as const;

export const MAX_DRAFT_SUBJECT_CHARS = 200;
export const MAX_DRAFT_BODY_CHARS = 4000;
export const MAX_DRAFT_CTA_CHARS = 200;

/**
 * Strict draft schema — closed key set. Extra keys (e.g. a smuggled
 * `providerCredentials`, `send`, `tool` field from model output) are
 * rejected, so a model can never self-authorize execution metadata.
 */
export const NurtureDraftContentSchema = z.strictObject({
  channel: z.enum(NURTURE_CHANNELS),
  subject: z.string().max(MAX_DRAFT_SUBJECT_CHARS).optional(),
  body: z.string().min(1).max(MAX_DRAFT_BODY_CHARS),
  cta: z.string().max(MAX_DRAFT_CTA_CHARS).optional(),
});

export type NurtureDraftContent = z.infer<typeof NurtureDraftContentSchema>;

export const NURTURE_CONTENT_ERROR_CODES = [
  "DRAFT_SCHEMA_INVALID",
  "DRAFT_INJECTION_SUSPECTED",
  "DRAFT_SECRET_PATTERN",
  "DRAFT_SENSITIVE_TRAIT_REFERENCE",
] as const;

export type NurtureContentErrorCode = (typeof NURTURE_CONTENT_ERROR_CODES)[number];

export class NurtureContentError extends Error {
  readonly code: NurtureContentErrorCode;
  readonly findings: readonly string[];

  constructor(code: NurtureContentErrorCode, message: string, findings: readonly string[] = []) {
    super(message);
    this.name = "NurtureContentError";
    this.code = code;
    this.findings = findings;
  }
}

function fail(code: NurtureContentErrorCode, message: string, findings: readonly string[] = []): never {
  throw new NurtureContentError(code, message, findings);
}

// ─── Injection patterns (untrusted text stays inert) ───

const INJECTION_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "ignore-previous-instructions", re: /ignore\s+(all\s+)?(previous|prior|the above)\s+instructions/i },
  { id: "system-prompt-reference", re: /(reveal|print|leak|exfiltrate)\s+(your|the)\s+(system\s+)?prompt/i },
  { id: "instruction-override", re: /you\s+(must|will|shall)\s+(now\s+)?(bypass|disable|skip)\s+(approval|policy|privacy|the gate)/i },
  { id: "tool-invocation-text", re: /\b(call|invoke|execute|run)\s+(the\s+)?(provider|transport|crm|email|send)\s+(tool|api|function|command)\b/i },
  { id: "credential-request", re: /\b(paste|include|show|send)\s+(your\s+)?(api\s*key|access\s*token|credentials?|secret)\b/i },
  { id: "role-override", re: /from\s+now\s+on\s+you\s+(are|will\s+act\s+as)/i },
];

// ─── Secret/credential-shaped material ───

const SECRET_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/ },
  { id: "vcs-token", re: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { id: "assigned-secret", re: /\b(api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"']{8,}["']?/i },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

// ─── Protected / sensitive trait references (never in outreach drafts) ───

const SENSITIVE_TRAIT_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "race-ethnicity-trait", re: /\b(your\s+(race|ethnicity|skin\s+color)|based\s+on\s+(race|ethnicity))\b/i },
  { id: "religion-trait", re: /\b(your\s+(religion|faith|beliefs?)|because\s+you\s+(are|worship))\b/i },
  { id: "political-trait", re: /\b(your\s+political\s+(beliefs?|affiliation|views?)|voted\s+for)\b/i },
  { id: "health-trait", re: /\b(your\s+(health|medical|diagnos|condition)|your\s+disabilit)\b/i },
  { id: "orientation-trait", re: /\b(your\s+sexual\s+orientation|your\s+gender\s+identity)\b/i },
];

function findMatches(
  text: string,
  patterns: ReadonlyArray<{ id: string; re: RegExp }>
): string[] {
  const hits: string[] = [];
  for (const { id, re } of patterns) {
    if (re.test(text)) hits.push(id);
  }
  return hits;
}

/** Validated draft: frozen, schema-bound, and carries zero execution authority. */
export interface ValidatedNurtureDraft {
  readonly boundaryVersion: typeof NURTURE_CONTENT_BOUNDARY_VERSION;
  readonly channel: NurtureChannel;
  readonly subject: string | null;
  readonly body: string;
  readonly cta: string | null;
  /** sha256 of the canonical draft — the content snapshot for approvals. */
  readonly contentHash: string;
}

/**
 * The single D4 validation gate. Throws NurtureContentError (fail closed);
 * returns a frozen ValidatedNurtureDraft on success.
 */
export function validateNurtureDraft(raw: unknown): ValidatedNurtureDraft {
  const parsed = NurtureDraftContentSchema.safeParse(raw);
  if (!parsed.success) {
    fail(
      "DRAFT_SCHEMA_INVALID",
      `Draft failed strict schema validation: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`
    );
  }
  const draft = parsed.data;
  const fullText = [draft.subject ?? "", draft.body, draft.cta ?? ""].join("\n");

  const secretHits = findMatches(fullText, SECRET_PATTERNS);
  if (secretHits.length > 0) {
    fail("DRAFT_SECRET_PATTERN", "Draft contains credential-shaped material; refusing to handle.", secretHits);
  }

  const injectionHits = findMatches(fullText, INJECTION_PATTERNS);
  if (injectionHits.length > 0) {
    fail("DRAFT_INJECTION_SUSPECTED", "Draft contains instruction-override patterns; treating as untrusted text and refusing.", injectionHits);
  }

  const traitHits = findMatches(fullText, SENSITIVE_TRAIT_PATTERNS);
  if (traitHits.length > 0) {
    fail("DRAFT_SENSITIVE_TRAIT_REFERENCE", "Draft references protected/sensitive traits; outreach may never use them.", traitHits);
  }

  return Object.freeze({
    boundaryVersion: NURTURE_CONTENT_BOUNDARY_VERSION,
    channel: draft.channel,
    subject: draft.subject ?? null,
    body: draft.body,
    cta: draft.cta ?? null,
    contentHash: sha256Hex(canonicalJson({ v: 1, draft })),
  });
}

/**
 * Server-built dispatch content — the ONLY content shape a transport seam
 * accepts. Built exclusively from a ValidatedNurtureDraft by governed
   service code; raw model output can never satisfy this call path without
 * passing validateNurtureDraft first.
 */
export interface DispatchContent {
  readonly boundaryVersion: typeof NURTURE_CONTENT_BOUNDARY_VERSION;
  readonly channel: NurtureChannel;
  readonly subject: string | null;
  readonly body: string;
  readonly cta: string | null;
  readonly contentHash: string;
}

export function buildDispatchContent(draft: ValidatedNurtureDraft): DispatchContent {
  return Object.freeze({
    boundaryVersion: draft.boundaryVersion,
    channel: draft.channel,
    subject: draft.subject,
    body: draft.body,
    cta: draft.cta,
    contentHash: draft.contentHash,
  });
}
