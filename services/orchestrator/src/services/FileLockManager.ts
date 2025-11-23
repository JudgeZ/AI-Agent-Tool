import { createHash } from "node:crypto";
import path from "node:path";
import type { RedisClientType } from "redis";
import { z } from "zod";

import { isRoomBusy } from "../collaboration/index.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import {
  recordFileLockAttempt,
  recordFileLockRateLimit,
  recordFileLockRelease,
} from "../observability/metrics.js";
import { getRequestContext } from "../observability/requestContext.js";
import { startSpan, type Span } from "../observability/tracing.js";
import { getDistributedLockService, LockAcquisitionError } from "./DistributedLockService.js";
import { PerSessionRateLimiter, type RateLimitResult } from "./RateLimiter.js";

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
  private static readonly RESTORE_LOCK_TIMEOUT_MS = 5_000;
  private static readonly RESTORE_BACKOFF_MS = 100;

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
    this.lockRateLimiter = new PerSessionRateLimiter(limit, windowMs, {
      prefix: "orchestrator:file-locks",
    });
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
    const MAX_SESSION_ID_LENGTH = 128;
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || sessionId.length > MAX_SESSION_ID_LENGTH) {
      throw new FileLockError("Invalid session id", "busy", { reason: "invalid_session_id" });
    }
    return sessionId;
  }

  private sessionHistoryKey(sessionId: string): string {
    return `session:locks:${this.sanitizeSessionId(sessionId)}`;
  }

  private async enforceRateLimit(sessionId: string, operation: "acquire" | "restore"): Promise<void> {
    const result = await this.lockRateLimiter.check(sessionId);
    this.recordRateLimit(result);
    if (!result.allowed) {
      throw new FileLockError("Session lock rate limit exceeded", "rate_limited", {
        sessionId,
        windowMs: result.windowMs,
        limit: result.limit,
        retryAfterMs: result.retryAfterMs,
        operation,
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
    const startedAt = Date.now();
    try {
      await this.enforceRateLimit(sessionId, "acquire");
      const normalizedPath = this.normalizePath(filePath);

      const roomId = this.buildRoomId(normalizedPath);
      if (isRoomBusy(roomId)) {
        throw new FileLockError(`File is busy: ${normalizedPath}`, "busy", {
          path: normalizedPath,
          reason: "room_busy",
        });
      }

      const lockKey = `file:${normalizedPath}`;
      const fileLock = await this.withLockSpan(
        "file_lock.acquire",
        { path: normalizedPath, sessionId, agentId },
        traceContext,
        async (span, mergedTrace) => {
          try {
            await this.connect();
            const lockService = await this.lockServicePromise;
            const release = await lockService.acquireLock(lockKey, this.lockTtlMs, undefined, undefined, mergedTrace);
            span.setAttribute("lock.ttl_ms", this.lockTtlMs);
            const trackedRelease = this.wrapRelease(sessionId, normalizedPath, release, mergedTrace);
            const fileLock: FileLock = { path: normalizedPath, lockKey, release: trackedRelease };
            this.rememberLock(sessionId, normalizedPath, fileLock);
            try {
              await this.persistHistory(sessionId, true);
              appLogger.info(
                { path: normalizedPath, sessionId, agentId, ...mergedTrace },
                "file lock acquired",
              );
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
      this.recordLockAttempt("acquire", "success", startedAt);
      return fileLock;
    } catch (error) {
      this.recordLockAttempt("acquire", this.outcomeForError(error), startedAt);
      throw error;
    }
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
    await this.lockRateLimiter.reset(sessionId);
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
        await this.withTimeout(
          this.acquireLockWithoutPersist(sessionId, storedPath),
          FileLockManager.RESTORE_LOCK_TIMEOUT_MS,
        );
      } catch (error) {
        appLogger.warn(
          { err: normalizeError(error), sessionId, path: storedPath },
          "failed to restore file lock",
        );
        await this.delay(FileLockManager.RESTORE_BACKOFF_MS);
      }
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new FileLockError("Timed out restoring lock", "unavailable", { reason: "restore_timeout" }));
      }, timeoutMs);

      promise
        .then((result) => resolve(result))
        .catch(reject)
        .finally(() => {
          clearTimeout(timer);
        });
    });
  }

  private delay(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
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

  private wrapRelease(
    sessionId: string,
    normalizedPath: string,
    release: ReleaseFn,
    traceContext?: TraceContext,
  ): ReleaseFn {
    return async () => {
      let outcome: "success" | "error" = "success";
      try {
        await release();
      } catch (error) {
        outcome = "error";
        throw error;
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
        appLogger.info(
          { path: normalizedPath, sessionId, ...traceContext },
          "file lock released",
        );
        recordFileLockRelease(outcome);
      }
    };
  }

  private async acquireLockWithoutPersist(
    sessionId: string,
    filePath: string,
    traceContext?: TraceContext,
  ): Promise<FileLock> {
    this.sanitizeSessionId(sessionId);
    const startedAt = Date.now();
    try {
      await this.enforceRateLimit(sessionId, "restore");
    } catch (error) {
      this.recordLockAttempt("restore", this.outcomeForError(error), startedAt);
      throw error;
    }
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
          const trackedRelease = this.wrapRelease(sessionId, normalizedPath, release, mergedTrace);
          const fileLock: FileLock = { path: normalizedPath, lockKey, release: trackedRelease };
          this.rememberLock(sessionId, normalizedPath, fileLock);
          this.recordLockAttempt("restore", "success", startedAt);
          return fileLock;
        } catch (error) {
          if (error instanceof FileLockError) {
            this.recordLockAttempt("restore", this.outcomeForError(error), startedAt);
            throw error;
          }
          if (error instanceof LockAcquisitionError) {
            const wrappedError = new FileLockError(`File is busy: ${normalizedPath}`, "busy", {
              path: normalizedPath,
              reason: error.code === "busy" ? "lock_contended" : "lock_timeout",
            });
            this.recordLockAttempt("restore", "busy", startedAt);
            throw wrappedError;
          }
          appLogger.warn(
            { err: normalizeError(error), path: normalizedPath, sessionId, ...mergedTrace },
            "failed to acquire file lock during restore",
          );
          const wrappedError = new FileLockError(`Failed to acquire lock for ${normalizedPath}`, "unavailable", {
            path: normalizedPath,
            reason: "lock_acquisition_failed",
          });
          this.recordLockAttempt("restore", "error", startedAt);
          throw wrappedError;
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

  private recordRateLimit(result: RateLimitResult): void {
    recordFileLockRateLimit(result.allowed ? "allowed" : "blocked");
  }

  private recordLockAttempt(
    operation: "acquire" | "restore",
    outcome: "success" | "busy" | "error" | "rate_limited",
    startedAt: number,
  ): void {
    recordFileLockAttempt(operation, outcome, Date.now() - startedAt);
  }

  private outcomeForError(error: unknown): "success" | "busy" | "error" | "rate_limited" {
    if (error instanceof FileLockError) {
      if (error.code === "busy") return "busy";
      if (error.code === "rate_limited") return "rate_limited";
    }
    return "error";
  }
}

export const fileLockManager = new FileLockManager();
