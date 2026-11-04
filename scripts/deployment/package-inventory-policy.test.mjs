import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import {
  validatePackageInventory,
  PACKAGE_INVENTORY_REASON_CODES as C,
  PACKAGE_INVENTORY_LIMITS as LIMITS,
} from "./package-inventory-policy.mjs";

const file = (path = "app/dist/boot.js", overrides = {}) => ({
  path, kind: "file", size: 0, sha256: "a".repeat(64), runtimeWritable: false, ...overrides,
});
function rejects(entries, code) {
  const result = validatePackageInventory(entries);
  assert.equal(result.status, "FAIL");
  assert.equal(result.productionApproved, false);
  assert.ok(result.findings.some((finding) => finding.code === code), `expected ${code}`);
  return result;
}
const rejectsPaths = (paths, code) => paths.forEach((path) => rejects([file(path)], code));

test("ET01-T01: safe synthetic app, browser and dependency descriptors", () => {
  const entries = [
    file(), file("app/dist/public/index.html", { size: 42 }),
    file("app/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node"),
    file("app/node_modules/execa/index.js"), file("browsers/chromium/chrome.exe"),
    file("evidence/licenses/MIT.txt", { size: Number.MAX_SAFE_INTEGER }),
  ];
  assert.deepEqual(validatePackageInventory(entries), {
    schemaVersion: 1, scope: "INVENTORY_POLICY_ONLY", status: "PASS",
    productionApproved: false, findings: [],
  });
  const nullRecord = Object.assign(Object.create(null), file("app/dist/worker.js"));
  assert.equal(validatePackageInventory([nullRecord]).status, "PASS");
});

test("ET01-T02: strict inventory shape and metadata integrity", () => {
  for (const input of [null, undefined, {}, "[]", 42, new Set(), [], new Array(LIMITS.maxEntries + 1)]) {
    rejects(input, C.INVALID_INPUT);
  }
  const extraArray = [file()];
  extraArray.extra = true;
  rejects(extraArray, C.INVALID_INPUT);
  const symbolArray = [file()];
  symbolArray[Symbol.iterator] = () => { throw new Error("must not iterate caller input"); };
  rejects(symbolArray, C.INVALID_INPUT);
  rejects(new Array(1), C.INVALID_ENTRY);
  for (const entry of [null, false, "file", [], new Date(0), new (class Entry {})(),
    { ...file(), extra: true }, { ...file(), [Symbol("extra")]: true }]) {
    rejects([entry], C.INVALID_ENTRY);
  }
  for (const key of ["path", "kind", "size", "sha256", "runtimeWritable"]) {
    const entry = file();
    delete entry[key];
    rejects([entry], C.INVALID_ENTRY);
  }
  for (const size of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0", null, 0n]) {
    rejects([file(undefined, { size })], C.INVALID_SIZE);
  }
  for (const sha256 of ["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64),
    "a".repeat(64) + "\n", "a".repeat(64) + "\r", "a".repeat(64) + " ", 0, null]) {
    rejects([file(undefined, { sha256 })], C.INVALID_SHA256);
  }
  for (const key of ["0\n", "00", "01", "1e0", "-0"]) {
    const ambiguousArray = [file()];
    ambiguousArray[key] = true;
    rejects(ambiguousArray, C.INVALID_INPUT);
  }
  rejects([file(undefined, { path: null })], C.UNSAFE_PATH);
  rejects([file("a".repeat(LIMITS.maxPathLength + 1))], C.UNSAFE_PATH);
  rejects([file("app/" + "a".repeat(LIMITS.maxSegmentLength + 1))], C.UNSAFE_PATH);
  const boundaryPath = ["a".repeat(255), "b".repeat(255), "c".repeat(255), "d".repeat(254), "e"].join("/");
  assert.equal(boundaryPath.length, LIMITS.maxPathLength);
  assert.equal(validatePackageInventory([file(boundaryPath)]).status, "PASS");
});

