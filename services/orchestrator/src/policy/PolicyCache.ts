import { createClient } from "redis";

import type { AppConfig } from "../config.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import type { PolicyDecision } from "./PolicyEnforcer.js";

export type PolicyDecisionCache = {
  get(key: string): Promise<PolicyDecision | null>;
  set(key: string, decision: PolicyDecision): Promise<void>;
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

  async close(): Promise<void> {
    this.entries.clear();
  }
}

type RedisCacheOptions = {
  redisUrl: string;
  keyPrefix: string;
  ttlSeconds: number;
  maxEntries: number;
};

type RedisClient = ReturnType<typeof createClient>;

class RedisPolicyDecisionCache implements PolicyDecisionCache {
  private readonly redisUrl: string;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly memory: MemoryPolicyDecisionCache;
  private client: RedisClient | null = null;
  private connecting: Promise<RedisClient> | null = null;
  private closed = false;

  constructor(options: RedisCacheOptions) {
    this.redisUrl = options.redisUrl;
    this.keyPrefix = options.keyPrefix;
    this.ttlSeconds = Math.max(MIN_TTL_SECONDS, Math.floor(options.ttlSeconds));
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
    } catch (error) {
      logger.warn(
        { err: normalizeError(error), event: "policy.cache.redis.set_failed" },
        "Failed to store policy decision in Redis cache",
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.connecting;
    this.connecting = null;
    try {
      await pending;
    } catch {
      // ignore pending connection errors during shutdown
    }
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
