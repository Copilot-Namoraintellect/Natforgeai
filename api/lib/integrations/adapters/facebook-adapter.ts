import { publishToFacebook, type PublishPayload, type PublishResult } from "../platforms";
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
 * Facebook adapter — wraps the existing `publishToFacebook` provider
 * function (api/lib/integrations/platforms.ts) in the governed adapter
 * contract. Auth seam is preserved: the caller hands in the decrypted page
 * token and page id exactly as the publishing runner does today.
 */

export interface FacebookAdapterDestination {
  accessToken: string;
  pageId: string;
}

export interface FacebookProviderRequest {
  pageId: string;
  /** Authoritative content, transported verbatim. */
  content: PublishPayload;
}

export interface FacebookAdapterDependencies {
  publish?: typeof publishToFacebook;
}

export function createFacebookAdapter(
  deps: FacebookAdapterDependencies = {}
): PlatformAdapter<FacebookAdapterDestination, FacebookProviderRequest> {
  const publishFn = deps.publish ?? publishToFacebook;

  return {
    platform: "facebook",

    validateInput(input: AuthoritativePublicationInput): AdapterValidationResult {
      return validatePublishPayloadContent(input.content);
    },

    validateDestination(destination: FacebookAdapterDestination): AdapterValidationResult {
      if (typeof destination.accessToken !== "string" || destination.accessToken.length === 0) {
        return validationIssue("destination_token_empty", "Facebook access token is required.");
      }
      if (typeof destination.pageId !== "string" || destination.pageId.length === 0) {
        return validationIssue("destination_page_empty", "Facebook page id is required.");
      }
      return validationOk();
    },

    buildProviderRequest(
      input: AuthoritativePublicationInput,
      destination: FacebookAdapterDestination
    ): FacebookProviderRequest {
      // Transport fidelity: the message transported to Graph API is the
      // authoritative text, byte for byte. Endpoint selection (feed vs
      // photos) happens inside the provider function — transport-only.
      assertTransportFidelity(input, input.content.text);
      return { pageId: destination.pageId, content: input.content };
    },

    async publish(
      request: FacebookProviderRequest,
      destination: FacebookAdapterDestination,
      operation: PublicationOperationIdentity
    ): Promise<NormalizedPublicationReceipt> {
      const raw: PublishResult = await publishFn(
        destination.accessToken,
        request.pageId,
        request.content
      );
      if (!raw.success) {
        throw normalizeAdapterError("facebook", raw.error ?? "Facebook publish failed.", operation);
      }
      return normalizeProviderReceipt("facebook", raw, operation);
    },

    normalizeReceipt(
      raw: PublishResult,
      operation: PublicationOperationIdentity
    ): NormalizedPublicationReceipt {
      return normalizeProviderReceipt("facebook", raw, operation);
    },

    normalizeError(error: unknown, operation?: PublicationOperationIdentity): AdapterProviderError {
      return normalizeAdapterError("facebook", error, operation);
    },
  };
}
