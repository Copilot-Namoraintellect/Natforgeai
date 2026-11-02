// ─── R10-C Runtime Resilience — version / release safety (C11) ───
//
// PURE gate: a worker must never process a job created under a runtime
// contract it does not explicitly support. The supported-job-contract set is
// CLOSED and worker-derived (a worker supports its own contract version; R10-A
// may widen the allow-list at binding, never the client). An old worker fails
// closed rather than misinterpret a new job contract; a new worker refuses a
// job whose contract it has not been certified for. Both the contract-version
// allow-list and exact release match fail closed; release drift is also
// surfaced to observability.

import {
  RUNTIME_RESILIENCE_CONTRACT_VERSION,
  RuntimeStateConflictError,
} from "./runtime-resilience-contract";

/** The closed set of job contract versions a worker is certified to process. */
export function supportedJobContractsForWorker(
  workerRuntimeVersion: string
): ReadonlySet<string> {
  // Closed default: a worker processes exactly the contract version it
  // implements. Widening happens only by explicit R10-A binding, never here.
  return new Set([workerRuntimeVersion]);
}

/**
 * Fail closed unless the job's runtime contract version is in the worker's
 * closed supported set. Throws JOB_VERSION_INCOMPATIBLE on any mismatch.
 */
export function assertJobVersionCompatible(input: {
  jobRuntimeVersion: string;
  jobReleaseVersion: string;
  workerRuntimeVersion: string;
  workerReleaseVersion: string;
  supportedJobContracts?: ReadonlySet<string>;
}): void {
  const supported =
    input.supportedJobContracts ??
    supportedJobContractsForWorker(input.workerRuntimeVersion);
  if (
    !supported.has(input.jobRuntimeVersion) ||
    input.jobReleaseVersion !== input.workerReleaseVersion
  ) {
    throw new RuntimeStateConflictError(
      "JOB_VERSION_INCOMPATIBLE",
      `worker (runtime ${input.workerRuntimeVersion}, release ${input.workerReleaseVersion}) cannot process job created under contract ${input.jobRuntimeVersion}; failing closed rather than misinterpreting the contract.`
    );
  }
  // A worker whose own contract has drifted from the engine's current contract
  // must not process anything.
  if (input.workerRuntimeVersion !== RUNTIME_RESILIENCE_CONTRACT_VERSION) {
    throw new RuntimeStateConflictError(
      "JOB_VERSION_INCOMPATIBLE",
      `worker runtime ${input.workerRuntimeVersion} is not the bound contract ${RUNTIME_RESILIENCE_CONTRACT_VERSION}.`
    );
  }
}
