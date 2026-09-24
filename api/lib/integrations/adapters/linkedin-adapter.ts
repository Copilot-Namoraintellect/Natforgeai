import { publishToLinkedIn, type PublishPayload, type PublishResult } from "../platforms";
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
 * LinkedIn adapter — wraps the existing `publishToLinkedIn` provider
 * function. The runner currently passes `integration.accountName` as the
 * organization id; that seam is preserved unchanged — the caller decides
 * what routing identity to hand in.
 */

export interface LinkedInAdapterDestination {
  accessToken: string;
  organizationId: string;
}

export interface LinkedInProviderRequest {
  /** Authoritative content, transported verbatim. */
  content: PublishPayload;
}

export interface LinkedInAdapterDependencies {
  publish?: typeof publishToLinkedIn;
}

export function createLinkedInAdapter(
  deps: LinkedInAdapterDependencies = {}
): PlatformAdapter<LinkedInAdapterDestination, LinkedInProviderRequest> {
  const publishFn = deps.publish ?? publishToLinkedIn;

  return {
    platform: "linkedin",

    validateInput(input: AuthoritativePublicationInput): AdapterValidationResult {
      return validatePublishPayloadContent(input.content);
    },

    validateDestination(destination: LinkedInAdapterDestination): AdapterValidationResult {
      if (typeof destination.accessToken !== "string" || destination.accessToken.length === 0) {
        return validationIssue("destination_token_empty", "LinkedIn access token is required.");
      }
      if (
        typeof destination.organizationId !== "string" ||
        destination.organizationId.length === 0
      ) {
        return validationIssue("destination_org_empty", "LinkedIn organization id is required.");
      }
      return validationOk();
    },

    buildProviderRequest(
      input: AuthoritativePublicationInput,
      _destination: LinkedInAdapterDestination
    ): LinkedInProviderRequest {
      // Transport fidelity: the shareCommentary text transported in the UGC
      // post body is the authoritative text, byte for byte.
      assertTransportFidelity(input, input.content.text);
      return { content: input.content };
    },

    async publish(
      request: LinkedInProviderRequest,
      destination: LinkedInAdapterDestination,
      operation: PublicationOperationIdentity
    ): Promise<NormalizedPublicationReceipt> {
      const raw: PublishResult = await publishFn(
        destination.accessToken,
        destination.organizationId,
        request.content
      );
      if (!raw.success) {
        throw normalizeAdapterError("linkedin", raw.error ?? "LinkedIn publish failed.", operation);
      }
      return normalizeProviderReceipt("linkedin", raw, operation);
    },

    normalizeReceipt(
      raw: PublishResult,
      operation: PublicationOperationIdentity
    ): NormalizedPublicationReceipt {
      return normalizeProviderReceipt("linkedin", raw, operation);
    },

    normalizeError(error: unknown, operation?: PublicationOperationIdentity): AdapterProviderError {
      return normalizeAdapterError("linkedin", error, operation);
    },
  };
}
