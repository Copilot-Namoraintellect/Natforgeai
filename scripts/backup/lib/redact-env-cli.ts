/**
 * Redacted env-inventory CLI (used by backup-config.sh).
 *   tsx redact-env-cli.ts --env-file /path/.env --out /dir/env-inventory.redacted.json
 * Paths arrive via argv so OS path handling stays correct everywhere.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactEnv } from "./redact-env";

const args = process.argv.slice(2);
const envFile = args[args.indexOf("--env-file") + 1];
const out = args[args.indexOf("--out") + 1];
if (!envFile || !out) {
  console.error("usage: redact-env-cli.ts --env-file <path> --out <path>");
  process.exit(2);
}
const inv = redactEnv(readFileSync(envFile, "utf8"));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(inv, null, 2));
console.log(`[redact-env-cli] ${inv.entryCount} keys, ${inv.entries.filter((e) => e.redacted).length} redacted -> ${out}`);
