import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDependencyEvidence as validate, DEPENDENCY_EVIDENCE_LIMITS as L } from './dependency-evidence-preflight.mjs';

function fixture(change = () => {}) {
  const p = { dependencies: { alpha: '1.0.0' } };
  const l = { lockfileVersion: 3, packages: { '': structuredClone(p), 'node_modules/alpha': { version: '1.0.0' } } };
  const e = { packages: [{ path: 'node_modules/alpha', version: '1.0.0' }], sourceImports: ['node_modules/alpha'], buildImports: [], resources: [] };
  change(p, l, e);
  return { packageJson: JSON.stringify(p), lockJson: JSON.stringify(l), evidenceJson: JSON.stringify(e) };
}
const has = (input, code) => assert.ok(validate(input).findings.includes(code), code);
test('I4-T01 consistent unsigned exact records never establish approval', () => {
  const out = validate(fixture()); assert.equal(out.status, 'EVIDENCE_CONSISTENT');
  for (const [k, v] of Object.entries(out)) if (typeof v === 'boolean') assert.equal(v, false, k);
  assert.ok(Object.isFrozen(out)); assert.ok(Object.isFrozen(out.findings));
});
test('I4-T02 source/lock correspondence and direct exact version', () => {
  has(fixture((p) => p.dependencies.alpha = '2.0.0'), 'SOURCE_LOCK_MISMATCH');
  has(fixture((p, l) => { p.dependencies.alpha = l.packages[''].dependencies.alpha = '2.0.0'; }), 'DIRECT_VERSION_MISMATCH');
  has(fixture((p, l) => delete l.packages['node_modules/alpha']), 'MISSING_DIRECT_LOCK_ENTRY');
  has(fixture(p => p.name = 'different'), 'SOURCE_LOCK_IDENTITY_MISMATCH');
  has(fixture(p => p.packageManager = 'pnpm@10.0.0'), 'UNSUPPORTED_PACKAGE_MANAGER');
});
test('I4-T03 version ambiguity remains unresolved', () => {
  has(fixture((p, l) => { p.dependencies.alpha = l.packages[''].dependencies.alpha = '^1.0.0'; }), 'VERSION_RANGE_UNVERIFIED');
  has(fixture((p, l) => l.packages['node_modules/alpha'].version = 'latest'), 'UNSUPPORTED_LOCK_RECORD');
});
test('I4-T04 missing transitive, optional and peer relationships', () => {
  has(fixture((p, l) => l.packages['node_modules/alpha'].dependencies = { beta: '1.0.0' }), 'MISSING_TRANSITIVE_LOCK_ENTRY');
  has(fixture((p, l) => l.packages['node_modules/alpha'].optionalDependencies = { beta: '1.0.0' }), 'MISSING_OPTIONAL_LOCK_ENTRY');
  has(fixture((p, l) => l.packages['node_modules/alpha'].peerDependencies = { beta: '*' }), 'UNSUPPORTED_RELATIONSHIP');
});
test('I4-T05 nearest nested package version, never global name match', () => {
  has(fixture((p, l, e) => {
    l.packages['node_modules/alpha'].dependencies = { beta: '2.0.0' };
    l.packages['node_modules/alpha/node_modules/beta'] = { version: '1.0.0' };
    l.packages['node_modules/beta'] = { version: '2.0.0' };
    e.packages.push({ path: 'node_modules/alpha/node_modules/beta', version: '1.0.0' }, { path: 'node_modules/beta', version: '2.0.0' });
  }), 'EDGE_VERSION_MISMATCH');
});
test('I4-T06 optional native and install resources stay unverified', () => {
  const input = fixture((p, l) => Object.assign(l.packages['node_modules/alpha'], { optional: true, os: ['win32'], cpu: ['x64'], hasInstallScript: true }));
  for (const c of ['OPTIONAL_SELECTION_UNVERIFIED', 'PLATFORM_SELECTION_UNVERIFIED', 'INSTALL_RESOURCE_UNVERIFIED']) has(input, c);
});
test('I4-T07 browser, native, FFmpeg declarations required; claims never verify binaries', () => {
  for (const [n, kind] of [['playwright', 'browser'], ['playwright-core', 'browser'], ['sharp', 'native'], ['ffmpeg-static', 'external-binary']]) {
    const setup = (p, l, e) => { l.packages[`node_modules/${n}`] = { version: '1.0.0' }; e.packages.push({ path: `node_modules/${n}`, version: '1.0.0' }); };
    has(fixture(setup), 'MISSING_RESOURCE_DECLARATION');
    for (const state of ['missing', 'supplied-unverified']) has(fixture((p,l,e) => { setup(p,l,e); e.resources.push({ owner: `node_modules/${n}`, kind, state }); }), state === 'missing' ? 'MISSING_RESOURCE_EVIDENCE' : 'RESOURCE_UNVERIFIED');
  }
});
test('I4-T08 source/build omissions and missing package evidence', () => {
  has(fixture((p,l,e) => e.buildImports = null), 'MISSING_BUILD_EVIDENCE');
  has(fixture((p,l,e) => e.sourceImports = null), 'MISSING_SOURCE_EVIDENCE');
  has(fixture((p,l,e) => e.packages = []), 'IMPORT_WITHOUT_PACKAGE_EVIDENCE');
  has(fixture((p,l,e) => e.packages = []), 'MISSING_PACKAGE_EVIDENCE');
});
test('I4-T09 duplicates, conflicts and lock mismatches', () => {
  has(fixture((p,l,e) => e.packages.push({ ...e.packages[0] })), 'DUPLICATE_PACKAGE');
  has(fixture((p,l,e) => e.packages.push({ ...e.packages[0], version: '2.0.0' })), 'CONFLICTING_PACKAGE');
  has(fixture((p,l,e) => e.packages[0].path = 'node_modules/missing'), 'MISSING_LOCK_ENTRY');
  has(fixture((p,l,e) => e.packages[0].version = '2.0.0'), 'LOCK_VERSION_MISMATCH');
  has(fixture((p,l) => l.packages['node_modules/ALPHA'] = { version: '1.0.0' }), 'LOCATION_COLLISION');
});
test('I4-T10 unsafe outer records never execute getters, proxies or coercion', () => {
  let calls = 0; const fail = () => { calls++; throw Error('secret'); };
  const getter = fixture(); Object.defineProperty(getter, 'packageJson', { get: fail });
  const proxy = new Proxy({}, { ownKeys: fail, getPrototypeOf: fail, get: fail });
  const rev = Proxy.revocable({}, {}); rev.revoke();
  for (const v of [getter, proxy, rev.proxy, null, [], { ...fixture(), extra: true }, { ...fixture(), packageJson: { toString: fail } }]) has(v, 'INVALID_OR_LIMITED_INPUT');
  assert.equal(calls, 0);
});
test('I4-T11 malformed and unsupported records fail redacted', () => {
  for (const input of [
    { ...fixture(), lockJson: '{secret' },
    fixture((p,l) => l.lockfileVersion = 2),
    fixture((p,l,e) => e.packages[0].path = '../secret'),
    fixture((p,l,e) => e.resources.push({ owner: 'node_modules/alpha', kind: 'native', state: 'verified' })),
    fixture((p,l,e) => e.productionApproved = true),
    fixture((p,l) => l.packages['node_modules/alpha'].dependencies = ['bad'])
  ]) { const out = validate(input); assert.equal(out.status, 'EVIDENCE_INCOMPLETE'); assert.ok(!JSON.stringify(out).includes('secret')); }
});
test('I4-T12 resource and diagnostic ceilings', () => {
  has({ ...fixture(), packageJson: ' '.repeat(L.jsonBytes + 1) }, 'INVALID_OR_LIMITED_INPUT');
  has(fixture((p,l,e) => e.packages = Array(L.records + 1).fill(e.packages[0])), 'INVALID_OR_LIMITED_INPUT');
  const out = validate(fixture((p,l,e) => e.packages = Array(100).fill(e.packages[0])));
  assert.equal(out.findings.length, L.findings); assert.equal(out.truncated, true);
});
test('I4-T13 deterministic output, nonmutation, null prototype, no authority fields', () => {
  const input = fixture(); const copy = structuredClone(input); Object.freeze(input);
  assert.deepEqual(validate(input), validate(input)); assert.deepEqual(input, copy);
  assert.equal(validate(Object.assign(Object.create(null), input)).status, 'EVIDENCE_CONSISTENT');
  const symbols = { ...input, [Symbol('secret')]: true }; has(symbols, 'INVALID_OR_LIMITED_INPUT');
});
test('I4-T14 duplicate JSON keys, excessive nesting and malformed flags reject', () => {
  has({ ...fixture(), packageJson: '{"dependencies":{},"dependen\\u0063ies":{}}' }, 'INVALID_OR_LIMITED_INPUT');
  has({ ...fixture(), packageJson: '['.repeat(70) + '0' + ']'.repeat(70) }, 'INVALID_OR_LIMITED_INPUT');
  has(fixture((p,l) => l.packages['node_modules/alpha'].optional = 'false'), 'INVALID_OR_LIMITED_INPUT');
  has(fixture((p,l) => l.packages['node_modules/alpha'].os = 'win32'), 'INVALID_OR_LIMITED_INPUT');
});

