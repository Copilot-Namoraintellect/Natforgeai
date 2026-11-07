// Deterministic, read-only reconciliation gate. Never imports application/config/DB code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { baseline, root, groups, allR10, read, json, kit, schemaModel, snapshot, groupDDL, canonicalSQL, normalizeSQLFinalNewline, parseDDL } from './r10-migration-model.mjs';

// Git stores LF while this Windows checkout uses CRLF; compare repository content.
const hash = data => createHash('sha256').update(data.toString('utf8').replaceAll('\r\n', '\n')).digest('hex');
export function validateJournal(journal, original) {
  assert.equal(journal.version, original.version);
  assert.equal(journal.dialect, 'mysql');
  assert.deepEqual(journal.entries.slice(0, original.entries.length), original.entries, 'R9 journal history changed');
  assert.equal(journal.entries.length, original.entries.length + 4);
  for (const field of ['idx', 'tag', 'when']) {
    assert.equal(new Set(journal.entries.map(e => e[field])).size, journal.entries.length, `duplicate journal ${field}`);
  }
  groups.forEach((g, i) => {
    const e = journal.entries[original.entries.length + i];
    assert.deepEqual({ idx: e.idx, tag: e.tag, version: e.version, breakpoints: e.breakpoints },
      { idx: g.idx, tag: g.tag, version: '5', breakpoints: true });
    assert(e.when > journal.entries[original.entries.length + i - 1].when);
  });
}
export function validateGroupSQL(actual, generated, names) {
  assert.deepEqual(parseDDL(actual), parseDDL(generated), 'SQL differs from Drizzle schema (columns, types, defaults, keys or indexes)');
  assert.deepEqual(Object.keys(parseDDL(actual)).sort(), [...names].sort());
  // Exact generator output also excludes hidden DML/DDL and lost statement breakpoints.
  // Normalize expected output only: malformed canonical EOF must still fail.
  assert.equal(actual.replaceAll('\r\n', '\n'), normalizeSQLFinalNewline(generated));
}
export function validateSnapshot(actual, expected, previousId, identities) {
  assert.match(actual.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert(!identities.has(actual.id), 'duplicate snapshot identity');
  assert.equal(actual.prevId, previousId, 'broken snapshot ancestry');
  assert.deepEqual({ ...actual, id: '<generated>' }, JSON.parse(JSON.stringify({ ...expected, id: '<generated>' })), 'snapshot does not match cumulative schema');
  identities.add(actual.id);
}
function baselineFiles() {
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', baseline, '--', 'db/migrations'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  const wanted = paths.filter(p => /\/meta\/\d{4}_snapshot\.json$/.test(p) || /\/\d{4}_[^/]+\.sql$/.test(p) && Number(path.basename(p).slice(0, 4)) <= 37);
  wanted.push('db/migrations/meta/_journal.json');
  const batch = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: wanted.map(p => `${baseline}:${p}`).join('\n') + '\n', maxBuffer: 50 * 1024 * 1024 });
  let offset = 0; const values = {};
  for (const p of wanted) {
    const end = batch.indexOf(10, offset);
    const header = batch.subarray(offset, end).toString().split(' ');
    assert.equal(header[1], 'blob');
    const length = Number(header[2]);
    values[p] = batch.subarray(end + 1, end + 1 + length);
    offset = end + length + 2;
  }
  return values;
}
export async function validatePackage() {
  const historical = baselineFiles();
  const original = JSON.parse(historical['db/migrations/meta/_journal.json']);
  const preservation = {};
  for (const [p, bytes] of Object.entries(historical)) {
    if (p.endsWith('_journal.json')) continue;
    assert.equal(hash(fs.readFileSync(path.join(root, p))), hash(bytes), `preserved history changed: ${p}`);
    preservation[p] = hash(bytes);
  }
  const journal = json('db/migrations/meta/_journal.json');
  validateJournal(journal, original);
  for (const e of journal.entries) assert(fs.existsSync(path.join(root, 'db/migrations', e.tag + '.sql')), `missing SQL ${e.tag}`);
  const r10Files = fs.readdirSync(path.join(root, 'db/migrations')).filter(n => /^\d{4}_.*\.sql$/.test(n) && Number(n.slice(0, 4)) >= 38).sort();
  assert.deepEqual(r10Files, groups.map(g => g.tag + '.sql').sort(), 'orphan/duplicate R10 migrations');
  const imports = await schemaModel();
  const complete = await kit.generateMySQLDrizzleJson(imports);
  const frozenSnapshot = json('db/migrations/meta/0037_snapshot.json');
  for (const [name, originalTable] of Object.entries(frozenSnapshot.tables)) {
    const currentTable = JSON.parse(JSON.stringify(complete.tables[name]));
    if (name === 'approval_requests') {
      assert(currentTable.columns.approvalType.type.includes("'mission_action'"));
      assert(!originalTable.columns.approvalType.type.includes("'mission_action'"));
      currentTable.columns.approvalType.type = currentTable.columns.approvalType.type.replace(", 'mission_action'", '').replace(",'mission_action'", '');
    }
    assert.deepEqual(currentTable, originalTable, `unexpected pre-R9 schema drift: ${name}`);
  }
  const included = new Set(Object.keys(complete.tables).filter(n => !allR10.includes(n)));
  let previous = json('db/migrations/meta/0037_snapshot.json');
  const identities = new Set([previous.id]);
  const inventory = [];
  const oldTables = new Set(Object.keys(previous.tables));
  const metadataCatchup = [...included].filter(n => !oldTables.has(n));
  assert.equal(metadataCatchup.length, 17, 'unexpected baseline metadata catch-up');
  for (const g of groups) {
    const archive = `db/migrations/archived/r10-provisional/${g.provisional}`;
    const originalBytes = execFileSync('git', ['show', `${baseline}:db/migrations/${g.provisional}`], { cwd: root });
    assert.equal(hash(fs.readFileSync(path.join(root, archive))), hash(originalBytes), `provisional evidence changed: ${archive}`);
    g.tables.forEach(n => included.add(n));
    const actual = json(`db/migrations/meta/${g.idx.toString().padStart(4, '0')}_snapshot.json`);
    const expected = await snapshot(imports, included, previous.id);
    validateSnapshot(actual, expected, previous.id, identities);
    const generated = canonicalSQL(await groupDDL(imports, g.tables));
    const sql = read(`db/migrations/${g.tag}.sql`);
    validateGroupSQL(sql, generated, g.tables);
    const canonical = parseDDL(sql), provisional = parseDDL(read(archive));
    assert.deepEqual(Object.keys(provisional).sort(), [...g.tables].sort());
    for (const name of g.tables) {
      const table = canonical[name], source = provisional[name];
      assert.deepEqual(table.columns, source.columns, `provisional column mismatch: ${name}`);
      assert.deepEqual(table.unique, source.unique, `provisional unique mismatch: ${name}`);
      assert.deepEqual(table.indexes, source.indexes, `provisional index mismatch: ${name}`);
      const missingPrimary = source.primary.length === 0;
      if (!missingPrimary) assert.deepEqual(table.primary, source.primary, `provisional primary key mismatch: ${name}`);
      else assert(name.startsWith('operational_') || name === 'service_health_observations', `unapproved missing primary key: ${name}`);
      inventory.push({ migration: g.idx, table: name, columns: Object.keys(table.columns).length, columnDefinitions: table.columns, primary: table.primary,
        unique: table.unique, indexes: table.indexes, defaults: Object.fromEntries(Object.entries(table.columns).filter(([, c]) => c.default !== null).map(([n, c]) => [n, c.default])),
        difference: missingPrimary ? 'Canonical adds explicit id PRIMARY KEY required by schema; provisional serial implied uniqueness only.' : g.idx === 38 ? 'CURRENT_TIMESTAMP normalized to (now()); inline PK becomes named PK. Equivalent semantics.' : g.idx === 41 ? 'Primary keys named by Drizzle; identical columns/types/uniqueness and ASCII binary collation.' : 'No semantic difference; Drizzle statement formatting/order only.' });
    }
    previous = actual;
  }
  assert.equal(inventory.length, 18);
  // Verify R9 metadata catch-up against already-executable canonical DDL, never emit it again.
  const r9Names = metadataCatchup;
  const r9Generated = parseDDL(canonicalSQL(await groupDDL(imports, r9Names)));
  const r9SQL = read('db/migrations/0037_r9_mission_control_foundation.sql');
  assert(r9SQL.includes("'mission_action'"), 'R9 SQL must already own approval enum extension');
  const r9Creates = r9SQL.slice(0, r9SQL.search(/ALTER TABLE/i));
  const r9Historical = parseDDL(r9Creates);
  // Pre-existing R9 differences are explicitly bounded, not silently repaired in R10 DDL.
  assert.equal(r9Historical.mission_schedules.columns.version.default, null);
  assert.equal(r9Generated.mission_schedules.columns.version.default, '1');
  r9Generated.mission_schedules.columns.version.default = null;
  for (const prefix of ['mgd_decision_id', 'mgd_user_decision']) {
    assert(r9Generated.mission_governance_decisions.unique[prefix + '_idx']);
    r9Generated.mission_governance_decisions.unique[prefix + '_uidx'] = r9Generated.mission_governance_decisions.unique[prefix + '_idx'];
    delete r9Generated.mission_governance_decisions.unique[prefix + '_idx'];
  }
  assert.deepEqual(r9Historical, r9Generated, 'unexpected R9 SQL/schema divergence');
  const contract = read('api/lib/autonomy/autonomy-contract.ts');
  for (const field of ['configuredLevel', 'effectiveLevel', 'runtimeState']) assert(contract.includes(`${field}: "DISABLED"`));
  assert(read('api/lib/autonomy/autonomy-mysql-store.ts').includes('if (!rows.length) return disabled(scope)'));
  const result = { ok: true, mode: 'OFFLINE_ONLY', baseline, migrationExecution: false, tables: inventory,
    preservedFiles: preservation, preservedJournalEntries: original.entries.length,
    metadataCatchup, approvalEnumCatchup: 'mission_action already applied by SQL 0037; recorded in generated snapshot 0038',
    inheritedR9Differences: ['mission_schedules.version: schema default 1; SQL 0037 has no default', 'mission_governance_decisions: SQL *_uidx versus schema *_idx for two equivalent unique keys'],
    drizzleKitVersion: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/drizzle-kit/package.json'))).version };
  assert.deepEqual(json('docs/recovery/r10-x-migration-reconciliation-inventory.json'), result, 'published inventory is stale');
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await validatePackage();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('R10 migration validation failed: ' + error.message.split('\n')[0]);
    process.exitCode = 1;
  }
}
