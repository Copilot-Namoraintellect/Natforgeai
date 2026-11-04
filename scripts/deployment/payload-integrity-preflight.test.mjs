import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyPayloadIntegrity as verify, PAYLOAD_INTEGRITY_LIMITS as limits } from "./payload-integrity-preflight.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const record = (p = "app/a", bytes = "abc") => ({ path: p, size: Buffer.byteLength(bytes), sha256: sha(bytes), class: "static", runtimeWritable: false });
async function fixture(t, files = { "app/a": "abc" }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "r10a-i2-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [p, bytes] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true }); await fs.writeFile(path.join(root, p), bytes); }
  return { root, manifest: Object.entries(files).map(([p, bytes]) => record(p, bytes)) };
}
function failure(r) { assert.equal(r.status, "FAIL"); assert.equal(r.productionApproved, false); return r; }

test("I2-T01 known digests, binary/empty files, hidden entries, reordered manifest", async t => {
  const f = await fixture(t, { "app/a": "abc", "app/b": Buffer.from([0, 255, 12]), "app/.asset": "", "empty": "" });
  assert.equal(f.manifest[0].sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(f.manifest[2].sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  const r = await verify(f.root, f.manifest.reverse()); assert.equal(r.status, "PASS"); assert.equal(r.bytesRead, 6); assert.equal(r.filesRead, 4);
});
test("I2-T02 root and manifest validation precedes IO, getters/proxies reject", async t => {
  let calls = 0; t.mock.method(fs, "lstat", async () => { calls++; throw Error("must not read"); });
  for (const root of [undefined, null, {}, "", ".", "C:relative", "\\\\host\\share", "//host/share", "\\\\?\\C:\\x", "\\\\.\\NUL", path.parse(process.cwd()).root]) failure(await verify(root, [record()]));
  for (const input of [null, [], {}, new Array(1), [new Proxy(record(), {})], [record("../a")], [{ ...record(), extra: true }]]) failure(await verify(path.join(os.tmpdir(), "not-read"), input));
  const m = record(); Object.defineProperty(m, "path", { enumerable: true, get() { throw Error("getter"); } });
  failure(await verify(path.join(os.tmpdir(), "not-read"), [m])); assert.equal(calls, 0);
});
test("I2-T03 missing/extra/case mismatch and directory substitution", async t => {
  const f = await fixture(t);
  failure(await verify(f.root, [record("app/missing")]));
  failure(await verify(f.root, [record("APP/a")]));
  await fs.writeFile(path.join(f.root, "app/extra"), "x"); failure(await verify(f.root, f.manifest));
  await fs.unlink(path.join(f.root, "app/extra")); await fs.unlink(path.join(f.root, "app/a"));
  await fs.mkdir(path.join(f.root, "app/a")); failure(await verify(f.root, f.manifest));
});
test("I2-T04 prohibited real paths rejected before opening contents or descending", async t => {
  const f = await fixture(t, { "app/.env.production": "SYNTHETIC_ONLY" });
  let opens = 0; t.mock.method(fs, "open", async () => { opens++; throw Error("no content read"); });
  const r = failure(await verify(f.root, [record()])); assert.equal(r.findings[0].code, "PATH_POLICY"); assert.equal(opens, 0);
});
test("I2-T05 truncation and same-size substitution", async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, "app/a"), "ab"); failure(await verify(f.root, f.manifest));
  await fs.writeFile(path.join(f.root, "app/a"), "xyz"); const r = failure(await verify(f.root, f.manifest)); assert.ok(r.findings.some(f => f.code === "SHA256_MISMATCH"));
});
test("I2-T06 hardlink rejection", async t => {
  const f = await fixture(t); await fs.link(path.join(f.root, "app/a"), path.join(f.root, "app/link"));
  failure(await verify(f.root, f.manifest));
});
test("I2-T07 symlink rejection when permitted", async t => {
  const f = await fixture(t);
  try { await fs.symlink(path.join(f.root, "app/a"), path.join(f.root, "app/link"), "file"); }
  catch (e) { if (["EPERM", "ENOSYS", "ENOTSUP"].includes(e.code)) { t.skip("NOT_RUN: local symlink capability unavailable"); return; } throw e; }
  failure(await verify(f.root, f.manifest));
});
test("I2-T08 Windows junction rejection", { skip: process.platform !== "win32" ? "NOT_RUN: Windows only" : false }, async t => {
  const f = await fixture(t); const other = await fixture(t, { "other": "x" });
  await fs.symlink(other.root, path.join(f.root, "linked"), "junction"); failure(await verify(f.root, f.manifest));
});
test("I2-T09 injected open failure/deletion is redacted", async t => {
  const f = await fixture(t); t.mock.method(fs, "open", async () => { throw Error("SYNTHETIC_PRIVATE_VALUE " + f.root); });
  const r = failure(await verify(f.root, f.manifest)); assert.equal(r.findings[0].code, "IO_ERROR");
  assert.ok(!JSON.stringify(r).includes("SYNTHETIC_PRIVATE_VALUE")); assert.ok(!JSON.stringify(r).includes(f.root));
});
test("I2-T10 deterministic append during read rejected; handle closes", async t => {
  const f = await fixture(t); const open = fs.open.bind(fs); let closes = 0;
  t.mock.method(fs, "open", async (...args) => {
    const h = await open(...args); const read = h.read.bind(h), close = h.close.bind(h); let changed = false;
    h.read = async (...a) => { const r = await read(...a); if (!changed) { changed = true; await fs.appendFile(path.join(f.root, "app/a"), "x"); } return r; };
    h.close = async () => { closes++; return close(); }; return h;
  });
  failure(await verify(f.root, f.manifest)); assert.equal(closes, 1);
});
test("I2-T11 deterministic deletion between enumeration/open rejects", async t => {
  const f = await fixture(t); const open = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args) => { await fs.unlink(path.join(f.root, "app/a")); return open(...args); });
  failure(await verify(f.root, f.manifest));
});
test("I2-T12 snapshot survives caller mutation after call; frozen inputs unchanged", async t => {
  const f = await fixture(t); const promise = verify(f.root, f.manifest); f.manifest[0].path = "../changed";
  assert.equal((await promise).status, "PASS");
  const frozen = Object.freeze([Object.freeze(record())]); assert.equal((await verify(f.root, frozen)).status, "PASS");
});
test("I2-T13 limits fixed, declared oversized bytes reject before IO, findings bounded", async t => {
  const f = await fixture(t); assert.ok(Object.isFrozen(limits));
  failure(await verify(f.root, [{ ...record(), size: limits.maxFileBytes + 1 }]));
  failure(await verify(f.root, new Array(limits.maxFiles + 1)));
  const bad = Array.from({ length: 200 }, (_, i) => ({ ...record(`app/a${i}`), class: "bad" }));
  const r = failure(await verify(f.root, bad)); assert.equal(r.findings.length, 128);
  assert.equal(r.findings.at(-1).code, "FINDING_LIMIT_REACHED");
});
test("I2-T14 unsupported identity and nonregular metadata fail closed", async t => {
  const f = await fixture(t); const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, "lstat", async (...args) => { const s = await lstat(...args); s.ino = 0n; return s; });
  failure(await verify(f.root, f.manifest));
});
test("I2-T15 restricted PASS never confers Windows/ACL/provenance approval", async t => {
  const f = await fixture(t); const r = await verify(f.root, f.manifest);
  assert.equal(r.status, "PASS"); assert.equal(r.windowsFilesystemSecurity, "BLOCKED");
  for (const k of ["productionApproved", "aclVerified", "fullReparseInspectionVerified", "adsInspectionVerified", "raceResistantContainmentVerified", "sourceTrustVerified", "signedProvenanceVerified", "allowlistVerified", "dependencyClosureVerified"]) assert.equal(r[k], false);
  assert.equal(r.runtimeWritableProvenance, "DECLARATION_ONLY_NOT_VERIFIED"); assert.ok(Object.isFrozen(r));
  assert.deepEqual(r, await verify(f.root, f.manifest));
});
test("I2-T16 exhaustive Windows ADS/reparse and race-proof containment", { skip: "BLOCKED: intentionally unsupported security capabilities" }, () => {});

