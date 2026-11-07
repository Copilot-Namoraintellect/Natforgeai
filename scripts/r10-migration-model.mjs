// Offline schema serialization and DDL comparison. No config/env/driver imports.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const ts = require('typescript');
export const kit = require('drizzle-kit/api');
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const baseline = 'c41cd564692717f6edc78ae581e01f9afab6125c';
export const groups = [
  { idx: 38, tag: '0038_r10_c_runtime_resilience', tables: ['runtime_workers', 'runtime_jobs', 'runtime_leases', 'runtime_dead_letters', 'runtime_lifecycle_events'] },
  { idx: 39, tag: '0039_r10_d_provider_resilience', tables: ['provider_account_bindings', 'provider_dispatch_requests', 'provider_callback_events', 'provider_reconciliation_records', 'provider_circuit_breaker_states'] },
  { idx: 40, tag: '0040_r10_e_observability_operations', tables: ['operational_events', 'operational_incidents', 'operational_incident_lifecycle_events', 'operational_alerts', 'service_health_observations'] },
  { idx: 41, tag: '0041_r10_h_autonomy_activation', tables: ['autonomy_activations', 'autonomy_activation_audit', 'autonomy_canary_reservations'] },
].map(g => ({ ...g, provisional: g.tag.replace(/^\d{4}/, '0038') + '.sql' }));
export const allR10 = groups.flatMap(g => g.tables);
export const read = p => fs.readFileSync(path.join(root, p), 'utf8');
export const json = p => JSON.parse(read(p));
export async function schemaModel() {
  const compiled = ts.transpileModule(read('db/schema.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  // Only the repository's declaration-only schema is evaluated; deny other imports.
  const schemaRequire = id => {
    assert.equal(id, 'drizzle-orm/mysql-core');
    return require(id);
  };
  new Function('require', 'module', 'exports', compiled)(schemaRequire, module, module.exports);
  return module.exports;
}
export async function snapshot(imports, names, prevId) {
  const { getTableName } = require('drizzle-orm');
  const selected = Object.fromEntries(Object.entries(imports).filter(([, value]) => {
    try { return names.has(getTableName(value)); } catch { return false; }
  }));
  return kit.generateMySQLDrizzleJson(selected, prevId);
}
export async function groupDDL(imports, tables) {
  const empty = await kit.generateMySQLDrizzleJson({});
  const current = await snapshot(imports, new Set(tables), empty.id);
  return kit.generateMySQLMigration(empty, current);
}
// Drizzle statements may already carry final newlines. Normalize only EOF,
// preserving every internal statement and breakpoint separator.
export const normalizeSQLFinalNewline = sql =>
  sql.replaceAll('\r\n', '\n').replace(/\n+$/, '') + '\n';
export const canonicalSQL = statements => normalizeSQLFinalNewline(
  '-- R10-X canonical package. Generated offline; NOT EXECUTED. No activation data.\n' +
  statements.join('\n--> statement-breakpoint\n')
);

function splitTop(value) {
  const parts = []; let start = 0, depth = 0, quote = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) { if (c === quote && value[i - 1] !== '\\') quote = null; continue; }
    if (c === "'" || c === '`' || c === '"') { quote = c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(value.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(value.slice(start).trim()); return parts;
}
const cols = text => [...text.matchAll(/`([^`]+)`/g)].map(m => m[1]);
const normalized = value => value.replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
export function parseDDL(source) {
  const text = source.replace(/^\s*--[^\n]*$/gm, '');
  const tables = {};
  const statements = text.split(';').map(s => s.trim()).filter(Boolean);
  for (const statement of statements) {
    let m = statement.match(/^CREATE TABLE\s+`?(\w+)`?\s*\(([\s\S]*)\)$/i);
    if (m) {
      assert(!tables[m[1]], `duplicate table ${m[1]}`);
      const table = tables[m[1]] = { columns: {}, primary: [], unique: {}, indexes: {} };
      for (const entry of splitTop(m[2])) {
        let key = entry.match(/^(?:CONSTRAINT\s+`([^`]+)`\s+)?PRIMARY KEY\s*\((.+)\)$/i);
        if (key) { table.primary = cols(key[2]).length ? cols(key[2]) : splitTop(key[2]).map(normalized); continue; }
        key = entry.match(/^CONSTRAINT\s+`([^`]+)`\s+UNIQUE\s*\((.+)\)$/i);
        if (key) { assert(!table.unique[key[1]]); table.unique[key[1]] = cols(key[2]); continue; }
        key = entry.match(/^`?(\w+)`?\s+([\s\S]+)$/);
        assert(key, `unknown table entry: ${entry}`);
        const name = key[1]; let definition = normalized(key[2]);
        if (/primary key/.test(definition)) { table.primary = [name]; definition = definition.replace(/ primary key/, ''); }
        assert(!table.columns[name]);
        // CURRENT_TIMESTAMP and (now()) are equivalent MySQL timestamp defaults.
        definition = definition.replace(/current_timestamp(?:\(\))?/g, '(now())');
        const defaultValue = definition.match(/\bdefault\s+(\(now\(\)\)|[^ ]+)/)?.[1] ?? null;
        const type = definition.split(/\s+(?:not null|default|auto_increment)/)[0].replace(/^tinyint\(1\)$/, 'boolean');
        table.columns[name] = { type, notNull: /not null/.test(definition), auto: /auto_increment/.test(definition), default: defaultValue };
      }
      continue;
    }
    m = statement.match(/^CREATE (UNIQUE )?INDEX `([^`]+)` ON `([^`]+)`\s*\((.+)\)$/i);
    assert(m && tables[m[3]], `unsupported or out-of-order DDL: ${statement.slice(0, 90)}`);
    const target = m[1] ? tables[m[3]].unique : tables[m[3]].indexes;
    assert(!target[m[2]]); target[m[2]] = cols(m[4]);
  }
  // MySQL primary-key members are implicitly NOT NULL, even if omitted in DDL.
  for (const table of Object.values(tables)) {
    for (const name of table.primary) table.columns[name].notNull = true;
  }
  return tables;
}
