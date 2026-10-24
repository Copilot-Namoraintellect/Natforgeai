/**
 * Engagement Source Authority seam (WBS-R5-C boundary module).
 *
 * R5-A (`social_signals`) and R5-B (`social_interpretations`) are frozen
 * upstream tables that do not exist on this branch — they land at R5-X
 * integration. This module is the single loading seam between them and the
 * engagement pipeline:
 *
 * - reads by ALLOW-LISTED columns through raw table-name SQL (no drizzle
 *   schema coupling, so this branch compiles without the upstream tables);
 * - re-verifies tenant ownership from the durable rows (ctx.user.id) on
 *   every load — cross-tenant reads fail closed;
 * - treats the R5-B `record` JSON as the canonical interpretation and
 *   validates the consumed subset with a local read-only mirror schema;
 * - NEVER writes to either table (immutability is an A/B invariant);
 * - selects no token/secret columns.
 *
 * Tests install a scripted fake authority (see r5-c-acceptance). At
 * integration the drizzle-backed default loader works unchanged.
 */

import { z } from "zod";
import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import type { EngagementSourceSignal } from "./action-request";
import type { EngagementSourceInterpretation } from "./action-request";
import type {
  EngagementInterpretationView,
  InterpretationConfidence,
  InterpretationIntent,
  InterpretationSentiment,
} from "./intelligence";

export const ENGAGEMENT_SOURCE_LOADER_CONTRACT_VERSION = "engagement/source-loader@v1";

export class EngagementSourceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngagementSourceError";
    this.code = code;
  }
}

/** Consumption subset of the R5-B interpretation record (read-only mirror). */
const interpretationRecordSchema = z.object({
  interpretationId: z.string().min(1).max(64),
  classifierVersion: z.string().min(1).max(64),
  signalId: z.string().min(1).max(128),
  signalVersion: z.number().int().positive(),
  signalContentHash: z.string().min(1).max(64),
  businessId: z.number().int().positive().nullable(),
  intent: z.string(),
  sentiment: z.string(),
  overallConfidence: z.string(),
  riskFlags: z.array(z.object({ flag: z.string(), evidence: z.string().nullable().optional() })),
  explanation: z.string().nullable().optional(),
});

export type LoadedInterpretation = EngagementSourceInterpretation & EngagementInterpretationView;

export interface EngagementSourceAuthority {
  loadSignal(signalId: string, userId: number): Promise<EngagementSourceSignal | null>;
  loadInterpretation(
    interpretationId: string,
    userId: number
  ): Promise<LoadedInterpretation | null>;
}

interface DbLike {
  execute: (query: unknown) => Promise<unknown>;
}

export function createDrizzleSourceAuthority(db?: DbLike): EngagementSourceAuthority {
  const database = db ?? (getDb() as unknown as DbLike);

  async function queryRows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    const result = (await database.execute(query)) as { rows?: T[] } | T[];
    if (Array.isArray(result)) return result as T[];
    return (result.rows ?? []) as T[];
  }

  return {
    async loadSignal(signalId, userId) {
      const rows = await queryRows<{
        signalKey: string;
        userId: number;
        businessId: number | null;
        provider: string;
        platform: string;
        externalObjectId: string | null;
        contentText: string | null;
        providerEvidenceHash: string;
        ingestionVersion: number;
      }>(
        sql`SELECT signalKey, userId, businessId, provider, platform, externalObjectId, contentText, providerEvidenceHash, ingestionVersion
            FROM social_signals WHERE signalKey = ${signalId} AND userId = ${userId} LIMIT 1`
      );
      const row = rows[0];
      if (!row) return null;
      return {
        signalId: row.signalKey,
        signalVersion: Number(row.ingestionVersion),
        businessId: row.businessId == null ? null : Number(row.businessId),
        userId: Number(row.userId),
        provider: row.provider,
        platform: row.platform,
        providerEvidenceHash: row.providerEvidenceHash,
      };
    },

    async loadInterpretation(interpretationId, userId) {
      const rows = await queryRows<{
        interpretationId: string;
        businessId: number | null;
        signalId: string;
        signalVersion: number;
        signalContentHash: string;
        classifierVersion: string;
        record: string | unknown;
      }>(
        sql`SELECT interpretationId, businessId, signalId, signalVersion, signalContentHash, classifierVersion, record
            FROM social_interpretations WHERE interpretationId = ${interpretationId} AND userId = ${userId} LIMIT 1`
      );
      const row = rows[0];
      if (!row) return null;
      let parsedRecord: unknown;
      try {
        parsedRecord = typeof row.record === "string" ? JSON.parse(row.record) : row.record;
      } catch {
        throw new EngagementSourceError(
          "MALFORMED_INTERPRETATION_RECORD",
          "Interpretation record JSON is unreadable; failing closed."
        );
      }
      const validated = interpretationRecordSchema.safeParse(parsedRecord);
      if (!validated.success) {
        throw new EngagementSourceError(
          "MALFORMED_INTERPRETATION_RECORD",
          "Interpretation record does not match the consumed contract shape; failing closed."
        );
      }
      const record = validated.data;
      if (record.interpretationId !== row.interpretationId) {
        throw new EngagementSourceError(
          "INTELLIGENCE_BINDING_MISMATCH",
          "Interpretation record identity does not match the durable row."
        );
      }
      return {
        interpretationId: row.interpretationId,
        signalId: row.signalId,
        signalVersion: Number(row.signalVersion),
        signalContentHash: row.signalContentHash,
        classifierVersion: row.classifierVersion,
        businessId: row.businessId == null ? null : Number(row.businessId),
        intent: record.intent as InterpretationIntent,
        sentiment: record.sentiment as InterpretationSentiment,
        overallConfidence: record.overallConfidence as InterpretationConfidence,
        riskFlags: record.riskFlags,
        explanation: record.explanation ?? null,
      };
    },
  };
}
