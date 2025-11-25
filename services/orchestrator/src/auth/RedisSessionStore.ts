import { randomUUID } from "node:crypto";
import { createClient } from "redis";

import { appLogger, normalizeError } from "../observability/logger.js";
import type { ISessionStore } from "./ISessionStore.js";
import type { CreateSessionInput, SessionRecord } from "./SessionStore.js";
import { normalizeRoles, SessionRecordSchema } from "./sessionUtils.js";

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
   * L1 cache TTL in milliseconds. Only applies if enableL1Cache is true.
   * Default: 30000 (30 seconds)
   */
  l1CacheTtlMs?: number;
};

interface L1CacheEntry {
  session: SessionRecord;
  cachedAt: number;
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
 *
 * Redis Key Structure:
 * - Session data: `{prefix}:{sessionId}` → JSON SessionRecord
 */
// Default L1 cache cleanup interval (60 seconds)
const DEFAULT_L1_CLEANUP_INTERVAL_MS = 60 * 1000;

export class RedisSessionStore implements ISessionStore {
  private readonly redisUrl: string;
  private readonly keyPrefix: string;
  private readonly enableL1Cache: boolean;
  private readonly l1CacheTtlMs: number;
  private readonly l1Cache: Map<string, L1CacheEntry>;
  private client: RedisClient | null = null;
  private connecting: Promise<RedisClient> | null = null;
  private closed = false;
  private l1CleanupTimer?: NodeJS.Timeout;

  constructor(config: RedisSessionStoreConfig) {
    this.redisUrl = config.redisUrl;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.enableL1Cache = config.enableL1Cache ?? false;
    this.l1CacheTtlMs = Math.max(1000, config.l1CacheTtlMs ?? 30000);
    this.l1Cache = new Map();

    // Start periodic L1 cache cleanup if L1 caching is enabled
    if (this.enableL1Cache) {
      this.startL1Cleanup();
    }
  }

  /**
   * Start periodic L1 cache cleanup to prevent unbounded memory growth.
   */
  private startL1Cleanup(): void {
    this.l1CleanupTimer = setInterval(() => {
      this.cleanupExpired().catch((error) => {
        logger.warn(
          { err: normalizeError(error), event: "session.store.l1.cleanup_failed" },
          "L1 cache cleanup failed",
        );
      });
    }, DEFAULT_L1_CLEANUP_INTERVAL_MS);
    // Don't prevent Node from exiting
    this.l1CleanupTimer.unref();
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

  /**
   * Check if an L1 cache entry is still valid (not expired).
   */
  private isL1CacheValid(entry: L1CacheEntry): boolean {
    const now = Date.now();
    // Check if L1 cache entry has expired
    if (now - entry.cachedAt >= this.l1CacheTtlMs) {
      return false;
    }
    // Also check if the session itself has expired
    if (now >= Date.parse(entry.session.expiresAt)) {
      return false;
    }
    return true;
  }

  /**
   * Store a session in the L1 cache.
   */
  private setL1Cache(session: SessionRecord): void {
    if (!this.enableL1Cache) return;
    this.l1Cache.set(session.id, {
      session,
      cachedAt: Date.now(),
    });
  }

  /**
   * Get a session from the L1 cache if valid.
   */
  private getL1Cache(id: string): SessionRecord | undefined {
    if (!this.enableL1Cache) return undefined;
    const entry = this.l1Cache.get(id);
    if (!entry) return undefined;
    if (!this.isL1CacheValid(entry)) {
      this.l1Cache.delete(id);
      return undefined;
    }
    return entry.session;
  }

  /**
   * Remove a session from the L1 cache.
   */
  private deleteL1Cache(id: string): void {
    this.l1Cache.delete(id);
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
    // Use override directly when provided; only fall back to TTL-based expiry
    // when no override is given. This allows external systems (like OIDC) to
    // set session expiry based on token lifetime.
    const expiresAtMs = expiresAtMsOverride ?? issuedAtMs + ttlMs;

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
    let redisSuccess = false;

    if (client) {
      try {
        await client.set(this.formatKey(id), JSON.stringify(session), {
          EX: actualTtlSeconds,
        });
        redisSuccess = true;
        logger.debug(
          { sessionId: id, subject: input.subject, ttlSeconds: actualTtlSeconds, event: "session.created" },
          "Session created in Redis",
        );
        // Cache in L1 only after successful Redis write
        this.setL1Cache(session);
      } catch (error) {
        logger.error(
          { err: normalizeError(error), sessionId: id, event: "session.store.redis.create_failed" },
          "Failed to create session in Redis",
        );
      }
    }

    // If Redis failed, only cache in L1 as fallback (if enabled)
    if (!redisSuccess) {
      if (this.enableL1Cache) {
        this.setL1Cache(session);
        logger.warn(
          { sessionId: id, event: "session.store.redis.fallback" },
          "Session stored in L1 cache only (Redis unavailable); session may not be visible to other replicas",
        );
      } else {
        // No persistence available - fail the operation
        throw new Error(
          "Failed to create session: Redis unavailable and L1 cache disabled",
        );
      }
    }

    return session;
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    // Check L1 cache first
    const cached = this.getL1Cache(id);
    if (cached) {
      return cached;
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

      // Validate session data at process boundary using Zod schema
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        logger.warn(
          { sessionId: id, event: "session.store.redis.parse_failed" },
          "Failed to parse session JSON from Redis",
        );
        return undefined;
      }

      const parseResult = SessionRecordSchema.safeParse(parsed);
      if (!parseResult.success) {
        logger.warn(
          { sessionId: id, error: parseResult.error.message, event: "session.store.redis.validation_failed" },
          "Session data from Redis failed schema validation",
        );
        return undefined;
      }

      const session = parseResult.data;

      // Check if expired (Redis TTL should handle this, but double-check)
      if (Date.now() >= Date.parse(session.expiresAt)) {
        // Session expired, Redis TTL should clean it up
        return undefined;
      }

      // Populate L1 cache on read (cache-aside pattern)
      this.setL1Cache(session);

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
    this.deleteL1Cache(id);

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
    this.l1Cache.clear();

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
    // Clean up expired entries in L1 cache
    for (const [id, entry] of this.l1Cache) {
      if (!this.isL1CacheValid(entry)) {
        this.l1Cache.delete(id);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;

    // Stop L1 cache cleanup timer
    if (this.l1CleanupTimer) {
      clearInterval(this.l1CleanupTimer);
      this.l1CleanupTimer = undefined;
    }

    // Clear L1 cache
    this.l1Cache.clear();

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
