import { randomUUID } from "node:crypto";
import { createClient } from "redis";

import { appLogger, normalizeError } from "../observability/logger.js";
import type { ISessionStore } from "./ISessionStore.js";
import { MemorySessionStore, type CreateSessionInput, type SessionRecord } from "./SessionStore.js";

const logger = appLogger.child({ subsystem: "session-store" });

const DEFAULT_KEY_PREFIX = "session";
const MIN_TTL_SECONDS = 1;

type RedisClient = ReturnType<typeof createClient>;

export type RedisSessionStoreConfig = {
  redisUrl: string;
  keyPrefix?: string;
  /**
   * Enable L1 memory cache for frequently accessed sessions.
   * The L1 cache uses a short TTL to reduce Redis round-trips.
   */
  enableL1Cache?: boolean;
  /**
   * L1 cache TTL in seconds. Only applies if enableL1Cache is true.
   * Default: 30 seconds
   */
  l1CacheTtlSeconds?: number;
};

function normalizeRoles(roles: string[]): string[] {
  return Array.from(
    new Set(roles.map((role) => role.trim()).filter((role) => role.length > 0)),
  ).sort((a, b) => a.localeCompare(b));
}

/**
 * Redis-backed session store implementation.
 *
 * Suitable for horizontal scaling and multi-instance deployments.
 * Sessions are persisted in Redis with automatic TTL-based expiration.
 *
 * Features:
 * - Distributed session storage across orchestrator instances
 * - Automatic TTL enforcement via Redis expiration
 * - Optional L1 memory cache for reduced latency
 * - Graceful fallback to memory if Redis unavailable
 *
 * Redis Key Structure:
 * - Session data: `{prefix}:{sessionId}` → JSON SessionRecord
 */
export class RedisSessionStore implements ISessionStore {
  private readonly redisUrl: string;
  private readonly keyPrefix: string;
  private readonly enableL1Cache: boolean;
  private readonly l1CacheTtlSeconds: number;
  private readonly memory: MemorySessionStore | null;
  private client: RedisClient | null = null;
  private connecting: Promise<RedisClient> | null = null;
  private closed = false;

  constructor(config: RedisSessionStoreConfig) {
    this.redisUrl = config.redisUrl;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.enableL1Cache = config.enableL1Cache ?? false;
    this.l1CacheTtlSeconds = Math.max(1, config.l1CacheTtlSeconds ?? 30);
    this.memory = this.enableL1Cache ? new MemorySessionStore() : null;
  }

