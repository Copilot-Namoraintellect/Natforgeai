/**
 * Shared stateful fake for the social-listening database slice.
 *
 * Emulates the exact drizzle chains the listening modules issue:
 *   select().from(X).where(...).limit(n)  (+ .orderBy().limit(n))
 *   insert(X).values(v)
 *   update(X).set(v).where(...)
 *
 * WHERE parameters are recovered by walking drizzle SQL queryChunks and
 * collecting Param values in order, so natural-key and integrationId filters
 * are honored with real fidelity. social_signals enforces its unique natural
 * key; social_listening_states enforces its unique integrationId. Counter
 * increments written as sql`col + 1` are applied numerically.
 */

export interface ListeningSeed {
  integrations?: any[];
  queue?: any[];
  receipts?: any[]; // audit_events rows: { eventFingerprint, metadata, userId }
  signals?: any[];
  listeningStates?: any[];
}

/** Tagged WHERE criteria: eq (field equals value) or in (field within values). */
type Criterion = { eq: unknown } | { in: unknown[] };

function extractCriteria(cond: any, out: Criterion[] = []): Criterion[] {
  if (cond === null || cond === undefined) return out;
  if (cond instanceof Date) {
    out.push({ eq: cond });
    return out;
  }
  if (Array.isArray(cond.queryChunks)) {
    for (const chunk of cond.queryChunks) extractCriteria(chunk, out);
    return out;
  }
  if (Array.isArray(cond.conditions)) {
    for (const c of cond.conditions) extractCriteria(c, out);
    return out;
  }
  if (cond?.constructor?.name === "Param" && Object.prototype.hasOwnProperty.call(cond, "value")) {
    out.push({ eq: cond.value });
    return out;
  }
  // inArray() emits an array chunk of Param values (OR-semantics per field).
  if (Array.isArray(cond)) {
    const paramValues =
      cond.length > 0 && cond.every((item) => item?.constructor?.name === "Param")
        ? cond.map((item) => item.value)
        : null;
    if (paramValues) {
      out.push({ in: paramValues });
      return out;
    }
    for (const item of cond) {
      if (item === null || ["string", "number", "boolean"].includes(typeof item)) {
        out.push({ eq: item });
      } else {
        extractCriteria(item, out);
      }
    }
  }
  return out;
}

function rowMatchesCriteria(row: any, criteria: Criterion[]): boolean {
  return criteria.every((c) => {
    if ("eq" in c) {
      if (c.eq instanceof Date) {
        return !(row.observedAt instanceof Date) || row.observedAt >= c.eq;
      }
      return Object.values(row).some((v) => v === c.eq);
    }
    return Object.values(row).some((v) => (c.in as unknown[]).includes(v));
  });
}

function signalKeyOf(row: any): string {
  return `${row.provider}|${row.providerAccountId}|${row.externalEventId}`;
}

function tableName(table: any): string {
  return table[Symbol.for("drizzle:Name")];
}

export function createListeningFakeDb(seed: ListeningSeed = {}) {
  const integrations = [...(seed.integrations ?? [])];
  const queue = [...(seed.queue ?? [])];
  const receipts = [...(seed.receipts ?? [])];
  const signals = new Map<string, any>();
  for (const s of seed.signals ?? []) signals.set(signalKeyOf(s), { ...s });
  const states = new Map<number, any>();
  for (const s of seed.listeningStates ?? []) states.set(s.integrationId, { ...s });

  let nextSignalId = 1000;
  let nextStateId = 5000;
  const insertedSignals: any[] = [];
  const stateUpdates: Array<{ integrationId: number; set: any }> = [];

  const db: any = {
    signals,
    states,
    insertedSignals,
    stateUpdates,
    integrations,
    queue,
    receipts,

    select: () => ({
      from: (table: any) => {
        const name = tableName(table);
        const allRows =
          name === "social_integrations"
            ? integrations
            : name === "publishing_queue"
              ? queue
              : name === "audit_events"
                ? receipts
                : name === "social_signals"
                  ? [...signals.values()]
                  : name === "social_listening_states"
                    ? [...states.values()]
                    : [];

        // Generic predicate over tagged WHERE criteria (eq / in).
        const matchRows = (criteria: Criterion[]) =>
          allRows.filter((r) => rowMatchesCriteria(r, criteria));

        const groupedCounts = (matched: any[]) => {
          const byIntegration = new Map<number, number>();
          for (const r of matched) {
            byIntegration.set(r.integrationId, (byIntegration.get(r.integrationId) ?? 0) + 1);
          }
          return [...byIntegration.entries()].map(([integrationId, count]) => ({
            integrationId,
            count,
          }));
        };

        const query: any = {
          where: (...conds: any[]) => {
            const criteria = extractCriteria(conds.length === 1 ? conds[0] : conds);
            const matched = matchRows(criteria);
            return {
              limit: async (_n: number) => matched,
              orderBy: () => ({
                limit: async (_n: number) => matched,
              }),
              // groupBy() executes the aggregate directly (no limit follows).
              groupBy: () => groupedCounts(matched),
            };
          },
          limit: async (_n: number) => allRows,
          orderBy: () => ({ limit: async (_n: number) => allRows }),
        };
        return query;
      },
    }),

    insert: (table: any) => ({
      values: async (values: any) => {
        const name = tableName(table);
        if (name === "social_signals") {
          const key = signalKeyOf(values);
          if (signals.has(key)) {
            const err: any = new Error("Duplicate entry for key 'ss_natural_key_uidx'");
            err.code = "ER_DUP_ENTRY";
            throw err;
          }
          const row = { id: nextSignalId++, ...values };
          signals.set(key, row);
          insertedSignals.push(row);
          return;
        }
        if (name === "social_listening_states") {
          if (states.has(values.integrationId)) {
            const err: any = new Error("Duplicate entry for key 'sls_integration_uidx'");
            err.code = "ER_DUP_ENTRY";
            throw err;
          }
          states.set(values.integrationId, {
            id: nextStateId++,
            cursor: null,
            acceptedCount: 0,
            duplicateCount: 0,
            rejectedCount: 0,
            ...values,
          });
          return;
        }
        throw new Error(`fake insert not supported for ${name}`);
      },
    }),
  };

  // update().set().where() awaited directly; WHERE params and sql`` counter
  // increments are applied to the stored state row.
  db.update = (table: any) => ({
    set: (setValues: any) => {
      const name = tableName(table);
      const target = {
        where: async (...conds: any[]) => {
          const criteria = extractCriteria(conds.length === 1 ? conds[0] : conds);
          const eqValues = criteria.flatMap((c) => ("eq" in c ? [c.eq] : c.in));
          if (name === "social_listening_states") {
            const state = states.get(Number(eqValues[0]));
            if (state) {
              stateUpdates.push({ integrationId: state.integrationId, set: { ...setValues } });
              for (const [key, value] of Object.entries(setValues)) {
                if (value && typeof value === "object" && "queryChunks" in (value as any)) {
                  // sql`col + 1` increment
                  state[key] = (Number(state[key] ?? 0) || 0) + 1;
                } else {
                  state[key] = value;
                }
              }
            }
          }
        },
      };
      return target;
    },
  });

  return db;
}
