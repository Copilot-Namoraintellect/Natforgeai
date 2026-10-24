/**
 * Listening webhook boundary (WBS-R5-A A5).
 *
 * Authenticates → parses → ingests one webhook delivery. Meta surfaces are
 * HMAC-verified; platforms with no verifier fail closed (401) rather than
 * accept unverifiable events. Replayed/tampered deliveries are rejected by
 * the authenticity check; legitimately redelivered events are collapsed by
 * the exact-once store (duplicate dispositions, 200).
 */

import { getListeningAdapter } from "./adapters";
import { SignalContractError } from "./signal-contract";
import { ingestRawSignalEvent, type IngestDeps, type IngestionDisposition } from "./ingest";

export interface ListeningWebhookOutcome {
  httpStatus: number;
  received: boolean;
  dispositions: IngestionDisposition[];
  error?: string;
}

const PLATFORM_PROVIDERS: Record<string, string> = {
  facebook: "meta",
  instagram: "meta",
  whatsapp: "meta",
  linkedin: "linkedin",
};

export async function processListeningWebhook(
  input: {
    platform: string;
    rawBody: string;
    signature: string;
    appSecret?: string;
  },
  deps: IngestDeps = {}
): Promise<ListeningWebhookOutcome> {
  const { platform, rawBody, signature } = input;
  const providerId = PLATFORM_PROVIDERS[platform];

  if (!providerId) {
    return {
      httpStatus: 401,
      received: false,
      dispositions: [],
      error: `Unsupported listening platform: ${platform}`,
    };
  }

  const adapter = getListeningAdapter(providerId);
  const capability = adapter.capabilityFor(platform);
  if (!capability || capability.webhook !== "supported") {
    // No verifier exists for this surface — fail closed, never accept
    // unverifiable events.
    return {
      httpStatus: 401,
      received: false,
      dispositions: [],
      error: `Webhook listening is not supported for platform: ${platform}`,
    };
  }

  const appSecret = input.appSecret ?? "";
  if (!appSecret || !adapter.verifyWebhookAuthenticity({ rawBody, headers: { "x-hub-signature-256": signature }, appSecret })) {
    return {
      httpStatus: 401,
      received: false,
      dispositions: [],
      error: "Invalid webhook signature",
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return {
      httpStatus: 400,
      received: false,
      dispositions: [],
      error: "Malformed webhook payload",
    };
  }

  let events;
  try {
    events = adapter.parseWebhookPayload(platform as never, payload);
  } catch (err) {
    if (err instanceof SignalContractError) {
      return {
        httpStatus: 422,
        received: false,
        dispositions: [],
        error: err.message,
      };
    }
    throw err;
  }

  const dispositions: IngestionDisposition[] = [];
  for (const event of events) {
    const outcome = await ingestRawSignalEvent(platform, event, deps);
    dispositions.push(outcome.disposition);
  }

  return { httpStatus: 200, received: true, dispositions };
}
