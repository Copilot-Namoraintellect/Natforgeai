// Changed-source scan only. Reports locations, never matched credential material.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execFileSync(
  "git",
  ["ls-files", "-m", "-o", "--exclude-standard", "-z"],
  { encoding: "utf8" }
)
  .split("\0")
  .filter(Boolean);
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/,
];
const findings = [];
for (const file of files) {
  if (!/\.(?:ts|tsx|js|mjs|json|sql|md)$/.test(file)) continue;
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (patterns.some(pattern => pattern.test(line)))
        findings.push(`${file}:${index + 1}`);
    });
}
console.log(`changed_files=${files.length} secret_findings=${findings.length}`);
findings.forEach(location => console.log(location));
process.exitCode = findings.length ? 1 : 0;
