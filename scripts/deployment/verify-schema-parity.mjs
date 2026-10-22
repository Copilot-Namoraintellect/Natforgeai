// WBS-R2.4 — Live schema parity probe for the migration rehearsal.
// Compares a DISPOSABLE database's information_schema against the canonical
// terminal snapshot (db/migrations/meta/0026_snapshot.json).
// Usage: node scripts/deployment/verify-schema-parity.mjs <DATABASE_URL>
// Exit 0 = parity, 1 = mismatch/missing tables, 2 = usage/connection error.
import mysql from "mysql2/promise";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const snapshot = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "db/migrations/meta/0026_snapshot.json"), "utf8")
);

const url = process.argv[2];
if (!url || !/^mysql:\/\//i.test(url)) {
  console.error("FAIL  supply a disposable MySQL DATABASE_URL as the only argument.");
  process.exit(2);
}

let connection;
try {
  connection = await mysql.createConnection(url);
} catch (err) {
  console.error(`FAIL  could not connect: ${err.message}`);
  process.exit(2);
}

const [columns] = await connection.query(
  `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
     FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME, ORDINAL_POSITION`
);

const live = new Map();
for (const row of columns) {
  if (!live.has(row.tableName)) live.set(row.tableName, []);
  live.get(row.tableName).push(row.columnName);
}

const mismatches = [];
for (const [table, def] of Object.entries(snapshot.tables)) {
  const expectedCols = Object.keys(def.columns).sort();
  const actualCols = (live.get(table) ?? []).sort();
  if (actualCols.length === 0) {
    mismatches.push(`${table}: MISSING TABLE`);
    continue;
  }
  const missing = expectedCols.filter((c) => !actualCols.includes(c));
  const extra = actualCols.filter((c) => !expectedCols.includes(c));
  if (missing.length || extra.length) {
    mismatches.push(
      `${table}: missing=[${missing.join(",")}] extra=[${extra.join(",")}]`
    );
  }
  live.delete(table);
}
for (const leftover of live.keys()) {
  mismatches.push(`${leftover}: unexpected extra table`);
}

await connection.end();

if (mismatches.length > 0) {
  console.error(`FAIL  schema parity broken (${mismatches.length} issue(s)):`);
  for (const m of mismatches) console.error(`  - ${m}`);
  process.exit(1);
}
console.log(
  `PASS  schema parity: all ${Object.keys(snapshot.tables).length} canonical tables and their columns match the terminal snapshot.`
);
process.exit(0);
