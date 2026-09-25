import {
  createFacebookAdapter,
  type FacebookAdapterDestination,
  type FacebookProviderRequest,
} from "./facebook-adapter";
import {
  createInstagramAdapter,
  type InstagramAdapterDestination,
  type InstagramProviderRequest,
} from "./instagram-adapter";
import {
  createLinkedInAdapter,
  type LinkedInAdapterDestination,
  type LinkedInProviderRequest,
} from "./linkedin-adapter";
import { normalizeAdapterError, isPlatformAdapterId, type PlatformAdapter } from "./platform-adapter";
import {
  createTwitterAdapter,
  type TwitterAdapterDestination,
  type TwitterProviderRequest,
} from "./twitter-adapter";

/**
 * The single governed adapter boundary for Distribution: one resolver that
 * maps a platform name (the values used by publishing_queue.platform) to the
 * governed adapter for that platform. Unmapped platforms fail closed with a
 * normalized, non-retryable "unsupported" error — the same semantics as the
 * publishing runner's default branch today.
 */

export type AnyPlatformAdapter =
  | PlatformAdapter<FacebookAdapterDestination, FacebookProviderRequest>
  | PlatformAdapter<InstagramAdapterDestination, InstagramProviderRequest>
  | PlatformAdapter<LinkedInAdapterDestination, LinkedInProviderRequest>
  | PlatformAdapter<TwitterAdapterDestination, TwitterProviderRequest>;

export interface PlatformAdapterRegistry {
  resolve(platform: string): AnyPlatformAdapter;
  list(): string[];
}

export interface PlatformAdapterRegistryDependencies {
  facebook?: ReturnType<typeof createFacebookAdapter>;
  instagram?: ReturnType<typeof createInstagramAdapter>;
  linkedin?: ReturnType<typeof createLinkedInAdapter>;
  twitter?: ReturnType<typeof createTwitterAdapter>;
}

export function createPlatformAdapterRegistry(
  deps: PlatformAdapterRegistryDependencies = {}
): PlatformAdapterRegistry {
  const adapters = {
    facebook: deps.facebook ?? createFacebookAdapter(),
    instagram: deps.instagram ?? createInstagramAdapter(),
    linkedin: deps.linkedin ?? createLinkedInAdapter(),
    twitter: deps.twitter ?? createTwitterAdapter(),
  } as const;

  return {
    resolve(platform: string): AnyPlatformAdapter {
      if (isPlatformAdapterId(platform)) {
        return adapters[platform];
      }
      throw normalizeAdapterError(
        platform,
        `Platform ${platform} not supported`,
        undefined
      );
    },
    list(): string[] {
      return Object.keys(adapters);
    },
  };
}
