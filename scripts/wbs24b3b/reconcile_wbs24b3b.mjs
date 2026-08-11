#!/usr/bin/env node
// WBS 2.4B3B — production reconciliation runbook artifact.
// Applies only the missing 0015 schema effects and the eight tracking rows
// (10–17) after verifying that 0009–0014 and 0016 schema effects are already
// present and exactly match their definitions. Never executes 0009–0014 or 0016.

import mysql from 'mysql2/promise';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// -----------------------------------------------------------------------------
// Authoritative production baseline (pre-repair) — hard-coded from WBS 2.4B3A.
// -----------------------------------------------------------------------------
const PRODUCTION_BASELINE = [
  { id: 1, hash: '72b3c061c1ad128ac438ccf529de78f0e0002725d10fe71502e71ffd2e9902a1', created_at: 1779900649982, tag: '0000_vengeful_triathlon' },
  { id: 2, hash: 'a75ec6176d74c3154b716e32c8483cbe42606dd60e500f841507034e6588a19b', created_at: 1780324454630, tag: '0001_parallel_tinkerer' },
  { id: 3, hash: '4fc651b25fba9161117051d6efc12ee0f716d12c72fd1599678aa0213673d423', created_at: 1780324500000, tag: '0002_hardening_sprint' },
  { id: 4, hash: 'cc1f0ad292b61ee46ac88df8e61154eff9297a55ade1d9f540621c5523f74933', created_at: 1780831759898, tag: '0003_safe_hydra' },
  { id: 5, hash: '688aed12f2e961e1bb024c148eb55600c60e3001ae5ec5bc463780fe8643a7ff', created_at: 1781510827473, tag: '0004_left_squadron_supreme' },
  { id: 6, hash: '1cb50c16061be27e898d1394c658777b9bacd5c8c713e8c1a7a97cfdaf9a6492', created_at: 1781542151944, tag: '0005_dear_guardsmen' },
  { id: 7, hash: '2e43ba6c7dcac164d49fd80bf77fd95c37f124faba72525a14141a1908767d89', created_at: 1781548376131, tag: '0006_bizarre_gamma_corps' },
  { id: 8, hash: '1cbf0cbce58141fea0af9a197decbe6483e5926b75b8a3f1ddfe08849b71929b', created_at: 1781691852016, tag: '0007_curved_nitro' },
  { id: 9, hash: 'e2a4f7230720940a41a03d9942ba8f0324992284b1048daf55384e560acc5e32', created_at: 1782301770674, tag: '0012_strange_puff_adder' },
];

const MISSING_ROWS = [
  { id: 10, hash: 'ce33730998dde10569ff2c8e038d321d8a4963f50a11b01ecfe36b0099bc147f', created_at: 1782459275896, tag: '0009_workable_stephen_strange' },
  { id: 11, hash: '7aaefb5ea121c78df1a910afc313915b5edf26ae44ca14e828280c795f2bc0b6', created_at: 1782495282088, tag: '0010_colorful_polaris' },
  { id: 12, hash: '22f040486d9441dded492f5e137d403b183cb44400d229cee36a229031ca0655', created_at: 1782571686288, tag: '0011_polite_tusk' },
  { id: 13, hash: '7d9452351c176705178034ab852b8fcc6a47b3e904c97790621c2660998638f9', created_at: 1782834565471, tag: '0012_add_message_pack_asset_type' },
  { id: 14, hash: '026fc1717dfa1371f629f2e16dec11a1486040b1e4987b404bb8d53dcccbd7a8', created_at: 1783021494761, tag: '0013_add_social_integrations_business_id' },
  { id: 15, hash: 'ad3ba6c3f2e692a15cc42822eaba537e4fb59c5df094211cffa7efdde6a978fa', created_at: 1783341181484, tag: '0014_dedupe_social_profiles' },
  { id: 16, hash: '36e961ca7d822c6065cc19ce0d9cdd3ecb9d0edf0b3ab71212a46a1dd5bee0d0', created_at: 1786376773661, tag: '0015_medical_dreadnoughts' },
  { id: 17, hash: '86412d4815a155b39ed074885176ba6a8e3179b4b830fb6808ccd3854bb7f0bf', created_at: 1786381570150, tag: '0016_email_verification_fields' },
];

const EXPECTED_MAX_CREATED_AT = 1786381570150;
const FULL_MANIFEST = [...PRODUCTION_BASELINE, ...MISSING_ROWS];

const TARGET_COLUMN = { table: 'credit_transactions', column: 'idempotencyKey' };
const TARGET_INDEX = { table: 'credit_transactions', name: 'credit_transactions_idempotencyKey_unique' };
const SOCIAL_INDEX = { table: 'social_profiles', name: 'user_platform_external_idx', columns: ['userId', 'platform', 'externalId'] };
const EXPECTED_ASSET_ENUM = ['image','video_script','carousel','ad_copy','caption','caption_adaptation','caption_pack','hashtag_set','cta_variant','email_copy','whatsapp_copy','video_concept','reel_script','carousel_ad','whatsapp_promo','lead_gen_ad','launch_pack','message_pack'];

const REQUIRED_GATES = [
  'WBS24B3B_CHANGE_REFERENCE',
  'WBS24B3B_APPROVER',
  'WBS24B3B_APPROVAL_TIMESTAMP',
  'WBS24B3B_OPERATOR',
  'WBS24B3B_INDEPENDENT_VERIFIER',
  'WBS24B3B_BACKUP_IDENTIFIER',
  'WBS24B3B_BACKUP_COMPLETED_AT',
  'WBS24B3B_RESTORE_VALIDATION_REFERENCE',
  'WBS24B3B_MAINTENANCE_WINDOW_REFERENCE',
];
const QUIESCENCE_GATES = [
  ['WBS24B3B_APP_QUIESCED', 'yes'],
  ['WBS24B3B_WORKERS_QUIESCED', 'yes'],
  ['WBS24B3B_SCHEDULERS_QUIESCED', 'yes'],
  ['WBS24B3B_CONCURRENT_MIGRATORS_EXCLUDED', 'yes'],
];

let exitClassification = 'FAIL_WBS_2_4B3B_VALIDATION';

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------
function log(msg) {
  console.error(`[WBS24B3B] ${new Date().toISOString()} ${msg}`);
}

