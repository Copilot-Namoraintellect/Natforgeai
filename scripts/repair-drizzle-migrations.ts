/**
 * Reconciles the local migration journal with the production `__drizzle_migrations__` table.
 *
 * Use this when migrations were applied outside Drizzle's normal flow (e.g. manually in
 * Cloud SQL) and `npm run db:migrate` fails or refuses to apply new migrations.
 *
 * The script reads `db/migrations/meta/_journal.json`, computes each migration file's
 * SHA-256 hash, and inserts any missing entries into `__drizzle_migrations__`. It is
 * idempotent: running it twice will not create duplicates.
 *
 * Run with:
 *   npx tsx scripts/repair-drizzle-migrations.ts
 */
import "dotenv/config";
import { createConnection } from "mysql2/promise";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const migrationsDir = join(process.cwd(), "db", "migrations");
const journalPath = join(migrationsDir, "meta", "_journal.json");

function loadJournal(): Journal {
  return JSON.parse(readFileSync(journalPath, "utf-8"));
}

function computeHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

async function main() {
  const journal = loadJournal();
  const connection = await createConnection(databaseUrl);

  try {
    console.log(`Repairing migration journal on ${new URL(databaseUrl).hostname}`);

    for (const entry of journal.entries) {
      const sqlPath = join(migrationsDir, `${entry.tag}.sql`);
      const hash = computeHash(sqlPath);

      const [existing] = await connection.execute<{ id: number }[]>(
        "SELECT id FROM `__drizzle_migrations` WHERE `created_at` = ?",
        [entry.when]
      );

      if (existing && existing.length > 0) {
        console.log(`  ${entry.tag}: already recorded (created_at=${entry.when})`);
        continue;
      }

      await connection.execute(
        "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
        [hash, entry.when]
      );
      console.log(`  ${entry.tag}: inserted (hash=${hash.slice(0, 12)}..., created_at=${entry.when})`);
    }

    console.log("Migration journal repair complete.");
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
