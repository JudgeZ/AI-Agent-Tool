import { createHash } from "node:crypto";
import path from "node:path";
import { createClient, type RedisClientType } from "redis";
import { z } from "zod";

import { isRoomBusy } from "../collaboration/index.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import { getDistributedLockService } from "./DistributedLockService.js";

type ReleaseFn = () => Promise<void>;

export interface FileLock {
  path: string;
  lockKey: string;
  release: ReleaseFn;
}

export type FileLockErrorCode = "busy" | "unavailable";

export class FileLockError extends Error {
  constructor(
    message: string,
    public readonly code: FileLockErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class FileLockManager {
  private readonly lockService = getDistributedLockService();
  private readonly redis: RedisClientType;
  private readonly activeLocks = new Map<string, Map<string, FileLock>>();
  private readonly lockHistory = new Map<string, Set<string>>();

  private readonly historySchema = z.array(z.string());

  constructor(redisUrl?: string) {
    this.redis = createClient({ url: redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379" });
    this.redis.on("error", (err) => {
      appLogger.warn({ err: normalizeError(err) }, "file lock redis error");
    });
  }

  async connect(): Promise<void> {
    if (this.redis.isOpen) return;
    try {
      await this.redis.connect();
    } catch (error) {
      throw new FileLockError("Lock service unavailable", "unavailable", { err: normalizeError(error) });
    }
  }

  private normalizePath(target: string): string {
    const normalized = path.posix.normalize(target.replace(/\\/g, "/"));
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }

  private sessionHistoryKey(sessionId: string): string {
    return `session:locks:${sessionId}`;
  }

  private async persistHistory(sessionId: string): Promise<void> {
    try {
      await this.connect();
      const history = Array.from(this.lockHistory.get(sessionId) ?? []);
      await this.redis.set(this.sessionHistoryKey(sessionId), JSON.stringify(history));
    } catch (error) {
      appLogger.warn(
        { err: normalizeError(error), sessionId },
        "failed to persist file lock history",
      );
    }
  }

  private rememberLock(sessionId: string, normalizedPath: string, lock: FileLock): void {
    if (!this.activeLocks.has(sessionId)) {
      this.activeLocks.set(sessionId, new Map());
    }
    this.activeLocks.get(sessionId)!.set(normalizedPath, lock);

    if (!this.lockHistory.has(sessionId)) {
      this.lockHistory.set(sessionId, new Set());
    }
    this.lockHistory.get(sessionId)!.add(normalizedPath);
  }

  async acquireLock(sessionId: string, filePath: string, agentId?: string): Promise<FileLock> {
    const normalizedPath = this.normalizePath(filePath);

    const roomId = this.buildRoomId(normalizedPath);
    if (isRoomBusy(roomId)) {
      throw new FileLockError(`File is busy: ${normalizedPath}`, "busy", {
        path: normalizedPath,
        reason: "room_busy",
      });
    }

    const lockKey = `file:${normalizedPath}`;
    try {
      await this.connect();
      const release = await this.lockService.acquireLock(lockKey, 30_000);
      const trackedRelease = this.wrapRelease(sessionId, normalizedPath, release);
      const fileLock: FileLock = { path: normalizedPath, lockKey, release: trackedRelease };
      this.rememberLock(sessionId, normalizedPath, fileLock);
      await this.persistHistory(sessionId);
      return fileLock;
    } catch (error) {
      if (error instanceof FileLockError) {
        throw error;
      }
      appLogger.warn(
        { err: normalizeError(error), path: normalizedPath, sessionId, agentId },
        "failed to acquire file lock",
      );
      throw new FileLockError(`Failed to acquire lock for ${normalizedPath}`, "unavailable", {
        path: normalizedPath,
        reason: "lock_acquisition_failed",
      });
    }
  }

  async releaseSessionLocks(sessionId: string): Promise<void> {
    const locks = this.activeLocks.get(sessionId);
    if (!locks) return;

    const releasePromises = Array.from(locks.entries()).map(async ([pathKey, lock]) => {
      try {
        await lock.release();
      } catch (error) {
        appLogger.warn(
          { err: normalizeError(error), sessionId, path: pathKey },
          "failed to release file lock",
        );
      }
    });
    await Promise.all(releasePromises);

    this.activeLocks.delete(sessionId);
    const history = this.lockHistory.get(sessionId);
    if (history) {
      history.clear();
    }
    await this.persistHistory(sessionId);
  }

  async restoreSessionLocks(sessionId: string): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      appLogger.warn({ err: normalizeError(error), sessionId }, "failed to connect for lock restore");
      return;
    }

    let raw: string | null = null;
    try {
      raw = await this.redis.get(this.sessionHistoryKey(sessionId));
    } catch (error) {
      appLogger.warn({ err: normalizeError(error), sessionId }, "failed to read lock history");
      return;
    }

    if (!raw) return;

    let paths: string[] = [];
    try {
      paths = this.historySchema.parse(JSON.parse(raw));
    } catch (error) {
      appLogger.warn({ err: normalizeError(error), sessionId }, "invalid session lock history");
      return;
    }

    for (const storedPath of paths) {
      try {
        await this.acquireLockWithoutPersist(sessionId, storedPath);
      } catch (error) {
        appLogger.warn(
          { err: normalizeError(error), sessionId, path: storedPath },
          "failed to restore file lock",
        );
      }
    }
  }

  async close(): Promise<void> {
    if (this.redis.isOpen) {
      await this.redis.quit();
    }
  }

  private buildRoomId(normalizedPath: string): string {
    return createHash("sha256").update(normalizedPath).digest("hex");
  }

  private wrapRelease(sessionId: string, normalizedPath: string, release: ReleaseFn): ReleaseFn {
    return async () => {
      try {
        await release();
      } finally {
        const locks = this.activeLocks.get(sessionId);
        locks?.delete(normalizedPath);
        const history = this.lockHistory.get(sessionId);
        history?.delete(normalizedPath);
        await this.persistHistory(sessionId);
      }
    };
  }

  private async acquireLockWithoutPersist(sessionId: string, filePath: string): Promise<FileLock> {
    const normalizedPath = this.normalizePath(filePath);
    const roomId = this.buildRoomId(normalizedPath);
    if (isRoomBusy(roomId)) {
      throw new FileLockError(`File is busy: ${normalizedPath}`, "busy", {
        path: normalizedPath,
        reason: "room_busy",
      });
    }

    const lockKey = `file:${normalizedPath}`;
    const release = await this.lockService.acquireLock(lockKey, 30_000);
    const trackedRelease = this.wrapRelease(sessionId, normalizedPath, release);
    const fileLock: FileLock = { path: normalizedPath, lockKey, release: trackedRelease };
    this.rememberLock(sessionId, normalizedPath, fileLock);
    return fileLock;
  }
}

export const fileLockManager = new FileLockManager();
