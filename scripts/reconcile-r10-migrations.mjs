// Generates artifacts only. Uses Drizzle's actual MySQL serializer/differ APIs.
// Deliberately bypasses drizzle.config.ts (dotenv + DATABASE_URL requirement).
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, groups, allR10, read, json, kit, schemaModel, snapshot, groupDDL, canonicalSQL } from './r10-migration-model.mjs';
assert(process.argv.includes('--write'), 'Explicit --write required; no database mode exists.');
const imports = await schemaModel();
const current = await kit.generateMySQLDrizzleJson(imports);
const names = new Set(Object.keys(current.tables).filter(n => !allR10.includes(n)));
const dir = path.join(root, 'db/migrations');
const journal = json('db/migrations/meta/_journal.json');
assert.equal(journal.entries.at(-1).idx, 37, 'Generation is single-use; validate existing package instead.');
let previous = json('db/migrations/meta/0037_snapshot.json');
// Prepare everything in memory before replacing any provisional source.
const outputs = [];
for (const group of groups) {
  group.tables.forEach(n => names.add(n));
  const snap = await snapshot(imports, names, previous.id);
  const statements = await groupDDL(imports, group.tables);
  outputs.push({ group, snap, sql: canonicalSQL(statements), evidence: read('db/migrations/' + group.provisional) });
  previous = snap;
}
const archive = path.join(dir, 'archived/r10-provisional');
fs.mkdirSync(archive, { recursive: true });
for (const { group, evidence } of outputs) {
  fs.writeFileSync(path.join(archive, group.provisional), evidence, { flag: 'wx' });
}
for (const { group, snap, sql } of outputs) {
  fs.unlinkSync(path.join(dir, group.provisional));
  fs.writeFileSync(path.join(dir, group.tag + '.sql'), sql);
  fs.writeFileSync(path.join(dir, 'meta', String(group.idx).padStart(4, '0') + '_snapshot.json'), JSON.stringify(snap, null, 2) + '\n');
  journal.entries.push({ idx: group.idx, version: snap.version, when: Date.now() + group.idx, tag: group.tag, breakpoints: true });
}
fs.writeFileSync(path.join(dir, 'meta/_journal.json'), JSON.stringify(journal, null, 2) + '\n');
console.log('Generated four canonical SQL files and Drizzle snapshots offline. No database operations.');