test('I4-T15 null dependency maps cannot silently become absent maps', () => {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    has(fixture((p,l) => { p[field] = null; l.packages[''][field] = null; }), 'INVALID_OR_LIMITED_INPUT');
    has(fixture((p,l) => l.packages['node_modules/alpha'][field === 'devDependencies' ? 'dependencies' : field] = null), 'INVALID_OR_LIMITED_INPUT');
  }
});

test('I4-T16 canonical exact versions and bounded prerelease profile', () => {
  for (const version of ['01.0.0', '1.0.0-01', '1.0.0-a..b', '1.0.0-.', '9007199254740992.0.0', '1.0.0+build', '1.0.0-' + 'a'.repeat(161)]) {
    has(fixture((p,l,e) => e.packages[0].version = version), 'INVALID_OR_LIMITED_INPUT');
    has(fixture((p,l) => l.packages['node_modules/alpha'].version = version), 'UNSUPPORTED_LOCK_RECORD');
  }
  const input = fixture((p,l,e) => {
    p.dependencies.alpha = l.packages[''].dependencies.alpha = '1.0.0-alpha.1';
    l.packages['node_modules/alpha'].version = e.packages[0].version = '1.0.0-alpha.1';
  });
  assert.equal(validate(input).status, 'EVIDENCE_CONSISTENT');
});

