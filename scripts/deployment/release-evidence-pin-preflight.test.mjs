import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyPinnedReleaseEvidence as verify, RELEASE_EVIDENCE_PIN_LIMITS as limits } from "./release-evidence-pin-preflight.mjs";

const hash = b => createHash("sha256").update(b).digest("hex");
const candidates = () => ({ manifest: Buffer.from("abc"), allowlist: new Uint8Array([0, 255, 10]) });
const pins = c => ({ manifestSha256: hash(c.manifest), allowlistSha256: hash(c.allowlist) });
function fail(c, p) { const r = verify(c, p); assert.equal(r.status, "PIN_COMPARISON_FAIL"); assert.equal(r.productionApproved, false); return r; }

test("I3-T01 known exact-byte vectors and opaque binary allowlist", () => {
  const c = { manifest: Buffer.from("abc"), allowlist: new Uint8Array() };
  const p = { manifestSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", allowlistSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
  assert.equal(verify(c, p).status, "PIN_COMPARISON_PASS");
  const binary = candidates(); assert.equal(verify(binary, pins(binary)).status, "PIN_COMPARISON_PASS");
});
test("I3-T02 independent mismatches, swapped artifacts and pins", () => {
  const c = candidates(), p = pins(c);
  assert.deepEqual(fail({ ...c, manifest: Buffer.from("abd") }, p).findings, [{ artifact: "manifest", code: "DIGEST_MISMATCH" }]);
  assert.deepEqual(fail({ ...c, allowlist: Buffer.from("changed") }, p).findings, [{ artifact: "allowlist", code: "DIGEST_MISMATCH" }]);
  assert.equal(fail({ manifest: c.allowlist, allowlist: c.manifest }, p).findings.length, 2);
  fail(c, { manifestSha256: p.allowlistSha256, allowlistSha256: p.manifestSha256 });
});
test("I3-T03 truncation, newline, empty bytes, JSON whitespace are not normalized", () => {
  const c = candidates(), p = pins(c);
  for (const text of ["ab", "abc\n", "abc\r\n", "", "ABC"]) fail({ ...c, manifest: Buffer.from(text) }, p);
  const a = { manifest: Buffer.from('{"a":1}'), allowlist: Buffer.alloc(0) };
  fail({ ...a, manifest: Buffer.from('{ "a": 1 }') }, pins(a));
  const empty = { manifest: new Uint8Array(), allowlist: Buffer.alloc(0) };
  assert.equal(verify(empty, pins(empty)).status, "PIN_COMPARISON_PASS");
});
test("I3-T04 exact own data fields and plain/null prototypes", () => {
  const c = candidates(), p = pins(c);
  for (const bad of [null, undefined, [], 7, "synthetic", new Date(), Object.create({ manifest: c.manifest, allowlist: c.allowlist }), { ...c, extra: 1 }, { manifest: c.manifest }]) fail(bad, p);
  for (const bad of [null, [], { ...p, extra: 1 }, { manifestSha256: p.manifestSha256 }, Object.create(p)]) fail(c, bad);
  const symbol = { ...c, [Symbol("hidden")]: true }; fail(symbol, p);
  const hidden = { ...c }; Object.defineProperty(hidden, "manifest", { value: c.manifest, enumerable: false }); fail(hidden, p);
  assert.equal(verify(Object.assign(Object.create(null), c), Object.assign(Object.create(null), p)).status, "PIN_COMPARISON_PASS");
});
test("I3-T05 digest syntax never coerces values", () => {
  const c = candidates(), p = pins(c);
  for (const value of [p.manifestSha256.toUpperCase(), p.manifestSha256 + "\n", "0".repeat(63), "g".repeat(64), null, 4, {}, new String(p.manifestSha256)]) {
    fail(c, { ...p, manifestSha256: value }); fail(c, { ...p, allowlistSha256: value });
  }
});
test("I3-T06 supported byte views, offsets and unsupported representations", () => {
  const c = candidates(), p = pins(c);
  for (const b of ["abc", [97, 98, 99], new ArrayBuffer(3), new DataView(new ArrayBuffer(3)), new Int8Array(3), new Uint16Array(3), new Uint8ClampedArray(3), null, {}]) fail({ ...c, manifest: b }, p);
  const offset = new Uint8Array([77, 97, 98, 99, 88]).subarray(1, 4);
  assert.equal(verify({ ...c, manifest: offset }, p).status, "PIN_COMPARISON_PASS");
  class Custom extends Uint8Array {} fail({ ...c, manifest: new Custom([97, 98, 99]) }, p);
  const extra = Buffer.from("abc"); extra.extra = true; fail({ ...c, manifest: extra }, p);
  fail({ ...c, manifest: new Uint8Array(new SharedArrayBuffer(3)) }, p);
  fail({ ...c, manifest: new Uint8Array(new ArrayBuffer(3, { maxByteLength: 9 })) }, p);
  const detached = new Uint8Array([97, 98, 99]); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  fail({ ...c, manifest: detached }, p);
});
test("I3-T07 getters/proxies/revoked proxies never invoke callbacks", () => {
  const c = candidates(), p = pins(c); let calls = 0;
  const trap = () => { calls++; throw Error("SYNTHETIC_PRIVATE_MARKER"); };
  for (const [input, field, side] of [[c, "manifest", 0], [c, "allowlist", 0], [p, "manifestSha256", 1], [p, "allowlistSha256", 1]]) {
    const object = { ...input }; Object.defineProperty(object, field, { enumerable: true, get: trap });
    side ? fail(c, object) : fail(object, p);
  }
  for (const target of [c, p, c.manifest]) {
    const proxy = new Proxy(target, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    if (target === c) fail(proxy, p); else if (target === p) fail(c, proxy); else fail({ ...c, manifest: proxy }, p);
    const revoked = Proxy.revocable(target, {}); revoked.revoke();
    fail(target === c ? revoked.proxy : { ...c, manifest: revoked.proxy }, p);
  }
  const b = Buffer.from("abc"); Object.defineProperty(b, "byteLength", { get: trap }); fail({ ...c, manifest: b }, p);
  const coercion = { toString: trap, valueOf: trap }; fail(c, { ...p, manifestSha256: coercion });
  assert.equal(calls, 0);
});
test("I3-T08 preservation, deterministic frozen output and diagnostic redaction", () => {
  const c = candidates(), p = pins(c), original = Buffer.from(c.manifest);
  Object.freeze(c); Object.freeze(p); const a = verify(c, p); assert.deepEqual(a, verify(c, p)); assert.deepEqual(c.manifest, original);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.findings)); assert.throws(() => { a.productionApproved = true; }, TypeError);
  const r = fail({ ...c, manifest: Buffer.from("SYNTHETIC_PRIVATE_MARKER") }, p);
  const output = JSON.stringify(r); for (const value of ["SYNTHETIC_PRIVATE_MARKER", p.manifestSha256, hash(Buffer.from("SYNTHETIC_PRIVATE_MARKER"))]) assert.equal(output.includes(value), false);
  assert.ok(r.findings.every(Object.isFrozen)); assert.ok(r.findings.length <= 16);
});
test("I3-T09 resource ceilings accept exact maximum and reject oversized artifacts", () => {
  assert.ok(Object.isFrozen(limits)); assert.equal(limits.maxArtifactBytes, 4194304); assert.equal(limits.maxCombinedBytes, 8388608);
  const c = { manifest: new Uint8Array(limits.maxArtifactBytes), allowlist: Buffer.alloc(limits.maxArtifactBytes) };
  assert.equal(verify(c, pins(c)).status, "PIN_COMPARISON_PASS");
  const p = pins(c); fail({ ...c, manifest: new Uint8Array(limits.maxArtifactBytes + 1) }, p);
  fail({ ...c, allowlist: new Uint8Array(limits.maxArtifactBytes + 1) }, p);
});
test("I3-T10 self-supplied matching pins establish no trust or approval", () => {
  const c = candidates(), result = verify(c, pins(c)); assert.equal(result.status, "PIN_COMPARISON_PASS");
  assert.equal(result.scope, "RELEASE_EVIDENCE_PIN_COMPARISON_ONLY");
  for (const k of ["productionApproved", "trustAnchorAuthorizationVerified", "signatureVerified", "revocationVerified", "allowlistEnforced", "dependencyClosureVerified"]) assert.equal(result[k], false);
  const bad = fail(c, { manifestSha256: "bad", allowlistSha256: "bad" });
  for (const k of ["productionApproved", "trustAnchorAuthorizationVerified", "signatureVerified", "revocationVerified", "allowlistEnforced", "dependencyClosureVerified"]) assert.equal(bad[k], false);
});
