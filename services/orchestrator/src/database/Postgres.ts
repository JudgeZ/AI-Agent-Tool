import { Pool } from "pg";

import { resolveEnv } from "../utils/env.js";

let pool: Pool | null = null;

export function getPostgresPool(): Pool | null {
  if (pool) {
    return pool;
  }
  const connectionString = resolveEnv("POSTGRES_URL");
  if (!connectionString) {
    return null;
  }
  pool = new Pool({ connectionString });
  pool.on("error", error => {
    // eslint-disable-next-line no-console
    console.error("postgres.pool.error", { message: (error as Error).message });
  });
  return pool;
}

export async function closePostgresPool(): Promise<void> {
  if (!pool) {
    return;
  }
  const current = pool;
  pool = null;
  await current.end().catch(error => {
    // eslint-disable-next-line no-console
    console.warn("postgres.pool.close_failed", { message: (error as Error).message });
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
