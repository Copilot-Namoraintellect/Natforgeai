import test from "node:test";
import assert from "node:assert/strict";
import { validateManifestFileInventory as validate } from "./manifest-inventory-preflight.mjs";

const hash = "a".repeat(64);
const manifest = (path = "app/main.js", extra = {}) => ({ path, size: 1, sha256: hash, class: "server-bundle", runtimeWritable: false, ...extra });
const observed = (path = "app/main.js", extra = {}) => ({ path, size: 1, sha256: hash, kind: "file", runtimeWritable: false, ...extra });
function fails(m, o) { const result = validate(m, o); assert.equal(result.status, "FAIL"); assert.equal(result.productionApproved, false); return result; }
function both(recordChange) {
  fails([recordChange(manifest())], [observed()]);
  fails([manifest()], [recordChange(observed())]);
}

test("ET02-I1-T01 valid classes, unordered file correspondence and null prototypes", () => {
  const classes = ["server-bundle", "static", "dependency", "browser", "license"];
  const m = classes.map((value, i) => Object.assign(Object.create(null), manifest(`app/file${i}`, { class: value })));
  const o = classes.map((_, i) => observed(`app/file${i}`)).reverse();
  assert.equal(validate(m, o).status, "PASS");
});

test("ET02-I1-T02 malformed arrays, holes, extras and unusual prototypes", () => {
  for (const input of [null, undefined, {}, "secret-marker", [], new Array(1), Object.assign([manifest()], { extra: 1 }), Object.setPrototypeOf([manifest()], null)]) {
    fails(input, [observed()]); fails([manifest()], input);
  }
  for (const key of [Symbol("private"), "01", "1\n"]) {
    const input = [manifest()]; input[key] = 1; fails(input, [observed()]);
  }
});

test("ET02-I1-T03 exact fields and classes; class never substitutes for kind", () => {
  for (const field of ["path", "size", "sha256", "runtimeWritable"]) both(record => { delete record[field]; return record; });
  both(record => ({ ...record, unexpected: "secret-marker" }));
  both(record => Object.assign(record, { [Symbol("private")]: true }));
  both(record => Object.setPrototypeOf(record, { inherited: true }));
  for (const value of [undefined, null, "file", "STATIC", {}, 1]) fails([manifest(undefined, { class: value })], [observed()]);
  const m = manifest(); delete m.class; fails([m], [observed()]);
  fails([{ ...manifest(), kind: "file" }], [observed()]);
  const o = observed(); delete o.kind; fails([manifest()], [o]);
  fails([manifest()], [{ ...observed(), class: "static" }]);
});

test("ET02-I1-T04 unsafe and sensitive paths on either input", () => {
  for (const path of ["/root", "C:/file", "C:file", "\\\\host\\share", "\\\\?\\C:\\file", "\\\\.\\NUL", "app/../file", "app/./file", "app//file", "app\\file", "app/file:stream", "app/CON.txt", "app/nul", "app/file.", "app/%2e%2e/file", "app/.env", "app/.env.example", "public/web.config.bak", "app/fixture-logo2.svg", "app/fixture-logoFINAL.svg", "app/FiXtUrE-LoGo", "app/tests/file", "app/private.key", "app/logs/file", "app/firebase-adminsdk.json", "app/a\n"]) {
    fails([manifest(path)], [observed()]); fails([manifest()], [observed(path)]);
  }
});

test("ET02-I1-T05 duplicates, case collisions and ancestor conflicts in both orders", () => {
  for (const paths of [["app/a", "app/a"], ["app/A", "app/a"], ["app/a", "app/a/b"], ["app/a/b", "app/a"]]) {
    fails(paths.map(path => manifest(path)), [observed()]);
    fails([manifest()], paths.map(path => observed(path)));
  }
});

test("ET02-I1-T06 case-only cross-input mismatch is not repaired", () => {
  const result = fails([manifest("app/Main.js")], [observed("app/main.js")]);
  assert.deepEqual(result.findings, [{ side: "manifest", entryIndex: 0, code: "CASE_MISMATCH" }]);
});

test("ET02-I1-T07 missing and unexpected files", () => {
  assert.deepEqual(fails([manifest("app/a")], [observed("app/b")]).findings.map(f => f.code), ["MISSING_FILE", "UNEXPECTED_FILE"]);
  fails([manifest(), manifest("app/extra")], [observed()]);
  fails([manifest()], [observed(), observed("app/extra")]);
});

