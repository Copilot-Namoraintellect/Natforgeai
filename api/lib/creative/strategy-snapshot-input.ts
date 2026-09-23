import { TRPCError } from "@trpc/server";

import {
  getStrategySnapshotByStrategyRunId,
} from "../strategy/strategy-snapshot-db-store";
import {
  hashStrategySnapshotPayload,
  type JsonValue,
} from "../strategy/strategy-snapshot";
import type {
  PersistedStrategySnapshot,
} from "../strategy/strategy-snapshot-store";
import type {
  CreativeStrategyAuthority,
} from "./strategy-authority";

export interface ImmutableCreativeStrategyContext {
  readonly coreMessage: string | null;
  readonly valueProposition: string | null;
  readonly positioning: string | null;
  readonly campaignTheme: string | null;
  readonly personas: readonly unknown[];
}

export interface CreativeStrategySnapshotInput {
  readonly authority: CreativeStrategyAuthority;
  readonly snapshot: JsonValue;
  readonly creativeContext: ImmutableCreativeStrategyContext;
}

export interface ResolveCreativeStrategySnapshotInput {
  readonly authority: CreativeStrategyAuthority;
  readonly userId: number;
  readonly campaignId: number;
  readonly businessId: number;
}

export interface CreativeStrategySnapshotInputDependencies {
  readonly loadByStrategyRunId?: (
    strategyRunId: number
  ) => Promise<PersistedStrategySnapshot | null>;
}

function failClosed(reason: string): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message:
      `Immutable Strategy snapshot authority failed (${reason}). ` +
      "Regenerate and approve the Strategy before creating content.",
  });
}

function requirePositiveInteger(
  field: string,
  value: number
): void {
  if (
    !Number.isInteger(value) ||
    value <= 0
  ) {
    failClosed(field);
  }
}

function normaliseHash(
  value: string
): string {
  return value.trim().toLowerCase();
}

function optionalText(
  value: unknown
): string | null {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    return null;
  }

  return value.trim();
}

function requireObjectPayload(
  value: JsonValue
): Record<string, unknown> {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object"
  ) {
    failClosed("snapshot payload");
  }

  return value as unknown as Record<string, unknown>;
}

/**
 * Load the exact immutable WBS11 Strategy snapshot referenced by approved
 * Creative authority and prove that both identity and payload still match.
 *
 * Creative downstream code must consume this result rather than reconstructing
 * Strategy intent from mutable campaign projection fields.
 */
export async function resolveImmutableCreativeStrategyInput(
  input: ResolveCreativeStrategySnapshotInput,
  dependencies: CreativeStrategySnapshotInputDependencies = {}
): Promise<CreativeStrategySnapshotInput> {
  requirePositiveInteger(
    "userId",
    input.userId
  );

  requirePositiveInteger(
    "campaignId",
    input.campaignId
  );

  requirePositiveInteger(
    "businessId",
    input.businessId
  );

  const loadByStrategyRunId =
    dependencies.loadByStrategyRunId ??
    getStrategySnapshotByStrategyRunId;

  const persisted =
    await loadByStrategyRunId(
      input.authority.strategyRunId
    );

  if (!persisted) {
    failClosed("snapshot missing");
  }

  if (
    persisted.userId !== input.userId ||
    persisted.campaignId !== input.campaignId ||
    persisted.businessId !== input.businessId
  ) {
    failClosed("ownership");
  }

  if (
    persisted.strategyRunId !==
    input.authority.strategyRunId
  ) {
    failClosed("strategyRunId");
  }

  if (
    persisted.snapshotId !==
    input.authority.strategySnapshotId
  ) {
    failClosed("strategySnapshotId");
  }

  if (
    persisted.version !==
    input.authority.strategyVersion
  ) {
    failClosed("strategyVersion");
  }

  if (
    persisted.businessDnaSnapshotId !==
    input.authority.businessDnaSnapshotId
  ) {
    failClosed("businessDnaSnapshotId");
  }

  if (
    persisted.creativeBriefFingerprint !==
    input.authority.creativeBriefFingerprint
  ) {
    failClosed("creativeBriefFingerprint");
  }

  const persistedHash =
    normaliseHash(
      persisted.strategyHashSha256
    );

  const authorityHash =
    normaliseHash(
      input.authority.strategyHashSha256
    );

  const payloadHash =
    normaliseHash(
      hashStrategySnapshotPayload(
        persisted.snapshot
      )
    );

  if (
    persistedHash !== authorityHash ||
    payloadHash !== persistedHash
  ) {
    failClosed("strategyHashSha256");
  }

  const payload =
    requireObjectPayload(
      persisted.snapshot
    );

  const personas =
    Array.isArray(payload.personas)
      ? Object.freeze(
          [...payload.personas]
        )
      : Object.freeze(
          [] as unknown[]
        );

  const creativeContext =
    Object.freeze({
      coreMessage:
        optionalText(
          payload.coreMessage
        ),
      valueProposition:
        optionalText(
          payload.valueProposition
        ),
      positioning:
        optionalText(
          payload.positioning
        ),
      campaignTheme:
        optionalText(
          payload.campaignTheme
        ),
      personas,
    });

  if (
    !creativeContext.coreMessage &&
    !creativeContext.valueProposition &&
    creativeContext.personas.length === 0
  ) {
    failClosed(
      "creative context"
    );
  }

  return Object.freeze({
    authority:
      input.authority,
    snapshot:
      persisted.snapshot,
    creativeContext,
  });
}
