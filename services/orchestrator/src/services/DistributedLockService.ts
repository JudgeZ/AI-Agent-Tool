import { createClient, type RedisClientType } from "redis";
import { appLogger, normalizeError } from "../observability/logger.js";
import { randomUUID } from "node:crypto";

export class DistributedLockService {
  private readonly client: RedisClientType;
  private connected = false;

  constructor(redisUrl: string) {
    this.client = createClient({ url: redisUrl });
    this.client.on("error", (error) => {
      appLogger.warn({ err: normalizeError(error) }, "lock service redis error");
    });
  }

  async connect(): Promise<void> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
      this.connected = false;
    }
  }

  async acquireLock(resource: string, ttlMs: number, retryCount = 3, retryDelayMs = 100): Promise<() => Promise<void>> {
    await this.connect();
    const key = `lock:${resource}`;
    const token = randomUUID();

    for (let i = 0; i < retryCount; i++) {
      // NX: Set if Not Exists, PX: Expire in milliseconds
      const acquired = await this.client.set(key, token, { NX: true, PX: ttlMs });
      if (acquired) {
        return async () => {
          try {
            // Lua script to release lock only if token matches
            const script = `
              if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
              else
                return 0
              end
            `;
            await this.client.eval(script, { keys: [key], arguments: [token] });
          } catch (error) {
            appLogger.warn({ err: normalizeError(error), resource }, "failed to release lock");
          }
        };
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    throw new Error(`Failed to acquire lock for resource ${resource} after ${retryCount} attempts`);
  }
}

