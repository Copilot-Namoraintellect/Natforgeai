/**
 * R8-X canonical strategic-governance engine binding (X4 — provisional seam
 * BIND).
 *
 * R8-D (strategic reasoning) and R8-E (opportunity/risk) consume the R8-F
 * strategic-governance authority through registration ports that fail closed
 * when no engine is registered (`STRATEGIC_GOVERNANCE_AUTHORITY_UNAVAILABLE` /
 * `GOVERNANCE_AUTHORITY_UNAVAILABLE`). Stream-level development registered
 * only test doubles; the integrated system must never voice reasoning or
 * candidates on guessed governance. This module binds the canonical in-process
 * R8-F engine exactly once at server boot.
 *
 * The bound port is an architectural adapter only: it forwards proposal
 * material to the frozen R8-F evaluation authority (real governed evaluation,
 * tenant-anchored bridge provider, durable decision persistence inside a
 * transaction). It grants D/E no authority F did not already hold — the
 * returned decision is re-validated at the consuming seam boundary, and
 * approvals still resolve through the shared approval ledger.
 */

import { getDb } from "../../queries/connection";
import { DEFAULT_STRATEGIC_POLICY_VERSION } from "./strategic-governance-contract";
import { evaluateStrategicGovernanceForProposal } from "./strategic-governance-service";
import {
  bindStrategicGovernanceStoreExecutor,
  createStrategicGovernanceBridgeProvider,
} from "./strategic-governance-bridge";
import { registerStrategicGovernanceEnginePort } from "../strategic-reasoning/strategic-reasoning-governance-seam";
import { registerStrategicOpportunityRiskGovernanceEngine } from "../strategic-opportunity-risk/strategic-opportunity-risk-governance-seam";

let bound = false;

/**
 * Idempotent: later calls are no-ops so tests and hot-reload paths can
 * clear/re-register their own doubles without interference.
 */
export function bindCanonicalStrategicGovernanceEngine(): void {
  if (bound) return;
  const port = {
    getCurrentPolicyVersion(): string {
      return DEFAULT_STRATEGIC_POLICY_VERSION;
    },
    async evaluateProposal(input: {
      userId: number;
      businessId: number;
      proposal: unknown;
      policyVersion?: string;
    }): Promise<unknown> {
      const db = getDb();
      const provider = createStrategicGovernanceBridgeProvider(db, input.userId);
      const result = await db.transaction(async (tx) =>
        evaluateStrategicGovernanceForProposal(
          { userId: input.userId, proposal: input.proposal, policyVersion: input.policyVersion },
          { provider },
          bindStrategicGovernanceStoreExecutor(tx)
        )
      );
      // Consuming seams validate the raw immutable decision payload.
      return result.decision;
    },
  };
  registerStrategicGovernanceEnginePort(port);
  registerStrategicOpportunityRiskGovernanceEngine(port);
  bound = true;
}
