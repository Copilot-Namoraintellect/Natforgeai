/**
 * Listening adapter registry (WBS-R5-A A2/A5).
 *
 * Maps provider families to their listening adapters and exposes per-platform
 * capability resolution. Unknown providers/platforms fail closed — there is
 * no default adapter and no permissive fallback. Providers with no listening
 * support at all (twitter, tiktok) have no adapter here; capability resolution
 * for their surfaces reports unsupported.
 */

import {
  isSocialSignalProvider,
  SignalContractError,
  type SocialSignalPlatform,
  type SocialSignalProvider,
} from "../signal-contract";
import type {
  PlatformListeningCapability,
  SocialListeningAdapter,
} from "./types";
import { metaListeningAdapter } from "./meta-listening-adapter";
import { LinkedInListeningAdapter } from "./linkedin-listening-adapter";

const ADAPTERS: Partial<Readonly<Record<SocialSignalProvider, SocialListeningAdapter>>> = {
  meta: metaListeningAdapter,
  linkedin: new LinkedInListeningAdapter(),
};

export function getListeningAdapter(
  provider: string
): SocialListeningAdapter {
  if (!isSocialSignalProvider(provider)) {
    throw new SignalContractError(
      "UNKNOWN_PROVIDER",
      `Unknown listening provider: ${provider}`
    );
  }
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new SignalContractError(
      "UNKNOWN_PROVIDER",
      `No listening adapter registered for provider: ${provider}`
    );
  }
  return adapter;
}

export type ResolvedListeningMechanism =
  | { kind: "supported"; provider: SocialSignalProvider; capability: PlatformListeningCapability }
  | { kind: "unsupported"; reason: string };

/**
 * Resolve how (and whether) one platform surface can be listened to.
 * Unknown surfaces report unsupported — they never throw into the ingestion
 * hot path, but callers that require listening treat this as fail-closed.
 */
export function resolveListeningMechanism(
  provider: string,
  platform: string
): ResolvedListeningMechanism {
  if (!isSocialSignalProvider(provider)) {
    return { kind: "unsupported", reason: `unknown provider: ${provider}` };
  }
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    return { kind: "unsupported", reason: `no listening adapter for provider: ${provider}` };
  }
  const capability = adapter.capabilityFor(platform);
  if (!capability) {
    return {
      kind: "unsupported",
      reason: `provider ${provider} does not listen on platform: ${platform}`,
    };
  }
  return { kind: "supported", provider: adapter.provider, capability };
}

export function isPlatformListenable(
  provider: string,
  platform: string
): boolean {
  return resolveListeningMechanism(provider, platform).kind === "supported";
}

export type { PlatformListeningCapability, SocialListeningAdapter };
export type { SocialSignalPlatform };
