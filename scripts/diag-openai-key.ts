/**
 * Diagnostic: confirm whether OPENAI_API_KEY is available and where it came from.
 *
 * Never prints the key value. Only prints:
 *   - present: true/false
 *   - length (number of characters)
 *   - source: process env / .env / Google Secret Manager / not found
 */

const beforeDotenv = !!process.env.OPENAI_API_KEY;

import "dotenv/config";
import { loadOpenAIApiKeyFromSecretManager } from "../api/lib/secrets";

async function main() {
  let source: "process env" | ".env" | "Google Secret Manager" | "not found" = "not found";

  if (beforeDotenv) {
    source = "process env";
  } else if (process.env.OPENAI_API_KEY) {
    source = ".env";
  } else {
    const loaded = await loadOpenAIApiKeyFromSecretManager();
    if (loaded) source = "Google Secret Manager";
  }

  const key = process.env.OPENAI_API_KEY;

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    present: !!key,
    length: key ? key.length : 0,
    source,
  }, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Diagnostic failed:", err.message || err);
  process.exit(1);
});
