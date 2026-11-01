/**
 * Backup-set naming. All identifiers are UTC, lexicographically sortable,
 * and contain no host-specific or secret material.
 */

export function utcTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

export function setId(d: Date = new Date()): string {
  return `set-${utcTimestamp(d)}Z`;
}

export function runId(d: Date = new Date()): string {
  return `bkp-${utcTimestamp(d)}Z`;
}

const SET_RE = /^set-\d{8}T\d{6}Z$/;

export function isValidSetId(id: string): boolean {
  return SET_RE.test(id);
}

/** Parse a set id back to a Date (for retention math). Invalid → null. */
export function setIdToDate(id: string): Date | null {
  if (!isValidSetId(id)) return null;
  const m = id.match(/^set-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(
    Date.UTC(+y, +mo - 1, +d, +h, +mi, +s),
  );
}
