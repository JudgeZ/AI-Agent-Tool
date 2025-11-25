import { createClient, type RedisClientType } from "redis";

import { appLogger, normalizeError } from "../observability/logger.js";
import type { CreateSessionInput, ISessionStore, SessionRecord } from "./ISessionStore.js";
import { buildSessionRecord, getSessionTtlMs, isSessionExpired } from "./sessionUtils.js";

const DEFAULT_PREFIX = "session";
const MIN_TTL_MS = 1000; // Minimum 1 second TTL for Redis

export type RedisSessionStoreOptions = {
  prefix?: string;
};

/**
 * Redis-backed implementation of ISessionStore.
 * Suitable for horizontally scaled deployments where sessions must be shared
 * across multiple instances.
 *
 * Sessions are stored as JSON strings with Redis TTL for automatic expiration.
 */
export class RedisSessionStore implements ISessionStore {
  private readonly client: RedisClientType;
  private readonly prefix: string;
  private connecting: Promise<void> | null = null;
  private connected = false;

  constructor(
    redisUrl: string,
    options: RedisSessionStoreOptions = {},
  ) {
    this.client = createClient({ url: redisUrl });
    this.prefix = options.prefix ?? DEFAULT_PREFIX;

    this.client.on("error", (error: unknown) => {
      appLogger.warn({ err: normalizeError(error), subsystem: "session-store" }, "redis connection error");
    });
  }

  async connect(): Promise<void> {
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
          appLogger.error({ err: normalizeError(error), subsystem: "session-store" }, "failed to connect to redis");
          throw error;
        });
    }
    await this.connecting;
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

  async createSession(
    input: CreateSessionInput,
    ttlSeconds: number,
    expiresAtMsOverride?: number,
  ): Promise<SessionRecord> {
    await this.ensureConnected();

    const session = buildSessionRecord(input, ttlSeconds, expiresAtMsOverride);
    const ttlMs = Math.max(getSessionTtlMs(session), MIN_TTL_MS);
    const key = this.sessionKey(session.id);

    await this.client.set(key, JSON.stringify(session), { PX: ttlMs });

    return session;
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    await this.ensureConnected();

    const key = this.sessionKey(id);
    const data = await this.client.get(key);

    if (!data) {
      return undefined;
    }

    try {
      const session = JSON.parse(data) as SessionRecord;

      // Belt-and-suspenders: verify expiration even though Redis TTL should handle it
      if (isSessionExpired(session)) {
        await this.client.del(key);
        return undefined;
      }

      return session;
    } catch (error) {
      appLogger.warn(
        { err: normalizeError(error), sessionId: id, subsystem: "session-store" },
        "failed to parse session data",
      );
      // Delete corrupted data
      await this.client.del(key);
      return undefined;
    }
  }

  async revokeSession(id: string): Promise<boolean> {
    await this.ensureConnected();

    const key = this.sessionKey(id);
    const deleted = await this.client.del(key);
    return deleted > 0;
  }

  async clear(): Promise<void> {
    await this.ensureConnected();

    const pattern = `${this.prefix}:*`;
    for await (const key of this.client.scanIterator({ MATCH: pattern })) {
      await this.client.del(key);
    }
  }

  async cleanupExpired(): Promise<void> {
    // No-op: Redis TTL handles automatic expiration
    // This method exists for interface compatibility with MemorySessionStore
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  private sessionKey(id: string): string {
    return `${this.prefix}:${id}`;
  }
}
