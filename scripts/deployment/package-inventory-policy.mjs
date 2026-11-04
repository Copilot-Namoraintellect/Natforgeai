import { types } from "node:util";

/** ET01 descriptor policy only: no file reads, hashing, packaging or approval. */
export const PACKAGE_INVENTORY_REASON_CODES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_ENTRY: "INVALID_ENTRY",
  UNSAFE_PATH: "UNSAFE_PATH",
  PATH_COLLISION: "PATH_COLLISION",
  FORBIDDEN_PATH: "FORBIDDEN_PATH",
  UNSUPPORTED_KIND: "UNSUPPORTED_KIND",
  INVALID_SIZE: "INVALID_SIZE",
  INVALID_SHA256: "INVALID_SHA256",
  WRITABLE_PAYLOAD: "WRITABLE_PAYLOAD",
  FINDING_LIMIT_REACHED: "FINDING_LIMIT_REACHED",
});

export const PACKAGE_INVENTORY_LIMITS = Object.freeze({
  maxEntries: 100_000,
  maxPathLength: 1_024,
  maxSegmentLength: 255,
  maxFindings: 128,
});

const CODES = PACKAGE_INVENTORY_REASON_CODES;
const FIELDS = Object.freeze(["path", "kind", "size", "sha256", "runtimeWritable"]);
const DENIED_SEGMENTS = new Set([
  ".git", ".agents", ".codex", ".npm", ".cache", ".config", ".aws", ".azure", ".ssh",
  ".credentials", ".nyc_output", ".npmrc", ".yarnrc", ".netrc", ".pypirc", ".git-credentials",
  ".firebase", ".gcloud", ".pytest_cache", "__pycache__", ".vite", ".parcel-cache",
  "gcloud", "ms-playwright", "playwright-cache",
  "test", "tests", "__tests__", "fixture", "fixtures", "__fixtures__", "examples", "coverage",
  "log", "logs", "dumps", "crash-dumps", "cache", "caches", "credential-cache",
  "profile", "profiles", "browser-profile", "browser-profiles", "user-data", "user-data-dir",
  "temp", "tmp", "scratch", "backup", "backups", "data", "uploads", "generated", "generated-state",
  "secrets", "credentials", "secret-source", "secret-store", "credential-store", "vault-exports",
  "token", "tokens", "access_token", "refresh_token",
]);
const DEVICES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)$/;
const ARTIFACT_SUFFIX = /\.(?:bak|backup[^.]*|old|orig|swp|swo|tmp|temp|pem|pfx|p12|key|jks|keystore|log|dmp|mdmp|dump|sql|zip|tar|tgz|gz|7z|rar)(?:\.|$)/;
const CREDENTIAL_ARTIFACT = /(?:service[-_]?account|firebase.*(?:credential|adminsdk)|credential|secret|(?:^|[-_.])tokens?(?=[-_.]|$)|vault[-_]?export|backup[-_]?config|break[-_]?glass|signing[-_]?key).*\.(?:json|jsonc|yaml|yml|ini|conf|config|txt)$/;

function isDataDescriptor(descriptor) {
  return descriptor !== undefined && Object.hasOwn(descriptor, "value") && descriptor.enumerable;
}

function readRecord(entry) {
  if (entry === null || typeof entry !== "object" || types.isProxy(entry)) return null;
  const prototype = Object.getPrototypeOf(entry);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(entry);
  if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key))) return null;
  const record = Object.create(null);
  for (const key of FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(entry, key);
    if (!isDataDescriptor(descriptor)) return null;
    record[key] = descriptor.value;
  }
  return record;
}

