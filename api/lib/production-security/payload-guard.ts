/**
 * R10-F — Model-visible payload guard (prompt/context exclusion + output
 * screening).
 *
 * Screens any payload that is about to become model-visible (prompt/system/
 * context composition) or that came back from a model (structured output
 * about to be persisted or echoed). Secret-shaped material fails closed with
 * a typed error that names the path but never the material.
 *
 * Rules:
 *  - Fails closed: detection ⇒ throw; there is no warn-and-pass mode.
 *  - Findings name the JSON path and the shape id only — never the value.
 *  - Sensitive keys with non-trivial string values are findings even when
 *    the value matches no vendor shape (key smuggling is still a leak).
 *  - Depth-capped and cycle-safe; never throws for structural reasons.
 */

import { detectSecretShapes, type SecretShapeId } from "./secret-shapes";
import { SENSITIVE_KEY_PATTERN } from "./redact";

export const MODEL_PAYLOAD_SECRET_DETECTED = "MODEL_PAYLOAD_SECRET_DETECTED";

export interface SecretFinding {
  /** JSON path of the offending string, e.g. "context.business.notes". */
  readonly path: string;
  /** Detection kind: a secret-shape id, or SENSITIVE_KEY_VALUE. */
  readonly kind: SecretShapeId | "SENSITIVE_KEY_VALUE";
}

export class ModelPayloadSecretError extends Error {
  readonly code: typeof MODEL_PAYLOAD_SECRET_DETECTED;
  readonly findings: ReadonlyArray<SecretFinding>;

  constructor(findings: SecretFinding[]) {
    const paths = findings.map((f) => `${f.path}(${f.kind})`).join(", ");
    super(
      `Model payload rejected: secret-shaped material detected at ${paths}. ` +
        `Material is never logged or persisted by this guard.`
    );
    this.name = "ModelPayloadSecretError";
    this.code = MODEL_PAYLOAD_SECRET_DETECTED;
    this.findings = Object.freeze(findings.slice());
  }
}

const MAX_SCAN_DEPTH = 12;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function scanInternal(
  value: unknown,
  path: string,
  key: string | null,
  depth: number,
  seen: WeakSet<object>,
  findings: SecretFinding[]
): void {
  if (findings.length > 50) return; // bound work; fail closed on first batch
  if (depth > MAX_SCAN_DEPTH) return;

  if (typeof value === "string") {
    if (value.length === 0) return;
    const shapes = detectSecretShapes(value);
    for (const shape of shapes) findings.push({ path, kind: shape });
    if (key !== null && SENSITIVE_KEY_PATTERN.test(key) && value.trim().length >= 12) {
      findings.push({ path, kind: "SENSITIVE_KEY_VALUE" });
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanInternal(item, `${path}[${index}]`, null, depth + 1, seen, findings));
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      scanInternal(v, `${path}.${k}`, k, depth + 1, seen, findings);
    }
  }
  seen.delete(value as object);
}

/** Scan a payload; returns all findings (bounded, deterministic order). */
export function scanPayloadForSecrets(payload: unknown, rootPath = "payload"): SecretFinding[] {
  const findings: SecretFinding[] = [];
  scanInternal(payload, rootPath, null, 0, new WeakSet(), findings);
  return findings;
}

/** Fail-closed guard: throws ModelPayloadSecretError on any finding. */
export function assertSecretFreeModelPayload(payload: unknown, rootPath?: string): void {
  const findings = scanPayloadForSecrets(payload, rootPath);
  if (findings.length > 0) throw new ModelPayloadSecretError(findings);
}

/** Non-throwing predicate for call sites that branch instead of throwing. */
export function isSecretFreeModelPayload(payload: unknown, rootPath?: string): boolean {
  return scanPayloadForSecrets(payload, rootPath).length === 0;
}
