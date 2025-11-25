import { createClient } from "redis";

import type { AppConfig } from "../config.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import type { PolicyDecision } from "./PolicyEnforcer.js";

export type PolicyDecisionCache = {
  get(key: string): Promise<PolicyDecision | null>;
  set(key: string, decision: PolicyDecision): Promise<void>;
  /**
   * Invalidate a specific cache entry.
   * Used for cross-replica cache consistency via Pub/Sub.
   */
  invalidate?(key: string): void;
  close?(): Promise<void>;
};

const logger = appLogger.child({ subsystem: "policy-cache" });

const DEFAULT_REDIS_KEY_PREFIX = "policy:decision";
const MIN_TTL_SECONDS = 1;
const MIN_MAX_ENTRIES = 1;

type PolicyCacheConfig = AppConfig["policy"]["cache"];

type MemoryCacheEntry = {
  expiresAt: number;
  decision: PolicyDecision;
};

class MemoryPolicyDecisionCache implements PolicyDecisionCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, MemoryCacheEntry>();

  constructor(options: { ttlSeconds: number; maxEntries: number }) {
    this.ttlMs = Math.max(MIN_TTL_SECONDS, Math.floor(options.ttlSeconds)) * 1000;
    this.maxEntries = Math.max(MIN_MAX_ENTRIES, Math.floor(options.maxEntries));
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private ensureCapacity(): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }
    const excess = this.entries.size - this.maxEntries;
    let remaining = excess;
    for (const key of this.entries.keys()) {
      this.entries.delete(key);
      remaining -= 1;
      if (remaining <= 0) {
        break;
      }
    }
  }

  async get(key: string): Promise<PolicyDecision | null> {
    const now = Date.now();
    this.pruneExpired(now);
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    // Refresh LRU ordering by reinserting the entry at the end of the map.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.decision;
  }

  async set(key: string, decision: PolicyDecision): Promise<void> {
    const now = Date.now();
    const expiresAt = now + this.ttlMs;
    this.pruneExpired(now);
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, { decision, expiresAt });
    this.ensureCapacity();
  }

  /**
   * Invalidate a specific cache entry.
   * Called by RedisPolicyDecisionCache when receiving Pub/Sub invalidation events.
   */
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

type RedisCacheOptions = {
  redisUrl: string;
  keyPrefix: string;
  ttlSeconds: number;
  maxEntries: number;
  /**
   * Enable Pub/Sub invalidation for L1 cache consistency across replicas.
   * Default: true
   */
  enableInvalidation?: boolean;
  /**
   * Unique instance ID. If not provided, a random ID will be generated.
   * Used to prevent self-invalidation on Pub/Sub events.
   */
  instanceId?: string;
};

type RedisClient = ReturnType<typeof createClient>;

const DEFAULT_INVALIDATION_CHANNEL = "policy:cache:invalidate";

/**
 * Invalidation message format for Pub/Sub.
 * Includes the source instance ID to prevent self-invalidation.
 */
interface InvalidationMessage {
  key: string;
  sourceInstanceId: string;
}

/**
 * Redis-backed policy decision cache with L1 (memory) and L2 (Redis) caching.
 *
 * Features:
 * - Two-tier caching for low latency reads
 * - Automatic TTL-based expiration
 * - Optional Pub/Sub invalidation for L1 cache consistency across replicas
 *
 * When enableInvalidation is true (default), the cache:
 * - Subscribes to a Redis Pub/Sub channel for invalidation events
 * - Publishes invalidation events when cache entries are set
 * - Invalidates L1 cache entries when receiving invalidation events
 *
 * This ensures that when one replica updates a policy decision, other replicas
 * will invalidate their L1 cache and fetch the updated value from Redis.
 */
class RedisPolicyDecisionCache implements PolicyDecisionCache {
  private readonly redisUrl: string;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly enableInvalidation: boolean;
  private readonly invalidationChannel: string;
  private readonly instanceId: string;
  private readonly memory: MemoryPolicyDecisionCache;
  private client: RedisClient | null = null;
  private subscriber: RedisClient | null = null;
  private connecting: Promise<RedisClient> | null = null;
  private subscribing: Promise<void> | null = null;
  private subscribed = false;
  private closed = false;

