import { EventEmitter } from "events";
import { createClient } from "redis";

import { appLogger, normalizeError } from "../observability/logger.js";
import type { ISharedContext } from "./ISharedContext.js";
import {
  type ContextEntry,
  type ContextQueryOptions,
  ContextScope,
  type SharedContextConfig,
} from "./AgentCommunication.js";

const logger = appLogger.child({ subsystem: "shared-context" });

type RedisClient = ReturnType<typeof createClient>;

const DEFAULT_KEY_PREFIX = "context";

export type RedisSharedContextConfig = Partial<SharedContextConfig> & {
  redisUrl: string;
  keyPrefix?: string;
};

type SerializedContextEntry = Omit<ContextEntry, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

/**
 * Redis-backed shared context manager.
 *
 * Enables sharing context data across multiple orchestrator instances.
 * Context entries are stored in Redis with TTL-based expiration.
 *
 * Redis Key Structure:
 * - Entry data: `{prefix}:entry:{key}` → JSON SerializedContextEntry
 * - Access control: `{prefix}:acl:{key}` → Redis Set of agent IDs
 * - Owner index: `{prefix}:owner:{ownerId}` → Redis Set of owned keys
 *
 * LIMITATIONS:
 * - Query operations scan all keys (may be slow with many entries)
 * - Access control changes are not broadcast to other instances
 * - Large values may impact Redis performance
 */
export class RedisSharedContext extends EventEmitter implements ISharedContext {
  private readonly config: SharedContextConfig;
  private readonly redisUrl: string;
  private readonly keyPrefix: string;

  private client: RedisClient | null = null;
  private connecting: Promise<RedisClient> | null = null;
  private closed = false;

  constructor(config: RedisSharedContextConfig) {
    super();
    this.redisUrl = config.redisUrl;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;

    this.config = {
      maxEntries: config.maxEntries ?? 10000,
      defaultTtl: config.defaultTtl ?? 60 * 60 * 1000,
      cleanupInterval: config.cleanupInterval ?? 5 * 60 * 1000,
      enableVersioning: config.enableVersioning ?? true,
    };
  }

  private formatEntryKey(key: string): string {
    return `${this.keyPrefix}:entry:${key}`;
  }

  private formatAclKey(key: string): string {
    return `${this.keyPrefix}:acl:${key}`;
  }

