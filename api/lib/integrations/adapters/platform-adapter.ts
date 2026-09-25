import type { PublishPayload, PublishResult } from "../platforms";

/**
 * WBS13.3 — Governed platform adapter boundary.
 *
 * A PlatformAdapter translates an ALREADY-AUTHORITATIVE publication payload
 * into platform-specific provider requests. The adapter is the last transport
 * seam before the provider: it owns validation, deterministic payload
 * building, submission through the existing provider functions, and receipt /
 * error normalization.
 *
 * Governance contract — what adapters may and may not do:
 *
 *  PERMITTED (transport/format transformation only):
 *    - structural validation of input and destination
 *    - deterministic provider request construction (endpoint selection,
 *      query/body encoding, media routing)
 *    - delegating submission to the existing provider functions in
 *      `../platforms` (the existing auth seam: decrypted tokens are handed in
 *      by the caller, never read from storage here)
 *    - normalizing provider receipts/errors into stable shapes
 *
 *  PROHIBITED (semantic rewriting):
 *    - rewriting, trimming, summarizing, or "improving" copy
 *    - generating or substituting CTAs, hooks, captions, hashtags, or claims
 *    - rereading mutable Strategy/Creative state to regenerate content
 *    - calling any Creative/AI generation pipeline
 *
 * The invariant that enforces this is `assertTransportFidelity`: the message
 * text transported to the provider must be byte-identical to the
 * authoritative input text. Formatting around the text (endpoints, params,
 * envelopes) may differ per platform; the text itself may not.
 */

export const PLATFORM_ADAPTER_IDS = ["facebook", "instagram", "linkedin", "twitter"] as const;

export type PlatformAdapterId = (typeof PLATFORM_ADAPTER_IDS)[number];

export function isPlatformAdapterId(value: string): value is PlatformAdapterId {
  return (PLATFORM_ADAPTER_IDS as readonly string[]).includes(value);
}

/**
 * Stable identity for one logical publication operation. A retry of the same
 * operation MUST reuse the same operationId so retries stay the same
 * publication — never a semantic regeneration.
 */
export interface PublicationOperationIdentity {
  operationId: string;
}

/**
 * Reference fields a caller can derive a stable operation identity from.
 * Either a publishing-queue item id or a content-post id is required so the
 * derived identity stays deterministic across retries.
 */
export interface PublicationOperationRef {
  queueItemId?: number | string | null;
  contentPostId?: number | string | null;
  platform: string;
}

export function derivePublicationOperationId(ref: PublicationOperationRef): string {
  if (ref.queueItemId !== undefined && ref.queueItemId !== null && ref.queueItemId !== "") {
    return `publication:${ref.platform}:${ref.queueItemId}`;
  }
  if (ref.contentPostId !== undefined && ref.contentPostId !== null && ref.contentPostId !== "") {
    return `publication:${ref.platform}:${ref.contentPostId}`;
  }
  throw new Error(
    "derivePublicationOperationId requires a stable queueItemId or contentPostId so retries keep one publication identity."
  );
}

/**
 * The minimal generic adapter input contract. `content` reuses the repo's
 * existing common publication payload type (`PublishPayload`) verbatim, so
 * this boundary can later consume Stream 4's immutable PublishPackage through
 * a thin mapping without inventing conflicting semantics.
 */
export interface AuthoritativePublicationInput extends PublicationOperationIdentity {
  content: PublishPayload;
}

export interface AdapterValidationIssue {
  code: string;
  message: string;
}

export interface AdapterValidationResult {
  ok: boolean;
  issues: AdapterValidationIssue[];
}

export function validationOk(): AdapterValidationResult {
  return { ok: true, issues: [] };
}

export function validationIssue(code: string, message: string): AdapterValidationResult {
  return { ok: false, issues: [{ code, message }] };
}

export function combineValidation(
  ...results: AdapterValidationResult[]
): AdapterValidationResult {
  const issues = results.flatMap(r => r.issues);
  return { ok: issues.length === 0, issues };
}

/**
 * Structural validation of the authoritative content itself. Adapters run
 * this in validateInput. It checks shape only — it never mutates or normalizes
 * the text.
 */
