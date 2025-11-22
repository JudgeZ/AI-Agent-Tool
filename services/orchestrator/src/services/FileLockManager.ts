import { createHash } from "node:crypto";
import path from "node:path";
import type { RedisClientType } from "redis";
import { z } from "zod";

import { isRoomBusy } from "../collaboration/index.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import { getRequestContext } from "../observability/requestContext.js";
import { startSpan, type Span } from "../observability/tracing.js";
import { getDistributedLockService, LockAcquisitionError } from "./DistributedLockService.js";
import { PerSessionRateLimiter } from "./RateLimiter.js";

type ReleaseFn = () => Promise<void>;

export interface FileLock {
  path: string;
  lockKey: string;
  release: ReleaseFn;
}

export type FileLockErrorCode = "busy" | "unavailable" | "rate_limited";

type TraceContext = { traceId?: string; requestId?: string; spanId?: string };

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
  private readonly lockServicePromise: Promise<Awaited<ReturnType<typeof getDistributedLockService>>>;
  private readonly redisClientPromise: Promise<RedisClientType>;
  private readonly lockTtlMs: number;
  private readonly sessionHistoryTtlSeconds: number | null;
  private readonly lockRateLimiter: PerSessionRateLimiter;
  private readonly activeLocks = new Map<string, Map<string, FileLock>>();
  private readonly lockHistory = new Map<string, Set<string>>();

  private readonly historySchema = z.array(z.string());

  private static readonly MAX_LOCK_TTL_MS = 300_000;

  constructor(
    redisUrl?: string,
    lockTtlMs = Number(process.env.LOCK_TTL_MS ?? 30_000),
    sessionHistoryTtlSeconds = Number(process.env.LOCK_HISTORY_TTL_SEC ?? 0),
    lockRateLimit = Number(process.env.LOCK_RATE_LIMIT_PER_MIN ?? 60),
    lockRateWindowMs = Number(process.env.LOCK_RATE_LIMIT_WINDOW_MS ?? 60_000),
  ) {
    this.lockServicePromise = getDistributedLockService(redisUrl);
    const normalizedTtl = Number.isFinite(lockTtlMs) && lockTtlMs > 0 ? lockTtlMs : 30_000;
    this.lockTtlMs = Math.min(normalizedTtl, FileLockManager.MAX_LOCK_TTL_MS);
    if (this.lockTtlMs < normalizedTtl) {
      appLogger.warn({ requestedTtlMs: lockTtlMs, appliedTtlMs: this.lockTtlMs }, "lock TTL capped to safe maximum");
    }
    this.sessionHistoryTtlSeconds =
      Number.isFinite(sessionHistoryTtlSeconds) && sessionHistoryTtlSeconds > 0
        ? sessionHistoryTtlSeconds
        : null;
    const limit = Number.isFinite(lockRateLimit) && lockRateLimit > 0 ? lockRateLimit : 60;
    const windowMs = Number.isFinite(lockRateWindowMs) && lockRateWindowMs > 0 ? lockRateWindowMs : 60_000;
    this.lockRateLimiter = new PerSessionRateLimiter(limit, windowMs);
    this.redisClientPromise = this.lockServicePromise.then(async (service) => {
      await service.connect();
      const client = service.getClient();
      client.on("error", (err) => {
        appLogger.warn({ err: normalizeError(err) }, "file lock redis error");
      });
      return client;
    });
  }

  async connect(): Promise<void> {
    const redis = await this.redisClientPromise;
    if (redis.isOpen) return;
    try {
      await redis.connect();
    } catch (error) {
      throw new FileLockError("Lock service unavailable", "unavailable", { err: normalizeError(error) });
    }
  }

  private normalizePath(target: string): string {
    const normalized = path.posix.normalize(target.replace(/\\/g, "/"));
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }

  private sanitizeSessionId(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new FileLockError("Invalid session id", "busy", { reason: "invalid_session_id" });
    }
    return sessionId;
  }

  private sessionHistoryKey(sessionId: string): string {
    return `session:locks:${this.sanitizeSessionId(sessionId)}`;
  }

  private enforceRateLimit(sessionId: string): void {
    const result = this.lockRateLimiter.check(sessionId);
    if (!result.allowed) {
      throw new FileLockError("Session lock rate limit exceeded", "rate_limited", {
        sessionId,
        windowMs: result.windowMs,
        limit: result.limit,
      });
    }
  }

  private async persistHistory(sessionId: string, throwOnError = false): Promise<void> {
    try {
      await this.connect();
      const history = Array.from(this.lockHistory.get(sessionId) ?? []);
      const redis = await this.redisClientPromise;
      if (this.sessionHistoryTtlSeconds) {
        await redis.set(this.sessionHistoryKey(sessionId), JSON.stringify(history), {
          EX: this.sessionHistoryTtlSeconds,
        });
        return;
      }

      await redis.set(this.sessionHistoryKey(sessionId), JSON.stringify(history));
    } catch (error) {
      appLogger.warn(
        { err: normalizeError(error), sessionId },
        "failed to persist file lock history",
      );
      if (throwOnError) {
        throw new FileLockError("Failed to persist lock history", "unavailable", { sessionId });
      }
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

  async acquireLock(
    sessionId: string,
    filePath: string,
    agentId?: string,
    traceContext?: TraceContext,
  ): Promise<FileLock> {
    this.sanitizeSessionId(sessionId);
    this.enforceRateLimit(sessionId);
    const normalizedPath = this.normalizePath(filePath);

    const roomId = this.buildRoomId(normalizedPath);
    if (isRoomBusy(roomId)) {
      throw new FileLockError(`File is busy: ${normalizedPath}`, "busy", {
        path: normalizedPath,
        reason: "room_busy",
      });
    }

    const lockKey = `file:${normalizedPath}`;
    return this.withLockSpan(
      "file_lock.acquire",
      { path: normalizedPath, sessionId, agentId },
      traceContext,
      async (span, mergedTrace) => {
        try {
          await this.connect();
          const lockService = await this.lockServicePromise;
          const release = await lockService.acquireLock(lockKey, this.lockTtlMs, undefined, undefined, mergedTrace);
          span.setAttribute("lock.ttl_ms", this.lockTtlMs);
          const trackedRelease = this.wrapRelease(sessionId, normalizedPath, release);
          const fileLock: FileLock = { path: normalizedPath, lockKey, release: trackedRelease };
          this.rememberLock(sessionId, normalizedPath, fileLock);
          try {
            await this.persistHistory(sessionId, true);
          } catch (error) {
            await trackedRelease().catch((releaseError) => {
              appLogger.warn(
                { err: normalizeError(releaseError), path: normalizedPath, sessionId, ...mergedTrace },
                "failed to roll back lock",
              );
            });
            throw error;
          }
          return fileLock;
        } catch (error) {
          if (error instanceof FileLockError) {
            throw error;
          }
          if (error instanceof LockAcquisitionError) {
            throw new FileLockError(`File is busy: ${normalizedPath}`, "busy", {
              path: normalizedPath,
              reason: error.code === "busy" ? "lock_contended" : "lock_timeout",
            });
          }
          appLogger.warn(
            { err: normalizeError(error), path: normalizedPath, sessionId, agentId, ...mergedTrace },
            "failed to acquire file lock",
          );
          throw new FileLockError(`Failed to acquire lock for ${normalizedPath}`, "unavailable", {
            path: normalizedPath,
            reason: "lock_acquisition_failed",
          });
        }
      },
    );
  }

  async releaseSessionLocks(sessionId: string): Promise<void> {
    this.sanitizeSessionId(sessionId);
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
      this.lockHistory.delete(sessionId);
    }
    await this.persistHistory(sessionId);
    this.lockRateLimiter.reset(sessionId);
  }

  async restoreSessionLocks(sessionId: string): Promise<void> {
    this.sanitizeSessionId(sessionId);
    try {
      await this.connect();
    } catch (error) {
      appLogger.warn({ err: normalizeError(error), sessionId }, "failed to connect for lock restore");
      return;
    }

    let raw: string | null = null;
    try {
      const redis = await this.redisClientPromise;
      raw = await redis.get(this.sessionHistoryKey(sessionId));
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
    const redis = await this.redisClientPromise;
    if (redis.isOpen) {
      await redis.quit();
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
        if (locks && locks.size === 0) {
          this.activeLocks.delete(sessionId);
        }
        const history = this.lockHistory.get(sessionId);
        history?.delete(normalizedPath);
        if (history && history.size === 0) {
          this.lockHistory.delete(sessionId);
        }
        await this.persistHistory(sessionId);
      }
    };
  }

  private async acquireLockWithoutPersist(
    sessionId: string,
    filePath: string,
    traceContext?: TraceContext,
  ): Promise<FileLock> {
    this.sanitizeSessionId(sessionId);
    this.enforceRateLimit(sessionId);
    const normalizedPath = this.normalizePath(filePath);
    const roomId = this.buildRoomId(normalizedPath);
    if (isRoomBusy(roomId)) {
      throw new FileLockError(`File is busy: ${normalizedPath}`, "busy", {
        path: normalizedPath,
        reason: "room_busy",
      });
    }

    const lockKey = `file:${normalizedPath}`;
    return this.withLockSpan(
      "file_lock.restore",
      { path: normalizedPath, sessionId },
      traceContext,
      async (_span, mergedTrace) => {
        try {
          await this.connect();
          const lockService = await this.lockServicePromise;
          const release = await lockService.acquireLock(lockKey, this.lockTtlMs, undefined, undefined, mergedTrace);
          const trackedRelease = this.wrapRelease(sessionId, normalizedPath, release);
          const fileLock: FileLock = { path: normalizedPath, lockKey, release: trackedRelease };
          this.rememberLock(sessionId, normalizedPath, fileLock);
          return fileLock;
        } catch (error) {
          if (error instanceof FileLockError) {
            throw error;
          }
          if (error instanceof LockAcquisitionError) {
            throw new FileLockError(`File is busy: ${normalizedPath}`, "busy", {
              path: normalizedPath,
              reason: error.code === "busy" ? "lock_contended" : "lock_timeout",
            });
          }
          appLogger.warn(
            { err: normalizeError(error), path: normalizedPath, sessionId, ...mergedTrace },
            "failed to acquire file lock during restore",
          );
          throw new FileLockError(`Failed to acquire lock for ${normalizedPath}`, "unavailable", {
            path: normalizedPath,
            reason: "lock_acquisition_failed",
          });
        }
      },
    );
  }

  private buildTraceContext(span: Span | null, provided?: TraceContext): TraceContext {
    const requestContext = getRequestContext();
    return {
      traceId: span?.context.traceId ?? provided?.traceId ?? requestContext?.traceId,
      spanId: span?.context.spanId ?? provided?.spanId,
      requestId: provided?.requestId ?? requestContext?.requestId,
    };
  }

  private async withLockSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    traceContext: TraceContext | undefined,
    fn: (span: Span, mergedTrace: TraceContext) => Promise<T>,
  ): Promise<T> {
    const span = startSpan(name, attributes);
    const mergedTrace = this.buildTraceContext(span, traceContext);

    try {
      return await fn(span, mergedTrace);
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  }
}

export const fileLockManager = new FileLockManager();
