import { createClient, type RedisClientType } from "redis";
import { appLogger, normalizeError } from "../observability/logger.js";
import { randomUUID } from "node:crypto";

/**
 * DistributedLockService provides distributed locking via Redis.
 *
 * ## Implementation Details
 *
 * Uses the Redis SET NX PX pattern for atomic lock acquisition:
 * - `SET key token NX PX ttl` - Acquire lock only if key doesn't exist
 * - Lua script for safe release (only delete if token matches)
 *
 * ## Limitations
 *
 * **Single Redis Instance:**
 * This implementation assumes a single Redis instance or Redis Sentinel
 * with automatic failover. It does NOT implement the Redlock algorithm
 * for distributed consensus across multiple Redis masters.
 *
 * **NOT suitable for:**
 * - Redis Cluster in multi-master mode
 * - Scenarios requiring strong consistency during Redis failover
 * - Critical sections where split-brain could cause data corruption
 *
 * **Suitable for:**
 * - Single Redis instance deployments
 * - Redis Sentinel with automatic failover
 * - Use cases where occasional lock contention during failover is acceptable
 *
 * ## Lock Correctness Guarantees
 *
 * Under normal operation (no Redis failures):
 * - Mutual exclusion: Only one client holds the lock at a time
 * - Deadlock freedom: Locks automatically expire via TTL
 * - Safe release: Token-based release prevents accidental unlock
 *
 * During Redis failover:
 * - Brief period where lock state may be inconsistent
 * - Multiple clients may briefly believe they hold the lock
 * - Applications should be designed to handle this edge case
 *
 * ## Redlock Alternative
 *
 * For multi-master Redis deployments or stronger consistency requirements,
 * consider using the `redlock` npm package which implements the Redlock
 * algorithm across multiple independent Redis instances.
 *
 * @see https://redis.io/topics/distlock for the Redlock algorithm specification
 */

const instances = new Map<string, DistributedLockService>();
const instancePromises = new Map<string, Promise<DistributedLockService>>();
const MAX_RETRY_COUNT = 10;

export class LockAcquisitionError extends Error {
  constructor(
    message: string,
    public readonly code: "busy" | "timeout",
  ) {
    super(message);
  }
}

export class DistributedLockService {
  private readonly client: RedisClientType;
  private connected = false;

  constructor(redisUrl: string) {
    this.client = createClient({ url: redisUrl });
    this.client.on("error", (error) => {
      appLogger.warn({ err: normalizeError(error) }, "lock service redis error");
    });
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
      this.connected = false;
    }
  }

  getClient(): RedisClientType {
    return this.client;
  }

  async acquireLock(
    resource: string,
    ttlMs: number,
    retryCount = 3,
    retryDelayMs = 100,
    trace?: { traceId?: string; spanId?: string },
  ): Promise<() => Promise<void>> {
    const safeRetryCount = Math.min(Math.max(Math.trunc(retryCount) || 1, 1), MAX_RETRY_COUNT);
    const safeRetryDelayMs = Math.max(Math.trunc(retryDelayMs) || 0, 0);
    await this.connect();
    const key = `lock:${resource}`;
    const token = randomUUID();

    for (let i = 0; i < safeRetryCount; i++) {
      // NX: Set if Not Exists, PX: Expire in milliseconds
      const acquired = await this.client.set(key, token, { NX: true, PX: ttlMs });
      if (acquired) {
        return async () => {
          try {
            // Lua script to release lock only if token matches
            const script = `
              if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
              else
                return 0
              end
            `;
            await this.client.eval(script, { keys: [key], arguments: [token] });
          } catch (error) {
            appLogger.warn({ err: normalizeError(error), resource, ...trace }, "failed to release lock");
          }
        };
      }
      await new Promise((resolve) => setTimeout(resolve, safeRetryDelayMs));
    }
    throw new LockAcquisitionError(
      `Failed to acquire lock for resource ${resource} after ${safeRetryCount} attempts`,
      "busy",
    );
  }
}

export async function getDistributedLockService(redisUrl?: string): Promise<DistributedLockService> {
  const url = redisUrl ?? process.env.LOCK_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379";

  const existing = instances.get(url);
  if (existing) {
    return existing;
  }

  if (instances.size > 0 && !instances.has(url)) {
    throw new Error(
      "DistributedLockService already initialized for a different Redis URL; call resetDistributedLockService before switching endpoints.",
    );
  }

  const pending = instancePromises.get(url);
  if (pending) {
    return pending;
  }

  const instancePromise = (async () => {
    const instance = new DistributedLockService(url);
    instances.set(url, instance);
    instancePromises.delete(url);
    return instance;
  })();

  instancePromises.set(url, instancePromise);
  return instancePromise;
}

// Exported for tests
export async function resetDistributedLockService(): Promise<void> {
  for (const instance of instances.values()) {
    try {
      await instance.disconnect();
    } catch (error) {
      appLogger.warn({ err: normalizeError(error) }, "failed to close lock service client during reset");
    }
  }
  instances.clear();
  instancePromises.clear();
}