test("ET01-T03: Windows absolute, UNC, device and ADS forms", () => {
  rejectsPaths([
    "/root/file.js", "//host/share/file.js", "C:/app/file.js", "c:file.js",
    "\\\\host\\share\\file.js", "\\\\?\\C:\\file.js", "\\\\.\\CON",
    "\\root\\file.js", "app\\dist\\boot.js", "app/boot.js:payload", "app/file::$DATA",
    "https://host/file.js",
  ], C.UNSAFE_PATH);
});

test("ET01-T04: traversal and ambiguous encodings are rejected, never repaired", () => {
  rejectsPaths([
    "", ".", "..", "../file.js", "app/../file.js", "app/./file.js", "app//file.js",
    "app/file.js/", "%2e%2e/file.js", "app/%252e%252e/file.js", "app/%2f/file.js",
    "app/..\\file.js", "app/DIST~1/boot.js", "app/name%20file.js",
  ], C.UNSAFE_PATH);
});

test("ET01-T05: Windows reserved names, normalization aliases and characters", () => {
  const devices = ["CON", "prn", "AuX", "NUL", "COM1", "com9", "LPT1", "lpt9", "CONIN$", "CONOUT$", "CLOCK$"];
  for (const name of devices) rejectsPaths([`app/${name}`, `app/${name}.txt`, `app/${name} .txt`], C.UNSAFE_PATH);
  rejectsPaths([
    "app/name.", "app/name ", "app/name /file.js", "app/a\u0000b", "app/a\nb",
    "app/a\tb", "app/a\u007fb", "app/caf\u00e9.js", "app/COM\u00b9.txt", "app/a<b",
    "app/a>b", 'app/a"b', "app/a|b", "app/a?b", "app/a*b",
  ], C.UNSAFE_PATH);
  for (const path of ["app/COM10.txt", "app/LPT0.txt", "app/console.js"]) {
    assert.equal(validatePackageInventory([file(path)]).status, "PASS");
  }
});

test("ET01-T06: duplicates, case collisions and file/ancestor conflicts", () => {
  for (const paths of [
    ["app/dist/boot.js", "app/dist/boot.js"], ["App/Dist/Boot.js", "app/dist/boot.JS"],
    ["app/dist", "APP/DIST/boot.js"], ["app/dist/boot.js", "APP/DIST"],
  ]) {
    const result = rejects(paths.map((path) => file(path)), C.PATH_COLLISION);
    assert.deepEqual(result.findings, [{ entryIndex: 1, code: C.PATH_COLLISION }]);
  }
  assert.equal(validatePackageInventory([file("App/a.js"), file("app/b.js")]).status, "PASS");
});

test("ET01-T07: environment files excluded at every depth, including example", () => {
  rejectsPaths([
    ".env", ".ENV", ".env.production", ".env.example", "app/.Env.local",
    "app/dist/public/.ENV.backup-20260623-181231", "app/node_modules/pkg/.env.test",
  ], C.FORBIDDEN_PATH);
  assert.equal(validatePackageInventory([file("app/environment.js")]).status, "PASS");
});

test("ET01-T08: backup configuration, archives, credentials and private keys", () => {
  rejectsPaths([
    "public/web.config.bak", "app/dist/public/WEB.CONFIG.BAK", "app/settings.backup-2026",
    "app/x.bak.old", "app/x.orig", "app/x.swp", "app/x.swo", "app/x~", "app/.#edit",
    "app/#edit#", "app/database.sql", "app/db.sql.gz", "app/repo.tar.gz", "app/release.zip",
    "app/a.tgz", "app/a.7z", "app/a.rar", "app/tls.PEM", "app/tls.pfx", "app/tls.p12",
    "app/private.key", "app/private.key.old", "app/store.jks", "app/store.keystore",
    "app/serviceAccountKey.json", "app/service-account.json", "app/firebase-adminsdk-key.json",
    "app/application_default_credentials.json", "app/credentials.json", "app/secrets.yaml",
    "app/token.txt", "app/access_token.txt", "app/vault-export.json", "app/backup-config.json",
    "app/token", "app/tokens", "app/access_token", "app/refresh_token", "app/backup.config", "app/backup.env",
    "app/break-glass.json", "app/signing-key.json", "app/id_rsa", "app/id_ed25519",
  ], C.FORBIDDEN_PATH);
  assert.equal(validatePackageInventory([file("app/dist/public/web.config")]).status, "PASS");
});

