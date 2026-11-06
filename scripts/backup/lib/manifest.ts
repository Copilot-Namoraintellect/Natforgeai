/**
 * SHA-256 manifest over a backup set. The manifest itself
 * (MANIFEST.sha256) is never hashed; it is the plain-text root of trust
 * for the set and is re-checked on every copy/restore.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const MANIFEST_FILENAME = "MANIFEST.sha256";

export interface ManifestEntry {
  /** Path relative to the set root, posix separators. */
  path: string;
  sha256: string;
  size: number;
}

export interface ManifestVerification {
  ok: boolean;
  missing: string[];
  extra: string[];
  hashMismatch: string[];
  sizeMismatch: string[];
  entriesChecked: number;
}

export function sha256OfBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export async function sha256OfFile(filePath: string): Promise<string> {
  return sha256OfBuffer(await fs.readFile(filePath));
}

async function walk(dir: string, base: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (e.isDirectory()) {
      await walk(full, base, out);
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
}

/** Build the manifest for a directory (excluding the manifest file itself). */
export async function buildManifest(dir: string): Promise<ManifestEntry[]> {
  const files: string[] = [];
  await walk(dir, dir, files);
  const manifest: ManifestEntry[] = [];
  for (const rel of files) {
    if (rel === MANIFEST_FILENAME) continue;
    const full = path.join(dir, ...rel.split("/"));
    const stat = await fs.stat(full);
    manifest.push({ path: rel, sha256: await sha256OfFile(full), size: stat.size });
  }
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  return manifest;
}

export function serializeManifest(entries: ManifestEntry[]): string {
  return entries.map((e) => `${e.sha256}  ${e.path}\n`).join("");
}

export function parseManifest(content: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const m = line.match(/^([0-9a-f]{64})\s\s(.+)$/);
    if (!m) throw new Error(`MANIFEST_MALFORMED_LINE: ${line.slice(0, 80)}`);
    out.push({ path: m[2], sha256: m[1], size: -1 });
  }
  return out;
}

/** Re-hash a directory against an existing manifest. */
export async function verifyManifest(dir: string, entries: ManifestEntry[]): Promise<ManifestVerification> {
  const missing: string[] = [];
  const hashMismatch: string[] = [];
  const sizeMismatch: string[] = [];
  const onDisk = new Set<string>();
  const files: string[] = [];
  await walk(dir, dir, files);
  for (const rel of files) {
    if (rel !== MANIFEST_FILENAME) onDisk.add(rel);
  }
  for (const e of entries) {
    const full = path.join(dir, ...e.path.split("/"));
    onDisk.delete(e.path);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      missing.push(e.path);
      continue;
    }
    if (stat.size !== e.size && e.size >= 0) {
      sizeMismatch.push(e.path);
      continue;
    }
    const actual = await sha256OfFile(full);
    if (actual !== e.sha256) hashMismatch.push(e.path);
  }
  const extra = [...onDisk].sort();
  return {
    ok: missing.length === 0 && hashMismatch.length === 0 && sizeMismatch.length === 0 && extra.length === 0,
    missing: missing.sort(),
    extra,
    hashMismatch: hashMismatch.sort(),
    sizeMismatch: sizeMismatch.sort(),
    entriesChecked: entries.length,
  };
}
