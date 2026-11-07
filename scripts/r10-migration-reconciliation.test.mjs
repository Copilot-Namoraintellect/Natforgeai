import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { root, baseline, groups, read, json, canonicalSQL } from './r10-migration-model.mjs';
import { validatePackage, validateJournal, validateGroupSQL, validateSnapshot } from './validate-r10-migrations.mjs';

test('complete offline package: 18 tables, four snapshots, frozen R9 content', async () => {
  const result = await validatePackage();
  assert.equal(result.ok, true);
  assert.equal(result.tables.length, 18);
  assert.equal(result.metadataCatchup.length, 17);
  assert.equal(result.migrationExecution, false);
});
const original = JSON.parse(execFileSync('git', ['show', `${baseline}:db/migrations/meta/_journal.json`], { cwd: root }));
test('rejects journal history changes', () => {
  const j = json('db/migrations/meta/_journal.json'); j.entries[37].tag += '_changed';
  assert.throws(() => validateJournal(j, original), /history changed/);
});
test('rejects duplicate journal identity', () => {
  const j = json('db/migrations/meta/_journal.json'); j.entries[39].idx = 38;
  assert.throws(() => validateJournal(j, original), /duplicate journal idx/);
});
test('rejects non-monotonic migration timestamps', () => {
  const j = json('db/migrations/meta/_journal.json'); j.entries[39].when = j.entries[37].when - 1;
  assert.throws(() => validateJournal(j, original));
});
const h = groups[3], hSQL = read(`db/migrations/${h.tag}.sql`);
test('rejects an additional trailing blank line while normalizing generated EOF', () => {
  const statement = 'CREATE TABLE `example` (`id` int);';
  assert.equal(canonicalSQL([statement + '\n\n']), canonicalSQL([statement]));
  // Expected Drizzle output can carry a blank line; canonical input cannot.
  assert.doesNotThrow(() => validateGroupSQL(hSQL, hSQL + '\n', h.tables));
  assert.throws(() => validateGroupSQL(hSQL + '\n', hSQL, h.tables));
});
for (const [name, mutate] of [
  ['case-insensitive scope comparison', s => s.replaceAll('ascii_bin', 'ascii_general_ci')],
  ['signed version field', s => s.replace('bigint unsigned', 'bigint')],
  ['JSON converted to text', s => s.replace('`state_json` json', '`state_json` text')],
  ['lost uniqueness member', s => s.replace('PRIMARY KEY(`scope_key`,`action_id`)', 'PRIMARY KEY(`scope_key`)')],
  ['activation INSERT', s => s + "INSERT INTO autonomy_activations VALUES ('scope', 0, '{}');\n"],
  ['lost statement breakpoint', s => s.replace('--> statement-breakpoint', '')],
]) test(`rejects ${name}`, () => assert.throws(() => validateGroupSQL(mutate(hSQL), hSQL, h.tables)));
test('rejects changed timestamp default', () => {
  const g = groups[0], sql = read(`db/migrations/${g.tag}.sql`);
  assert.throws(() => validateGroupSQL(sql.replace('DEFAULT (now())', 'DEFAULT 0'), sql, g.tables));
});
test('rejects missing index', () => {
  const g = groups[0], sql = read(`db/migrations/${g.tag}.sql`);
  assert.throws(() => validateGroupSQL(sql.replace(/CREATE INDEX[^;]+;/, ''), sql, g.tables));
});
test('rejects broken snapshot ancestry and reused UUID', () => {
  const s = json('db/migrations/meta/0041_snapshot.json');
  assert.throws(() => validateSnapshot(s, s, 'wrong-parent', new Set()), /ancestry/);
  assert.throws(() => validateSnapshot(s, s, s.prevId, new Set([s.id])), /duplicate snapshot/);
});
test('rejects snapshot schema drift', () => {
  const s = json('db/migrations/meta/0041_snapshot.json'), changed = structuredClone(s);
  changed.tables.autonomy_activations.columns.scope_key.type = 'varchar(512)';
  assert.throws(() => validateSnapshot(changed, s, s.prevId, new Set()), /cumulative schema/);
});