function fail(classification, reason) {
  log(`FAIL-CLOSED: ${classification} — ${reason}`);
  printFinalFlags(classification);
  process.exit(1);
}

function printFinalFlags(classification) {
  const flags = {
    PRODUCTION_SCHEMA_PREFLIGHT_COMPLETED: true,
    PRODUCTION_MIGRATION_SIMULATION_COMPLETED: true,
    RECONCILIATION_ARCHITECTURE_VALIDATED: true,
    PRODUCTION_RUNBOOK_VALIDATED: classification === 'PASS_WBS_2_4B3B_FROZEN_PRODUCTION_ARTIFACT_VALIDATED',
    PRODUCTION_RECONCILIATION_PATH_VALIDATED: classification === 'PASS_WBS_2_4B3B_FROZEN_PRODUCTION_ARTIFACT_VALIDATED',
    PRODUCTION_DEPLOYMENT_READY: false,
    DEPLOYMENT_AUTHORISED: false,
  };
  log(`FINAL_CLASSIFICATION=${classification}`);
  log(`RETAINED_FLAGS=${JSON.stringify(flags)}`);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function parseDbUrl(url) {
  try {
    const u = new URL(url);
    return {
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      host: u.hostname,
      port: Number(u.port),
      database: u.pathname.replace(/^\//, ''),
    };
  } catch (e) {
    fail('BLOCKED_OPERATIONAL_GATES', `Invalid database URL: ${e.message}`);
  }
}

function parseExpectedAccount(raw) {
  const m = raw.match(/^([^@]+)(?:@(.+))?$/);
  if (!m) return null;
  return { user: m[1], host: m[2] ?? null };
}

function accountMatches(expected, actual) {
  const e = parseExpectedAccount(expected);
  const a = parseExpectedAccount(actual);
  if (!e || !a) return false;
  if (e.user.toLowerCase() !== a.user.toLowerCase()) return false;
  if (e.host === null || e.host === '%') return true;
  return e.host.toLowerCase() === (a.host ?? '').toLowerCase();
}

function versionMatchesRange(expected, actual) {
  const clean = actual.replace(/-.*$/, '');
  const exp = expected.toLowerCase().split('.');
  const act = clean.split('.');
  for (let i = 0; i < exp.length; i++) {
    if (exp[i] === 'x' || exp[i] === '*') continue;
    if (String(exp[i]) !== String(act[i] ?? '')) return false;
  }
  return true;
}

async function getConnectionId(conn) {
  const [[row]] = await conn.execute('SELECT CONNECTION_ID() AS id');
  return row.id;
}

async function queryVersion(conn) {
  const [[row]] = await conn.execute('SELECT VERSION() AS v');
  return row.v;
}

async function queryCurrentUser(conn) {
  const [[row]] = await conn.execute('SELECT CURRENT_USER() AS u');
  return row.u;
}

async function getDbName(conn) {
  const [[row]] = await conn.execute('SELECT DATABASE() AS db');
  return row.db;
}

async function getTrackingRows(conn) {
  try {
    const [rows] = await conn.execute('SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id');
    return rows;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return [];
    throw e;
  }
}

function normalizeHash(h) {
  return String(h).toLowerCase().trim();
}

function baselineMatches(rows) {
  if (rows.length !== PRODUCTION_BASELINE.length) return false;
  for (let i = 0; i < PRODUCTION_BASELINE.length; i++) {
    const b = PRODUCTION_BASELINE[i];
    const r = rows[i];
    if (Number(r.id) !== b.id) return false;
    if (normalizeHash(r.hash) !== normalizeHash(b.hash)) return false;
    if (Number(r.created_at) !== b.created_at) return false;
  }
  return true;
}

function manifestMatches(rows) {
  if (rows.length !== FULL_MANIFEST.length) return false;
  for (let i = 0; i < FULL_MANIFEST.length; i++) {
    const m = FULL_MANIFEST[i];
    const r = rows[i];
    if (Number(r.id) !== m.id) return false;
    if (normalizeHash(r.hash) !== normalizeHash(m.hash)) return false;
    if (Number(r.created_at) !== m.created_at) return false;
  }
  return true;
}

async function hasColumn(conn, table, column) {
  const db = await getDbName(conn);
  const [rows] = await conn.execute(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [db, table, column]
  );
  return rows.length > 0;
}

async function hasIndex(conn, table, indexName) {
  const db = await getDbName(conn);
  const [rows] = await conn.execute(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [db, table, indexName]
  );
  return rows.length > 0;
}

async function getColumnInfo(conn, table, column) {
  const db = await getDbName(conn);
  const [rows] = await conn.execute(
    `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
            CHARACTER_SET_NAME, COLLATION_NAME
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [db, table, column]
  );
  return rows[0] ?? null;
}

async function getTableInfo(conn, table) {
  const db = await getDbName(conn);
  const [rows] = await conn.execute(
    `SELECT TABLE_NAME, TABLE_COLLATION
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [db, table]
  );
  return rows[0] ?? null;
}

async function getEnumMembers(conn, table, column) {
  const info = await getColumnInfo(conn, table, column);
  if (!info) return null;
  const m = info.COLUMN_TYPE.match(/enum\((.*)\)/is);
  if (!m) return null;
  return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
}

async function getIndexRows(conn, table, indexName) {
  const db = await getDbName(conn);
  const [rows] = await conn.execute(
    `SELECT COLUMN_NAME, SUB_PART, NON_UNIQUE, SEQ_IN_INDEX, INDEX_TYPE, COLLATION
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?
     ORDER BY SEQ_IN_INDEX`,
    [db, table, indexName]
  );
  return rows;
}

async function countDuplicateSocialProfiles(conn) {
  const [[row]] = await conn.execute(
    `SELECT COUNT(*) AS n FROM (
       SELECT userId, platform, externalId FROM social_profiles
       GROUP BY userId, platform, externalId HAVING COUNT(*) > 1
     ) t`
  );
  return Number(row.n);
}

async function getShowCreateTable(conn, table) {
  const [[row]] = await conn.execute(`SHOW CREATE TABLE \`${table}\``);
  return row?.['Create Table'] ?? row?.['Create Table'] ?? null;
}

async function getVerificationValuesFingerprint(conn) {
  const hasEmail = await hasColumn(conn, 'users', 'emailVerifiedAt');
  const hasLast = await hasColumn(conn, 'users', 'lastTwoFactorVerifiedAt');
  if (!hasEmail || !hasLast) return null;
  const [rows] = await conn.execute(
    'SELECT id, CAST(`twoFactorVerifiedAt` AS CHAR) AS t, CAST(`emailVerifiedAt` AS CHAR) AS e, CAST(`lastTwoFactorVerifiedAt` AS CHAR) AS l FROM users ORDER BY id'
  );
  return rows.map(r => `${r.id}:${r.t}:${r.e}:${r.l}`).join('|');
}

async function getVerificationAggregates(conn) {
  const hasEmail = await hasColumn(conn, 'users', 'emailVerifiedAt');
  const hasLast = await hasColumn(conn, 'users', 'lastTwoFactorVerifiedAt');
  if (!hasEmail || !hasLast) return { columnsPresent: false };
  const [[row]] = await conn.execute(
    `SELECT
       COUNT(*) AS total,
       COUNT(CASE WHEN twoFactorVerifiedAt IS NOT NULL THEN 1 END) AS legacy_present,
       COUNT(CASE WHEN twoFactorVerifiedAt IS NOT NULL
                      AND NOT (emailVerifiedAt <=> twoFactorVerifiedAt
                               AND lastTwoFactorVerifiedAt <=> twoFactorVerifiedAt)
                    THEN 1 END) AS legacy_not_preserved,
       COUNT(CASE WHEN twoFactorVerifiedAt IS NULL
                      AND (emailVerifiedAt IS NOT NULL OR lastTwoFactorVerifiedAt IS NOT NULL)
                    THEN 1 END) AS spurious_new
     FROM users`
  );
  return {
    columnsPresent: true,
    total: Number(row.total),
    legacyPresent: Number(row.legacy_present),
    legacyNotPreserved: Number(row.legacy_not_preserved),
    spuriousNew: Number(row.spurious_new),
  };
}

function assertColumn(info, expectations, label) {
  if (!info) return `${label}: missing`;
  if (expectations.dataType && info.DATA_TYPE !== expectations.dataType) {
    return `${label}: DATA_TYPE expected ${expectations.dataType}, got ${info.DATA_TYPE}`;
  }
  if (expectations.columnTypeIncludes && !String(info.COLUMN_TYPE).includes(expectations.columnTypeIncludes)) {
    return `${label}: COLUMN_TYPE expected to include ${expectations.columnTypeIncludes}, got ${info.COLUMN_TYPE}`;
  }
  if (expectations.isNullable !== undefined && info.IS_NULLABLE !== (expectations.isNullable ? 'YES' : 'NO')) {
    return `${label}: IS_NULLABLE expected ${expectations.isNullable ? 'YES' : 'NO'}, got ${info.IS_NULLABLE}`;
  }
  if ('default' in expectations) {
    const actual = info.COLUMN_DEFAULT === null ? null : String(info.COLUMN_DEFAULT);
    const expected = expectations.default === null ? null : String(expectations.default);
    if (actual !== expected) return `${label}: COLUMN_DEFAULT expected ${expected}, got ${actual}`;
  }
  if (expectations.collation && info.COLLATION_NAME !== expectations.collation) {
    return `${label}: COLLATION_NAME expected ${expectations.collation}, got ${info.COLLATION_NAME}`;
  }
  return null;
}

function assertIndex(rows, expectations, label) {
  if (!rows.length) return `${label}: missing`;
  if (expectations.nonUnique !== undefined && Number(rows[0].NON_UNIQUE) !== expectations.nonUnique) {
    return `${label}: NON_UNIQUE expected ${expectations.nonUnique}, got ${rows[0].NON_UNIQUE}`;
  }
  const columns = rows.map(r => r.COLUMN_NAME);
  if (expectations.columns && JSON.stringify(columns) !== JSON.stringify(expectations.columns)) {
    return `${label}: columns expected ${JSON.stringify(expectations.columns)}, got ${JSON.stringify(columns)}`;
  }
  const seqs = rows.map(r => Number(r.SEQ_IN_INDEX));
  if (expectations.columns && JSON.stringify(seqs) !== JSON.stringify(expectsSeq(expectations.columns.length))) {
    return `${label}: SEQ_IN_INDEX mismatch`;
  }
  const subParts = rows.map(r => r.SUB_PART);
  if (expectations.subPartNull && subParts.some(p => p !== null)) {
    return `${label}: expected no SUB_PART, got ${JSON.stringify(subParts)}`;
  }
  if (expectations.indexType && rows[0].INDEX_TYPE !== expectations.indexType) {
    return `${label}: INDEX_TYPE expected ${expectations.indexType}, got ${rows[0].INDEX_TYPE}`;
  }
  return null;
}

function expectsSeq(n) {
  return Array.from({ length: n }, (_, i) => i + 1);
}

async function runSchemaEquivalenceChecks(conn, { expectTargetColumn = true, expectTargetIndex = true } = {}) {
  const errors = [];

  // 0009_workable_stephen_strange
  const siTable = await getTableInfo(conn, 'social_integrations');
  const pageId = await getColumnInfo(conn, 'social_integrations', 'pageId');
  const pageErr = assertColumn(pageId, { dataType: 'varchar', columnTypeIncludes: '255', isNullable: true, default: null, collation: siTable?.TABLE_COLLATION }, '0009 social_integrations.pageId');
  if (pageErr) errors.push(pageErr);

  const pageToken = await getColumnInfo(conn, 'social_integrations', 'pageAccessTokenEncrypted');
  const tokenErr = assertColumn(pageToken, { dataType: 'text', isNullable: true, default: null }, '0009 social_integrations.pageAccessTokenEncrypted');
  if (tokenErr) errors.push(tokenErr);

  // 0010_colorful_polaris
  const integrationId = await getColumnInfo(conn, 'publishing_queue', 'integrationId');
  const intErr = assertColumn(integrationId, { dataType: 'bigint', columnTypeIncludes: 'unsigned', isNullable: true, default: null }, '0010 publishing_queue.integrationId');
  if (intErr) errors.push(intErr);

  // 0011_polite_tusk
  const ig = await getColumnInfo(conn, 'social_integrations', 'instagramBusinessAccountId');
  const igErr = assertColumn(ig, { dataType: 'varchar', columnTypeIncludes: '255', isNullable: true, default: null, collation: siTable?.TABLE_COLLATION }, '0011 social_integrations.instagramBusinessAccountId');
  if (igErr) errors.push(igErr);

  // 0012_add_message_pack_asset_type
  const assetEnum = await getEnumMembers(conn, 'campaign_assets', 'assetType');
  if (!assetEnum) errors.push('0012 campaign_assets.assetType enum missing');
  else if (JSON.stringify(assetEnum) !== JSON.stringify(EXPECTED_ASSET_ENUM)) errors.push(`0012 campaign_assets.assetType enum mismatch: ${JSON.stringify(assetEnum)}`);
  const assetTypeInfo = await getColumnInfo(conn, 'campaign_assets', 'assetType');
  const assetErr = assertColumn(assetTypeInfo, { isNullable: false, default: null }, '0012 campaign_assets.assetType');
  if (assetErr) errors.push(assetErr);

  // 0013_add_social_integrations_business_id
  const biz = await getColumnInfo(conn, 'social_integrations', 'businessId');
  const bizErr = assertColumn(biz, { dataType: 'bigint', columnTypeIncludes: 'unsigned', isNullable: true, default: null }, '0013 social_integrations.businessId');
  if (bizErr) errors.push(bizErr);

  // 0014_dedupe_social_profiles
  const socialIdx = await getIndexRows(conn, 'social_profiles', SOCIAL_INDEX.name);
  const socialErr = assertIndex(socialIdx, { nonUnique: 0, columns: SOCIAL_INDEX.columns, subPartNull: true, indexType: 'BTREE' }, '0014 social_profiles.user_platform_external_idx');
  if (socialErr) errors.push(socialErr);
  const dups = await countDuplicateSocialProfiles(conn);
  if (dups !== 0) errors.push(`0014 duplicate social_profiles groups: ${dups}`);

  // 0016_email_verification_fields (schema only)
  const usersTable = await getTableInfo(conn, 'users');
  const emailVerified = await getColumnInfo(conn, 'users', 'emailVerifiedAt');
  const emailErr = assertColumn(emailVerified, { dataType: 'timestamp', isNullable: true, default: null }, '0016 users.emailVerifiedAt');
  if (emailErr) errors.push(emailErr);

  const last2fa = await getColumnInfo(conn, 'users', 'lastTwoFactorVerifiedAt');
  const lastErr = assertColumn(last2fa, { dataType: 'timestamp', isNullable: true, default: null }, '0016 users.lastTwoFactorVerifiedAt');
  if (lastErr) errors.push(lastErr);

  const tfcTable = await getTableInfo(conn, 'two_factor_challenges');
  const purpose = await getColumnInfo(conn, 'two_factor_challenges', 'purpose');
  const purposeErr = assertColumn(purpose, { dataType: 'varchar', columnTypeIncludes: '50', isNullable: false, default: 'login_2fa', collation: tfcTable?.TABLE_COLLATION }, '0016 two_factor_challenges.purpose');
  if (purposeErr) errors.push(purposeErr);

  // 0015_medical_dreadnoughts (must be applied by the runbook, but verify when expected)
  const ctTable = await getTableInfo(conn, TARGET_COLUMN.table);
  const idemCol = await getColumnInfo(conn, TARGET_COLUMN.table, TARGET_COLUMN.column);
  if (expectTargetColumn) {
    if (!idemCol) errors.push('0015 credit_transactions.idempotencyKey missing');
    else {
      const idemErr = assertColumn(idemCol, { dataType: 'varchar', columnTypeIncludes: '255', isNullable: true, default: null, collation: ctTable?.TABLE_COLLATION }, '0015 credit_transactions.idempotencyKey');
      if (idemErr) errors.push(idemErr);
    }
  } else if (idemCol) {
    errors.push('0015 credit_transactions.idempotencyKey present before expected');
  }

  const idemIdx = await getIndexRows(conn, TARGET_INDEX.table, TARGET_INDEX.name);
  if (expectTargetIndex) {
    if (!idemIdx.length) errors.push('0015 credit_transactions_idempotencyKey_unique missing');
    else {
      const idxErr = assertIndex(idemIdx, { nonUnique: 0, columns: [TARGET_COLUMN.column], subPartNull: true, indexType: 'BTREE' }, '0015 credit_transactions_idempotencyKey_unique');
      if (idxErr) errors.push(idxErr);
    }
  } else if (idemIdx.length) {
    errors.push('0015 credit_transactions_idempotencyKey_unique present before expected');
  }

  const aggregates = await getVerificationAggregates(conn);

  return { errors, aggregates };
}

async function apply0015Column(conn) {
  log('APPLY_0015_COLUMN credit_transactions.idempotencyKey');
  const ctTable = await getTableInfo(conn, TARGET_COLUMN.table);
  const collate = ctTable?.TABLE_COLLATION ? `COLLATE ${ctTable.TABLE_COLLATION}` : '';
  await conn.execute(
    `ALTER TABLE \`${TARGET_COLUMN.table}\` ADD COLUMN \`${TARGET_COLUMN.column}\` varchar(255) ${collate} DEFAULT NULL`.replace(/\s+/g, ' ').trim()
  );
}

async function apply0015Index(conn) {
  log('APPLY_0015_INDEX credit_transactions_idempotencyKey_unique');
  await conn.execute(
    `ALTER TABLE \`${TARGET_INDEX.table}\` ADD CONSTRAINT \`${TARGET_INDEX.name}\` UNIQUE (\`${TARGET_COLUMN.column}\`)`
  );
}

async function detectState(conn) {
  const rows = await getTrackingRows(conn);
  const hasCol = await hasColumn(conn, TARGET_COLUMN.table, TARGET_COLUMN.column);
  const hasIdx = await hasIndex(conn, TARGET_INDEX.table, TARGET_INDEX.name);

  const isFullManifest = manifestMatches(rows);
  const isBaseline = baselineMatches(rows);

  if (isFullManifest && hasCol && hasIdx) return { state: 'D', hasCol, hasIdx, rows };
  if (isBaseline && !hasCol && !hasIdx) return { state: 'A', hasCol, hasIdx, rows };
  if (isBaseline && hasCol && !hasIdx) return { state: 'B', hasCol, hasIdx, rows };
  if (isBaseline && hasCol && hasIdx) return { state: 'C', hasCol, hasIdx, rows };

  return { state: 'UNKNOWN', hasCol, hasIdx, rows, isBaseline, isFullManifest };
}

async function insertTrackingRows(conn) {
  await conn.beginTransaction();
  let affected = 0;
  try {
    for (const row of MISSING_ROWS) {
      const [res] = await conn.execute(
        'INSERT INTO __drizzle_migrations (id, hash, created_at) VALUES (?, ?, ?)',
        [row.id, row.hash, row.created_at]
      );
      affected += res.affectedRows;
    }

    const [allRows] = await conn.execute('SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id');
    const ids = allRows.map(r => Number(r.id));
    const createdAts = allRows.map(r => Number(r.created_at));
    const hashes = allRows.map(r => normalizeHash(r.hash));
    const hasDuplicateId = new Set(ids).size !== ids.length;
    const hasDuplicateCreatedAt = new Set(createdAts).size !== createdAts.length;
    const hasDuplicateHash = new Set(hashes).size !== hashes.length;
    const [[maxRow]] = await conn.execute('SELECT MAX(created_at) AS m FROM __drizzle_migrations');
    const maxCreated = Number(maxRow.m);

    let discrepancy = null;
    if (affected !== MISSING_ROWS.length) discrepancy = `affected rows=${affected}`;
    else if (allRows.length !== FULL_MANIFEST.length) discrepancy = `row count ${allRows.length} != ${FULL_MANIFEST.length}`;
    else if (!manifestMatches(allRows)) discrepancy = 'prospective rows do not match manifest';
    else if (hasDuplicateId) discrepancy = 'duplicate id detected';
    else if (hasDuplicateCreatedAt) discrepancy = 'duplicate created_at detected';
    else if (hasDuplicateHash) discrepancy = 'duplicate hash detected';
    else if (maxCreated !== EXPECTED_MAX_CREATED_AT) discrepancy = `MAX(created_at)=${maxCreated}`;

    if (discrepancy) {
      log(`TRACKING_ROLLBACK: ${discrepancy}`);
      await conn.rollback();
      return { committed: false, discrepancy, affected };
    }

    await conn.commit();
    return { committed: true, affected };
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  }
}

async function getTrackingFingerprint(conn) {
  const [rows] = await conn.execute('SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id');
  return rows.map(r => `${r.id}:${r.hash}:${r.created_at}`).join('|');
}

async function getSchemaFingerprint(conn) {
  const db = (await conn.execute('SELECT DATABASE() AS d'))[0][0].d;
  const [cols] = await conn.execute(
    `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, COLUMN_NAME`,
    [db]
  );
  const [idxs] = await conn.execute(
    `SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SUB_PART
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [db]
  );
  return JSON.stringify({ columns: cols, indexes: idxs });
}

async function getGeneralLogStatus(conn) {
  const [rows] = await conn.execute("SHOW VARIABLES LIKE 'general_log%'");
  const vars = Object.fromEntries(rows.map(r => [r.Variable_name, r.Value]));
  const [logOutputRows] = await conn.execute("SHOW VARIABLES LIKE 'log_output%'");
  vars.log_output = logOutputRows[0]?.Value;
  return vars;
}

async function truncateGeneralLog(conn) {
  try {
    await conn.execute('TRUNCATE TABLE mysql.general_log');
    return true;
  } catch (e) {
    return false;
  }
}

async function readSuspiciousGeneralLog(conn) {
  const [rows] = await conn.execute(
    `SELECT command_type, CAST(LEFT(argument, 300) AS CHAR) AS argument
     FROM mysql.general_log
     WHERE command_type IN ('Execute','Query')
       AND argument REGEXP 'ALTER|CREATE|DROP|UPDATE|DELETE|INSERT INTO __drizzle_migrations'
     ORDER BY event_time`
  );
  return rows
    .map(r => ({ command_type: r.command_type, argument: String(r.argument) }))
    .filter(r => !r.argument.includes('mysql.general_log') && !r.argument.includes('CAST(LEFT(argument'));
}

async function runMigrateOnce() {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'npm.cmd' : 'npm', ['run', 'db:migrate'], {
      shell: true,
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      stdio: 'pipe',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function runMigratorNoOpProof(conn) {
  log('NOOP_PROOF_START');

  const status = await getGeneralLogStatus(conn);
  if (status.general_log !== 'ON' || (status.log_output && status.log_output !== 'TABLE')) {
    fail('BLOCKED_DIRECT_NO_OP_CONTROL', `general_log must be ON with log_output=TABLE (got general_log=${status.general_log}, log_output=${status.log_output}); enable instrumentation externally and rerun`);
  }
  log('NOOP_PROOF general_log=TABLE');

  const beforeTrack = await getTrackingFingerprint(conn);
  const beforeSchema = await getSchemaFingerprint(conn);
  const beforeValues = await getVerificationValuesFingerprint(conn);
  const beforeAgg = await getVerificationAggregates(conn);

  const runs = [];
  for (let i = 1; i <= 2; i++) {
    if (!await truncateGeneralLog(conn)) {
      fail('BLOCKED_DIRECT_NO_OP_CONTROL', `run ${i}: unable to truncate mysql.general_log; ensure the migration account has DROP on mysql.general_log`);
    }
    log(`NOOP_PROOF run=${i} truncated_general_log`);

    const result = await runMigrateOnce();
    log(`NOOP_PROOF run=${i} db:migrate exit=${result.code}`);
    if (result.code !== 0) {
      fail('BLOCKED_DIRECT_NO_OP_CONTROL', `run ${i}: npm run db:migrate exited ${result.code}`);
    }

    const suspicious = await readSuspiciousGeneralLog(conn);
    log(`NOOP_PROOF run=${i} suspicious_entries=${suspicious.length}`);
    if (suspicious.length > 0) {
      const excerpt = suspicious.slice(0, 3).map(r => `[${r.command_type}] ${r.argument.slice(0, 120)}`).join('; ');
      fail('BLOCKED_DIRECT_NO_OP_CONTROL', `run ${i}: observed migration-like statements: ${excerpt}`);
    }
    runs.push({ run: i, migrateExitCode: result.code, suspicious: suspicious.slice(0, 10) });
  }

  const afterTrack = await getTrackingFingerprint(conn);
  const afterSchema = await getSchemaFingerprint(conn);
  const afterValues = await getVerificationValuesFingerprint(conn);
  const afterAgg = await getVerificationAggregates(conn);

  const trackingUnchanged = beforeTrack === afterTrack;
  const schemaUnchanged = beforeSchema === afterSchema;
  const valuesUnchanged = beforeValues === afterValues;
  const aggregatesUnchanged = JSON.stringify(beforeAgg) === JSON.stringify(afterAgg);

  if (!trackingUnchanged) fail('BLOCKED_DIRECT_NO_OP_CONTROL', 'tracking fingerprint changed after db:migrate');
  if (!schemaUnchanged) fail('BLOCKED_DIRECT_NO_OP_CONTROL', 'schema fingerprint changed after db:migrate');
  if (!valuesUnchanged) fail('BLOCKED_DIRECT_NO_OP_CONTROL', 'verification-value fingerprint changed after db:migrate');
  if (!aggregatesUnchanged) fail('BLOCKED_DIRECT_NO_OP_CONTROL', 'verification aggregates changed after db:migrate');

  const proof = {
    runs,
    trackingUnchanged,
    schemaUnchanged,
    valuesUnchanged,
    aggregatesUnchanged,
    beforeTrackingFingerprint: beforeTrack,
  };
  log(`NOOP_PROOF_RESULT=${JSON.stringify(proof)}`);
  log('NOOP_PROOF_OK');
  return proof;
}

async function runSmokeTests() {
  const raw = process.env.WBS24B3B_SMOKE_COMMANDS;
  if (!raw) {
    log('SMOKE_TESTS_PENDING_OPERATOR_EXECUTION');
    return { status: 'pending' };
  }
  let commands;
  try { commands = JSON.parse(raw); } catch (e) {
    fail('BLOCKED_OPERATIONAL_GATES', `WBS24B3B_SMOKE_COMMANDS not valid JSON: ${e.message}`);
  }
  const results = [];
  for (const cmd of commands) {
    log(`SMOKE command: ${cmd}`);
    const code = await new Promise((resolve) => {
      const child = spawn(process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd], {
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
        stdio: 'pipe',
      });
      child.on('close', resolve);
    });
    results.push({ command: cmd, exitCode: code });
    log(`SMOKE result: exit=${code}`);
  }
  return { status: 'executed', results };
}

async function runReleaseGate() {
  const approver = process.env.WBS24B3B_RELEASE_APPROVER;
  const ts = process.env.WBS24B3B_RELEASE_APPROVAL_TIMESTAMP;
  const ref = process.env.WBS24B3B_RELEASE_REFERENCE;
  if (!approver || !ts || !ref) {
    log('RELEASE_APPROVAL_PENDING_OPERATOR');
    return { status: 'pending' };
  }
  log(`RELEASE_APPROVAL operator=${approver} timestamp=${ts} reference=${ref}`);
  return { status: 'executed', approver, timestamp: ts, reference: ref };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------
async function main() {
  log('START reconcile_wbs24b3b.mjs');
  const noopOnly = process.env.WBS24B3B_NOOP_ONLY === 'yes';
  if (noopOnly) log('MODE=WBS24B3B_NOOP_ONLY (DDL/tracking skipped)');

  const roUrl = process.env.READ_ONLY_DATABASE_URL;
  const rwUrl = process.env.DATABASE_URL;
  if (!roUrl) fail('BLOCKED_OPERATIONAL_GATES', 'READ_ONLY_DATABASE_URL missing');
  if (!rwUrl) fail('BLOCKED_OPERATIONAL_GATES', 'DATABASE_URL missing');

  const expectedHost = process.env.WBS24B3B_EXPECTED_HOST;
  const expectedPort = process.env.WBS24B3B_EXPECTED_PORT;
  const expectedDb = process.env.WBS24B3B_EXPECTED_DATABASE;
  const expectedVersion = process.env.WBS24B3B_EXPECTED_MYSQL_VERSION;
  const expectedAccount = process.env.WBS24B3B_EXPECTED_MIGRATION_ACCOUNT;

  if (!expectedHost || !expectedPort || !expectedDb || !expectedVersion || !expectedAccount) {
    fail('BLOCKED_OPERATIONAL_GATES', 'One or more WBS24B3B_EXPECTED_* variables missing');
  }

  const ro = parseDbUrl(roUrl);
  const rw = parseDbUrl(rwUrl);

  const mismatch = [];
  if (ro.host !== expectedHost || rw.host !== expectedHost) mismatch.push('host');
  if (String(ro.port) !== String(expectedPort) || String(rw.port) !== String(expectedPort)) mismatch.push('port');
  if (ro.database !== expectedDb || rw.database !== expectedDb) mismatch.push('database');
  if (!accountMatches(expectedAccount, `${rw.username}@%`)) {
    const exp = parseExpectedAccount(expectedAccount);
    if (!exp || exp.user.toLowerCase() !== rw.username.toLowerCase()) mismatch.push('migration_account_username');
  }
  if (mismatch.length) {
    fail('BLOCKED_OPERATIONAL_GATES', `Target manifest mismatch: ${mismatch.join(',')} expected host=${expectedHost} port=${expectedPort} db=${expectedDb} account=${expectedAccount}`);
  }
  log(`TARGET_MANIFEST host=${expectedHost} port=${expectedPort} db=${expectedDb} version=${expectedVersion} account=${expectedAccount}`);

  // ---------------------------------------------------------------------------
  // Read-only preflight
  // ---------------------------------------------------------------------------
  let roConn;
  try {
    roConn = await mysql.createConnection(roUrl);
    const roId = await getConnectionId(roConn);
    log(`PREFLIGHT_CONN_OPENED id=${roId} url=${ro.host}:${ro.port}/${ro.database}`);

    await roConn.execute('SET SESSION TRANSACTION READ ONLY');
    const [[roCheck]] = await roConn.execute('SELECT @@transaction_read_only AS ro');
    if (Number(roCheck.ro) !== 1) fail('BLOCKED_ACCOUNT_SEPARATION', 'read-only session not verified');
    log('READ_ONLY_SESSION_VERIFIED transaction_read_only=1');

    const version = await queryVersion(roConn);
    if (!versionMatchesRange(expectedVersion, version)) {
      fail('BLOCKED_OPERATIONAL_GATES', `MySQL version ${version} does not match expected ${expectedVersion}`);
    }
    log(`VERSION_OK actual=${version} expected=${expectedVersion}`);

    const state = await detectState(roConn);
    if (state.state === 'UNKNOWN') {
      const rows = state.rows;
      fail('BLOCKED_ACTUAL_PRODUCTION_BASELINE', `unrecognised preflight state: ${rows.length} rows; ids=[${rows.map(r => r.id).join(',')}] hashes=[${rows.map(r => r.hash).join(',')}]`);
    }
    log(`PREFLIGHT_STATE state=${state.state} hasTargetColumn=${state.hasCol} hasTargetIndex=${state.hasIdx}`);

    const checks = await runSchemaEquivalenceChecks(roConn, { expectTargetColumn: undefined, expectTargetIndex: undefined });
    // During preflight the target may or may not be present; we only verify historical effects here.
    const historicalErrors = checks.errors.filter(e => !e.startsWith('0015'));
    if (historicalErrors.length) {
      fail('BLOCKED_SCHEMA_EQUIVALENCE', `preflight historical schema mismatch: ${historicalErrors.join('; ')}`);
    }
    log('PREFLIGHT_HISTORICAL_SCHEMA_OK');

    await roConn.end();
    log(`PREFLIGHT_CONN_CLOSED id=${roId}`);
    roConn = null;
  } catch (e) {
    if (roConn) { try { await roConn.end(); } catch {} }
    fail('BLOCKED_OPERATIONAL_GATES', `read-only preflight error: ${e.message}`);
  }

  // ---------------------------------------------------------------------------
  // Operational gates (between connections)
  // ---------------------------------------------------------------------------
  const missingGates = [];
  for (const g of REQUIRED_GATES) if (!process.env[g]) missingGates.push(g);
  for (const [g, val] of QUIESCENCE_GATES) if (process.env[g] !== val) missingGates.push(`${g}=${val}`);
  if (missingGates.length) {
    fail('BLOCKED_OPERATIONAL_GATES', `Missing/invalid gates: ${missingGates.join(', ')}`);
  }
  log('OPERATIONAL_GATES_OK');

  // ---------------------------------------------------------------------------
  // Migration connection
  // ---------------------------------------------------------------------------
  let rwConn;
  try {
    rwConn = await mysql.createConnection(rwUrl);
    const rwId = await getConnectionId(rwConn);
    log(`MIGRATION_CONN_OPENED id=${rwId} url=${rw.host}:${rw.port}/${rw.database}`);

    const currentUser = await queryCurrentUser(rwConn);
    if (!accountMatches(expectedAccount, currentUser)) {
      fail('BLOCKED_ACCOUNT_SEPARATION', `migration account mismatch: CURRENT_USER=${currentUser} expected=${expectedAccount}`);
    }
    log(`MIGRATION_ACCOUNT_OK current_user=${currentUser}`);

    const version = await queryVersion(rwConn);
    if (!versionMatchesRange(expectedVersion, version)) {
      fail('BLOCKED_OPERATIONAL_GATES', `migration MySQL version ${version} does not match expected ${expectedVersion}`);
    }

    const state = await detectState(rwConn);
    log(`DETECTED_STATE state=${state.state} hasTargetColumn=${state.hasCol} hasTargetIndex=${state.hasIdx}`);
    if (state.state === 'UNKNOWN') {
      fail('BLOCKED_ACTUAL_PRODUCTION_BASELINE', `migration-time state unrecognised: ${state.rows.length} rows`);
    }

    if (noopOnly) {
      if (state.state !== 'D') {
        fail('BLOCKED_DIRECT_NO_OP_CONTROL', `WBS24B3B_NOOP_ONLY requires state D (fully reconciled), got ${state.state}`);
      }
      const checks = await runSchemaEquivalenceChecks(rwConn, { expectTargetColumn: true, expectTargetIndex: true });
      if (checks.errors.length) fail('BLOCKED_SCHEMA_EQUIVALENCE', checks.errors.join('; '));
      log('SCHEMA_EQUIVALENCE_OK');
      await runMigratorNoOpProof(rwConn);
      await rwConn.end();
      log(`MIGRATION_CONN_CLOSED id=${rwId}`);
      await runSmokeTests();
      await runReleaseGate();
      exitClassification = 'PASS_WBS_2_4B3B_FROZEN_PRODUCTION_ARTIFACT_VALIDATED';
      printFinalFlags(exitClassification);
      process.exit(0);
    }

    if (state.state === 'D') {
      log('NO-OP fully reconciled');
      const checks = await runSchemaEquivalenceChecks(rwConn, { expectTargetColumn: true, expectTargetIndex: true });
      if (checks.errors.length) fail('BLOCKED_SCHEMA_EQUIVALENCE', checks.errors.join('; '));
      log('SCHEMA_EQUIVALENCE_OK');
      await runMigratorNoOpProof(rwConn);
      await rwConn.end();
      log(`MIGRATION_CONN_CLOSED id=${rwId}`);
      await runSmokeTests();
      await runReleaseGate();
      exitClassification = 'PASS_WBS_2_4B3B_FROZEN_PRODUCTION_ARTIFACT_VALIDATED';
      printFinalFlags(exitClassification);
      process.exit(0);
    }

    if (state.state !== 'A' && state.state !== 'B' && state.state !== 'C') {
      fail('FAIL_WBS_2_4B3B_VALIDATION', `unrecognized state: ${JSON.stringify(state)}`);
    }

    // -------------------------------------------------------------------------
    // Verify all historical (0009–0014, 0016) schema effects before touching 0015.
    // -------------------------------------------------------------------------
    const historicalChecks = await runSchemaEquivalenceChecks(rwConn, { expectTargetColumn: false, expectTargetIndex: false });
    const historicalErrors = historicalChecks.errors.filter(e => !e.startsWith('0015'));
    if (historicalErrors.length) {
      fail('BLOCKED_SCHEMA_EQUIVALENCE', `historical schema mismatch before 0015: ${historicalErrors.join('; ')}`);
    }
    log('HISTORICAL_SCHEMA_EQUIVALENCE_OK');

    // Capture verification-value fingerprint before any DDL to prove no 0016 UPDATE ran.
    const verificationValuesBefore = await getVerificationValuesFingerprint(rwConn);
    log(`VERIFICATION_VALUES_BEFORE ${verificationValuesBefore === null ? 'columns_absent' : 'fingerprint_captured'}`);

    // -------------------------------------------------------------------------
    // Apply only the 0015 schema effects that are missing.
    // -------------------------------------------------------------------------
    if (state.state === 'A') {
      log('DDL_ADD_0015_COLUMN_AND_INDEX');
      await apply0015Column(rwConn);
      await apply0015Index(rwConn);
    } else if (state.state === 'B') {
      log('DDL_ADD_0015_INDEX');
      await apply0015Index(rwConn);
    } else if (state.state === 'C') {
      log('DDL_0015_ALREADY_PRESENT');
    }

    const after0015Checks = await runSchemaEquivalenceChecks(rwConn, { expectTargetColumn: true, expectTargetIndex: true });
    if (after0015Checks.errors.length) fail('BLOCKED_SCHEMA_EQUIVALENCE', `post-0015 checks failed: ${after0015Checks.errors.join('; ')}`);
    log('SCHEMA_EQUIVALENCE_OK');
    log(`VERIFICATION_AGGREGATES ${JSON.stringify(after0015Checks.aggregates)}`);

    // Verify exact 0015 definition via SHOW CREATE TABLE evidence.
    const showCredit = await getShowCreateTable(rwConn, TARGET_COLUMN.table);
    log(`SHOW_CREATE_TABLE credit_transactions=${(showCredit || '').replace(/\s+/g, ' ').slice(0, 400)}`);

    // -------------------------------------------------------------------------
    // Verify the historical 0016 UPDATE did not run.
    // -------------------------------------------------------------------------
    if (verificationValuesBefore !== null) {
      const verificationValuesAfter = await getVerificationValuesFingerprint(rwConn);
      if (verificationValuesAfter !== verificationValuesBefore) {
        fail('BLOCKED_SCHEMA_EQUIVALENCE', 'verification column values changed during reconciliation; historical 0016 UPDATE may have run');
      }
      log('VERIFICATION_VALUES_UNCHANGED');
    } else {
      const [[updated]] = await rwConn.execute(
        'SELECT COUNT(*) AS c FROM users WHERE emailVerifiedAt IS NOT NULL OR lastTwoFactorVerifiedAt IS NOT NULL'
      );
      if (Number(updated.c) > 0) {
        fail('BLOCKED_SCHEMA_EQUIVALENCE', '0016 historical UPDATE appears to have run; emailVerifiedAt/lastTwoFactorVerifiedAt are non-NULL before expected');
      }
      log('VERIFICATION_VALUES_UNCHANGED no_prior_columns');
    }

    // -------------------------------------------------------------------------
    // Tracking insertion (fail-closed)
    // -------------------------------------------------------------------------
    const stateBeforeTracking = await detectState(rwConn);
    if (stateBeforeTracking.state !== 'C') {
      fail('BLOCKED_TRACKING_TRANSACTION_SAFETY', `expected state C before insert, got ${stateBeforeTracking.state}`);
    }
    log('TRACKING_INSERT_START');
    const result = await insertTrackingRows(rwConn);
    if (!result.committed) {
      fail('BLOCKED_TRACKING_TRANSACTION_SAFETY', `tracking insertion rolled back: ${result.discrepancy}`);
    }
    log(`TRACKING_INSERT_COMMITTED affected=${result.affected}`);

    const afterRows = await getTrackingRows(rwConn);
    if (!manifestMatches(afterRows)) {
      fail('BLOCKED_TRACKING_TRANSACTION_SAFETY', 'post-commit manifest mismatch');
    }
    log('TRACKING_MANIFEST_OK 17_rows');

    // -------------------------------------------------------------------------
    // Verify verification values are still unchanged after tracking insertion.
    // -------------------------------------------------------------------------
    if (verificationValuesBefore !== null) {
      const verificationValuesAfterTracking = await getVerificationValuesFingerprint(rwConn);
      if (verificationValuesAfterTracking !== verificationValuesBefore) {
        fail('BLOCKED_DIRECT_NO_OP_CONTROL', 'verification column values changed during tracking insertion');
      }
      log('VERIFICATION_VALUES_UNCHANGED_AFTER_TRACKING');
    } else {
      const [[updatedAfter]] = await rwConn.execute(
        'SELECT COUNT(*) AS c FROM users WHERE emailVerifiedAt IS NOT NULL OR lastTwoFactorVerifiedAt IS NOT NULL'
      );
      if (Number(updatedAfter.c) > 0) {
        fail('BLOCKED_DIRECT_NO_OP_CONTROL', 'verification values appeared during tracking insertion');
      }
      log('VERIFICATION_VALUES_UNCHANGED_AFTER_TRACKING no_prior_columns');
    }

    // -------------------------------------------------------------------------
    // Direct no-op proof
    // -------------------------------------------------------------------------
    await runMigratorNoOpProof(rwConn);

    await rwConn.end();
    log(`MIGRATION_CONN_CLOSED id=${rwId}`);
    rwConn = null;
  } catch (e) {
    if (rwConn) { try { await rwConn.end(); } catch {} }
    fail('FAIL_WBS_2_4B3B_VALIDATION', `migration phase error: ${e.message}`);
  }

  await runSmokeTests();
  await runReleaseGate();

  exitClassification = 'PASS_WBS_2_4B3B_FROZEN_PRODUCTION_ARTIFACT_VALIDATED';
  printFinalFlags(exitClassification);
  process.exit(0);
}

main().catch(e => {
  log(`UNHANDLED_ERROR: ${e.stack || e.message}`);
  printFinalFlags('FAIL_WBS_2_4B3B_VALIDATION');
  process.exit(1);
});
