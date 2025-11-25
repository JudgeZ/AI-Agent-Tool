import { createClient } from "redis";

import { appLogger, normalizeError } from "../observability/logger.js";
import type { IDedupeService } from "./IDedupeService.js";

const logger = appLogger.child({ subsystem: "dedupe-service" });

const DEFAULT_KEY_PREFIX = "dedupe";

type RedisClient = ReturnType<typeof createClient>;

export type RedisDedupeServiceConfig = {
  redisUrl: string;
  keyPrefix?: string;
};

/**
 * Redis-backed deduplication service implementation.
 *
 * Uses Redis SET NX PX for atomic claim operations with TTL.
 * Suitable for horizontal scaling and multi-instance deployments.
 *
 * Features:
 * - Distributed claim management across orchestrator instances
 * - Automatic TTL-based claim expiration
 * - Atomic claim operations (no race conditions)
 *
 * Redis Key Structure:
 * - Claim: `{prefix}:{key}` → "1" with TTL
 */
export class RedisDedupeService implements IDedupeService {
  private readonly redisUrl: string;
  private readonly keyPrefix: string;
  private client: RedisClient | null = null;
  private connecting: Promise<RedisClient> | null = null;
  private closed = false;

  constructor(config: RedisDedupeServiceConfig) {
    this.redisUrl = config.redisUrl;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  private formatKey(key: string): string {
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
          { err: normalizeError(error), event: "dedupe.service.redis.error" },
          "Redis dedupe service connection error",
        );
      });
      this.connecting = client
        .connect()
        .then(() => {
          this.client = client;
          logger.info({ event: "dedupe.service.redis.connected" }, "Redis dedupe service connected");
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
        { err: normalizeError(error), event: "dedupe.service.redis.connect_failed" },
        "Failed to establish Redis dedupe service connection",
      );
      return null;
    }
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const client = await this.getClient();
    if (!client) {
      // If Redis is unavailable, allow the claim to prevent blocking
      // This is a trade-off: we may process duplicates but won't deadlock
      logger.warn(
        { key, event: "dedupe.service.redis.unavailable" },
        "Redis unavailable; allowing claim to prevent blocking",
      );
      return true;
    }

    const safeTtlMs = Math.max(1, Math.floor(ttlMs));

    try {
      // SET NX PX: Set if Not Exists with expiration in milliseconds
      const result = await client.set(this.formatKey(key), "1", {
        NX: true,
        PX: safeTtlMs,
      });

      const claimed = result !== null;

      if (claimed) {
        logger.debug(
          { key, ttlMs: safeTtlMs, event: "dedupe.claimed" },
          "Idempotency key claimed",
        );
      } else {
        logger.debug(
          { key, event: "dedupe.already_claimed" },
          "Idempotency key already claimed",
        );
      }

      return claimed;
    } catch (error) {
      logger.error(
        { err: normalizeError(error), key, event: "dedupe.service.redis.claim_failed" },
        "Failed to claim idempotency key in Redis",
      );
      // On error, allow the claim to prevent blocking
      return true;
    }
  }

  async release(key: string): Promise<void> {
    const client = await this.getClient();
    if (!client) {
      return;
    }

    try {
      await client.del(this.formatKey(key));
      logger.debug(
        { key, event: "dedupe.released" },
        "Idempotency key released",
      );
    } catch (error) {
      logger.warn(
        { err: normalizeError(error), key, event: "dedupe.service.redis.release_failed" },
        "Failed to release idempotency key from Redis",
      );
    }
  }

  async isClaimed(key: string): Promise<boolean> {
    const client = await this.getClient();
    if (!client) {
      return false;
    }

    try {
      const result = await client.exists(this.formatKey(key));
      return result > 0;
    } catch (error) {
      logger.warn(
        { err: normalizeError(error), key, event: "dedupe.service.redis.check_failed" },
        "Failed to check idempotency key in Redis",
      );
      return false;
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
          { err: normalizeError(error), event: "dedupe.service.redis.close_failed" },
          "Failed to close Redis dedupe service client",
        );
      });
    }

    logger.info({ event: "dedupe.service.closed" }, "Redis dedupe service closed");
  }
}
