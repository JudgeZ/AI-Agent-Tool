import { appLogger } from "../observability/logger.js";
import { MessageBus, SharedContextManager } from "./AgentCommunication.js";
import type { IMessageBus } from "./IMessageBus.js";
import type { ISharedContext } from "./ISharedContext.js";
import { RedisMessageBus, type RedisMessageBusConfig } from "./RedisMessageBus.js";
import { RedisSharedContext, type RedisSharedContextConfig } from "./RedisSharedContext.js";

const logger = appLogger.child({ subsystem: "agent-communication" });

export type MessageBusProvider = "memory" | "redis";

export type MessageBusRedisConfig = {
  url?: string;
  channelPrefix?: string;
  instanceId?: string;
};

export type MessageBusConfig = {
  provider: MessageBusProvider;
  maxQueueSize?: number;
  defaultTtl?: number;
  cleanupInterval?: number;
  maxRetries?: number;
  enableMetrics?: boolean;
  redis?: MessageBusRedisConfig;
};

/**
 * Create a message bus based on configuration.
 *
 * @param config - Message bus configuration
 * @returns An IMessageBus implementation
 *
 * @example
 * // Memory bus (default, for development)
 * const bus = createMessageBus({ provider: "memory" });
 *
 * @example
 * // Redis bus (for production/horizontal scaling)
 * const bus = createMessageBus({
 *   provider: "redis",
 *   redis: {
 *     url: "redis://localhost:6379",
 *     channelPrefix: "msgbus",
 *   },
 * });
 */
export function createMessageBus(config: MessageBusConfig): IMessageBus {
  const provider = config.provider ?? "memory";

  if (provider === "redis") {
    const redisUrl = config.redis?.url;
    if (!redisUrl) {
      logger.warn(
        { event: "msgbus.config.missing_url" },
        "Redis message bus configured but redis.url not provided; falling back to memory",
      );
      return new MessageBus({
        maxQueueSize: config.maxQueueSize,
        defaultTtl: config.defaultTtl,
        cleanupInterval: config.cleanupInterval,
        maxRetries: config.maxRetries,
        enableMetrics: config.enableMetrics,
      });
    }

    const redisConfig: RedisMessageBusConfig = {
      redisUrl,
      channelPrefix: config.redis?.channelPrefix,
      instanceId: config.redis?.instanceId,
      maxQueueSize: config.maxQueueSize,
      defaultTtl: config.defaultTtl,
      cleanupInterval: config.cleanupInterval,
      maxRetries: config.maxRetries,
      enableMetrics: config.enableMetrics,
    };

    logger.info(
      { provider: "redis", channelPrefix: redisConfig.channelPrefix, event: "msgbus.created" },
      "Creating Redis message bus",
    );

    return new RedisMessageBus(redisConfig);
  }

  logger.info(
    { provider: "memory", event: "msgbus.created" },
    "Creating in-memory message bus",
  );

  return new MessageBus({
    maxQueueSize: config.maxQueueSize,
    defaultTtl: config.defaultTtl,
    cleanupInterval: config.cleanupInterval,
    maxRetries: config.maxRetries,
    enableMetrics: config.enableMetrics,
  });
}

/**
 * Create a message bus from environment variables.
 *
 * Environment variables:
 * - MESSAGE_BUS_PROVIDER: "memory" | "redis" (default: "memory")
 * - MESSAGE_BUS_REDIS_URL: Redis connection URL
 * - MESSAGE_BUS_REDIS_CHANNEL_PREFIX: Channel prefix (default: "msgbus")
 * - MESSAGE_BUS_INSTANCE_ID: Unique instance ID (auto-generated if not set)
 */
export function createMessageBusFromEnv(): IMessageBus {
  const provider = (process.env.MESSAGE_BUS_PROVIDER ?? "memory") as MessageBusProvider;
  const redisUrl = process.env.MESSAGE_BUS_REDIS_URL;
  const channelPrefix = process.env.MESSAGE_BUS_REDIS_CHANNEL_PREFIX;
  const instanceId = process.env.MESSAGE_BUS_INSTANCE_ID;

  return createMessageBus({
    provider,
    redis: redisUrl
      ? {
          url: redisUrl,
          channelPrefix,
          instanceId,
        }
      : undefined,
  });
}

export type SharedContextProvider = "memory" | "redis";

export type SharedContextRedisConfig = {
  url?: string;
  keyPrefix?: string;
};

export type SharedContextConfig = {
  provider: SharedContextProvider;
  maxEntries?: number;
  defaultTtl?: number;
  cleanupInterval?: number;
  enableVersioning?: boolean;
  redis?: SharedContextRedisConfig;
};

/**
 * Create a shared context manager based on configuration.
 *
 * @param config - Shared context configuration
 * @returns An ISharedContext implementation
 *
 * @example
 * // Memory context (default, for development)
 * const context = createSharedContext({ provider: "memory" });
 *
 * @example
 * // Redis context (for production/horizontal scaling)
 * const context = createSharedContext({
 *   provider: "redis",
 *   redis: {
 *     url: "redis://localhost:6379",
 *     keyPrefix: "context",
 *   },
 * });
 */
export function createSharedContext(config: SharedContextConfig): ISharedContext {
  const provider = config.provider ?? "memory";

  if (provider === "redis") {
    const redisUrl = config.redis?.url;
    if (!redisUrl) {
      logger.warn(
        { event: "context.config.missing_url" },
        "Redis shared context configured but redis.url not provided; falling back to memory",
      );
      return new SharedContextManager({
        maxEntries: config.maxEntries,
        defaultTtl: config.defaultTtl,
        cleanupInterval: config.cleanupInterval,
        enableVersioning: config.enableVersioning,
      });
    }

    const redisConfig: RedisSharedContextConfig = {
      redisUrl,
      keyPrefix: config.redis?.keyPrefix,
      maxEntries: config.maxEntries,
      defaultTtl: config.defaultTtl,
      cleanupInterval: config.cleanupInterval,
      enableVersioning: config.enableVersioning,
    };

    logger.info(
      { provider: "redis", keyPrefix: redisConfig.keyPrefix, event: "context.created" },
      "Creating Redis shared context",
    );

    return new RedisSharedContext(redisConfig);
  }

  logger.info(
    { provider: "memory", event: "context.created" },
    "Creating in-memory shared context",
  );

  return new SharedContextManager({
    maxEntries: config.maxEntries,
    defaultTtl: config.defaultTtl,
    cleanupInterval: config.cleanupInterval,
    enableVersioning: config.enableVersioning,
  });
}

/**
 * Create a shared context from environment variables.
 *
 * Environment variables:
 * - SHARED_CONTEXT_PROVIDER: "memory" | "redis" (default: "memory")
 * - SHARED_CONTEXT_REDIS_URL: Redis connection URL
 * - SHARED_CONTEXT_REDIS_KEY_PREFIX: Key prefix (default: "context")
 */
export function createSharedContextFromEnv(): ISharedContext {
  const provider = (process.env.SHARED_CONTEXT_PROVIDER ?? "memory") as SharedContextProvider;
  const redisUrl = process.env.SHARED_CONTEXT_REDIS_URL;
  const keyPrefix = process.env.SHARED_CONTEXT_REDIS_KEY_PREFIX;

  return createSharedContext({
    provider,
    redis: redisUrl
      ? {
          url: redisUrl,
          keyPrefix,
        }
      : undefined,
  });
}