test("ET01-T09: fixture, cache, credential-source and writable state exclusions", () => {
  for (const segment of [
    "tests", "__tests__", "fixtures", "__fixtures__", "examples", "coverage", ".nyc_output",
    ".git", ".agents", ".codex", ".npm", ".cache", ".config", ".aws", ".azure", ".ssh",
    ".npmrc", ".netrc", ".credentials", ".pytest_cache", "__pycache__", ".vite", ".parcel-cache",
    "gcloud", "ms-playwright", "playwright-cache",
    "logs", "dumps", "crash-dumps", "cache", "credential-cache", "profiles", "browser-profile",
    "user-data-dir", "temp", "tmp", "scratch", "backup", "backups", "data", "uploads",
    "generated", "generated-state", "secrets", "credentials", "secret-source", "secret-store",
    "credential-store", "vault-exports",
  ]) rejectsPaths([`app/${segment.toUpperCase()}/synthetic.js`], C.FORBIDDEN_PATH);
  rejectsPaths([
    "app/feature.test.js", "app/feature.spec.ts", "app/test.js", "app/feature.js.map",
    "public/TEST-LOGO.png", "app/fixture-logos.js", "app/fixture_logo.svg", "app/error.log",
    "app/core.dmp", "app/crash.mdmp", "app/database.dump",
  ], C.FORBIDDEN_PATH);
});

test("ET01-T10: only read-only regular-file descriptors supported", () => {
  for (const kind of ["symlink", "junction", "hardlink", "directory", "unknown", "File", null, {}]) {
    rejects([file(undefined, { kind })], C.UNSUPPORTED_KIND);
  }
  for (const runtimeWritable of [true, null, undefined, 0, "false", {}]) {
    rejects([file(undefined, { runtimeWritable })], C.WRITABLE_PAYLOAD);
  }
});

test("ET01-T11: stable reason ordering and bounded failure output", () => {
  const entries = [file(), file("APP/DIST/BOOT.js", { kind: "link", size: -1, sha256: "bad", runtimeWritable: true }), file("app/.env")];
  const result = validatePackageInventory(entries);
  assert.deepEqual(result.findings, [
    { entryIndex: 1, code: C.PATH_COLLISION }, { entryIndex: 1, code: C.UNSUPPORTED_KIND },
    { entryIndex: 1, code: C.INVALID_SIZE }, { entryIndex: 1, code: C.INVALID_SHA256 },
    { entryIndex: 1, code: C.WRITABLE_PAYLOAD }, { entryIndex: 2, code: C.FORBIDDEN_PATH },
  ]);
  assert.deepEqual(validatePackageInventory(entries), result);
  assert.ok(Object.isFrozen(C));
  assert.ok(Object.isFrozen(LIMITS));
  const bounded = rejects(Array.from({ length: LIMITS.maxFindings + 10 }, () => null), C.FINDING_LIMIT_REACHED);
  assert.equal(bounded.findings.length, LIMITS.maxFindings);
  assert.equal(bounded.findings.at(-1).code, C.FINDING_LIMIT_REACHED);
});

