import { createHash } from "node:crypto";
import { types } from "node:util";

export const RELEASE_EVIDENCE_PIN_LIMITS = Object.freeze({
  maxArtifactBytes: 4 * 1024 * 1024,
  maxCombinedBytes: 8 * 1024 * 1024,
  artifactCount: 2,
  maxFindings: 16,
});
const L = RELEASE_EVIDENCE_PIN_LIMITS;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength").get;
const backingBuffer = Object.getOwnPropertyDescriptor(typedPrototype, "buffer").get;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable").get;

function record(input, fields) {
  if (!input || typeof input !== "object" || types.isProxy(input)) return null;
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length || keys.some(k => !fields.includes(k))) return null;
  const out = Object.create(null);
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (!d || !d.enumerable || !Object.hasOwn(d, "value")) return null;
    out[key] = d.value;
  }
  return out;
}

function bytes(input) {
  if (types.isProxy(input) || !types.isUint8Array(input)) return null;
  const proto = Object.getPrototypeOf(input);
  if (proto !== Uint8Array.prototype && proto !== Buffer.prototype) return null;
  const buffer = backingBuffer.call(input);
  if (types.isSharedArrayBuffer(buffer) || resizable.call(buffer)) return null;
  const length = byteLength.call(input);
  if (length > L.maxArtifactBytes) return { oversized: true };
  // Typed-array indices cannot be accessor properties. All other own keys deny.
  const keys = Reflect.ownKeys(input);
  if (keys.length !== length || keys.some((key, index) => key !== String(index))) return null;
  const copy = new Uint8Array(length);
  // Uses typed-array internal data, not a caller iterator, getter or species.
  Uint8Array.prototype.set.call(copy, input);
  return copy;
}

/** Exact-byte comparison only; independently obtaining authorized pins is caller work. */
export function verifyPinnedReleaseEvidence(candidateBytes, expectedDigests) {
  const findings = [];
  function add(artifact, code) {
    if (findings.length < L.maxFindings) findings.push(Object.freeze({ artifact, code }));
  }
  function result() {
    return Object.freeze({
      scope: "RELEASE_EVIDENCE_PIN_COMPARISON_ONLY",
      status: findings.length ? "PIN_COMPARISON_FAIL" : "PIN_COMPARISON_PASS",
      productionApproved: false,
      trustAnchorAuthorizationVerified: false,
      signatureVerified: false,
      revocationVerified: false,
      allowlistEnforced: false,
      dependencyClosureVerified: false,
      findings: Object.freeze(findings),
    });
  }
  const candidates = record(candidateBytes, ["manifest", "allowlist"]);
  const pins = record(expectedDigests, ["manifestSha256", "allowlistSha256"]);
  if (!candidates) add(null, "INVALID_CANDIDATE_RECORD");
  if (!pins) add(null, "INVALID_PIN_RECORD");
  if (!candidates || !pins) return result();
  const snapshots = Object.create(null);
  for (const artifact of ["manifest", "allowlist"]) {
    const pin = pins[`${artifact}Sha256`];
    if (typeof pin !== "string" || !/^[a-f0-9]{64}$/.test(pin)) add(artifact, "INVALID_PIN");
    try {
      const copy = bytes(candidates[artifact]);
      if (copy === null) add(artifact, "UNSUPPORTED_BYTES");
      else if (copy.oversized === true) add(artifact, "ARTIFACT_BYTE_LIMIT");
      else snapshots[artifact] = copy;
    } catch {
      // Detached/invalid views fail without exposing exception messages or values.
      add(artifact, "UNSUPPORTED_BYTES");
    }
  }
  if (findings.length) return result();
  if (snapshots.manifest.byteLength + snapshots.allowlist.byteLength > L.maxCombinedBytes) {
    add(null, "COMBINED_BYTE_LIMIT");
    return result();
  }
  for (const artifact of ["manifest", "allowlist"]) {
    const actual = createHash("sha256").update(snapshots[artifact]).digest("hex");
    if (actual !== pins[`${artifact}Sha256`]) add(artifact, "DIGEST_MISMATCH");
  }
  return result();
}
