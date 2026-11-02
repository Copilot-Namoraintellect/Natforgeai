// Server-only credential boundary. Registrations come from trusted composition code;
// there is no env-name, filesystem-path, URL, or model-selected secret lookup.
import type { ProviderBindingView } from "./provider-binding";
import { ProviderInputError } from "./provider-resilience-contract";
export interface ServerCredentialRegistration {
  readonly binding: ProviderBindingView;
  readonly callbackVerificationKey: string;
  readonly allowedOperations: readonly ["verify_callback"];
}
export function createServerCallbackKeyResolver(
  registrations: readonly ServerCredentialRegistration[]
) {
  const keys = new Map<string, ServerCredentialRegistration>();
  for (const registration of registrations) {
    if (
      !registration.callbackVerificationKey ||
      registration.allowedOperations.length !== 1 ||
      registration.allowedOperations[0] !== "verify_callback" ||
      keys.has(registration.binding.bindingId)
    ) {
      throw new ProviderInputError(
        "CREDENTIAL_UNAVAILABLE",
        "invalid fixed credential registration"
      );
    }
    keys.set(registration.binding.bindingId, {
      binding: Object.freeze({ ...registration.binding }),
      callbackVerificationKey: registration.callbackVerificationKey,
      allowedOperations: ["verify_callback"],
    });
  }
  return async (binding: ProviderBindingView): Promise<string | null> => {
    const registration = keys.get(binding.bindingId);
    if (!registration) return null;
    for (const coordinate of [
      "userId",
      "businessId",
      "providerId",
      "providerAccountId",
      "capability",
      "actionType",
      "credentialFingerprint",
    ] as const) {
      if (registration.binding[coordinate] !== binding[coordinate]) return null;
    }
    return binding.status === "ACTIVE"
      ? registration.callbackVerificationKey
      : null;
  };
}