export function validatePublishPayloadContent(content: PublishPayload): AdapterValidationResult {
  const issues: AdapterValidationIssue[] = [];

  if (typeof content.text !== "string" || content.text.trim().length === 0) {
    issues.push({
      code: "content_text_empty",
      message: "Authoritative publication text must be a non-empty string.",
    });
  }

  if (content.mediaUrls !== undefined) {
    if (
      !Array.isArray(content.mediaUrls) ||
      content.mediaUrls.length === 0 ||
      content.mediaUrls.some(u => typeof u !== "string" || u.trim().length === 0)
    ) {
      issues.push({
        code: "content_media_invalid",
        message: "mediaUrls must be a non-empty array of non-empty URL strings when present.",
      });
    }
  }

  if (content.mediaType !== undefined && content.mediaType !== "image" && content.mediaType !== "video") {
    issues.push({
      code: "content_media_type_invalid",
      message: 'mediaType must be "image" or "video" when present.',
    });
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Provider-independent normalized receipt. `operationId` echoes the identity
 * the operation was submitted under so callers can match retries to the
 * original publication.
 */
export interface NormalizedPublicationReceipt extends PublicationOperationIdentity {
  platform: string;
  status: "published";
  externalPostId?: string;
  externalUrl?: string;
}

export type AdapterErrorCategory =
  | "auth"
  | "validation"
  | "rate_limited"
  | "network"
  | "provider"
  | "unsupported";

/**
 * Normalized provider failure. `retryable` answers: "could a retry of the
 * identical operation (same content, same operationId) succeed?" — not
 * "should the runner retry?" (the publishing runner keeps owning its own
 * retry policy).
 */
export interface AdapterProviderError {
  platform: string;
  category: AdapterErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  operationId?: string;
}

const PROVIDER_ERROR_PATTERNS: Array<{
  category: AdapterErrorCategory;
  code: string;
  retryable: boolean;
  patterns: RegExp[];
}> = [
  {
    category: "auth",
    code: "provider_auth",
    retryable: false,
    patterns: [/unauthor/i, /invalid.{0,20}token/i, /expired.{0,20}token/i, /oauth/i, /\b401\b/, /\b403\b/],
  },
  {
    category: "rate_limited",
    code: "provider_rate_limited",
    retryable: true,
    patterns: [/rate.?limit/i, /too many requests/i, /\b429\b/],
  },
  {
    category: "unsupported",
    code: "provider_unsupported",
    retryable: false,
    patterns: [/not supported/i, /requires video upload/i, /unsupported/i, /requires a recipient/i],
  },
  {
    category: "validation",
    code: "provider_validation",
    retryable: false,
    patterns: [/bad request/i, /\b400\b/, /invalid/i, /missing/i, /required/i, /url/i],
  },
  {
    category: "network",
    code: "provider_network",
    retryable: true,
    patterns: [
      /fetch failed/i,
      /network/i,
      /econn/i,
      /enotfound/i,
      /etimedout/i,
      /eai_again/i,
      /socket/i,
      /timeout/i,
      /timed out/i,
    ],
  },
];

/**
 * Deterministic error classification: fixed rule order, first match wins, so
 * the same provider message always yields the same normalized error.
 */
export function classifyProviderErrorMessage(message: string): {
  category: AdapterErrorCategory;
  code: string;
  retryable: boolean;
} {
  for (const rule of PROVIDER_ERROR_PATTERNS) {
    if (rule.patterns.some(p => p.test(message))) {
      return { category: rule.category, code: rule.code, retryable: rule.retryable };
    }
  }
  return { category: "provider", code: "provider_error", retryable: true };
}

export function normalizeProviderReceipt(
  platform: string,
  raw: PublishResult,
  operation: PublicationOperationIdentity
): NormalizedPublicationReceipt {
  return {
    platform,
    operationId: operation.operationId,
    status: "published",
    externalPostId: raw.postId,
    externalUrl: raw.url,
  };
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function normalizeAdapterError(
  platform: string,
  error: unknown,
  operation?: PublicationOperationIdentity
): AdapterProviderError {
  const message = errorMessageOf(error);
  const { category, code, retryable } = classifyProviderErrorMessage(message);
  return {
    platform,
    category,
    code,
    message,
    retryable,
    ...(operation ? { operationId: operation.operationId } : {}),
  };
}

/**
 * The transport-fidelity invariant. Every adapter calls this while building
 * its provider request, comparing the message text it is about to transport
 * against the authoritative input. If they differ, the adapter attempted
 * semantic rewriting and the build fails closed.
 */
export function assertTransportFidelity(
  input: AuthoritativePublicationInput,
  transportedText: string
): void {
  if (transportedText !== input.content.text) {
    throw new Error(
      "Adapter transport modified authoritative copy text. Only transport/format transformation is permitted; semantic rewriting is prohibited."
    );
  }
}

/**
 * The governed platform adapter boundary.
 *
 * @typeParam TDestination - caller-supplied credential/routing material
 *   (already-decrypted tokens — the existing auth seam is preserved: the
 *   publishing runner decrypts, the adapter only transports).
 * @typeParam TProviderRequest - the deterministic provider request envelope.
 */
export interface PlatformAdapter<TDestination, TProviderRequest> {
  readonly platform: PlatformAdapterId;

  /** Structural validation of the authoritative input (no mutation). */
  validateInput(input: AuthoritativePublicationInput): AdapterValidationResult;

  /** Structural validation of destination credentials/routing. */
  validateDestination(destination: TDestination): AdapterValidationResult;

  /**
   * Deterministic provider request construction. Same (input, destination)
   * always yields the same request. Semantics of the text are untouched —
   * enforced by assertTransportFidelity inside each implementation.
   */
  buildProviderRequest(
    input: AuthoritativePublicationInput,
    destination: TDestination
  ): TProviderRequest;

  /**
   * Submit one already-built request under a stable operation identity.
   * Delegates to the existing provider function. Resolves with a normalized
   * receipt; rejects with a normalized AdapterProviderError.
   */
  publish(
    request: TProviderRequest,
    destination: TDestination,
    operation: PublicationOperationIdentity
  ): Promise<NormalizedPublicationReceipt>;

  /** Normalize a raw provider result into the stable receipt shape. */
  normalizeReceipt(
    raw: PublishResult,
    operation: PublicationOperationIdentity
  ): NormalizedPublicationReceipt;

  /** Normalize any thrown/rejected failure into the stable error shape. */
  normalizeError(error: unknown, operation?: PublicationOperationIdentity): AdapterProviderError;
}