test('I4-T17 root and package relationships outside the supported profile stay unresolved', () => {
  for (const field of ['peerDependencies', 'peerDependenciesMeta', 'bundledDependencies', 'bundleDependencies', 'workspaces', 'overrides']) {
    has(fixture(p => p[field] = {}), 'UNSUPPORTED_RELATIONSHIP');
    has(fixture((p,l) => l.packages[''][field] = {}), 'UNSUPPORTED_RELATIONSHIP');
    has(fixture((p,l) => l.packages['node_modules/alpha'][field] = {}), 'UNSUPPORTED_RELATIONSHIP');
  }
});

test('I4-T18 nested resource owners and missing package claims cannot hide resources', () => {
  for (const [n, kind] of [['playwright', 'browser'], ['playwright-core', 'browser'], ['sharp', 'native'], ['ffmpeg-static', 'external-binary']]) {
    const owner = `node_modules/alpha/node_modules/${n}`;
    const setup = (p,l,e) => { l.packages[owner] = { version: '1.0.0' }; e.packages.push({ path: owner, version: '1.0.0' }); };
    has(fixture(setup), 'MISSING_RESOURCE_DECLARATION');
    has(fixture((p,l,e) => { setup(p,l,e); e.packages.pop(); }), 'MISSING_RESOURCE_DECLARATION');
    const out = validate(fixture((p,l,e) => { setup(p,l,e); e.resources.push({ owner, kind, state: 'supplied-unverified' }); }));
    assert.ok(!out.findings.includes('MISSING_RESOURCE_DECLARATION'));
    assert.ok(out.findings.includes('RESOURCE_UNVERIFIED'));
    assert.equal(out.productionApproved, false);
  }
});

test('I4-T19 UTF-8 byte, token, object-field and lock-location limits', () => {
  has({ ...fixture(), packageJson: JSON.stringify({ value: 'é'.repeat(L.jsonBytes / 2) }) }, 'INVALID_OR_LIMITED_INPUT');
  has(fixture(p => p.extra = Object.fromEntries(Array.from({ length: L.records + 1 }, (_,i) => [String(i), 0]))), 'INVALID_OR_LIMITED_INPUT');
  has(fixture((p,l) => { for (let i = 0; i < L.records; i++) l.packages[`node_modules/pkg${i}`] = { version: '1.0.0' }; }), 'INVALID_OR_LIMITED_INPUT');
  has(fixture(p => p.extra = Array.from({ length: 100 }, () => Array(1000).fill(0))), 'INVALID_OR_LIMITED_INPUT');
});