  private formatOwnerKey(ownerId: string): string {
    return `${this.keyPrefix}:owner:${ownerId}`;
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
          { err: normalizeError(error), event: "context.redis.error" },
          "Redis shared context connection error",
        );
      });
      this.connecting = client
        .connect()
        .then(() => {
          this.client = client;
          logger.info({ event: "context.redis.connected" }, "Redis shared context connected");
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
        { err: normalizeError(error), event: "context.redis.connect_failed" },
        "Failed to establish Redis shared context connection",
      );
      return null;
    }
  }

  private serializeEntry(entry: ContextEntry): string {
    const serialized: SerializedContextEntry = {
      ...entry,
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
    };
    return JSON.stringify(serialized);
  }

  private deserializeEntry(raw: string): ContextEntry {
    const serialized = JSON.parse(raw) as SerializedContextEntry;
    return {
      ...serialized,
      createdAt: new Date(serialized.createdAt),
      updatedAt: new Date(serialized.updatedAt),
    };
  }

  // ============================================================================
  // ISharedContext Implementation
  // ============================================================================

  set(
    key: string,
    value: unknown,
    ownerId: string,
    scope: ContextScope = ContextScope.PRIVATE,
    ttl?: number,
  ): void {
    // Fire and forget - async operation
    this.setAsync(key, value, ownerId, scope, ttl).catch((error) => {
      logger.warn(
        { err: normalizeError(error), key, ownerId, event: "context.set.failed" },
        "Failed to set context entry",
      );
    });
  }

  private async setAsync(
    key: string,
    value: unknown,
    ownerId: string,
    scope: ContextScope,
    ttl?: number,
  ): Promise<void> {
    const client = await this.getClient();
    if (!client) {
      throw new Error("Redis client unavailable");
    }

    // Get existing entry to preserve createdAt and update version
    const existingRaw = await client.get(this.formatEntryKey(key));
    const existing = existingRaw ? this.deserializeEntry(existingRaw) : null;

    const now = new Date();
    const entry: ContextEntry = {
      key,
      value,
      scope,
      ownerId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: this.config.enableVersioning ? (existing?.version ?? 0) + 1 : 1,
      ttl,
    };

    // Calculate Redis TTL (in seconds)
    const redisTtl = ttl ? Math.ceil(ttl / 1000) : Math.ceil(this.config.defaultTtl / 1000);

    // Store entry with TTL
    await client.set(this.formatEntryKey(key), this.serializeEntry(entry), {
      EX: redisTtl,
    });

    // Track owner's keys
    await client.sAdd(this.formatOwnerKey(ownerId), key);
    // Set TTL on owner index to clean up eventually
    await client.expire(this.formatOwnerKey(ownerId), redisTtl * 2);

    this.emit("context:set", { key, ownerId, scope, version: entry.version });
  }

  get(key: string, requesterId: string): unknown | undefined {
    // This needs to be sync per interface, but Redis is async
    // We'll throw if the value isn't immediately available
    // For proper async usage, use getAsync directly
    throw new Error(
      "RedisSharedContext.get() is not supported synchronously. " +
        "Use getAsync() or consider using MemorySharedContext for synchronous access.",
    );
  }

  /**
   * Async version of get() for Redis-backed context.
   */
  async getAsync(key: string, requesterId: string): Promise<unknown | undefined> {
    const client = await this.getClient();
    if (!client) {
      return undefined;
    }

    const raw = await client.get(this.formatEntryKey(key));
    if (!raw) {
      return undefined;
    }

    const entry = this.deserializeEntry(raw);

    // Check access
    const hasAccess = await this.hasAccessAsync(entry, requesterId, client);
    if (!hasAccess) {
      throw new Error(`Access denied to context key: ${key}`);
    }

    this.emit("context:get", { key, requesterId });
    return entry.value;
  }

  private async hasAccessAsync(entry: ContextEntry, requesterId: string, client: RedisClient): Promise<boolean> {
    // Owner always has access
    if (entry.ownerId === requesterId) {
      return true;
    }

    switch (entry.scope) {
      case ContextScope.GLOBAL:
        return true;

      case ContextScope.PRIVATE:
        return false;

      case ContextScope.SHARED: {
        const isMember = await client.sIsMember(this.formatAclKey(entry.key), requesterId);
        return isMember;
      }

      case ContextScope.PIPELINE:
        // For pipeline scope, check if requester is part of the same pipeline
        return Boolean(
          entry.metadata?.pipelineId && entry.metadata.pipelineId === requesterId,
        );

      default:
        return false;
    }
  }

  delete(key: string, requesterId: string): boolean {
    // Fire and forget
    this.deleteAsync(key, requesterId).catch((error) => {
      logger.warn(
        { err: normalizeError(error), key, requesterId, event: "context.delete.failed" },
        "Failed to delete context entry",
      );
    });
    return true; // Optimistic return
  }

  private async deleteAsync(key: string, requesterId: string): Promise<boolean> {
    const client = await this.getClient();
    if (!client) {
      return false;
    }

    const raw = await client.get(this.formatEntryKey(key));
    if (!raw) {
      return false;
    }

    const entry = this.deserializeEntry(raw);

    // Only owner can delete
    if (entry.ownerId !== requesterId) {
      throw new Error(`Only owner can delete context key: ${key}`);
    }

    // Delete entry, ACL, and remove from owner index
    await Promise.all([
      client.del(this.formatEntryKey(key)),
      client.del(this.formatAclKey(key)),
      client.sRem(this.formatOwnerKey(requesterId), key),
    ]);

    this.emit("context:delete", { key, ownerId: requesterId });
    return true;
  }

  share(key: string, ownerId: string, agentIds: string[]): void {
    // Fire and forget
    this.shareAsync(key, ownerId, agentIds).catch((error) => {
      logger.warn(
        { err: normalizeError(error), key, ownerId, event: "context.share.failed" },
        "Failed to share context entry",
      );
    });
  }

  private async shareAsync(key: string, ownerId: string, agentIds: string[]): Promise<void> {
    const client = await this.getClient();
    if (!client) {
      throw new Error("Redis client unavailable");
    }

    const raw = await client.get(this.formatEntryKey(key));
    if (!raw) {
      throw new Error(`Context key not found: ${key}`);
    }

    const entry = this.deserializeEntry(raw);

    if (entry.ownerId !== ownerId) {
      throw new Error(`Only owner can share context key: ${key}`);
    }

    // Update scope if needed
    if (entry.scope !== ContextScope.SHARED) {
      entry.scope = ContextScope.SHARED;
      entry.updatedAt = new Date();

      const redisTtl = entry.ttl
        ? Math.ceil(entry.ttl / 1000)
        : Math.ceil(this.config.defaultTtl / 1000);

      await client.set(this.formatEntryKey(key), this.serializeEntry(entry), {
        EX: redisTtl,
      });
    }

    // Add agent IDs to ACL
    if (agentIds.length > 0) {
      await client.sAdd(this.formatAclKey(key), agentIds);
      // Set TTL on ACL to match entry TTL
      const entryTtl = await client.ttl(this.formatEntryKey(key));
      if (entryTtl > 0) {
        await client.expire(this.formatAclKey(key), entryTtl);
      }
    }

    this.emit("context:shared", { key, ownerId, agentIds });
  }

  query(options: ContextQueryOptions, requesterId: string): ContextEntry[] {
    // Sync query not supported with Redis
    throw new Error(
      "RedisSharedContext.query() is not supported synchronously. " +
        "Use queryAsync() or consider using MemorySharedContext for synchronous access.",
    );
  }

  /**
   * Async version of query() for Redis-backed context.
   */
  async queryAsync(options: ContextQueryOptions, requesterId: string): Promise<ContextEntry[]> {
    const client = await this.getClient();
    if (!client) {
      return [];
    }

    const results: ContextEntry[] = [];
    const pattern = `${this.keyPrefix}:entry:${options.prefix ?? ""}*`;

    // Scan for matching keys
    let cursor = 0;
    do {
      const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor;

      for (const key of result.keys) {
        const raw = await client.get(key);
        if (!raw) continue;

        const entry = this.deserializeEntry(raw);

        // Check access
        const hasAccess = await this.hasAccessAsync(entry, requesterId, client);
        if (!hasAccess) continue;

        // Apply filters
        if (options.scope && !options.scope.includes(entry.scope)) continue;
        if (options.ownerId && entry.ownerId !== options.ownerId) continue;
        if (options.pattern && !options.pattern.test(entry.key)) continue;

        results.push(entry);
      }
    } while (cursor !== 0);

    return results;
  }

  getEntryCount(): number {
    // Sync not supported
    return 0;
  }

  /**
   * Async version of getEntryCount() for Redis-backed context.
   */
  async getEntryCountAsync(): Promise<number> {
    const client = await this.getClient();
    if (!client) {
      return 0;
    }

    const pattern = `${this.keyPrefix}:entry:*`;
    let count = 0;
    let cursor = 0;

    do {
      const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor;
      count += result.keys.length;
    } while (cursor !== 0);

    return count;
  }

  getKeys(scope?: ContextScope): string[] {
    // Sync not supported
    return [];
  }

  /**
   * Async version of getKeys() for Redis-backed context.
   */
  async getKeysAsync(scope?: ContextScope): Promise<string[]> {
    const client = await this.getClient();
    if (!client) {
      return [];
    }

    const pattern = `${this.keyPrefix}:entry:*`;
    const keys: string[] = [];
    let cursor = 0;

    do {
      const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor;

      for (const redisKey of result.keys) {
        // Extract the context key from Redis key
        const contextKey = redisKey.replace(`${this.keyPrefix}:entry:`, "");

        if (scope) {
          // Need to check scope
          const raw = await client.get(redisKey);
          if (raw) {
            const entry = this.deserializeEntry(raw);
            if (entry.scope === scope) {
              keys.push(contextKey);
            }
          }
        } else {
          keys.push(contextKey);
        }
      }
    } while (cursor !== 0);

    return keys;
  }

  shutdown(): void {
    this.closed = true;

    const pending = this.connecting;
    this.connecting = null;

    Promise.resolve(pending)
      .catch(() => undefined)
      .then(async () => {
        const client = this.client;
        this.client = null;
        if (client) {
          await client.quit().catch((error) => {
            logger.warn(
              { err: normalizeError(error), event: "context.redis.close_failed" },
              "Failed to close Redis shared context client",
            );
          });
        }
        logger.info({ event: "context.redis.closed" }, "Redis shared context closed");
      });

    this.emit("shutdown");
  }
}
