/**
 * LinkedIn listening adapter.
 *
 * LinkedIn has NO webhook authenticity verifier in this codebase, so the
 * webhook mechanism is explicitly unsupported and fails closed (verify →
 * false, parse → []). Polling is the supported mechanism and is cursor-based;
 * the live API fetch is an operator-injected seam — without it, fetchEvents
 * fails closed with LISTENING_NOT_CONFIGURED rather than faking success.
 */

import { SignalContractError } from "../signal-contract";
import {
  POLLING_DEFAULT_PAGE_SIZE,
  type PollingFetchInput,
  type PollingFetchResult,
  type PlatformListeningCapability,
  type RawSocialSignalEvent,
  type SocialListeningAdapter,
  type WebhookVerificationInput,
} from "./types";

const CAPABILITIES: readonly PlatformListeningCapability[] = [
  { platform: "linkedin", webhook: "unsupported", polling: "supported" },
];

export type LinkedInPollingFetcher = (
  input: PollingFetchInput
) => Promise<PollingFetchResult>;

export class LinkedInListeningAdapter implements SocialListeningAdapter {
  readonly provider = "linkedin" as const;
  readonly capabilities = CAPABILITIES;
  private readonly fetcher?: LinkedInPollingFetcher;

  constructor(fetcher?: LinkedInPollingFetcher) {
    this.fetcher = fetcher;
  }

  capabilityFor(platform: string): PlatformListeningCapability | null {
    return CAPABILITIES.find((c) => c.platform === platform) ?? null;
  }

  verifyWebhookAuthenticity(_input: WebhookVerificationInput): boolean {
    // No LinkedIn webhook verifier exists in this codebase. Fail closed.
    return false;
  }

  parseWebhookPayload(): RawSocialSignalEvent[] {
    // Unsupported mechanism — never invent events.
    return [];
  }

  async fetchEvents(input: PollingFetchInput): Promise<PollingFetchResult> {
    if (!this.fetcher) {
      throw new SignalContractError(
        "MALFORMED_SIGNAL",
        "LISTENING_NOT_CONFIGURED: linkedin polling fetch seam is not configured"
      );
    }
    const limit =
      Number.isSafeInteger(input.limit) && input.limit > 0
        ? Math.min(input.limit, 100)
        : POLLING_DEFAULT_PAGE_SIZE;
    return this.fetcher({ ...input, limit });
  }
}
