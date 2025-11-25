import { createClient, type RedisClientType } from "redis";

import { loadConfig, type DedupeConfig } from "../config/loadConfig.js";
import { appLogger, normalizeError } from "../observability/logger.js";

/**
 * Interface for deduplication services.
 * Used to prevent duplicate message processing in queue adapters.
 */
export interface IDedupeService {
  /**
   * Attempts to add a key to the dedupe set.
   * @param key - The idempotency key to add
   * @param ttlMs - Optional TTL in milliseconds (uses default if not specified)
   * @returns true if key was newly added, false if it already exists
   */
  tryAdd(key: string, ttlMs?: number): Promise<boolean>;

  /**
   * Releases a key from the dedupe set.
   * Should be called when message processing completes (ack, deadLetter, or error).
   * @param key - The idempotency key to release
   */
  release(key: string): Promise<void>;

  /**
   * Checks if a key exists in the dedupe set.
   * @param key - The idempotency key to check
   * @returns true if the key exists, false otherwise
   */
  has(key: string): Promise<boolean>;

  /**
   * Clears all keys from the dedupe set.
   * Useful for testing.
   */
  clear(): Promise<void>;

  /**
   * Disconnects from the backing store (if applicable).
   */
  disconnect?(): Promise<void>;
}

/**
 * In-memory implementation of IDedupeService.
 * Suitable for single-instance deployments or development.
 */
export class MemoryDedupeService implements IDedupeService {
  private readonly keys = new Set<string>();

  async tryAdd(key: string): Promise<boolean> {
    if (this.keys.has(key)) {
      return false;
    }
    this.keys.add(key);
    return true;
  }

  async release(key: string): Promise<void> {
    this.keys.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.keys.has(key);
  }

  async clear(): Promise<void> {
    this.keys.clear();
  }

  /**
   * Returns the number of keys currently tracked.
   * Useful for testing and monitoring.
   */
  get size(): number {
    return this.keys.size;
  }
}

const DEFAULT_DEDUPE_PREFIX = "dedupe";
const DEFAULT_DEDUPE_TTL_MS = 300_000; // 5 minutes
const MIN_TTL_MS = 1000; // Minimum 1 second

export type RedisDedupeServiceOptions = {
  prefix?: string;
  defaultTtlMs?: number;
};

/**
 * Redis-backed implementation of IDedupeService.
 * Uses SET NX PX for atomic add-if-not-exists with TTL.
 * Suitable for horizontally scaled deployments.
 */
export class RedisDedupeService implements IDedupeService {
  private readonly client: RedisClientType;
  private readonly prefix: string;
  private readonly defaultTtlMs: number;
  private connecting: Promise<void> | null = null;
  private connected = false;

  constructor(
    redisUrl: string,
    options: RedisDedupeServiceOptions = {},
  ) {
    this.client = createClient({ url: redisUrl });
    this.prefix = options.prefix ?? DEFAULT_DEDUPE_PREFIX;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_DEDUPE_TTL_MS;

    this.client.on("error", (error: unknown) => {
      appLogger.warn({ err: normalizeError(error), subsystem: "dedupe-service" }, "redis connection error");
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
          appLogger.error({ err: normalizeError(error), subsystem: "dedupe-service" }, "failed to connect to redis");
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

  async tryAdd(key: string, ttlMs?: number): Promise<boolean> {
    await this.ensureConnected();

    const redisKey = this.dedupeKey(key);
    const effectiveTtl = Math.max(ttlMs ?? this.defaultTtlMs, MIN_TTL_MS);

    // SET NX PX - atomic "set if not exists" with TTL
    const result = await this.client.set(redisKey, "1", {
      NX: true,
      PX: effectiveTtl,
    });

    return result === "OK";
  }

  async release(key: string): Promise<void> {
    await this.ensureConnected();
    await this.client.del(this.dedupeKey(key));
  }

  async has(key: string): Promise<boolean> {
    await this.ensureConnected();
    const exists = await this.client.exists(this.dedupeKey(key));
    return exists > 0;
  }

  async clear(): Promise<void> {
    await this.ensureConnected();

    const pattern = `${this.prefix}:*`;
    for await (const key of this.client.scanIterator({ MATCH: pattern })) {
      await this.client.del(key);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  private dedupeKey(key: string): string {
    return `${this.prefix}:${key}`;
  }
}

let dedupeServicePromise: Promise<IDedupeService> | null = null;

/**
 * Creates a dedupe service based on configuration.
 * @param config - Dedupe configuration
 * @returns A promise that resolves to the configured dedupe service
 */
export async function createDedupeService(config: DedupeConfig): Promise<IDedupeService> {
  if (config.provider === "redis") {
    const redisUrl = config.redisUrl ?? process.env.DEDUPE_REDIS_URL ?? process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("Redis dedupe service requires a Redis URL to be configured");
    }
    const service = new RedisDedupeService(redisUrl, {
      defaultTtlMs: config.defaultTtlMs,
    });
    await service.connect();
    appLogger.info({ provider: "redis", subsystem: "dedupe-service" }, "dedupe service initialized");
    return service;
  }

  appLogger.info({ provider: "memory", subsystem: "dedupe-service" }, "dedupe service initialized");
  return new MemoryDedupeService();
}

/**
 * Gets the singleton dedupe service instance.
 * Creates and connects to the service on first call based on application configuration.
 * @returns A promise that resolves to the dedupe service
 */
export async function getDedupeService(): Promise<IDedupeService> {
  if (!dedupeServicePromise) {
    const config = loadConfig();
    dedupeServicePromise = createDedupeService(config.messaging.dedupe).catch((error) => {
      // Reset promise so next call retries
      dedupeServicePromise = null;
      throw error;
    });
  }
  return dedupeServicePromise;
}

/**
 * Resets the dedupe service singleton.
 * Useful for testing and graceful shutdown.
 */
export async function resetDedupeService(): Promise<void> {
  if (dedupeServicePromise) {
    try {
      const service = await dedupeServicePromise;
      if (service.disconnect) {
        await service.disconnect();
      }
    } catch {
      // Ignore errors during reset
    }
    dedupeServicePromise = null;
  }
}
