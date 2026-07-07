/**
 * Optional Google Cloud Secret Manager loader for local scripts.
 *
 * This is intentionally NOT used by the production server runtime; the server
 * reads secrets from `process.env` only. This helper lets sample-generation
 * scripts fetch secrets when a developer has authenticated GCP credentials.
 */

import { existsSync } from "fs";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const SECRET_NAME_ENV = "GOOGLE_CLOUD_OPENAI_SECRET_NAME";
const SECRET_VERSION_ENV = "GOOGLE_CLOUD_OPENAI_SECRET_VERSION";
const PROJECT_ID_ENVS = ["GOOGLE_CLOUD_PROJECT_ID", "GCP_PROJECT_ID", "GCLOUD_PROJECT"];

function getProjectId(): string | undefined {
  for (const key of PROJECT_ID_ENVS) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

function credentialsAvailable(): boolean {
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credsPath) {
    if (existsSync(credsPath)) return true;
    console.warn(
      `[SecretManager] GOOGLE_APPLICATION_CREDENTIALS points to a missing file (${credsPath}); skipping Secret Manager.`
    );
    return false;
  }
  // Otherwise rely on ADC (gcloud auth application-default, metadata service, etc.)
  return true;
}

/**
 * Load a single secret from Google Cloud Secret Manager into process.env.
 * Returns true if the env var was populated.
 */
export async function loadSecretIntoEnv(
  secretName: string,
  envVar: string,
  options?: { projectId?: string; version?: string }
): Promise<boolean> {
  if (process.env[envVar]) return true; // already present

  if (!credentialsAvailable()) return false;

  const projectId = options?.projectId || getProjectId();
  if (!projectId) {
    console.warn(`[SecretManager] No project ID configured; skipping fetch for ${secretName}`);
    return false;
  }

  const version = options?.version || "latest";
  const name = `projects/${projectId}/secrets/${secretName}/versions/${version}`;

  try {
    const client = new SecretManagerServiceClient();
    const [response] = await client.accessSecretVersion({ name });
    const payload = response.payload?.data?.toString();
    if (!payload) {
      console.warn(`[SecretManager] Empty payload for ${secretName}`);
      return false;
    }
    process.env[envVar] = payload;
    return true;
  } catch (err: any) {
    console.warn(`[SecretManager] Failed to load ${secretName}: ${err.message || err}`);
    return false;
  }
}

/**
 * Convenience helper: load OPENAI_API_KEY from Secret Manager if it is not
 * already present in process.env or .env.
 */
export async function loadOpenAIApiKeyFromSecretManager(): Promise<boolean> {
  const secretName = process.env[SECRET_NAME_ENV] || "OPENAI_API_KEY";
  const version = process.env[SECRET_VERSION_ENV] || "latest";
  return loadSecretIntoEnv(secretName, "OPENAI_API_KEY", { version });
}
