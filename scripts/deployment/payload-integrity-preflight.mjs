import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { validatePackageInventory } from "./package-inventory-policy.mjs";
import { validateManifestFileInventory } from "./manifest-inventory-preflight.mjs";

export const PAYLOAD_INTEGRITY_LIMITS = Object.freeze({
  maxFiles: 100000, maxEntries: 200000, maxDepth: 128,
  maxFileBytes: 2 * 1024 ** 3, maxTotalBytes: 20 * 1024 ** 3,
  activeReads: 1, chunkBytes: 256 * 1024, maxFindings: 128,
});
const L = PAYLOAD_INTEGRITY_LIMITS;
const FIELDS = ["path", "size", "sha256", "class", "runtimeWritable"];
const EMPTY_HASH = "0".repeat(64);

function snapshot(input) {
  if (types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(input, "length").value;
  if (!length || length > L.maxFiles || Reflect.ownKeys(input).length !== length + 1) return null;
  const copy = [];
  for (let i = 0; i < length; i++) {
    const slot = Object.getOwnPropertyDescriptor(input, String(i));
    if (!slot || !slot.enumerable || !Object.hasOwn(slot, "value")) return null;
    const entry = slot.value;
    if (!entry || typeof entry !== "object" || types.isProxy(entry)) return null;
    const proto = Object.getPrototypeOf(entry);
    if ((proto !== null && proto !== Object.prototype) || Reflect.ownKeys(entry).length !== FIELDS.length) return null;
    const record = Object.create(null);
    for (const key of FIELDS) {
      const d = Object.getOwnPropertyDescriptor(entry, key);
      if (!d || !d.enumerable || !Object.hasOwn(d, "value")) return null;
      record[key] = d.value;
    }
    copy.push(record);
  }
  return copy;
}

function rootShape(root) {
  if (typeof root !== "string" || !root || /[\x00-\x1f\x7f]/.test(root)) return false;
  if (root.startsWith("\\") || root.startsWith("//")) return false;
  if (!path.isAbsolute(root) || path.resolve(root) === path.parse(root).root) return false;
  if (process.platform === "win32" && (!/^[A-Za-z]:[\\/]/.test(root) || root.slice(2).includes(":"))) return false;
  return !root.split(/[\\/]/).some(s => s === "." || s === ".." || /[ .]$/.test(s));
}
function identity(s) {
  return typeof s.ino === "bigint" && s.ino > 0n && typeof s.dev === "bigint" &&
    typeof s.nlink === "bigint" && s.nlink > 0n && typeof s.size === "bigint" &&
    s.size >= 0n && typeof s.mtimeNs === "bigint" && typeof s.ctimeNs === "bigint";
}
function same(a, b) {
  return ["dev", "ino", "nlink", "size", "mtimeNs", "ctimeNs"].every(k => a[k] === b[k]);
}
// runtimeWritable is only a reconciliation declaration, never an ACL observation.
// Physical kind=file is used for measured records only after regular-file checks.
const descriptor = (p, size = 0, sha256 = EMPTY_HASH) =>
  ({ path: p, kind: "file", size, sha256, runtimeWritable: false });

/** Trusted quiescent staging only. No comprehensive Windows containment/ADS/ACL assurance. */
export async function verifyPayloadIntegrity(packageRoot, manifestFiles) {
  const findings = [];
  let bytesRead = 0, filesRead = 0;
  function add(code, entryIndex = null) {
    if (findings.length >= L.maxFindings) return;
    findings.push(Object.freeze({ entryIndex, code: findings.length === L.maxFindings - 1 ? "FINDING_LIMIT_REACHED" : code }));
  }
  function result() {
    return Object.freeze({
      scope: "TRUSTED_STAGING_DEFAULT_STREAM_ONLY",
      status: findings.length ? "FAIL" : "PASS",
      defaultStreamComparison: findings.length ? "FAIL" : "PASS",
      productionApproved: false, windowsFilesystemSecurity: "BLOCKED",
      runtimeWritableProvenance: "DECLARATION_ONLY_NOT_VERIFIED",
      aclVerified: false, fullReparseInspectionVerified: false, adsInspectionVerified: false,
      raceResistantContainmentVerified: false, sourceTrustVerified: false,
      signedProvenanceVerified: false, allowlistVerified: false, dependencyClosureVerified: false,
      bytesRead, filesRead, findings: Object.freeze(findings),
    });
  }
  if (!rootShape(packageRoot)) { add("INVALID_ROOT"); return result(); }
  const manifest = snapshot(manifestFiles);
  if (!manifest) { add("INVALID_MANIFEST"); return result(); }
  const declared = manifest.map(r => descriptor(r.path, r.size, r.sha256));
  const preflight = validateManifestFileInventory(manifest, declared);
  if (preflight.status !== "PASS") {
    for (const f of preflight.findings) add(f.code, f.entryIndex);
    return result();
  }
  if (manifest.some(r => r.size > L.maxFileBytes) || manifest.reduce((n, r) => n + BigInt(r.size), 0n) > BigInt(L.maxTotalBytes)) {
    add("BYTE_LIMIT"); return result();
  }
  const root = path.resolve(packageRoot);
  const fail = code => { throw Object.freeze({ policyCode: code }); };
  const inside = p => { const rel = path.relative(root, p); return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)); };
  async function inspect(absolute) {
    const s = await fs.lstat(absolute, { bigint: true });
    if (!identity(s)) fail("UNSUPPORTED_METADATA");
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) fail("UNSUPPORTED_OBJECT");
    const real = await fs.realpath(absolute);
    if (!inside(real) || path.relative(absolute, real) !== "") fail("CONTAINMENT_FAILURE");
    if (s.isFile() && s.nlink !== 1n) fail("MULTIPLE_HARDLINKS");
    return s;
  }
  async function enumerate() {
    const records = [], directories = [], allPaths = [], folded = new Set();
    let count = 0;
    async function walk(relative, depth) {
      if (depth > L.maxDepth) fail("DEPTH_LIMIT");
      const absolute = path.join(root, relative);
      const before = await inspect(absolute);
      if (!before.isDirectory()) fail("DIRECTORY_CHANGED");
      directories.push({ absolute, stat: before });
      const names = [];
      const dir = await fs.opendir(absolute);
      try {
        for (;;) {
          const entry = await dir.read(); if (!entry) break;
          if (++count > L.maxEntries) fail("ENTRY_LIMIT");
          names.push(entry.name);
        }
      } finally { await dir.close(); }
      names.sort();
      for (const name of names) {
        const rel = relative ? `${relative}/${name}` : name;
        // Apply exclusions before lstat/open/descent. No content from denied names is read.
        if (validatePackageInventory([descriptor(rel)]).status !== "PASS") fail("PATH_POLICY");
        const lower = rel.toLowerCase();
        if (folded.has(lower)) fail("PATH_COLLISION"); folded.add(lower);
        allPaths.push(rel);
        const absoluteChild = path.join(root, ...rel.split("/"));
        const stat = await inspect(absoluteChild);
        if (stat.isDirectory()) await walk(rel, depth + 1);
        else {
          if (records.length >= L.maxFiles) fail("FILE_LIMIT");
          if (stat.size > BigInt(L.maxFileBytes)) fail("BYTE_LIMIT");
          records.push({ relative: rel, absolute: absoluteChild, stat });
        }
      }
      if (!same(before, await inspect(absolute))) fail("DIRECTORY_CHANGED");
    }
    await walk("", 0);
    return { records, directories, allPaths };
  }
  try {
    // Reject detectable linked ancestors too. No recursive scan of any ancestor.
    for (let p = root;; p = path.dirname(p)) {
      const s = await fs.lstat(p, { bigint: true });
      if (!identity(s) || s.isSymbolicLink() || !s.isDirectory()) fail("UNSAFE_ROOT");
      if (p === path.dirname(p)) break;
    }
    const initial = await enumerate();
    const expectedPaths = new Map(manifest.map(r => [r.path, r]));
    // Reject extras before reading; keep missing/case mismatch diagnostics in Increment 1.
    // This intermediate check compares names/sizes only. Expected digests here are
    // placeholders, not evidence; only the later handle-read hash enters measured.
    const namesCheck = validateManifestFileInventory(manifest, initial.records.map(r => {
      const expected = expectedPaths.get(r.relative);
      return descriptor(r.relative, Number(r.stat.size), expected ? expected.sha256 : EMPTY_HASH);
    }));
    if (namesCheck.status !== "PASS") {
      for (const f of namesCheck.findings) add(f.code, f.entryIndex);
      return result();
    }
    const measured = [], buffer = Buffer.alloc(L.chunkBytes);
    for (const record of initial.records) {
      if (!expectedPaths.has(record.relative)) fail("UNEXPECTED_FILE");
      const handle = await fs.open(record.absolute, "r");
      try {
        const before = await handle.stat({ bigint: true });
        if (!identity(before) || !before.isFile() || before.nlink !== 1n || !same(before, record.stat)) fail("FILE_CHANGED");
        const hash = createHash("sha256"); let count = 0;
        for (;;) {
          const read = await handle.read(buffer, 0, buffer.length, null);
          if (!read.bytesRead) break;
          count += read.bytesRead; bytesRead += read.bytesRead;
          if (count > L.maxFileBytes || bytesRead > L.maxTotalBytes || BigInt(count) > before.size) fail("BYTE_LIMIT_OR_CHANGE");
          hash.update(buffer.subarray(0, read.bytesRead));
        }
        const after = await handle.stat({ bigint: true });
        if (!same(before, after) || BigInt(count) !== before.size || !same(after, await inspect(record.absolute))) fail("FILE_CHANGED");
        measured.push(descriptor(record.relative, count, hash.digest("hex")));
        filesRead++;
      } finally { await handle.close(); }
    }
    const final = await enumerate();
    if (JSON.stringify(initial.allPaths) !== JSON.stringify(final.allPaths) ||
      initial.records.some((r, i) => !final.records[i] || !same(r.stat, final.records[i].stat)) ||
      initial.directories.some((r, i) => !final.directories[i] || !same(r.stat, final.directories[i].stat))) fail("TREE_CHANGED");
    const reconciliation = validateManifestFileInventory(manifest, measured);
    for (const f of reconciliation.findings) add(f.code, f.entryIndex);
  } catch (error) {
    // Only locally constructed policy errors carry codes; never echo OS errors or paths.
    const code = error && Object.getPrototypeOf(error) === Object.prototype && Object.isFrozen(error) &&
      typeof error.policyCode === "string" ? error.policyCode : "IO_ERROR";
    add(code);
  }
  return result();
}
