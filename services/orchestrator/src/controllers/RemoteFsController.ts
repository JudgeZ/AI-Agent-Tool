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

    const parsed = RemoteFsPathQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      respondWithValidationError(res, formatValidationIssues(parsed.error.issues));
      return;
    }

    const normalizedPath = this.normalizeRemotePath(parsed.data.path);
    const resolvedPath = await this.resolvePath(normalizedPath);

    if (!resolvedPath) {
      this.respondOutsideRoot(res, normalizedPath);
      return;
    }

    try {
      const stats = await fs.stat(resolvedPath);
      if (!stats.isDirectory()) {
        respondWithError(res, 400, {
          code: "invalid_request",
          message: "path must refer to a directory",
        });
        return;
      }

      const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
      const payload = entries.map((entry) => ({
        name: entry.name,
        path: this.normalizeRemotePath(path.posix.join(normalizedPath, entry.name)),
        isDirectory: entry.isDirectory(),
      }));

      const { requestId, traceId } = getRequestIds(res);
      logAuditEvent({
        action: "remote_fs.list",
        outcome: "allowed",
        requestId,
        traceId,
        subject: toAuditSubject(session),
        details: { path: normalizedPath },
      });

      res.json({ entries: payload });
    } catch (error) {
      this.handleFsError(res, error);
    }
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
    const resolvedPath = await this.resolvePath(normalizedPath);
    if (!resolvedPath) {
      this.respondOutsideRoot(res, normalizedPath);
      return;
    }

    try {
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
      this.handleFsError(res, error);
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
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
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
      this.handleFsError(res, error);
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
    const remoteSegments = normalizedRemote.split("/").filter(Boolean);
    const rootSegments = this.toPosixPath(this.root).split("/").filter(Boolean);

    let offset = 0;
    while (offset < rootSegments.length && remoteSegments[offset] === rootSegments[offset]) {
      offset += 1;
    }

    const relativeSegments = remoteSegments.slice(offset);
    return relativeSegments.join(path.sep);
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

    const parent = path.dirname(candidate);
    const realizedParent = await this.realpathExistingParent(parent);
    if (!realizedParent || !this.isWithinRoot(realizedParent)) {
      return null;
    }

    const realized = path.resolve(realizedParent, path.basename(candidate));
    if (!this.isWithinRoot(realized)) {
      return null;
    }

    return realized;
  }

  private isWithinRoot(target: string): boolean {
    const relative = path.relative(this.root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private async realpathExistingParent(target: string): Promise<string | null> {
    let current = target;

    while (true) {
      try {
        return await fs.realpath(current);
      } catch (error: any) {
        if (error?.code === "ENOENT") {
          const parent = path.dirname(current);
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
    } catch {
      return target;
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

  private handleFsError(res: Response, error: unknown): void {
    const normalized = normalizeError(error);
    if (normalized.code === "ENOENT") {
      respondWithError(res, 404, {
        code: "not_found",
        message: "path was not found",
      });
      return;
    }
    respondWithUnexpectedError(res, error);
  }
}
