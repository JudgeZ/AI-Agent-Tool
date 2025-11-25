import { appLogger } from "../observability/logger.js";
import type { ISessionStore } from "./ISessionStore.js";
import { RedisSessionStore, type RedisSessionStoreConfig } from "./RedisSessionStore.js";
import { MemorySessionStore } from "./SessionStore.js";

const logger = appLogger.child({ subsystem: "session-store" });

export type SessionStoreProvider = "memory" | "redis";

export type SessionStoreRedisConfig = {
  url?: string;
  keyPrefix?: string;
  enableL1Cache?: boolean;
  l1CacheTtlSeconds?: number;
};

export type SessionStoreConfig = {
  provider: SessionStoreProvider;
  redis?: SessionStoreRedisConfig;
};

/**
 * Create a session store based on configuration.
 *
 * @param config - Session store configuration
 * @returns An ISessionStore implementation
 *
 * @example
 * // Memory store (default, for development)
 * const store = createSessionStore({ provider: "memory" });
 *
 * @example
 * // Redis store (for production/horizontal scaling)
 * const store = createSessionStore({
 *   provider: "redis",
 *   redis: {
 *     url: "redis://localhost:6379",
 *     keyPrefix: "session",
 *   },
 * });
 */
export function createSessionStore(config: SessionStoreConfig): ISessionStore {
  const provider = config.provider ?? "memory";

  if (provider === "redis") {
    const redisUrl = config.redis?.url;
    if (!redisUrl) {
      logger.warn(
        { event: "session.store.config.missing_url" },
        "Redis session store configured but redis.url not provided; falling back to memory",
      );
      return new MemorySessionStore();
    }

    const redisConfig: RedisSessionStoreConfig = {
      redisUrl,
      keyPrefix: config.redis?.keyPrefix,
      enableL1Cache: config.redis?.enableL1Cache,
      // Convert seconds to milliseconds for RedisSessionStore
      l1CacheTtlMs: config.redis?.l1CacheTtlSeconds
        ? config.redis.l1CacheTtlSeconds * 1000
        : undefined,
    };

    logger.info(
      { provider: "redis", keyPrefix: redisConfig.keyPrefix, event: "session.store.created" },
      "Creating Redis session store",
    );

    return new RedisSessionStore(redisConfig);
  }

  logger.info(
    { provider: "memory", event: "session.store.created" },
    "Creating in-memory session store",
  );

  return new MemorySessionStore();
}

/**
 * Create a session store from environment variables.
 *
 * Environment variables:
 * - SESSION_STORE_PROVIDER: "memory" | "redis" (default: "memory")
 * - SESSION_STORE_REDIS_URL: Redis connection URL
 * - SESSION_STORE_REDIS_KEY_PREFIX: Key prefix (default: "session")
 * - SESSION_STORE_REDIS_L1_CACHE: Enable L1 cache ("true" | "false")
 * - SESSION_STORE_REDIS_L1_TTL: L1 cache TTL in seconds
 */
export function createSessionStoreFromEnv(): ISessionStore {
  const provider = (process.env.SESSION_STORE_PROVIDER ?? "memory") as SessionStoreProvider;
  const redisUrl = process.env.SESSION_STORE_REDIS_URL;
  const keyPrefix = process.env.SESSION_STORE_REDIS_KEY_PREFIX;
  const enableL1Cache = process.env.SESSION_STORE_REDIS_L1_CACHE === "true";
  const l1CacheTtlSecondsRaw = process.env.SESSION_STORE_REDIS_L1_TTL
    ? parseInt(process.env.SESSION_STORE_REDIS_L1_TTL, 10)
    : undefined;
  // Guard against NaN from invalid env var values
  const l1CacheTtlSeconds = l1CacheTtlSecondsRaw !== undefined && !Number.isNaN(l1CacheTtlSecondsRaw)
    ? l1CacheTtlSecondsRaw
    : undefined;

  return createSessionStore({
    provider,
    redis: redisUrl
      ? {
          url: redisUrl,
          keyPrefix,
          enableL1Cache,
          l1CacheTtlSeconds,
        }
      : undefined,
  });
}
