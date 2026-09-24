import { publishToTwitter, type PublishPayload, type PublishResult } from "../platforms";
import {
  assertTransportFidelity,
  normalizeAdapterError,
  normalizeProviderReceipt,
  validatePublishPayloadContent,
  validationIssue,
  validationOk,
  type AdapterProviderError,
  type AdapterValidationResult,
  type AuthoritativePublicationInput,
  type NormalizedPublicationReceipt,
  type PlatformAdapter,
  type PublicationOperationIdentity,
} from "./platform-adapter";

/**
 * X (Twitter) adapter — wraps the existing `publishToTwitter` provider
 * function. Provider-side length constraints (280 chars) are enforced by the
 * API itself; the adapter transports the authoritative text verbatim and
 * never truncates or rewrites it.
 */

export interface TwitterAdapterDestination {
  accessToken: string;
}

export interface TwitterProviderRequest {
  /** Authoritative content, transported verbatim. */
  content: PublishPayload;
}

export interface TwitterAdapterDependencies {
  publish?: typeof publishToTwitter;
}

export function createTwitterAdapter(
  deps: TwitterAdapterDependencies = {}
): PlatformAdapter<TwitterAdapterDestination, TwitterProviderRequest> {
  const publishFn = deps.publish ?? publishToTwitter;

  return {
    platform: "twitter",

    validateInput(input: AuthoritativePublicationInput): AdapterValidationResult {
      return validatePublishPayloadContent(input.content);
    },

    validateDestination(destination: TwitterAdapterDestination): AdapterValidationResult {
      if (typeof destination.accessToken !== "string" || destination.accessToken.length === 0) {
        return validationIssue("destination_token_empty", "Twitter access token is required.");
      }
      return validationOk();
    },

    buildProviderRequest(
      input: AuthoritativePublicationInput,
      _destination: TwitterAdapterDestination
    ): TwitterProviderRequest {
      // Transport fidelity: the tweet text transported in the POST body is
      // the authoritative text, byte for byte.
      assertTransportFidelity(input, input.content.text);
      return { content: input.content };
    },

    async publish(
      request: TwitterProviderRequest,
      destination: TwitterAdapterDestination,
      operation: PublicationOperationIdentity
    ): Promise<NormalizedPublicationReceipt> {
      const raw: PublishResult = await publishFn(destination.accessToken, request.content);
      if (!raw.success) {
        throw normalizeAdapterError("twitter", raw.error ?? "Twitter publish failed.", operation);
      }
      return normalizeProviderReceipt("twitter", raw, operation);
    },

    normalizeReceipt(
      raw: PublishResult,
      operation: PublicationOperationIdentity
    ): NormalizedPublicationReceipt {
      return normalizeProviderReceipt("twitter", raw, operation);
    },

    normalizeError(error: unknown, operation?: PublicationOperationIdentity): AdapterProviderError {
      return normalizeAdapterError("twitter", error, operation);
    },
  };
}