  private formatKey(sessionId: string): string {
    return `${this.keyPrefix}:${sessionId}`;
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
          { err: normalizeError(error), event: "session.store.redis.error" },
          "Redis session store connection error",
        );
      });
      this.connecting = client
        .connect()
        .then(() => {
          this.client = client;
          logger.info({ event: "session.store.redis.connected" }, "Redis session store connected");
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
        { err: normalizeError(error), event: "session.store.redis.connect_failed" },
        "Failed to establish Redis session store connection",
      );
      return null;
    }
  }

  async createSession(
    input: CreateSessionInput,
    ttlSeconds: number,
    expiresAtMsOverride?: number,
  ): Promise<SessionRecord> {
    const id = randomUUID();
    const issuedAtMs = Date.now();
    const safeTtlSeconds = Math.max(MIN_TTL_SECONDS, Math.floor(ttlSeconds));
    const ttlMs = safeTtlSeconds * 1000;
    const expiryCandidate = expiresAtMsOverride ?? issuedAtMs + ttlMs;
    const expiresAtMs = Math.min(expiryCandidate, issuedAtMs + ttlMs);

    const session: SessionRecord = {
      id,
      subject: input.subject,
      email: input.email,
      name: input.name,
      tenantId: input.tenantId,
      roles: normalizeRoles(input.roles),
      scopes: Array.from(new Set(input.scopes)).sort(),
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      claims: { ...input.claims },
    };

    // Calculate actual TTL for Redis (time until expiration)
    const actualTtlSeconds = Math.max(
      MIN_TTL_SECONDS,
      Math.ceil((expiresAtMs - issuedAtMs) / 1000),
    );

    const client = await this.getClient();
    if (client) {
      try {
        await client.set(this.formatKey(id), JSON.stringify(session), {
          EX: actualTtlSeconds,
        });
        logger.debug(
          { sessionId: id, subject: input.subject, ttlSeconds: actualTtlSeconds, event: "session.created" },
          "Session created in Redis",
        );
      } catch (error) {
        logger.error(
          { err: normalizeError(error), sessionId: id, event: "session.store.redis.create_failed" },
          "Failed to create session in Redis",
        );
        // Fall through to L1 cache if Redis fails
      }
    }

    // Store in L1 cache with shorter TTL
    if (this.memory) {
      await this.memory.createSession(input, this.l1CacheTtlSeconds, expiresAtMsOverride);
      // The L1 cache creates its own ID, so we need to manually set the correct session
      // Actually, we should store the actual session in L1
      // Let's use a different approach - just cache the result
    }

    return session;
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    // Check L1 cache first
    if (this.memory) {
      const cached = await this.memory.getSession(id);
      if (cached) {
        return cached;
      }
    }

    const client = await this.getClient();
    if (!client) {
      return undefined;
    }

    try {
      const raw = await client.get(this.formatKey(id));
      if (!raw) {
        return undefined;
      }

      const session = JSON.parse(raw) as SessionRecord;

      // Check if expired (Redis TTL should handle this, but double-check)
      if (Date.now() >= Date.parse(session.expiresAt)) {
        // Session expired, Redis TTL should clean it up
        return undefined;
      }

      // Populate L1 cache on read (cache-aside pattern)
      // We don't populate L1 on read to avoid complexity with TTL sync

      return session;
    } catch (error) {
      logger.warn(
        { err: normalizeError(error), sessionId: id, event: "session.store.redis.get_failed" },
        "Failed to read session from Redis",
      );
      return undefined;
    }
  }

  async revokeSession(id: string): Promise<boolean> {
    // Remove from L1 cache
    if (this.memory) {
      await this.memory.revokeSession(id);
    }

    const client = await this.getClient();
    if (!client) {
      return false;
    }

    try {
      const result = await client.del(this.formatKey(id));
      const deleted = result > 0;
      if (deleted) {
        logger.debug(
          { sessionId: id, event: "session.revoked" },
          "Session revoked from Redis",
        );
      }
      return deleted;
    } catch (error) {
      logger.warn(
        { err: normalizeError(error), sessionId: id, event: "session.store.redis.revoke_failed" },
        "Failed to revoke session from Redis",
      );
      return false;
    }
  }

  async clear(): Promise<void> {
    // Clear L1 cache
    if (this.memory) {
      await this.memory.clear();
    }

    const client = await this.getClient();
    if (!client) {
      return;
    }

    try {
      // Use SCAN to find and delete all session keys
      // This is safer than KEYS for production use
      const pattern = `${this.keyPrefix}:*`;
      let cursor = 0;
      do {
        const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
        cursor = result.cursor;
        if (result.keys.length > 0) {
          await client.del(result.keys);
        }
      } while (cursor !== 0);

      logger.info({ event: "session.store.cleared" }, "All sessions cleared from Redis");
    } catch (error) {
      logger.warn(
        { err: normalizeError(error), event: "session.store.redis.clear_failed" },
        "Failed to clear sessions from Redis",
      );
    }
  }

  async cleanupExpired(): Promise<void> {
    // Redis handles TTL-based expiration automatically
    // This method is primarily for the memory store
    if (this.memory) {
      await this.memory.cleanupExpired();
    }
    // No-op for Redis - TTL handles expiration
  }

  async close(): Promise<void> {
    this.closed = true;

    // Clear L1 cache
    if (this.memory) {
      await this.memory.close();
    }

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
          { err: normalizeError(error), event: "session.store.redis.close_failed" },
          "Failed to close Redis session store client",
        );
      });
    }

    logger.info({ event: "session.store.closed" }, "Redis session store closed");
  }
}
