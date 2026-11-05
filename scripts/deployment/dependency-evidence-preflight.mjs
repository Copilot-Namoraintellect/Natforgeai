import { types } from 'node:util';

export const DEPENDENCY_EVIDENCE_LIMITS = Object.freeze({ jsonBytes: 2097152, records: 4096, findings: 64, depth: 64, tokens: 150000 });
const L = DEPENDENCY_EVIDENCE_LIMITS;
function record(v, keys) {
  if (!v || typeof v !== 'object' || types.isProxy(v)) throw 0;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw 0;
  const own = Reflect.ownKeys(v);
  if (own.length !== keys.length || own.some(k => !keys.includes(k))) throw 0;
  const out = Object.create(null);
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw 0;
    out[k] = d.value;
  }
  return out;
}
function json(s) {
  if (typeof s !== 'string' || s.length > L.jsonBytes || Buffer.byteLength(s) > L.jsonBytes) throw 0;
  const parsed = JSON.parse(s);
  // JSON.parse accepts duplicate object keys. Reject ambiguous evidence instead.
  const tokens = s.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
  if (tokens.length > L.tokens) throw 0;
  let i = 0;
  function walk(depth) {
    if (depth > L.depth) throw 0;
    const token = tokens[i++];
    if (token === '{') {
      const seen = new Set();
      while (tokens[i] !== '}') {
        const key = JSON.parse(tokens[i++]);
        if (seen.has(key) || seen.size >= L.records) throw 0;
        seen.add(key); i++; walk(depth + 1);
        if (tokens[i] !== ',') break;
        i++;
      }
      i++;
    } else if (token === '[') {
      let count = 0;
      while (tokens[i] !== ']') {
        if (++count > L.records) throw 0;
        walk(depth + 1);
        if (tokens[i] !== ',') break;
        i++;
      }
      i++;
    }
  }
  walk(0);
  return parsed;
}
function obj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function map(v) {
  if (!obj(v) || Object.keys(v).length > L.records || Object.values(v).some(x => typeof x !== 'string' || x.length > 512)) throw 0;
  return v;
}
function list(v) { if (!Array.isArray(v) || v.length > L.records) throw 0; return v; }
const name = s => typeof s === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(s) && s.length <= 160;
const path = s => typeof s === 'string' && s.length <= 512 && /^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/.test(s) && !s.split('/').some(x => x === '.' || x === '..');
const exact = s => typeof s === 'string' && s.length <= 160 &&
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(s) &&
  s.split('-')[0].split('.').every(n => Number.isSafeInteger(Number(n))) &&
  (!s.includes('-') || s.slice(s.indexOf('-') + 1).split('.').every(n => !/^\d+$/.test(n) || n === '0' || !n.startsWith('0')));
const dependencyMap = (v, field) => map(Object.hasOwn(v, field) ? v[field] : {});
const unsupported = v => ['peerDependencies', 'peerDependenciesMeta', 'bundledDependencies', 'bundleDependencies', 'workspaces', 'overrides'].some(k => Object.hasOwn(v, k));

