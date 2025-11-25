import { EventEmitter } from "events";
import { createClient } from "redis";
import { z } from "zod";

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

/**
 * Maximum number of SCAN iterations to prevent unbounded operations.
 * With COUNT=100 per iteration, this allows scanning up to ~100,000 keys.
 */
const MAX_SCAN_ITERATIONS = 1000;

export type RedisSharedContextConfig = Partial<SharedContextConfig> & {
  redisUrl: string;
  keyPrefix?: string;
};

/**
 * Zod schema for serialized context entries.
 * Validates data at process boundary per coding guidelines.
 */
const SerializedContextEntrySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  scope: z.nativeEnum(ContextScope),
  ownerId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number(),
  ttl: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type SerializedContextEntry = z.infer<typeof SerializedContextEntrySchema>;

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

    // Note: cleanupInterval is not used since Redis handles TTL-based expiration natively
    this.config = {
      maxEntries: config.maxEntries ?? 10000,
      defaultTtl: config.defaultTtl ?? 60 * 60 * 1000,
      cleanupInterval: 0, // Unused - Redis handles expiration via TTL
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

  /**
   * Format key for lightweight ACL metadata.
   * Stores `ownerId:scope` for quick access checks before fetching full entry.
   */
  private formatMetaKey(key: string): string {
    return `${this.keyPrefix}:meta:${key}`;
  }

  /**
   * Parse lightweight metadata string `ownerId:scope`.
   */
  private parseMetadata(meta: string): { ownerId: string; scope: ContextScope } | null {
    const colonIndex = meta.lastIndexOf(":");
    if (colonIndex === -1) return null;
    const ownerId = meta.slice(0, colonIndex);
    const scopeStr = meta.slice(colonIndex + 1);
    // Validate scope is a valid ContextScope value
    if (!Object.values(ContextScope).includes(scopeStr as ContextScope)) {
      return null;
    }
    return { ownerId, scope: scopeStr as ContextScope };
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

  private deserializeEntry(raw: string): ContextEntry | null {
    // Validate data at process boundary using Zod schema
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      logger.warn(
        { err: normalizeError(error), event: "context.redis.parse_failed" },
        "Failed to parse context entry JSON from Redis",
      );
      return null;
    }

    const parseResult = SerializedContextEntrySchema.safeParse(parsed);
    if (!parseResult.success) {
      logger.warn(
        { error: parseResult.error.message, event: "context.redis.validation_failed" },
        "Context entry from Redis failed schema validation",
      );
      return null;
    }

    const serialized = parseResult.data;
    return {
      ...serialized,
      createdAt: new Date(serialized.createdAt),
      updatedAt: new Date(serialized.updatedAt),
    };
  }

  // ============================================================================
  // ISharedContext Implementation
  // ============================================================================

  async set(
    key: string,
    value: unknown,
    ownerId: string,
    scope: ContextScope = ContextScope.PRIVATE,
    ttl?: number,
  ): Promise<void> {
    const client = await this.getClient();
    if (!client) {
      throw new Error("Redis client unavailable");
    }

    // Get existing entry to preserve createdAt and update version
    const existingRaw = await client.get(this.formatEntryKey(key));
    const existing = existingRaw ? this.deserializeEntry(existingRaw) : null;
    // If deserialization fails, treat as if entry doesn't exist

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

    // Store lightweight metadata for quick ACL pre-check
    // Format: `ownerId:scope` - allows checking access before fetching full entry
    await client.set(this.formatMetaKey(key), `${ownerId}:${scope}`, {
      EX: redisTtl,
    });

    // Track owner's keys
    await client.sAdd(this.formatOwnerKey(ownerId), key);
    // Set TTL on owner index to clean up eventually
    await client.expire(this.formatOwnerKey(ownerId), redisTtl * 2);

    this.emit("context:set", { key, ownerId, scope, version: entry.version });
  }

  async get(key: string, requesterId: string): Promise<unknown | undefined> {
    const client = await this.getClient();
    if (!client) {
      return undefined;
    }

    // ACL Pre-check: Fetch lightweight metadata first to check access before loading full entry.
    // This optimization avoids fetching potentially large values when access would be denied.
    const meta = await client.get(this.formatMetaKey(key));
    if (meta) {
      const parsed = this.parseMetadata(meta);
      if (parsed) {
        // Quick denial for PRIVATE entries where requester is not owner
        if (parsed.scope === ContextScope.PRIVATE && parsed.ownerId !== requesterId) {
          throw new Error(`Access denied to context key: ${key}`);
        }
        // Quick denial for SHARED entries where requester is not owner and not in ACL
        if (parsed.scope === ContextScope.SHARED && parsed.ownerId !== requesterId) {
          const isMember = await client.sIsMember(this.formatAclKey(key), requesterId);
          if (!isMember) {
            throw new Error(`Access denied to context key: ${key}`);
          }
        }
        // GLOBAL and owner access passes through to fetch full entry
      }
    }

    // Fetch full entry
    const raw = await client.get(this.formatEntryKey(key));
    if (!raw) {
      return undefined;
    }

    const entry = this.deserializeEntry(raw);
    if (!entry) {
      // Deserialization failed, treat as not found
      return undefined;
    }

    // Final access check (handles cases where metadata is missing or PIPELINE scope)
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

  async delete(key: string, requesterId: string): Promise<boolean> {
    const client = await this.getClient();
    if (!client) {
      return false;
    }

    const raw = await client.get(this.formatEntryKey(key));
    if (!raw) {
      return false;
    }

    const entry = this.deserializeEntry(raw);
    if (!entry) {
      // Deserialization failed, treat as not found
      return false;
    }

    // Only owner can delete
    if (entry.ownerId !== requesterId) {
      throw new Error(`Only owner can delete context key: ${key}`);
    }

    // Delete entry, metadata, ACL, and remove from owner index
    await Promise.all([
      client.del(this.formatEntryKey(key)),
      client.del(this.formatMetaKey(key)),
      client.del(this.formatAclKey(key)),
      client.sRem(this.formatOwnerKey(requesterId), key),
    ]);

    this.emit("context:delete", { key, ownerId: requesterId });
    return true;
  }

  async share(key: string, ownerId: string, agentIds: string[]): Promise<void> {
    const client = await this.getClient();
    if (!client) {
      throw new Error("Redis client unavailable");
    }

    const raw = await client.get(this.formatEntryKey(key));
    if (!raw) {
      throw new Error(`Context key not found: ${key}`);
    }

    const entry = this.deserializeEntry(raw);
    if (!entry) {
      throw new Error(`Context key not found: ${key}`);
    }

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

  async query(options: ContextQueryOptions, requesterId: string): Promise<ContextEntry[]> {
    const client = await this.getClient();
    if (!client) {
      return [];
    }

    const results: ContextEntry[] = [];
    const pattern = `${this.keyPrefix}:entry:${options.prefix ?? ""}*`;

    // Pagination parameters
    const offset = options.offset ?? 0;
    const limit = options.limit;
    let skipped = 0;

    // Scan for matching keys with iteration cap to prevent unbounded operations
    let cursor = 0;
    let iterations = 0;
    do {
      const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor;
      iterations++;

      // Batch fetch entries using mGet to avoid N+1 queries
      if (result.keys.length > 0) {
        const rawValues = await client.mGet(result.keys);

        for (let i = 0; i < result.keys.length; i++) {
          // Early exit if we've collected enough results
          if (limit !== undefined && results.length >= limit) {
            break;
          }

          const raw = rawValues[i];
          if (!raw) continue;

          const entry = this.deserializeEntry(raw);
          if (!entry) continue; // Skip invalid entries

          // Check access
          const hasAccess = await this.hasAccessAsync(entry, requesterId, client);
          if (!hasAccess) continue;

          // Apply filters
          if (options.scope && !options.scope.includes(entry.scope)) continue;
          if (options.ownerId && entry.ownerId !== options.ownerId) continue;
          if (options.pattern && !options.pattern.test(entry.key)) continue;

          // Handle offset (skip entries until we've passed the offset)
          if (skipped < offset) {
            skipped++;
            continue;
          }

          results.push(entry);
        }
      }

      // Early exit if we've collected enough results
      if (limit !== undefined && results.length >= limit) {
        break;
      }

      // Prevent unbounded iteration
      if (iterations >= MAX_SCAN_ITERATIONS) {
        logger.warn(
          { iterations, pattern, resultsCount: results.length, event: "context.redis.query.iteration_limit" },
          "Query reached maximum iteration limit; results may be incomplete",
        );
        break;
      }
    } while (cursor !== 0);

    return results;
  }

  async getEntryCount(): Promise<number> {
    const client = await this.getClient();
    if (!client) {
      return 0;
    }

    const pattern = `${this.keyPrefix}:entry:*`;
    let count = 0;
    let cursor = 0;
    let iterations = 0;

    do {
      const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor;
      count += result.keys.length;
      iterations++;

      // Prevent unbounded iteration
      if (iterations >= MAX_SCAN_ITERATIONS) {
        logger.warn(
          { iterations, pattern, count, event: "context.redis.count.iteration_limit" },
          "Entry count reached maximum iteration limit; count may be incomplete",
        );
        break;
      }
    } while (cursor !== 0);

    return count;
  }

  async getKeys(scope?: ContextScope): Promise<string[]> {
    const client = await this.getClient();
    if (!client) {
      return [];
    }

    const pattern = `${this.keyPrefix}:entry:*`;
    const keys: string[] = [];
    let cursor = 0;
    let iterations = 0;

    do {
      const result = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor;
      iterations++;

      if (scope && result.keys.length > 0) {
        // Batch fetch entries using mGet to avoid N+1 queries when filtering by scope
        const rawValues = await client.mGet(result.keys);

        for (let i = 0; i < result.keys.length; i++) {
          const redisKey = result.keys[i];
          const raw = rawValues[i];

          // Extract the context key from Redis key
          const contextKey = redisKey.replace(`${this.keyPrefix}:entry:`, "");

          if (raw) {
            const entry = this.deserializeEntry(raw);
            if (entry && entry.scope === scope) {
              keys.push(contextKey);
            }
          }
        }
      } else if (!scope) {
        // No scope filter - just extract keys without fetching entries
        for (const redisKey of result.keys) {
          const contextKey = redisKey.replace(`${this.keyPrefix}:entry:`, "");
          keys.push(contextKey);
        }
      }

      // Prevent unbounded iteration
      if (iterations >= MAX_SCAN_ITERATIONS) {
        logger.warn(
          { iterations, pattern, keysCount: keys.length, event: "context.redis.keys.iteration_limit" },
          "getKeys reached maximum iteration limit; results may be incomplete",
        );
        break;
      }
    } while (cursor !== 0);

    return keys;
  }

  async shutdown(): Promise<void> {
    this.closed = true;

    const pending = this.connecting;
    this.connecting = null;

    try {
      await pending;
    } catch {
      // Ignore connection errors during shutdown
    }

    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.quit();
      } catch (error) {
        logger.warn(
          { err: normalizeError(error), event: "context.redis.close_failed" },
          "Failed to close Redis shared context client",
        );
      }
    }
    logger.info({ event: "context.redis.closed" }, "Redis shared context closed");

    this.emit("shutdown");
  }
}
