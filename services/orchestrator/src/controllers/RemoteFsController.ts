import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { Response } from "express";

import type { AppConfig } from "../config.js";
import { createRequestIdentity, buildRateLimitBuckets } from "../http/requestIdentity.js";
import { enforceRateLimit } from "../http/rateLimit.js";
import {
  respondWithError,
  respondWithUnexpectedError,
  respondWithValidationError,
} from "../http/errors.js";
import {
  RemoteFsListQuerySchema,
  RemoteFsPathQuerySchema,
  RemoteFsWriteSchema,
  formatValidationIssues,
} from "../http/validation.js";
import {
  getRequestIds,
  resolveAuthFailure,
  toPlanSubject,
  toAuditSubject,
  buildAuthFailureAuditDetails,
} from "../http/helpers.js";
import type { ExtendedRequest } from "../http/types.js";
import { logAuditEvent } from "../observability/audit.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import type { RateLimitStore } from "../rateLimit/store.js";

export class RemoteFsController {
  private readonly root: string;

  constructor(
    private readonly config: AppConfig,
    private readonly rateLimiter: RateLimitStore,
  ) {
    this.root = this.realpathSafe(path.resolve(config.server.remoteFs.root));
  }

  async list(req: ExtendedRequest, res: Response): Promise<void> {
    const session = this.ensureSession(req, res, "remote_fs.list");
    if (session === null) return;

    if (!(await this.enforceRateLimit(req, res, session))) {
      return;
    }

    const parsed = RemoteFsListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      respondWithValidationError(res, formatValidationIssues(parsed.error.issues));
      return;
    }

    const normalizedPath = this.normalizeRemotePath(parsed.data.path);
    if (!this.isWithinDeclaredRoot(normalizedPath)) {
      this.respondOutsideRoot(res, normalizedPath);
      return;
    }
    const requestedLimit = parsed.data.limit;
    const cursor = parsed.data.cursor ?? null;
    const resolvedPath = await this.resolvePath(normalizedPath);

    if (!resolvedPath) {
      this.respondOutsideRoot(res, normalizedPath);
      return;
    }