/** Supplied unsigned JSON comparison only. No IO, package execution or semver solver. */
export function validateDependencyEvidence(input) {
  const findings = []; let truncated = false;
  const add = code => { if (findings.length < L.findings) findings.push(code); else truncated = true; };
  const result = () => Object.freeze({ scope: 'UNSIGNED_DEPENDENCY_EVIDENCE_ONLY',
    status: findings.length ? 'EVIDENCE_INCOMPLETE' : 'EVIDENCE_CONSISTENT',
    productionApproved: false, dependencyClosureVerified: false, installedPackagesVerified: false,
    lockfileIntegrityVerified: false, trustedAcquisitionVerified: false, authorizedProvenanceVerified: false,
    allowlistEnforced: false, sbomComplete: false, windowsRuntimeVerified: false,
    truncated, findings: Object.freeze(findings) });
  try {
    const r = record(input, ['packageJson', 'lockJson', 'evidenceJson']);
    const p = json(r.packageJson), l = json(r.lockJson), e = json(r.evidenceJson);
    if (!obj(p) || !obj(l) || !obj(e)) throw 0;
    record(e, ['packages', 'sourceImports', 'buildImports', 'resources']);
    if (l.lockfileVersion !== 3 || !obj(l.packages)) { add('UNSUPPORTED_LOCK'); return result(); }
    const locations = Object.keys(l.packages);
    if (locations.length > L.records) throw 0;
    const root = l.packages['']; if (!obj(root)) throw 0;
    if (unsupported(p) || unsupported(root)) add('UNSUPPORTED_RELATIONSHIP');
    for (const field of ['name', 'version']) {
      if ((Object.hasOwn(p, field) && typeof p[field] !== 'string') || (Object.hasOwn(root, field) && typeof root[field] !== 'string')) throw 0;
      if (p[field] !== root[field]) add('SOURCE_LOCK_IDENTITY_MISMATCH');
    }
    if (Object.hasOwn(p, 'packageManager') && (typeof p.packageManager !== 'string' || !/^npm@\d+\.\d+\.\d+$/.test(p.packageManager))) add('UNSUPPORTED_PACKAGE_MANAGER');
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const a = dependencyMap(p, field), b = dependencyMap(root, field);
      // Edge declarations matter even when a shared target is also required and
      // npm does not mark that target optional. No installation is observed here.
      if (field === 'optionalDependencies' && (Object.keys(a).length || Object.keys(b).length)) add('OPTIONAL_SELECTION_UNVERIFIED');
      if (Object.keys(a).length !== Object.keys(b).length || Object.keys(a).some(k => !name(k) || a[k] !== b[k])) add('SOURCE_LOCK_MISMATCH');
      for (const n of Object.keys(a)) if (!Object.hasOwn(l.packages, `node_modules/${n}`)) add('MISSING_DIRECT_LOCK_ENTRY');
    }
    const claims = new Map();
    for (const row of list(e.packages)) {
      const c = record(row, ['path', 'version']);
      if (!path(c.path) || !exact(c.version)) throw 0;
      if (claims.has(c.path)) add(claims.get(c.path) === c.version ? 'DUPLICATE_PACKAGE' : 'CONFLICTING_PACKAGE');
      claims.set(c.path, c.version);
      const locked = l.packages[c.path];
      if (!Object.hasOwn(l.packages, c.path)) add('MISSING_LOCK_ENTRY');
      else if (!obj(locked) || locked.version !== c.version) add('LOCK_VERSION_MISMATCH');
    }
    const folded = new Set();
    for (const loc of locations) {
      if (loc === '') continue;
      if (folded.has(loc.toLowerCase())) add('LOCATION_COLLISION'); folded.add(loc.toLowerCase());
      const v = l.packages[loc];
      if (!path(loc) || !obj(v) || !exact(v.version)) { add('UNSUPPORTED_LOCK_RECORD'); continue; }
      for (const flag of ['dev', 'optional', 'devOptional', 'hasInstallScript', 'link']) if (Object.hasOwn(v, flag) && typeof v[flag] !== 'boolean') throw 0;
      for (const field of ['os', 'cpu', 'libc']) if (Object.hasOwn(v, field) && (!Array.isArray(v[field]) || v[field].some(x => typeof x !== 'string'))) throw 0;
      if (!claims.has(loc)) add('MISSING_PACKAGE_EVIDENCE');
      if (v.link || unsupported(v)) add('UNSUPPORTED_RELATIONSHIP');
      if (v.optional === true || v.devOptional === true) add('OPTIONAL_SELECTION_UNVERIFIED');
      if (v.os || v.cpu || v.libc) add('PLATFORM_SELECTION_UNVERIFIED');
      if (v.hasInstallScript === true) add('INSTALL_RESOURCE_UNVERIFIED');
      for (const field of ['dependencies', 'optionalDependencies']) {
        for (const [n, spec] of Object.entries(dependencyMap(v, field))) {
          if (!name(n)) throw 0;
          if (field === 'optionalDependencies') add('OPTIONAL_SELECTION_UNVERIFIED');
          // Nearest npm node_modules location. Never choose an arbitrary same-name version.
          let base = loc, target;
          while (true) {
            const candidate = `${base ? `${base}/` : ''}node_modules/${n}`;
            if (Object.hasOwn(l.packages, candidate)) { target = candidate; break; }
            if (!base) break;
            const cut = base.lastIndexOf('/node_modules/'); base = cut < 0 ? '' : base.slice(0, cut);
          }
          if (!target) add(field === 'optionalDependencies' ? 'MISSING_OPTIONAL_LOCK_ENTRY' : 'MISSING_TRANSITIVE_LOCK_ENTRY');
          if (!exact(spec)) add('VERSION_RANGE_UNVERIFIED');
          else if (target && l.packages[target]?.version !== spec) add('EDGE_VERSION_MISMATCH');
        }
      }
    }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [n, spec] of Object.entries(dependencyMap(p, field))) {
        if (!exact(spec)) add('VERSION_RANGE_UNVERIFIED');
        else if (l.packages[`node_modules/${n}`]?.version !== spec) add('DIRECT_VERSION_MISMATCH');
      }
    }
    for (const key of ['sourceImports', 'buildImports']) {
      if (e[key] === null) { add(key === 'buildImports' ? 'MISSING_BUILD_EVIDENCE' : 'MISSING_SOURCE_EVIDENCE'); continue; }
      for (const loc of list(e[key])) {
        if (!path(loc)) throw 0;
        if (!claims.has(loc)) add('IMPORT_WITHOUT_PACKAGE_EVIDENCE');
      }
    }
    for (const row of list(e.resources)) {
      const c = record(row, ['owner', 'kind', 'state']);
      if (!path(c.owner) || !['native', 'browser', 'external-binary', 'font', 'service', 'dynamic-import'].includes(c.kind) || !['missing', 'supplied-unverified'].includes(c.state)) throw 0;
      if (!claims.has(c.owner)) add('RESOURCE_WITHOUT_PACKAGE_EVIDENCE');
      add(c.state === 'missing' ? 'MISSING_RESOURCE_EVIDENCE' : 'RESOURCE_UNVERIFIED');
    }
    const needs = [['playwright', 'browser'], ['playwright-core', 'browser'], ['sharp', 'native'], ['ffmpeg-static', 'external-binary']];
    // Require declarations from lock evidence even when a package claim is omitted,
    // and at nested locations as well as the root. Resources never become verified.
    for (const loc of locations) for (const [n, kind] of needs) {
      if ((loc === `node_modules/${n}` || loc.endsWith(`/node_modules/${n}`)) &&
          !e.resources.some(c => c.owner === loc && c.kind === kind)) add('MISSING_RESOURCE_DECLARATION');
    }
  } catch { add('INVALID_OR_LIMITED_INPUT'); }
  return result();
}