test('I4-T20 hostile markers and approval fields never escape in any outcome', () => {
  for (const input of [fixture(), fixture((p,l,e) => e.resources.push({ owner: 'node_modules/alpha', kind: 'service', state: 'missing' })),
    fixture((p,l,e) => e.packages[0].version = 'SECRET_MARKER'),
    { ...fixture(), productionApproved: true }, fixture((p,l,e) => e.authorizedProvenanceVerified = true)]) {
    const out = validate(input);
    for (const field of ['productionApproved', 'dependencyClosureVerified', 'installedPackagesVerified', 'lockfileIntegrityVerified', 'trustedAcquisitionVerified', 'authorizedProvenanceVerified', 'allowlistEnforced', 'sbomComplete', 'windowsRuntimeVerified']) assert.equal(out[field], false);
    assert.ok(!JSON.stringify(out).includes('SECRET_MARKER'));
  }
});

function optionalUnverified(input) {
  const out = validate(input);
  assert.equal(out.status, 'EVIDENCE_INCOMPLETE');
  assert.ok(out.findings.includes('OPTIONAL_SELECTION_UNVERIFIED'));
  assert.ok(!out.findings.some(code => code.startsWith('MISSING_')));
  for (const field of ['productionApproved', 'dependencyClosureVerified', 'installedPackagesVerified', 'lockfileIntegrityVerified', 'trustedAcquisitionVerified', 'authorizedProvenanceVerified', 'allowlistEnforced', 'sbomComplete', 'windowsRuntimeVerified']) assert.equal(out[field], false);
  assert.deepEqual(validate(input), out);
}

test('I4-T21 root optional edges retain uncertainty independently of target flags', () => {
  for (const optional of [undefined, false, true]) for (const alsoRequired of [false, true]) {
    optionalUnverified(fixture((p,l) => {
      p.optionalDependencies = { alpha: '1.0.0' };
      l.packages[''].optionalDependencies = { alpha: '1.0.0' };
      if (!alsoRequired) { delete p.dependencies; delete l.packages[''].dependencies; }
      if (optional !== undefined) l.packages['node_modules/alpha'].optional = optional;
    }));
  }
  // A lock-root-only edge is still evidence, alongside the map mismatch.
  const mismatch = fixture((p,l) => l.packages[''].optionalDependencies = { alpha: '1.0.0' });
  has(mismatch, 'OPTIONAL_SELECTION_UNVERIFIED'); has(mismatch, 'SOURCE_LOCK_MISMATCH');
  assert.equal(validate(fixture((p,l) => { p.optionalDependencies = {}; l.packages[''].optionalDependencies = {}; })).status, 'EVIDENCE_CONSISTENT');
});

test('I4-T22 transitive optional edges retain uncertainty for present nested and shared targets', () => {
  for (const optional of [undefined, false, true]) for (const nested of [false, true]) {
    optionalUnverified(fixture((p,l,e) => {
      const target = nested ? 'node_modules/alpha/node_modules/beta' : 'node_modules/beta';
      l.packages['node_modules/alpha'].optionalDependencies = { beta: '2.0.0' };
      l.packages['node_modules/alpha'].dependencies = { beta: '2.0.0' };
      l.packages[target] = { version: '2.0.0' };
      if (optional !== undefined) l.packages[target].optional = optional;
      e.packages.push({ path: target, version: '2.0.0' });
    }));
  }
  const missing = fixture((p,l) => l.packages['node_modules/alpha'].optionalDependencies = { beta: '2.0.0' });
  has(missing, 'OPTIONAL_SELECTION_UNVERIFIED'); has(missing, 'MISSING_OPTIONAL_LOCK_ENTRY');
  assert.equal(validate(fixture((p,l) => l.packages['node_modules/alpha'].optionalDependencies = {})).status, 'EVIDENCE_CONSISTENT');
});

test('I4-T23 devOptional is explicit uncertainty, never missing-package evidence', () => {
  for (const optional of [undefined, false, true]) for (const dev of [undefined, false, true]) {
    optionalUnverified(fixture((p,l) => {
      const target = l.packages['node_modules/alpha']; target.devOptional = true;
      if (optional !== undefined) target.optional = optional;
      if (dev !== undefined) target.dev = dev;
    }));
  }
  assert.equal(validate(fixture((p,l) => Object.assign(l.packages['node_modules/alpha'], { devOptional: false, optional: false }))).status, 'EVIDENCE_CONSISTENT');
  has(fixture((p,l) => l.packages['node_modules/alpha'].devOptional = 'true'), 'INVALID_OR_LIMITED_INPUT');
});