test("I2-T17 deterministic read error closes handle; one active read and bounded chunks", async t => {
  const f = await fixture(t); const open = fs.open.bind(fs); let active = 0, closed = 0;
  t.mock.method(fs, "open", async (...args) => {
    active++; assert.equal(active, 1); const h = await open(...args), close = h.close.bind(h);
    h.read = async buffer => { assert.equal(buffer.length, 256 * 1024); throw Error("SYNTHETIC_PRIVATE_VALUE"); };
    h.close = async () => { active--; closed++; return close(); }; return h;
  });
  const r = failure(await verify(f.root, f.manifest)); assert.equal(r.findings[0].code, "IO_ERROR");
  assert.equal(active, 0); assert.equal(closed, 1);
});
test("I2-T18 deterministic file-to-directory substitution at open rejects", async t => {
  const f = await fixture(t); const open = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args) => {
    await fs.unlink(path.join(f.root, "app/a")); await fs.mkdir(path.join(f.root, "app/a")); return open(...args);
  });
  failure(await verify(f.root, f.manifest));
});
test("I2-T19 actual sparse oversized file and declared aggregate limit", async t => {
  const f = await fixture(t);
  const declared = Array.from({ length: 11 }, (_, i) => ({ ...record(`app/f${i}`), size: limits.maxFileBytes }));
  assert.equal(failure(await verify(f.root, declared)).findings[0].code, "BYTE_LIMIT");
  // Sparse synthetic file: enumeration must reject before reading its contents.
  await fs.truncate(path.join(f.root, "app/a"), limits.maxFileBytes + 1);
  const r = failure(await verify(f.root, f.manifest)); assert.equal(r.findings[0].code, "BYTE_LIMIT"); assert.equal(r.bytesRead, 0);
});
test("I2-T20 bounded incremental enumeration rejects entry overflow", async t => {
  const f = await fixture(t); let reads = 0, closes = 0;
  t.mock.method(fs, "opendir", async () => ({
    read: async () => ({ name: `f${reads++}` }), close: async () => { closes++; },
  }));
  const r = failure(await verify(f.root, f.manifest)); assert.equal(r.findings[0].code, "ENTRY_LIMIT");
  assert.equal(reads, 200001); assert.equal(closes, 1); assert.equal(r.bytesRead, 0);
});
test("I2-T21 unsupported child type, canonical escape and depth limit", async t => {
  const f = await fixture(t); const lstat = fs.lstat.bind(fs);
  const mock = t.mock.method(fs, "lstat", async (...args) => {
    const s = await lstat(...args);
    if (String(args[0]) === path.join(f.root, "app/a")) { s.isFile = () => false; s.isDirectory = () => false; }
    return s;
  });
  failure(await verify(f.root, f.manifest)); mock.mock.restore();
  const realpath = fs.realpath.bind(fs);
  const canonical = t.mock.method(fs, "realpath", async p => p === path.join(f.root, "app/a") ? path.dirname(f.root) : realpath(p));
  assert.equal(failure(await verify(f.root, f.manifest)).findings[0].code, "CONTAINMENT_FAILURE"); canonical.mock.restore();
  const relative = Array(129).fill("a").join("/"); await fs.mkdir(path.join(f.root, relative), { recursive: true });
  assert.equal(failure(await verify(f.root, f.manifest)).findings[0].code, "DEPTH_LIMIT");
});