test("ET02-I1-T08 size and digest comparisons use supplied values only", () => {
  assert.deepEqual(fails([manifest()], [observed(undefined, { size: 2, sha256: "b".repeat(64) })]).findings.map(f => f.code), ["SIZE_MISMATCH", "SHA256_MISMATCH"]);
  for (const size of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", {}]) both(record => ({ ...record, size }));
  for (const sha256 of ["A".repeat(64), hash + "\n", "bad", null, {}]) both(record => ({ ...record, sha256 }));
  for (const size of [0, Number.MAX_SAFE_INTEGER]) assert.equal(validate([manifest(undefined, { size })], [observed(undefined, { size })]).status, "PASS");
});

test("ET02-I1-T09 unsupported physical kinds and writable metadata", () => {
  for (const kind of ["symlink", "junction", "hardlink", "directory", "browser", undefined, {}]) fails([manifest()], [observed(undefined, { kind })]);
  for (const runtimeWritable of [true, 0, null, undefined, "false"]) both(record => ({ ...record, runtimeWritable }));
});

test("ET02-I1-T10 getters, array accessors and proxies never execute callbacks", () => {
  let calls = 0;
  const trap = () => { calls++; throw new Error("secret-marker"); };
  for (const key of ["path", "class", "sha256"]) {
    const entry = manifest(); Object.defineProperty(entry, key, { enumerable: true, get: trap });
    fails([entry], [observed()]);
  }
  const entry = observed(); Object.defineProperty(entry, "kind", { enumerable: true, get: trap }); fails([manifest()], [entry]);
  const array = [manifest()]; Object.defineProperty(array, "0", { enumerable: true, get: trap });
  fails(array, [observed()]); fails([manifest()], array);
  for (const target of [[manifest()], manifest(), observed()]) {
    const proxy = new Proxy(target, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
    fails(Array.isArray(target) ? proxy : [proxy], [observed()]);
    fails([manifest()], Array.isArray(target) ? proxy : [proxy]);
    const revoked = Proxy.revocable(target, {}); revoked.revoke();
    fails([revoked.proxy], [observed()]);
  }
  both(record => ({ ...record, size: { toString: trap, valueOf: trap } }));
  assert.equal(calls, 0);
});

test("ET02-I1-T11 frozen inputs preserved, deterministic redacted frozen results", () => {
  const m = Object.freeze([Object.freeze(manifest())]); const o = Object.freeze([Object.freeze(observed())]);
  assert.equal(validate(m, o).status, "PASS"); assert.equal(m[0].class, "server-bundle");
  const bad = [manifest("secret-marker/.env")];
  const first = fails(bad, o); assert.deepEqual(first, validate(bad, o));
  assert.equal(JSON.stringify(first).includes("secret-marker"), false);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.findings) && first.findings.every(Object.isFrozen));
  assert.throws(() => { first.productionApproved = true; }, TypeError);
});

test("ET02-I1-T12 count, path, segment and findings limits fail closed", () => {
  fails(new Array(100001), [observed()]); fails([manifest()], new Array(100001));
  both(record => ({ ...record, path: "a".repeat(256) }));
  both(record => ({ ...record, path: Array(6).fill("a".repeat(200)).join("/") }));
  const m = Array.from({ length: 200 }, (_, i) => manifest(`app/f${i}`, { class: "bad" }));
  const result = fails(m, [observed()]); assert.equal(result.findings.length, 128);
  assert.equal(result.findings.at(-1).code, "FINDING_LIMIT_REACHED");
  const valid = Array.from({ length: 100000 }, (_, i) => manifest(`app/f${i}`));
  assert.equal(validate(valid, valid.map(({ class: ignored, ...record }) => ({ ...record, kind: "file" }))).status, "PASS");
});

test("ET02-I1-T13 matched hashes never confer integrity, full manifest or production approval", () => {
  const result = validate([manifest()], [observed()]); assert.equal(result.status, "PASS");
  for (const key of ["productionApproved", "byteIntegrityVerified", "fullManifestVerified", "signedProvenanceVerified", "allowlistVerified", "dependencyClosureVerified"]) assert.equal(result[key], false);
  assert.equal(result.scope, "SUPPLIED_MANIFEST_FILE_INVENTORY_ONLY");
});

test("ET02-I1-T14 deferred extensions retain ET01 policy without new approval", () => {
  for (const ext of ["cab", "jar", "swn", "p8"]) {
    const result = validate([manifest(`app/file.${ext}`)], [observed(`app/file.${ext}`)]);
    assert.equal(result.status, "PASS"); assert.equal(result.productionApproved, false);
  }
});
