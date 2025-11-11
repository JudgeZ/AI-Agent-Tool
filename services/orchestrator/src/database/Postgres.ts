import { Pool, type PoolConfig } from "pg";

import { appLogger, normalizeError } from "../observability/logger.js";
import { resolveEnv } from "../utils/env.js";
import { loadConfig } from "../config.js";

let pool: Pool | null = null;

export function getPostgresPool(): Pool | null {
  if (pool) {
    return pool;
  }
  const connectionString = resolveEnv("POSTGRES_URL");
  if (!connectionString) {
    return null;
  }
  const config = loadConfig().database.postgres;
  const poolConfig: PoolConfig = {
    connectionString,
    max: config.maxConnections,
    min: Math.max(0, config.minConnections),
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    maxLifetimeSeconds: Math.max(1, Math.floor(config.maxConnectionLifetimeMs / 1000)),
  };
  if (config.statementTimeoutMs > 0) {
    poolConfig.statement_timeout = config.statementTimeoutMs;
  }
  if (config.queryTimeoutMs > 0) {
    poolConfig.query_timeout = config.queryTimeoutMs;
  }
  pool = new Pool(poolConfig);
  pool.on("error", (error: Error) => {
    appLogger.error(
      { err: error, event: "postgres.pool.error" },
      "Postgres connection pool emitted an error",
    );
  });
  return pool;
}

export async function closePostgresPool(): Promise<void> {
  if (!pool) {
    return;
  }
  const current = pool;
  pool = null;
  await current.end().catch((error: unknown) => {
    appLogger.warn(
      {
        err: normalizeError(error),
        event: "postgres.pool.close_failed",
      },
      "Failed to close Postgres connection pool",
    );
  });
}

export async function resetPostgresPoolForTests(): Promise<void> {
  if (!pool) {
    return;
  }
  const current = pool;
  pool = null;
  await current.end().catch(() => undefined);
}
