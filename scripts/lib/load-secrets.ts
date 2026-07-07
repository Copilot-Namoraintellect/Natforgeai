/**
 * Early-secret loader for local scripts.
 *
 * Import this module before any app code to ensure secrets from Google Cloud
 * Secret Manager are available in process.env before env.ts reads them.
 */

import "dotenv/config";
import { loadOpenAIApiKeyFromSecretManager } from "../../api/lib/secrets";

await loadOpenAIApiKeyFromSecretManager();
