/** Opt-in Vitest setup for R6-C verification; never imported by application code.
 * Loaded by r6-c-offline-vitest.config.ts in every test worker.
 * No live services: block sockets in every test worker, supply inert config,
 * and keep DB integration tests skipped (the database name has no safe-test tag).
 */
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import { vi } from "vitest";

function denyNetwork(): never {
  throw new Error("R6-C offline verification: network disabled");
}

net.Socket.prototype.connect = denyNetwork;
tls.connect = denyNetwork;
dgram.Socket.prototype.send = denyNetwork;
globalThis.fetch = denyNetwork;
syncBuiltinESMExports();

for (const key of Object.keys(process.env)) {
  if (/TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|FIREBASE_SERVICE_ACCOUNT|REDIS_URL/.test(key)) {
    delete process.env[key];
  }
}
process.env.DOTENV_CONFIG_PATH = "NUL";
vi.stubEnv("DATABASE_URL", "mysql://offline:offline@127.0.0.1:9/r6c_offline");
vi.stubEnv("VITE_FIREBASE_API_KEY", "offline-firebase-key");
vi.stubEnv("VITE_FIREBASE_PROJECT_ID", "offline-project");
vi.stubEnv("VITE_FIREBASE_APP_ID", "offline-app");
