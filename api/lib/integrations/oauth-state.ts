import { connectRedis, isRedisConfigured } from "../redis";

const OAUTH_STATE_PREFIX = "oauth:state:";
const OAUTH_STATE_TTL_SECONDS = 15 * 60; // 15 minutes

interface OAuthState {
  userId: number;
  platform: string;
  businessId?: number | null;
}

// Fallback in-memory store for development without Redis
const devOauthStates = new Map<string, OAuthState>();

async function getRedis() {
  if (!isRedisConfigured()) return null;
  return connectRedis();
}

export async function setOAuthState(
  state: string,
  data: OAuthState
): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    await redis.setEx(
      `${OAUTH_STATE_PREFIX}${state}`,
      OAUTH_STATE_TTL_SECONDS,
      JSON.stringify(data)
    );
  } else {
    devOauthStates.set(state, data);
    // Dev cleanup after 15 min
    setTimeout(() => devOauthStates.delete(state), OAUTH_STATE_TTL_SECONDS * 1000);
  }
}

export async function getOAuthState(state: string): Promise<OAuthState | null> {
  const redis = await getRedis();
  if (redis) {
    const raw = await redis.get(`${OAUTH_STATE_PREFIX}${state}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OAuthState;
    } catch {
      return null;
    }
  }
  return devOauthStates.get(state) ?? null;
}

export async function deleteOAuthState(state: string): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    await redis.del(`${OAUTH_STATE_PREFIX}${state}`);
  } else {
    devOauthStates.delete(state);
  }
}

// Legacy export for backwards compatibility during transition
export const oauthStates = {
  async set(state: string, data: OAuthState) {
    await setOAuthState(state, data);
  },
  async get(state: string): Promise<OAuthState | undefined> {
    return (await getOAuthState(state)) ?? undefined;
  },
  async delete(state: string) {
    await deleteOAuthState(state);
  },
};
