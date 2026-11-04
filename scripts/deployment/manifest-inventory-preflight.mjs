import { types } from "node:util";
import { validatePackageInventory, PACKAGE_INVENTORY_LIMITS } from "./package-inventory-policy.mjs";

const CLASSES = new Set(["server-bundle", "static", "dependency", "browser", "license"]);
const MANIFEST_FIELDS = ["path", "size", "sha256", "class", "runtimeWritable"];
const OBSERVED_FIELDS = ["path", "size", "sha256", "kind", "runtimeWritable"];

// Copy data descriptors only. Never invoke input getters, iterators or Proxy traps.
function snapshot(input, fields, side, add) {
  if (types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    add(side, null, "INVALID_INPUT");
    return null;
  }
  const length = Object.getOwnPropertyDescriptor(input, "length").value;
  if (!length || length > PACKAGE_INVENTORY_LIMITS.maxEntries || Reflect.ownKeys(input).some((key) =>
    key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)
  )) {
    add(side, null, "INVALID_INPUT");
    return null;
  }
  const records = [];
  for (let index = 0; index < length; index++) {
    const slot = Object.getOwnPropertyDescriptor(input, String(index));
    const entry = slot && Object.hasOwn(slot, "value") && slot.enumerable ? slot.value : null;
    if (entry === null || typeof entry !== "object" || types.isProxy(entry)) {
      add(side, index, "INVALID_ENTRY");
      return null;
    }
    const prototype = Object.getPrototypeOf(entry);
    const keys = Reflect.ownKeys(entry);
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== fields.length ||
      keys.some((key) => !fields.includes(key))) {
      add(side, index, "INVALID_ENTRY");
      return null;
    }
    const record = Object.create(null);
    for (const key of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
        add(side, index, "INVALID_ENTRY");
        return null;
      }
      record[key] = descriptor.value;
    }
    records.push(record);
  }
  return records;
}

/** Supplied metadata comparison only. No payload reads, hashing, IO or release authority. */
export function validateManifestFileInventory(manifestFiles, observedInventory) {
  const findings = [];
  let exhausted = false;
  function add(side, entryIndex, code) {
    if (exhausted) return;
    if (findings.length === PACKAGE_INVENTORY_LIMITS.maxFindings - 1) {
      findings.push(Object.freeze({ side, entryIndex, code: "FINDING_LIMIT_REACHED" }));
      exhausted = true;
    } else findings.push(Object.freeze({ side, entryIndex, code }));
  }
  function result() {
    return Object.freeze({
      schemaVersion: 1,
      scope: "SUPPLIED_MANIFEST_FILE_INVENTORY_ONLY",
      status: findings.length ? "FAIL" : "PASS",
      productionApproved: false,
      byteIntegrityVerified: false,
      fullManifestVerified: false,
      signedProvenanceVerified: false,
      allowlistVerified: false,
      dependencyClosureVerified: false,
      findings: Object.freeze(findings),
    });
  }
  const manifest = snapshot(manifestFiles, MANIFEST_FIELDS, "manifest", add);
  const observed = snapshot(observedInventory, OBSERVED_FIELDS, "observed", add);
  if (!manifest || !observed) return result();

  for (let index = 0; index < manifest.length && !exhausted; index++) {
    if (!CLASSES.has(manifest[index].class)) add("manifest", index, "UNSUPPORTED_CLASS");
  }
  // kind=file here represents a declared expectation for ET01 policy projection,
  // never an observation inferred from class. Observed kind is checked independently.
  const expectedPolicy = manifest.map(({ path, size, sha256, runtimeWritable }) =>
    ({ path, kind: "file", size, sha256, runtimeWritable }));
  for (const [side, records] of [["manifest", expectedPolicy], ["observed", observed]]) {
    const policy = validatePackageInventory(records);
    for (const finding of policy.findings) add(side, finding.entryIndex, finding.code);
  }
  if (findings.length) return result();

  const exact = new Map(observed.map((record, index) => [record.path, { record, index }]));
  const folded = new Map(observed.map((record, index) => [record.path.toLowerCase(), index]));
  const matched = new Set();
  for (let index = 0; index < manifest.length && !exhausted; index++) {
    const expected = manifest[index];
    const match = exact.get(expected.path);
    if (!match) {
      const caseIndex = folded.get(expected.path.toLowerCase());
      if (caseIndex !== undefined) {
        matched.add(caseIndex);
        add("manifest", index, "CASE_MISMATCH");
      } else add("manifest", index, "MISSING_FILE");
      continue;
    }
    matched.add(match.index);
    if (expected.size !== match.record.size) add("manifest", index, "SIZE_MISMATCH");
    if (expected.sha256 !== match.record.sha256) add("manifest", index, "SHA256_MISMATCH");
    // ET01 independently requires both runtimeWritable values to be exactly false.
  }
  for (let index = 0; index < observed.length && !exhausted; index++) {
    if (!matched.has(index)) add("observed", index, "UNEXPECTED_FILE");
  }
  return result();
}
