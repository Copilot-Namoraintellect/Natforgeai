import { createClient, type RedisClientType } from "redis";
import { env } from "./env";
import { createAlert, resolveAlerts } from "./alerts";

let redisClient: RedisClientType | null = null;

export function getRedisClient(): RedisClientType {
  if (!redisClient) {
    const url = env.redisUrl || "redis://localhost:6379";
    redisClient = createClient({ url });
    redisClient.on("error", async (err) => {
      console.error("[Redis] Error:", err.message);
      await createAlert({
        severity: "critical",
        category: "redis",
        message: `Redis connection error: ${err.message}`,
      }).catch(() => {});
    });
    redisClient.on("connect", async () => {
      await resolveAlerts("redis").catch(() => {});
    });
  }
  return redisClient;
}

export async function connectRedis(): Promise<RedisClientType> {
  const client = getRedisClient();
  if (!client.isOpen) {
    await client.connect();
    console.log("[Redis] Connected");
  }
  return client;
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient?.isOpen) {
    await redisClient.disconnect();
    console.log("[Redis] Disconnected");
  }
}

export function isRedisConfigured(): boolean {
  return !!env.redisUrl;
}