    try {
      if (!(await this.ensurePathWithinRoot(resolvedPath))) {
        this.respondOutsideRoot(res, normalizedPath);
        return;
      }

      const stats = await fs.stat(resolvedPath);
      if (!stats.isDirectory()) {
        respondWithError(res, 400, {
          code: "invalid_request",
          message: "path must refer to a directory",
        });
        return;
      }

      const maxEntries = Math.max(1, this.config.server.remoteFs.maxListEntries);
      const limit = Math.min(requestedLimit ?? maxEntries, maxEntries);
      const listing = await this.listDirectoryEntries(resolvedPath, normalizedPath, limit, cursor);

      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "remote_fs.list",
        outcome: "allowed",
        requestId,
        traceId,
        subject: toAuditSubject(session),
        details: { path: normalizedPath },
      });

      res.json(listing);
    } catch (error) {
      this.handleFsError(res, error, "remote_fs.list", normalizedPath, session);
    }
  }

  private async listDirectoryEntries(
    resolvedPath: string,
    normalizedPath: string,
    limit: number,
    cursor: string | null,
  ) {
    const entries: { name: string; path: string; isDirectory: boolean }[] = [];
    let truncated = false;
    let nextCursor: string | undefined;
    const dir = await fs.opendir(resolvedPath, { bufferSize: 64 });

    try {
      while (true) {
        const entry = await dir.read();
        if (!entry) break;
        if (cursor && entry.name <= cursor) {
          continue;
        }

        entries.push({
          name: entry.name,
          path: this.normalizeRemotePath(path.posix.join(normalizedPath, entry.name)),
          isDirectory: entry.isDirectory(),
        });

        if (entries.length > limit) {
          truncated = true;
          entries.pop();
          break;
        }
      }
    } finally {
      await dir.close();
    }

    if (truncated && entries.length > 0) {
      nextCursor = entries.at(-1)?.name;
    }

    return { entries, truncated, nextCursor };
  }

  async read(req: ExtendedRequest, res: Response): Promise<void> {
    const session = this.ensureSession(req, res, "remote_fs.read");
    if (session === null) return;

    if (!(await this.enforceRateLimit(req, res, session))) {
      return;
    }

    const parsed = RemoteFsPathQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      respondWithValidationError(res, formatValidationIssues(parsed.error.issues));
      return;
    }

    const normalizedPath = this.normalizeRemotePath(parsed.data.path);
    if (!this.isWithinDeclaredRoot(normalizedPath)) {
      this.respondOutsideRoot(res, normalizedPath);
      return;
    }
    const resolvedPath = await this.resolvePath(normalizedPath);
    if (!resolvedPath) {
      this.respondOutsideRoot(res, normalizedPath);
      return;
    }

    try {
      if (!(await this.ensurePathWithinRoot(resolvedPath))) {
        this.respondOutsideRoot(res, normalizedPath);
        return;
      }

      const stats = await fs.stat(resolvedPath);
      if (!stats.isFile()) {
        respondWithError(res, 400, {
          code: "invalid_request",
          message: "path must refer to a file",
        });
        return;
      }

      const content = await fs.readFile(resolvedPath, "utf8");
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "remote_fs.read",
        outcome: "allowed",
        requestId,
        traceId,
        subject: toAuditSubject(session),
        details: { path: normalizedPath },
      });
      res.json({ content });
    } catch (error) {
      this.handleFsError(res, error, "remote_fs.read", normalizedPath, session);
    }
  }

  async write(req: ExtendedRequest, res: Response): Promise<void> {
    const session = this.ensureSession(req, res, "remote_fs.write");
    if (session === null) return;

    if (!(await this.enforceRateLimit(req, res, session))) {
      return;
    }

    const parsed = RemoteFsWriteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      respondWithValidationError(res, formatValidationIssues(parsed.error.issues));
      return;
    }

    const normalizedPath = this.normalizeRemotePath(parsed.data.path);
    if (!this.isWithinDeclaredRoot(normalizedPath)) {
      this.respondOutsideRoot(res, normalizedPath);
      return;
    }
    const resolvedPath = await this.resolvePath(normalizedPath);
    if (!resolvedPath) {
      this.respondOutsideRoot(res, normalizedPath);
      return;
    }

    const contentBytes = Buffer.byteLength(parsed.data.content, "utf8");
    if (contentBytes > this.config.server.remoteFs.maxWriteBytes) {
      respondWithError(res, 413, {
        code: "payload_too_large",
        message: "file content exceeds the configured limit",
        details: { limit: this.config.server.remoteFs.maxWriteBytes },
      });
      return;
    }

    try {
      const parentDir = path.dirname(resolvedPath);
      if (!(await this.ensurePathWithinRoot(parentDir))) {
        this.respondOutsideRoot(res, normalizedPath);
        return;
      }

      if (!(await this.ensurePathWithinRoot(resolvedPath))) {
        this.respondOutsideRoot(res, normalizedPath);
        return;
      }

      await fs.mkdir(parentDir, { recursive: true });
      // Defense-in-depth: revalidate after mkdir in case the path was replaced via symlink between checks.
      if (!(await this.ensurePathWithinRoot(resolvedPath))) {
        this.respondOutsideRoot(res, normalizedPath);
        return;
      }

      await fs.writeFile(resolvedPath, parsed.data.content, { encoding: "utf8" });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "remote_fs.write",
        outcome: "allowed",
        requestId,
        traceId,
        subject: toAuditSubject(session),
        details: { path: normalizedPath, bytes: contentBytes },
      });
      res.status(204).end();
    } catch (error) {
      this.handleFsError(res, error, "remote_fs.write", normalizedPath, session);
    }
  }

  private normalizeRemotePath(input: string): string {
    const sanitized = this.toPosixPath(input.trim());
    const absolute = sanitized.startsWith("/") ? sanitized : `/${sanitized}`;
    const normalized = path.posix.normalize(absolute);
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
  }

  private toRelativeRemotePath(remotePath: string): string {
    const normalizedRemote = this.normalizeRemotePath(remotePath);
    const normalizedRoot = this.normalizeRemotePath(this.config.server.remoteFs.root);
    const remoteSegments = normalizedRemote.split("/").filter(Boolean);

    if (normalizedRemote === normalizedRoot || normalizedRemote.startsWith(`${normalizedRoot}/`)) {
      return this.toPosixPath(path.posix.relative(normalizedRoot, normalizedRemote));
    }

    const virtualRootSegment = normalizedRoot.split("/").filter(Boolean).at(-1);
    const allowedVirtualRoots = new Set([virtualRootSegment, "workspace"].filter(Boolean));
    if (remoteSegments[0] && allowedVirtualRoots.has(remoteSegments[0])) {
      return remoteSegments.slice(1).join(path.sep);
    }

    return remoteSegments.join(path.sep);
  }

  private isWithinDeclaredRoot(normalizedPath: string): boolean {
    const normalizedRoot = this.normalizeRemotePath(this.config.server.remoteFs.root);
    const virtualRootSegment = normalizedRoot.split("/").filter(Boolean).at(-1);
    const allowedRoots = new Set<string>([normalizedRoot, "/workspace"]);

    if (virtualRootSegment) {
      allowedRoots.add(`/${virtualRootSegment}`);
    }

    for (const rootCandidate of allowedRoots) {
      if (normalizedPath === rootCandidate || normalizedPath.startsWith(`${rootCandidate}/`)) {
        return true;
      }
    }

    return false;
  }

  private toPosixPath(input: string): string {
    return input.replace(/\\/g, "/");
  }

  private async resolvePath(remotePath: string): Promise<string | null> {
    const relativeRemotePath = this.toRelativeRemotePath(remotePath);
    const candidate = path.resolve(this.root, relativeRemotePath);
    if (!this.isWithinRoot(candidate)) {
      return null;
    }

    if (candidate === this.root) {
      return this.root;
    }

    const parent = path.dirname(candidate);
    const parentResolution = await this.realpathExistingParent(parent);
    if (!parentResolution || !this.isWithinRoot(parentResolution.realpath)) {
      return null;
    }

    let realized = parentResolution.realpath;
    const remainingSegments = [...parentResolution.remaining, path.basename(candidate)];
    for (const segment of remainingSegments) {
      realized = path.resolve(realized, segment);
      if (!this.isWithinRoot(realized)) {
        return null;
      }
    }

    return realized;
  }

  private isWithinRoot(target: string): boolean {
    const relative = path.relative(this.root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private async realpathExistingParent(
    target: string,
  ): Promise<{ realpath: string; remaining: string[] } | null> {
    let current = target;
    const remaining: string[] = [];

    while (true) {
      try {
        const resolved = await fs.realpath(current);
        return { realpath: resolved, remaining: remaining.reverse() };
      } catch (error: unknown) {
        const normalized = normalizeError(error);
        if (normalized.code === "ENOENT") {
          const parent = path.dirname(current);
          remaining.push(path.basename(current));

          if (parent === current) {
            return null;
          }
          current = parent;
          continue;
        }
        return null;
      }
    }
  }

  private realpathSafe(target: string): string {
    try {
      return fsSync.realpathSync(target);
    } catch (error) {
      appLogger.fatal({ err: error, path: target }, "Failed to resolve a critical path. The path must exist.");
      throw new Error(`Failed to resolve critical path "${target}": ${(error as Error).message}`);
    }
  }

  private respondOutsideRoot(res: Response, pathAttempt: string): void {
    appLogger.warn({ path: pathAttempt, root: this.root }, "remote fs path outside root");
    respondWithError(res, 400, {
      code: "invalid_request",
      message: "path must stay within the configured workspace root",
    });
  }

  private async enforceRateLimit(
    req: ExtendedRequest,
    res: Response,
    session: NonNullable<ExtendedRequest["auth"]>["session"] | undefined,
  ): Promise<boolean> {
    const identity = createRequestIdentity(
      req,
      this.config,
      session ? toPlanSubject(session) : undefined,
    );
    const buckets = buildRateLimitBuckets("remote-fs", this.config.server.rateLimits.remoteFs);
    const decision = await enforceRateLimit(this.rateLimiter, "remote-fs", identity, buckets);
    if (!decision.allowed) {
      respondWithError(
        res,
        429,
        { code: "too_many_requests", message: "remote fs rate limit exceeded" },
        decision.retryAfterMs ? { retryAfterMs: decision.retryAfterMs } : undefined,
      );
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "remote_fs.rate_limit",
        outcome: "denied",
        requestId,
        traceId,
        subject: toAuditSubject(session),
      });
      return false;
    }
    return true;
  }

  private ensureSession(
    req: ExtendedRequest,
    res: Response,
    action: string,
  ): NonNullable<ExtendedRequest["auth"]>["session"] | undefined | null {
    const session = req.auth?.session;
    if (this.config.auth.oidc.enabled && !session) {
      const failure = resolveAuthFailure(req);
      respondWithError(res, failure.status, {
        code: failure.code,
        message: failure.message,
        details: failure.details,
      });
      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action,
        outcome: "denied",
        requestId,
        traceId,
        subject: toAuditSubject(session),
        details: buildAuthFailureAuditDetails(failure),
      });
      return null;
    }
    return session;
  }

  private async ensurePathWithinRoot(target: string): Promise<boolean> {
    try {
      const stats = await fs.lstat(target);
      if (stats.isSymbolicLink()) {
        const realTarget = await fs.realpath(target);
        return this.isWithinRoot(realTarget);
      }
      return this.isWithinRoot(target);
    } catch (error: unknown) {
      const normalized = normalizeError(error);
      if (normalized.code === "ENOENT") {
        return true;
      }
      throw error;
    }
  }

  private handleFsError(
    res: Response,
    error: unknown,
    action?: string,
    pathAttempt?: string,
    session?: NonNullable<ExtendedRequest["auth"]>["session"],
  ): void {
    const normalized = normalizeError(error);
    const { requestId, traceId } = getRequestIds(res);

    if (normalized.code === "ENOENT") {
      logAuditEvent({
        action: action ?? "remote_fs.error",
        outcome: "denied",
        requestId,
        traceId,
        subject: toAuditSubject(session),
        details: { path: pathAttempt, error: "not_found" },
      });
      respondWithError(res, 404, {
        code: "not_found",
        message: "path was not found",
      });
      return;
    }

    logAuditEvent({
      action: action ?? "remote_fs.error",
      outcome: "denied",
      requestId,
      traceId,
      subject: toAuditSubject(session),
      details: { path: pathAttempt, error: normalized.message },
    });
    respondWithUnexpectedError(res, error);
  }
}