  constructor(options: RedisCacheOptions) {
    this.redisUrl = options.redisUrl;
    this.keyPrefix = options.keyPrefix;
    this.ttlSeconds = Math.max(MIN_TTL_SECONDS, Math.floor(options.ttlSeconds));
    this.enableInvalidation = options.enableInvalidation ?? true;
    this.invalidationChannel = `${this.keyPrefix || DEFAULT_INVALIDATION_CHANNEL}:invalidate`;
    this.instanceId = options.instanceId ?? `policy-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.memory = new MemoryPolicyDecisionCache({
      ttlSeconds: this.ttlSeconds,
      maxEntries: options.maxEntries,
    });
  }

  private formatKey(key: string): string {
    if (!this.keyPrefix) {
      return key;
    }
    return `${this.keyPrefix}:${key}`;
  }

  private async getClient(): Promise<RedisClient | null> {
    if (this.closed) {
      return null;
    }
    if (this.client) {
      return this.client;
    }
    if (!this.connecting) {
      const client = createClient({ url: this.redisUrl });
      client.on("error", (error: unknown) => {
        logger.warn(
          { err: normalizeError(error), event: "policy.cache.redis.error" },
          "Redis policy cache connection error",
        );
      });
      this.connecting = client
        .connect()
        .then(() => {
          this.client = client;
          // Setup invalidation subscription after main client connects
          if (this.enableInvalidation) {
            this.setupSubscription().catch((error) => {
              logger.warn(
                { err: normalizeError(error), event: "policy.cache.redis.subscription_failed" },
                "Failed to setup policy cache invalidation subscription",
              );
            });
          }
          return client;
        })
        .catch(async (error) => {
          await client.disconnect().catch(() => undefined);
          throw error;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    try {
      return await this.connecting;
    } catch (error) {
      logger.warn(
        { err: normalizeError(error), event: "policy.cache.redis.connect_failed" },
        "Failed to establish Redis policy cache connection; falling back to memory",
      );
      return null;
    }
  }

  /**
   * Setup Redis Pub/Sub subscription for cache invalidation events.
   * This allows multiple orchestrator instances to keep their L1 caches in sync.
   */
  private async setupSubscription(): Promise<void> {
    if (this.closed || this.subscribed || this.subscribing) {
      return;
    }

    this.subscribing = (async () => {
      try {
        // Create a separate client for subscriptions (Redis requires this)
        const subscriber = createClient({ url: this.redisUrl });
        subscriber.on("error", (error: unknown) => {
          logger.warn(
            { err: normalizeError(error), event: "policy.cache.redis.subscriber_error" },
            "Redis policy cache subscriber error",
          );
        });

        await subscriber.connect();
        this.subscriber = subscriber;

        // Subscribe to invalidation channel
        await subscriber.subscribe(this.invalidationChannel, (rawMessage: string) => {
          try {
            const message = JSON.parse(rawMessage) as InvalidationMessage;

            // Skip self-invalidation to avoid wasting work
            if (message.sourceInstanceId === this.instanceId) {
              return;
            }

            // Invalidate the L1 cache entry
            this.memory.invalidate(message.key);
            logger.debug(
              { key: message.key, sourceInstanceId: message.sourceInstanceId, event: "policy.cache.invalidated" },
              "L1 policy cache invalidated via Pub/Sub",
            );
          } catch (error) {
            logger.warn(
              { err: normalizeError(error), event: "policy.cache.invalidation.parse_failed" },
              "Failed to parse policy cache invalidation message",
            );
          }
        });

        this.subscribed = true;
        logger.info(
          { channel: this.invalidationChannel, event: "policy.cache.subscription.started" },
          "Policy cache invalidation subscription started",
        );
      } catch (error) {
        logger.warn(
          { err: normalizeError(error), event: "policy.cache.subscription.failed" },
          "Failed to setup policy cache invalidation subscription",
        );
        throw error;
      } finally {
        this.subscribing = null;
      }
    })();

    await this.subscribing;
  }

  /**
   * Publish an invalidation event to notify other replicas.
   * The message includes the source instance ID to prevent self-invalidation.
   */
  private async publishInvalidation(key: string): Promise<void> {
    if (!this.enableInvalidation || this.closed) {
      return;
    }
    const client = await this.getClient();
    if (!client) {
      return;
    }
    try {
      const message: InvalidationMessage = {
        key,
        sourceInstanceId: this.instanceId,
      };
      await client.publish(this.invalidationChannel, JSON.stringify(message));
    } catch (error) {
      logger.warn(
        { err: normalizeError(error), key, event: "policy.cache.redis.publish_failed" },
        "Failed to publish policy cache invalidation event",
      );
    }
  }

  async get(key: string): Promise<PolicyDecision | null> {
    const memoryDecision = await this.memory.get(key);
    if (memoryDecision) {
      return memoryDecision;
    }
    const client = await this.getClient();
    if (!client) {
      return null;
    }
    try {
      const raw = await client.get(this.formatKey(key));
      if (!raw) {
        return null;
      }
      const decision = JSON.parse(raw) as PolicyDecision;
      await this.memory.set(key, decision);
      return decision;
    } catch (error) {
      logger.warn(
        { err: normalizeError(error), event: "policy.cache.redis.get_failed" },
        "Failed to read policy decision from Redis cache",
      );
      return null;
    }
  }

  async set(key: string, decision: PolicyDecision): Promise<void> {
    await this.memory.set(key, decision);
    const client = await this.getClient();
    if (!client) {
      return;
    }
    try {
      await client.set(this.formatKey(key), JSON.stringify(decision), {
        EX: this.ttlSeconds,
      });
      // Publish invalidation event to notify other replicas
      await this.publishInvalidation(key);
    } catch (error) {
      logger.warn(
        { err: normalizeError(error), event: "policy.cache.redis.set_failed" },
        "Failed to store policy decision in Redis cache",
      );
    }
  }

  /**
   * Invalidate a specific cache entry in the L1 cache.
   * This is called internally when receiving Pub/Sub invalidation events.
   */
  invalidate(key: string): void {
    this.memory.invalidate(key);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscribed = false;

    // Wait for pending operations
    const pending = this.connecting;
    this.connecting = null;
    const pendingSub = this.subscribing;
    this.subscribing = null;

    try {
      await pending;
    } catch {
      // ignore pending connection errors during shutdown
    }
    try {
      await pendingSub;
    } catch {
      // ignore pending subscription errors during shutdown
    }

    // Close subscriber client
    const subscriber = this.subscriber;
    this.subscriber = null;
    if (subscriber) {
      await subscriber.unsubscribe(this.invalidationChannel).catch(() => undefined);
      await subscriber.quit().catch((error: unknown) => {
        logger.warn(
          { err: normalizeError(error), event: "policy.cache.redis.subscriber_close_failed" },
          "Failed to close Redis policy cache subscriber",
        );
      });
    }

    // Close main client
    const client = this.client;
    this.client = null;
    if (client) {
      await client.quit().catch((error: unknown) => {
        logger.warn(
          { err: normalizeError(error), event: "policy.cache.redis.close_failed" },
          "Failed to close Redis policy cache client",
        );
      });
    }

    await this.memory.close();
    logger.info({ event: "policy.cache.closed" }, "Policy cache closed");
  }
}

function sanitizePositiveInteger(value: number, minimum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  const normalized = Math.floor(value);
  if (normalized < minimum) {
    return minimum;
  }
  return normalized;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const serializedItems = value.map((item) => stableSerialize(item));
    return `[${serializedItems.join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  const serialized = entries
    .map(([key, val]) => `${JSON.stringify(key)}:${stableSerialize(val)}`)
    .join(",");
  return `{${serialized}}`;
}

export function buildPolicyCacheKey(input: unknown): string {
  return stableSerialize(input);
}

export function createPolicyDecisionCache(
  config: PolicyCacheConfig | null | undefined,
): PolicyDecisionCache | null {
  if (!config || !config.enabled) {
    return null;
  }
  const ttlSeconds = sanitizePositiveInteger(config.ttlSeconds, MIN_TTL_SECONDS);
  const maxEntries = sanitizePositiveInteger(config.maxEntries, MIN_MAX_ENTRIES);
  const provider = config.provider ?? "memory";
  if (provider === "redis") {
    const redisUrl = config.redis?.url;
    if (!redisUrl) {
      throw new Error("Redis policy cache provider requires redis.url to be configured");
    }
    const keyPrefix = config.redis?.keyPrefix ?? DEFAULT_REDIS_KEY_PREFIX;
    return new RedisPolicyDecisionCache({
      redisUrl,
      keyPrefix,
      ttlSeconds,
      maxEntries,
    });
  }
  return new MemoryPolicyDecisionCache({ ttlSeconds, maxEntries });
}