test("ET01-T12: no input mutation, getters, Proxy traps or diagnostic echoes", () => {
  const frozen = Object.freeze([Object.freeze(file())]);
  const before = JSON.stringify(frozen);
  assert.equal(validatePackageInventory(frozen).status, "PASS");
  assert.equal(JSON.stringify(frozen), before);
  let called = 0;
  const trap = () => { called++; throw new Error("caller callback must not run"); };
  const accessor = file();
  Object.defineProperty(accessor, "path", { get: trap, enumerable: true });
  rejects([accessor], C.INVALID_ENTRY);
  const hidden = file();
  Object.defineProperty(hidden, "path", { value: "safe.js", enumerable: false });
  rejects([hidden], C.INVALID_ENTRY);
  const accessorArray = [];
  Object.defineProperty(accessorArray, "0", { get: trap, enumerable: true });
  rejects(accessorArray, C.INVALID_ENTRY);
  const proxy = new Proxy(file(), { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  rejects([proxy], C.INVALID_ENTRY);
  rejects(new Proxy([file()], { get: trap, getPrototypeOf: trap, ownKeys: trap }), C.INVALID_INPUT);
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  rejects(revoked.proxy, C.INVALID_INPUT);
  const value = { toString: trap, valueOf: trap, toJSON: trap, [Symbol.toPrimitive]: trap };
  rejects([file(undefined, { path: value, sha256: value, size: value })], C.UNSAFE_PATH);
  const marker = "SYNTHETIC_ET01_DO_NOT_ECHO";
  const result = rejects([file(`${marker}/../bad`, { kind: marker, sha256: marker })], C.UNSAFE_PATH);
  assert.equal(JSON.stringify(result).includes(marker), false);
  assert.equal(called, 0);
});

test("ET01-T13: isolated import permits only the pure module and node:util", async () => {
  const moduleUrl = new URL("./package-inventory-policy.mjs?et01-capability-review", import.meta.url).href;
  const seen = [];
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      assert.ok(specifier === moduleUrl || specifier === "node:util", "unexpected import capability");
      seen.push(specifier);
      return nextResolve(specifier, context);
    },
  });
  try {
    const isolated = await import(moduleUrl);
    assert.equal(isolated.validatePackageInventory([file()]).status, "PASS");
    assert.deepEqual(seen, [moduleUrl, "node:util"]);
  } finally {
    hook.deregister();
  }
});

test("ET01-T14: PASS cannot imply contents, real hashes or production approval", () => {
  // These descriptor labels are not an on-disk file or a real digest claim.
  const result = validatePackageInventory([file("app/unknown-resource.json", { sha256: "0".repeat(64) })]);
  assert.equal(result.status, "PASS");
  assert.equal(result.scope, "INVENTORY_POLICY_ONLY");
  assert.equal(result.productionApproved, false);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.findings));
  assert.deepEqual(Object.keys(result), ["schemaVersion", "scope", "status", "productionApproved", "findings"]);
});

test("ET01-R01: fixture-logo basename prefix rejects every suffix and extension", () => {
  for (const path of [
    "app/fixture-logo2.svg", "app/fixture-logoFINAL.svg", "FiXtUrE-LoGo2.SVG",
    "app/dist/public/FiXtUrE-LoGoFINAL.svg", "app/node_modules/pkg/fixture-logo123.png",
    "fixture-logo", "app/fixture-logo2", "app/dist/fixture-logoFINAL",
    "app/fixture-logo.anything", "app/fixture-logoSuffix.custom", "app/fixture-logo-sample",
  ]) {
    const result = rejects([file(path)], C.FORBIDDEN_PATH);
    assert.deepEqual(result.findings, [{ entryIndex: 0, code: C.FORBIDDEN_PATH }]);
    assert.equal(result.scope, "INVENTORY_POLICY_ONLY");
  }
  for (const path of [
    "app/dist/logo2.svg", "app/dist/fixture-art.svg", "app/dist/fixture-log.svg",
    "app/dist/fixturelogo.svg", "app/dist/logo-fixture.svg", "app/dist/banner-fixture-logo2.svg",
  ]) {
    const result = validatePackageInventory([file(path)]);
    assert.equal(result.status, "PASS");
    assert.equal(result.productionApproved, false);
    assert.deepEqual(result.findings, []);
  }
});
