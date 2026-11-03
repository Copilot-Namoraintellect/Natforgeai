import type { Pool, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import {
  disabled,
  scopeKey,
  type Activation,
  type Scope,
} from "./autonomy-contract";
import type { ActivationRepository } from "./autonomy-service";

/** No migration or connection is executed on import. Pool is trusted server composition. */
export function createMysqlActivationRepository(
  pool: Pool
): ActivationRepository {
  return {
    async read(scope) {
      const [rows] = await pool.execute<RowDataPacket[]>(
        "SELECT version, state_json FROM autonomy_activations WHERE scope_key = ?",
        [scopeKey(scope)]
      );
      if (!rows.length) return disabled(scope);
      const value = (
        typeof rows[0].state_json === "string"
          ? JSON.parse(rows[0].state_json)
          : rows[0].state_json
      ) as Activation;
      if (
        scopeKey(value.scope) !== scopeKey(scope) ||
        value.version !== Number(rows[0].version)
      )
        throw new Error("AUTONOMY_STORAGE_CONFLICT");
      return value;
    },
    async transaction<T>(
      scope: Scope,
      run: Parameters<ActivationRepository["transaction"]>[1]
    ): Promise<T> {
      const connection = await pool.getConnection();
      const key = scopeKey(scope);
      try {
        await connection.beginTransaction();
        await connection.execute(
          "INSERT IGNORE INTO autonomy_activations (scope_key, version, state_json) VALUES (?, 0, ?)",
          [key, JSON.stringify(disabled(scope))]
        );
        const [rows] = await connection.execute<RowDataPacket[]>(
          "SELECT version, state_json FROM autonomy_activations WHERE scope_key = ? FOR UPDATE",
          [key]
        );
        if (rows.length !== 1) throw new Error("AUTONOMY_STORAGE_UNAVAILABLE");
        const current = (
          typeof rows[0].state_json === "string"
            ? JSON.parse(rows[0].state_json)
            : rows[0].state_json
        ) as Activation;
        if (
          scopeKey(current.scope) !== key ||
          current.version !== Number(rows[0].version)
        )
          throw new Error("AUTONOMY_STORAGE_CONFLICT");
        const result = await run({
          current,
          async save(next, audit) {
            const [updated] = await connection.execute<ResultSetHeader>(
              "UPDATE autonomy_activations SET version = ?, state_json = ? WHERE scope_key = ? AND version = ?",
              [next.version, JSON.stringify(next), key, current.version]
            );
            if (updated.affectedRows !== 1)
              throw new Error("AUTONOMY_VERSION_CONFLICT");
            await connection.execute(
              "INSERT INTO autonomy_activation_audit (scope_key, version, audit_json) VALUES (?, ?, ?)",
              [key, next.version, JSON.stringify(audit)]
            );
          },
          async reserveCanary(actionId, ceiling) {
            const [existing] = await connection.execute<RowDataPacket[]>(
              "SELECT action_id FROM autonomy_canary_reservations WHERE scope_key = ? AND action_id = ?",
              [key, actionId]
            );
            if (existing.length) return true;
            if (current.canaryUsed >= ceiling) return false;
            await connection.execute(
              "INSERT INTO autonomy_canary_reservations (scope_key, action_id) VALUES (?, ?)",
              [key, actionId]
            );
            const [updated] = await connection.execute<ResultSetHeader>(
              "UPDATE autonomy_activations SET state_json = JSON_SET(state_json, '$.canaryUsed', ?) WHERE scope_key = ? AND version = ?",
              [current.canaryUsed + 1, key, current.version]
            );
            if (updated.affectedRows !== 1)
              throw new Error("AUTONOMY_VERSION_CONFLICT");
            return true;
          },
        });
        await connection.commit();
        return result as T;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}
