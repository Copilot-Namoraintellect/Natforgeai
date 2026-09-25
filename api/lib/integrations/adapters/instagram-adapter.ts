import { publishToInstagram, type PublishPayload, type PublishResult } from "../platforms";
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
 * Instagram adapter — wraps the existing two-step Graph API flow
 * (`publishToInstagram`: media container creation → media_publish). The
 * public-URL transport constraint is enforced inside the provider function
 * via `resolvePublicImageUrl`; the adapter does not re-interpret URLs so the
 * existing behaviour (relative URLs resolved against the public app URL)
 * stays unchanged.
 */

export interface InstagramAdapterDestination {
  accessToken: string;
  instagramBusinessAccountId: string;
}

export interface InstagramProviderRequest {
  /** Authoritative content, transported verbatim. */
  content: PublishPayload;
}

export interface InstagramAdapterDependencies {
  publish?: typeof publishToInstagram;
}

export function createInstagramAdapter(
  deps: InstagramAdapterDependencies = {}
): PlatformAdapter<InstagramAdapterDestination, InstagramProviderRequest> {
  const publishFn = deps.publish ?? publishToInstagram;

  return {
    platform: "instagram",

    validateInput(input: AuthoritativePublicationInput): AdapterValidationResult {
      return validatePublishPayloadContent(input.content);
    },

    validateDestination(destination: InstagramAdapterDestination): AdapterValidationResult {
      if (typeof destination.accessToken !== "string" || destination.accessToken.length === 0) {
        return validationIssue("destination_token_empty", "Instagram access token is required.");
      }
      if (
        typeof destination.instagramBusinessAccountId !== "string" ||
        destination.instagramBusinessAccountId.length === 0
      ) {
        return validationIssue(
          "destination_account_empty",
          "Instagram business account id is required."
        );
      }
      return validationOk();
    },

    buildProviderRequest(
      input: AuthoritativePublicationInput,
      _destination: InstagramAdapterDestination
    ): InstagramProviderRequest {
      // Transport fidelity: the caption transported to the media container is
      // the authoritative text, byte for byte.
      assertTransportFidelity(input, input.content.text);
      return { content: input.content };
    },

    async publish(
      request: InstagramProviderRequest,
      destination: InstagramAdapterDestination,
      operation: PublicationOperationIdentity
    ): Promise<NormalizedPublicationReceipt> {
      const raw: PublishResult = await publishFn(
        destination.accessToken,
        destination.instagramBusinessAccountId,
        request.content
      );
      if (!raw.success) {
        throw normalizeAdapterError(
          "instagram",
          raw.error ?? "Instagram publish failed.",
          operation
        );
      }
      return normalizeProviderReceipt("instagram", raw, operation);
    },

    normalizeReceipt(
      raw: PublishResult,
      operation: PublicationOperationIdentity
    ): NormalizedPublicationReceipt {
      return normalizeProviderReceipt("instagram", raw, operation);
    },

    normalizeError(error: unknown, operation?: PublicationOperationIdentity): AdapterProviderError {
      return normalizeAdapterError("instagram", error, operation);
    },
  };
}
