import { createClient, type RedisClientType } from "redis";

import { appLogger, normalizeError } from "../observability/logger.js";

type LoggerLike = {
  debug?: (obj: Record<string, unknown>, msg?: string, ...args: unknown[]) => void;
  info?: (obj: Record<string, unknown>, msg?: string, ...args: unknown[]) => void;
  warn?: (obj: Record<string, unknown>, msg?: string, ...args: unknown[]) => void;
  error?: (obj: Record<string, unknown>, msg?: string, ...args: unknown[]) => void;
};

export type RateLimitBackendProvider = "memory" | "redis";

export type RateLimitBackendConfig = {
  provider: RateLimitBackendProvider;
  redisUrl?: string;
};

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterMs?: number;
};

export interface RateLimitStore {
  allow(key: string, windowMs: number, maxRequests: number): Promise<RateLimitDecision>;
  disconnect?(): Promise<void>;
}

type RateLimitStoreOptions = {
  prefix?: string;
  logger?: LoggerLike;
};

const DEFAULT_PREFIX = "rate-limit";

class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly prefix: string) {}

  async allow(key: string, windowMs: number, maxRequests: number): Promise<RateLimitDecision> {
    const namespaced = this.namespacedKey(key);
    const now = Date.now();
    const cutoff = now - windowMs;
    const entries = this.hits.get(namespaced) ?? [];
    const recent = entries.filter((timestamp) => timestamp > cutoff);
    if (recent.length >= maxRequests) {
      const oldest = Math.min(...recent);
      const retryAfter = Math.max(0, windowMs - (now - oldest));
      this.hits.set(namespaced, recent);
      return { allowed: false, retryAfterMs: retryAfter };
    }
    recent.push(now);
    this.hits.set(namespaced, recent);
    return { allowed: true };
  }

  private namespacedKey(key: string): string {
    return `${this.prefix}:${key}`;
  }
}

class RedisRateLimitStore implements RateLimitStore {
  private readonly client: RedisClientType;
  private connecting: Promise<void> | null = null;
  private connected = false;

  constructor(
    redisUrl: string,
    private readonly prefix: string,
    private readonly logger: LoggerLike,
  ) {
    this.client = createClient({ url: redisUrl });
    this.client.on("error", (error: unknown) => {
      this.logger.warn?.({ err: normalizeError(error) }, "rate limit redis connection error");
    });
  }

  async allow(key: string, windowMs: number, maxRequests: number): Promise<RateLimitDecision> {
    try {
      await this.ensureConnected();
      const bucketKey = this.namespacedKey(key);
      const now = Date.now();
      const windowStart = now - windowMs;

      await this.client.zRemRangeByScore(bucketKey, 0, windowStart);
      const current = await this.client.zCard(bucketKey);
      if (current >= maxRequests) {
        const oldestEntries = await this.client.zRangeWithScores(bucketKey, 0, 0);
        const oldest = oldestEntries[0]?.score ?? now;
        const retryAfter = Math.max(0, windowMs - (now - oldest));
        return { allowed: false, retryAfterMs: retryAfter };
      }

      const member = `${now}-${Math.random().toString(36).slice(2)}`;
      await this.client.zAdd(bucketKey, [{ score: now, value: member }]);
      await this.client.pExpire(bucketKey, windowMs);
      return { allowed: true };
    } catch (error) {
      this.logger.error?.(
        { err: normalizeError(error), subsystem: "rate-limit", backend: "redis" },
        "rate limit check failed; defaulting to allow",
      );
      return { allowed: true };
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected && !this.connecting) {
      return;
    }
    try {
      await this.client.quit();
    } finally {
      this.connected = false;
      this.connecting = null;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (!this.connecting) {
      this.connecting = this.client
        .connect()
        .then(() => {
          this.connected = true;
        })
        .catch((error: unknown) => {
          this.connecting = null;
          this.logger.error?.({ err: normalizeError(error) }, "failed to connect to redis rate limit backend");
          throw error;
        });
    }
    await this.connecting;
  }

  private namespacedKey(key: string): string {
    return `${this.prefix}:${key}`;
  }
}

export function createRateLimitStore(
  backend: RateLimitBackendConfig,
  options: RateLimitStoreOptions = {},
): RateLimitStore {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const logger = options.logger ?? appLogger.child({ subsystem: "rate-limit" });
  if (backend.provider === "redis") {
    const redisUrl = backend.redisUrl ?? process.env.RATE_LIMIT_REDIS_URL;
    if (!redisUrl) {
      throw new Error("Rate limit backend redis requires a redisUrl to be configured");
    }
    return new RedisRateLimitStore(redisUrl, prefix, logger);
  }
  return new MemoryRateLimitStore(prefix);
}
