import { appLogger } from "../observability/logger.js";
import type { IDedupeService } from "./IDedupeService.js";
import { MemoryDedupeService } from "./MemoryDedupeService.js";
import { RedisDedupeService, type RedisDedupeServiceConfig } from "./RedisDedupeService.js";

const logger = appLogger.child({ subsystem: "dedupe-service" });

export type DedupeServiceProvider = "memory" | "redis";

export type DedupeServiceRedisConfig = {
  url?: string;
  keyPrefix?: string;
};

export type DedupeServiceConfig = {
  provider: DedupeServiceProvider;
  redis?: DedupeServiceRedisConfig;
  /**
   * Cleanup interval for memory-based service (ms).
   * Only applies when provider is "memory".
   */
  cleanupIntervalMs?: number;
};

/**
 * Create a deduplication service based on configuration.
 *
 * @param config - Dedupe service configuration
 * @returns An IDedupeService implementation
 *
 * @example
 * // Memory store (default, for development)
 * const service = createDedupeService({ provider: "memory" });
 *
 * @example
 * // Redis store (for production/horizontal scaling)
 * const service = createDedupeService({
 *   provider: "redis",
 *   redis: {
 *     url: "redis://localhost:6379",
 *     keyPrefix: "dedupe",
 *   },
 * });
 */
export function createDedupeService(config: DedupeServiceConfig): IDedupeService {
  const provider = config.provider ?? "memory";

  if (provider === "redis") {
    const redisUrl = config.redis?.url;
    if (!redisUrl) {
      logger.warn(
        { event: "dedupe.service.config.missing_url" },
        "Redis dedupe service configured but redis.url not provided; falling back to memory",
      );
      return new MemoryDedupeService(config.cleanupIntervalMs);
    }

    const redisConfig: RedisDedupeServiceConfig = {
      redisUrl,
      keyPrefix: config.redis?.keyPrefix,
    };

    logger.info(
      { provider: "redis", keyPrefix: redisConfig.keyPrefix, event: "dedupe.service.created" },
      "Creating Redis dedupe service",
    );

    return new RedisDedupeService(redisConfig);
  }

  logger.info(
    { provider: "memory", event: "dedupe.service.created" },
    "Creating in-memory dedupe service",
  );

  return new MemoryDedupeService(config.cleanupIntervalMs);
}

/**
 * Create a dedupe service from environment variables.
 *
 * Environment variables:
 * - DEDUPE_SERVICE_PROVIDER: "memory" | "redis" (default: "memory")
 * - DEDUPE_SERVICE_REDIS_URL: Redis connection URL
 * - DEDUPE_SERVICE_REDIS_KEY_PREFIX: Key prefix (default: "dedupe")
 */
export function createDedupeServiceFromEnv(): IDedupeService {
  const provider = (process.env.DEDUPE_SERVICE_PROVIDER ?? "memory") as DedupeServiceProvider;
  const redisUrl = process.env.DEDUPE_SERVICE_REDIS_URL;
  const keyPrefix = process.env.DEDUPE_SERVICE_REDIS_KEY_PREFIX;

  return createDedupeService({
    provider,
    redis: redisUrl
      ? {
          url: redisUrl,
          keyPrefix,
        }
      : undefined,
  });
}
