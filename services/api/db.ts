import { Pool, type PoolClient } from "pg";
import type { ApiConfig } from "./config";

export function createPool(config: Pick<ApiConfig, "databaseUrl" | "databaseSchema" | "databasePoolMax">): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    options: `-c search_path=${config.databaseSchema} -c statement_timeout=10000 -c idle_in_transaction_session_timeout=10000`,
    max: config.databasePoolMax ?? 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
  });
}

export async function withTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  // Callbacks must contain database work only: a transaction may be retried.
  for (let attempt = 0; ; attempt++) {
    try { return await transactionOnce(pool, operation); }
    catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (attempt >= 2 || (code !== "40P01" && code !== "40001")) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
    }
  }
}

async function transactionOnce<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { broken = true; }
    throw error;
  } finally {
    client.release(broken);
  }
}
