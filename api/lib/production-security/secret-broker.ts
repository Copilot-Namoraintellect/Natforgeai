/**
 * R10-F — Least-privilege secret broker.
 *
 * The only sanctioned runtime mechanism by which a service identity obtains a
 * secret. Production wiring binds ONE broker per process at the composition
 * root with that process's service identity; the broker checks the F2
 * classification reader lists before touching the secret source.
 *
 * Trust-boundary rules:
 *  - Deny by default: unknown variable, unmapped class, or a reader not in
 *    the class reader list ⇒ SECRET_ACCESS_DENIED (never returns undefined
 *    silently for classified secrets — absence is also a deny).
 *  - `agent-runtime` is not in any reader list: a broker minted for an agent
 *    identity can never return a secret; callers must not mint one for it at
 *    all (minting is itself audited/test-forbidden).
 *  - BREAK_GLASS_SECRET has an empty reader list: no runtime identity reads
 *    break-glass material (human console only, F8).
 *  - The broker reads values but never logs them; errors name variable and
 *    class only.
 *  - PUBLIC_CONFIGURATION is not brokered: it is not secret material.
 */

import {
  classifyEnvVar,
  mayRead,
  SECRET_CLASS_READERS,
  SERVICE_IDENTITIES,
  type SecretClass,
  type ServiceIdentity,
} from "./secret-classification";

export const SECRET_ACCESS_DENIED = "SECRET_ACCESS_DENIED";

export class SecretAccessDeniedError extends Error {
  readonly code: typeof SECRET_ACCESS_DENIED;
  readonly variable: string;
  readonly secretClass: SecretClass;
  readonly reader: ServiceIdentity;

  constructor(variable: string, secretClass: SecretClass, reader: ServiceIdentity) {
    super(`Secret access denied: identity "${reader}" may not read "${variable}" (${secretClass}).`);
    this.name = "SecretAccessDeniedError";
    this.code = SECRET_ACCESS_DENIED;
    this.variable = variable;
    this.secretClass = secretClass;
    this.reader = reader;
  }
}

export type SecretSource = (variable: string) => string | undefined;

export interface SecretBroker {
  readonly identity: ServiceIdentity;
  /** Read a classified secret; throws SecretAccessDeniedError on violation. */
  read(variable: string): string | undefined;
  /** Read and require non-empty; throws when unset or denied. */
  required(variable: string): string;
  /** Class of a variable without reading it (planning/auditing only). */
  classify(variable: string): SecretClass;
}

/**
 * Mint a broker for a service identity. The identity is validated against
 * the closed vocabulary; `agent-runtime` is refused at mint time — agents
 * must never hold a broker (their boundary is no-read, enforced here).
 */
export function createSecretBroker(
  identity: ServiceIdentity,
  source: SecretSource = (name) => process.env[name]
): SecretBroker {
  if (!(SERVICE_IDENTITIES as readonly string[]).includes(identity)) {
    throw new SecretAccessDeniedError("<mint>", "BREAK_GLASS_SECRET", identity);
  }
  if (identity === "agent-runtime") {
    throw new SecretAccessDeniedError("<mint>", "BREAK_GLASS_SECRET", identity);
  }

  const read = (variable: string): string | undefined => {
    const cls = classifyEnvVar(variable);
    if (cls === "PUBLIC_CONFIGURATION") return source(variable);
    if (!mayRead(identity, cls)) {
      throw new SecretAccessDeniedError(variable, cls, identity);
    }
    return source(variable);
  };

  return {
    identity,
    read,
    required(variable: string): string {
      const value = read(variable);
      if (!value) {
        throw new Error(`Required secret "${variable}" is not available to identity "${identity}".`);
      }
      return value;
    },
    classify: classifyEnvVar,
  };
}

/** Reader list for a class (auditing/tests). */
export function readersOf(secretClass: SecretClass): readonly ServiceIdentity[] {
  return SECRET_CLASS_READERS[secretClass];
}
