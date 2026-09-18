// ─── Dormant creative-claim stale recovery classifier ───
//
// PURE diagnostic module: it receives normalized durable evidence and returns
// a closed, deterministic classification of whether a stale creative
// generation claim is recoverable. It performs no I/O of any kind, has zero
// imports, authorizes nothing, and mutates nothing. The evidence model
// deliberately excludes all identities, tokens, keys and raw dependency
// errors: recovery reasoning never needs them.
//
// Recoverable means "a conditional terminalization is permitted to try":
//   - stale_recoverable: a running claim whose lease has expired. The expired
//     lease is the staleness proof — ownership is defined as valid only while
//     the lease is strictly in the future, so an expired lease cannot belong
//     to a live, heartbeating owner.
//   - legacy_unleased_recoverable: a running claim with no lease column value
//     whose last activity is older than the caller's staleBefore threshold.
//     No heartbeat can ever renew a null lease, so no live owner can hold it.
// Everything else is non-recoverable and must be left untouched.

export type CreativeClaimStaleRecoveryClaimEvidence =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly status: "running" | "completed" | "failed";
      readonly leaseState: "active" | "stale" | "missing";
      readonly agedPastThreshold: boolean;
    };

export type CreativeClaimStaleRecoveryClassification =
  | "healthy_running"
  | "stale_recoverable"
  | "legacy_unleased_recoverable"
  | "unleased_recent_ambiguous"
  | "terminal_closed"
  | "integrity_blocked";

export interface CreativeClaimStaleRecoveryResult {
  readonly classification: CreativeClaimStaleRecoveryClassification;
  readonly recoverable: boolean;
}

export interface CreativeClaimStaleRecoveryEvidence {
  readonly claim: CreativeClaimStaleRecoveryClaimEvidence;
}

const CLAIM_STATUSES = new Set(["running", "completed", "failed"]);
const LEASE_STATES = new Set(["active", "stale", "missing"]);

function assertEvidenceShape(evidence: CreativeClaimStaleRecoveryEvidence): void {
  if (!evidence || typeof evidence !== "object") {
    throw new TypeError("Invalid recovery evidence: expected an object");
  }
  const claim = evidence.claim;
  if (!claim || typeof claim !== "object" || typeof claim.found !== "boolean") {
    throw new TypeError("Invalid recovery evidence: malformed claim evidence");
  }
  if (claim.found) {
    if (!CLAIM_STATUSES.has(claim.status as string)) {
      throw new TypeError("Invalid recovery evidence: unknown claim status");
    }
    if (!LEASE_STATES.has(claim.leaseState as string)) {
      throw new TypeError("Invalid recovery evidence: unknown lease state");
    }
    if (typeof claim.agedPastThreshold !== "boolean") {
      throw new TypeError(
        "Invalid recovery evidence: agedPastThreshold must be boolean"
      );
    }
  }
}

function freezeResult(
  classification: CreativeClaimStaleRecoveryClassification,
  recoverable: boolean
): CreativeClaimStaleRecoveryResult {
  return Object.freeze({ classification, recoverable });
}

/**
 * Deterministic, fail-closed classification of normalized durable evidence.
 * Precedence: missing claim → non-running statuses → active lease → stale
 * lease → unleased age check. Never throws for valid closed-union evidence;
 * the recoverable flag is true only for classifications whose staleness is
 * proven by lease or heartbeat-absence evidence.
 */
export function classifyCreativeClaimStaleRecovery(
  evidence: CreativeClaimStaleRecoveryEvidence
): CreativeClaimStaleRecoveryResult {
  assertEvidenceShape(evidence);
  const { claim } = evidence;

  // A missing claim row is an integrity fault: never infer that "not found"
  // means safe to recreate or act on.
  if (!claim.found) {
    return freezeResult("integrity_blocked", false);
  }

  // Terminal claims are already closed by their owner; recovery has nothing
  // to prove and nothing to do, even if the lease timestamp looks stale.
  if (claim.status !== "running") {
    return freezeResult("terminal_closed", false);
  }

  // An active lease may belong to a live, heartbeating owner: never touch it.
  if (claim.leaseState === "active") {
    return freezeResult("healthy_running", false);
  }

  // An expired lease is the authoritative staleness proof.
  if (claim.leaseState === "stale") {
    return freezeResult("stale_recoverable", true);
  }

  // A null lease can never be renewed by a heartbeat, so ownership can never
  // be asserted on it; age beyond the caller threshold is the only remaining
  // staleness evidence. A recent unleased claim has not yet proven staleness.
  return claim.agedPastThreshold
    ? freezeResult("legacy_unleased_recoverable", true)
    : freezeResult("unleased_recent_ambiguous", false);
}