function safeSegments(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > PACKAGE_INVENTORY_LIMITS.maxPathLength) return null;
  // No decoding, trimming, separator repair or OS-dependent path resolution.
  if (/[^\x20-\x7e]|[\\:%<>"|?*]/.test(path)) return null;
  const segments = path.split("/");
  for (const segment of segments) {
    if (!segment || segment.length > PACKAGE_INVENTORY_LIMITS.maxSegmentLength ||
      segment === "." || segment === ".." || /[ .]$/.test(segment)) return null;
    // Reject DOS-short-name-like aliases rather than guess their filesystem target.
    if (/~[0-9]/.test(segment)) return null;
    const deviceStem = segment.split(".", 1)[0].replace(/ +$/, "").toLowerCase();
    if (DEVICES.test(deviceStem)) return null;
  }
  return segments.map((segment) => segment.toLowerCase());
}

function forbiddenSegments(segments) {
  return segments.some((segment) =>
    DENIED_SEGMENTS.has(segment) || segment === ".env" || segment.startsWith(".env.") ||
    segment === "web.config.bak" || segment.startsWith("fixture-logo") ||
    ARTIFACT_SUFFIX.test(segment) || CREDENTIAL_ARTIFACT.test(segment) ||
    /(?:^|[._-])(?:test|spec)\./.test(segment) || /(?:fixture|test)[-_]logos?(?:[._-]|$)/.test(segment) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(segment) ||
    /^backup[._-]/.test(segment) ||
    segment.endsWith(".map") || segment.endsWith("~") || segment.startsWith(".#") ||
    (segment.startsWith("#") && segment.endsWith("#"))
  );
}

function registerPath(root, segments) {
  let node = root;
  for (const segment of segments) {
    if (node.file) return false;
    if (!node.children.has(segment)) node.children.set(segment, { file: false, children: new Map() });
    node = node.children.get(segment);
  }
  if (node.file || node.children.size !== 0) return false;
  node.file = true;
  return true;
}

export function validatePackageInventory(entries) {
  const findings = [];
  let exhausted = false;
  function add(entryIndex, code) {
    if (exhausted) return;
    if (findings.length === PACKAGE_INVENTORY_LIMITS.maxFindings - 1) {
      findings.push(Object.freeze({ entryIndex, code: CODES.FINDING_LIMIT_REACHED }));
      exhausted = true;
    } else findings.push(Object.freeze({ entryIndex, code }));
  }
  function result() {
    return Object.freeze({
      schemaVersion: 1,
      scope: "INVENTORY_POLICY_ONLY",
      status: findings.length === 0 ? "PASS" : "FAIL",
      productionApproved: false,
      findings: Object.freeze(findings),
    });
  }

  // Reject Proxies before any reflective operation; getters/iterators are never read.
  if (types.isProxy(entries) || !Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype) {
    add(null, CODES.INVALID_INPUT);
    return result();
  }
  const length = Object.getOwnPropertyDescriptor(entries, "length").value;
  if (length === 0 || length > PACKAGE_INVENTORY_LIMITS.maxEntries || Reflect.ownKeys(entries).some((key) =>
    key !== "length" && (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)
  )) {
    add(null, CODES.INVALID_INPUT);
    return result();
  }
  const root = { file: false, children: new Map() };
  for (let index = 0; index < length && !exhausted; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, String(index));
    const record = isDataDescriptor(descriptor) ? readRecord(descriptor.value) : null;
    if (record === null) {
      add(index, CODES.INVALID_ENTRY);
      continue;
    }
    const segments = safeSegments(record.path);
    if (segments === null) add(index, CODES.UNSAFE_PATH);
    else {
      if (!registerPath(root, segments)) add(index, CODES.PATH_COLLISION);
      if (forbiddenSegments(segments)) add(index, CODES.FORBIDDEN_PATH);
    }
    if (record.kind !== "file") add(index, CODES.UNSUPPORTED_KIND);
    if (!Number.isSafeInteger(record.size) || record.size < 0) add(index, CODES.INVALID_SIZE);
    if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) add(index, CODES.INVALID_SHA256);
    if (record.runtimeWritable !== false) add(index, CODES.WRITABLE_PAYLOAD);
  }
  return result();
}
