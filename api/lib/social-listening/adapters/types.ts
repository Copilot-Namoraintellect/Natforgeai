/**
 * Provider-neutral listening adapter boundary (WBS-R5-A A2).
 *
 * A SocialListeningAdapter converts validated provider payloads into
 * provider-neutral raw signal events. It owns:
 *
 *   PERMITTED:
 *    - webhook authenticity verification (where the provider supports one)
 *    - provider payload parsing into bounded, validated raw signal events
 *    - provider-specific event type mapping onto the canonical signal types
 *    - preserving the canonical evidence fragment needed for audit/reconciliation
 *    - cursor-based event fetching for polling (injected fetch seam — the
 *      adapter never holds credentials)
 *
 *   PROHIBITED:
 *    - any sentiment/qualification/scoring/engagement decision
 *    - persistence (the signal store owns that)
 *    - reading tokens from storage (callers hand decrypted material in)
 *    - inventing provider capabilities — anything unrecognized maps to
 *      "unknown" or is rejected; unsupported mechanisms report unsupported
 *      and fail closed.
 *
 * Raw events are still provider-shaped. Canonical minting (identity,
 * authority binding, attribution, persistence) happens downstream in the
 * ingestion pipeline where business/user context is authoritative.
 */

import type {
  SocialSignalPlatform,
  SocialSignalProvider,
  SocialSignalType,
} from "../signal-contract";

/**
 * One normalized-but-not-yet-canonical provider event. All fields were
 * validated and bounded by the adapter; `evidence` is the canonical fragment
 * (key-sorted-JSON hashable) that will back providerEvidenceHash.
 */
export interface RawSocialSignalEvent {
  /** Provider account (page/account id) the event arrived on. */
  providerAccountId: string;
  externalEventId: string;
  externalObjectId: string | null;
  parentExternalObjectId: string | null;
  /** Canonical signal type after provider mapping. */
  signalType: SocialSignalType;
  occurredAt: Date;
  actorReference: string | null;
  actorDisplayName: string | null;
  contentReference: string | null;
  /** Raw text — sanitized/bounded by the contract before persistence. */
  contentText: unknown;
  /** Canonical evidence fragment for providerEvidenceHash. */
  evidence: Record<string, unknown>;
}

/** How one platform surface can be listened to. */
export type ListeningMechanismSupport = "supported" | "unsupported";

export interface PlatformListeningCapability {
  platform: SocialSignalPlatform;
  webhook: ListeningMechanismSupport;
  polling: ListeningMechanismSupport;
}

export interface WebhookVerificationInput {
  rawBody: string;
  headers: Record<string, string | undefined>;
  /** Caller-supplied secret material (never read from storage here). */
  appSecret: string;
}

export interface PollingFetchInput {
  platform: SocialSignalPlatform;
  providerAccountId: string;
  /** Caller-supplied decrypted access token (never read from storage here). */
  accessToken: string;
  cursor: string | null;
  limit: number;
}

export interface PollingFetchResult {
  events: RawSocialSignalEvent[];
  /** Opaque monotonic checkpoint for the next pass; null when provider
   *  returned no further pages. */
  nextCursor: string | null;
}

export interface SocialListeningAdapter {
  readonly provider: SocialSignalProvider;
  readonly capabilities: readonly PlatformListeningCapability[];

  capabilityFor(platform: string): PlatformListeningCapability | null;

  /** True only when cryptographic authenticity is proven. Providers without
   *  a verifier must return false and be treated fail-closed by callers. */
  verifyWebhookAuthenticity(input: WebhookVerificationInput): boolean;

  /** Parse a verified webhook payload into raw signal events. Unknown shapes
   *  are ignored; malformed identity material throws SignalContractError. */
  parseWebhookPayload(
    platform: SocialSignalPlatform,
    payload: unknown
  ): RawSocialSignalEvent[];

  /** Fetch one bounded page of events for polling. Implementations that
   *  would call a live provider without an injected fetch seam must throw
   *  LISTENING_NOT_CONFIGURED (fail closed, never fake success). */
  fetchEvents(input: PollingFetchInput): Promise<PollingFetchResult>;
}

/** Deterministic cap on events parsed from one provider payload / page. */
export const MAX_EVENTS_PER_PAYLOAD = 100;
export const POLLING_DEFAULT_PAGE_SIZE = 25;
export const POLLING_MAX_PAGE_SIZE = 100;
