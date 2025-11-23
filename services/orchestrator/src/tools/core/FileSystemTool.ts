import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { applyAgentEditToRoom } from "../../collaboration/index.js";
import { appLogger, normalizeError } from "../../observability/logger.js";
import { startSpan } from "../../observability/tracing.js";
import { FileLockError, fileLockManager } from "../../services/FileLockManager.js";
import { PerSessionRateLimiter } from "../../services/RateLimiter.js";
import { SandboxCapabilities, SandboxType } from "../../sandbox/index.js";
import { McpTool, ToolCapability, type ToolContext, type ToolMetadata, type ToolResult } from "../McpTool";

interface FileSystemToolConfig {
  projectRoot: string;
  criticalPatterns?: RegExp[];
}

interface FileSystemToolInput {
  path: string;
  action: "read" | "write" | "delete";
  content?: string;
  requiresReview?: boolean;
  sessionId?: string;
  agentId?: string;
}

export class FileSystemTool extends McpTool<FileSystemToolInput, any> {
  private readonly config: FileSystemToolConfig;
  private readonly realProjectRoot: string;
  private readonly operationRateLimiter: PerSessionRateLimiter;

  constructor(logger: any, config: Partial<FileSystemToolConfig> = {}) {
    const metadata: ToolMetadata = {
      id: "filesystem",
      name: "File System Tool",
      description: "Read and write files inside the project workspace",
      version: "0.1.0",
      author: "AI-Agent-Tool",
      capabilities: [ToolCapability.READ_FILES, ToolCapability.WRITE_FILES],
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          action: { type: "string", enum: ["read", "write", "delete"] },
          content: { type: "string" },
          requiresReview: { type: "boolean" },
          sessionId: { type: "string" },
          agentId: { type: "string" },
        },
        required: ["path", "action"],
        additionalProperties: false,
      },
      requiresApproval: false,
      sandboxType: SandboxType.CONTAINER,
      sandboxCapabilities: { filesystem: true } as SandboxCapabilities,
      tags: ["filesystem"],
    };
    super(metadata, logger);
    this.config = {
      projectRoot: config.projectRoot ?? process.cwd(),
      criticalPatterns:
        config.criticalPatterns ?? [/package-lock\.json$/i, /yarn\.lock$/i, /\.env/i],
    };
    this.realProjectRoot = fsSync.realpathSync(this.config.projectRoot);
    const opLimit = Number.isFinite(Number(process.env.FILESYSTEM_RATE_LIMIT_PER_MIN))
      ? Number(process.env.FILESYSTEM_RATE_LIMIT_PER_MIN)
      : 120;
    const opWindow = Number.isFinite(Number(process.env.FILESYSTEM_RATE_LIMIT_WINDOW_MS))
      ? Number(process.env.FILESYSTEM_RATE_LIMIT_WINDOW_MS)
      : 60_000;
    this.operationRateLimiter = new PerSessionRateLimiter(
      opLimit > 0 ? opLimit : 120,
      opWindow > 0 ? opWindow : 60_000,
    );
  }

  private resolvePath(target: string): string {
    const resolved = path.resolve(this.realProjectRoot, target);
    const normalizedRoot = this.realProjectRoot;
    const relative = path.relative(normalizedRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path ${target} escapes project root`);
    }

    const realAncestor = this.realpathNearestAncestor(resolved);
    const realRelative = path.relative(normalizedRoot, realAncestor);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error(`Path ${target} escapes project root`);
    }
    return resolved;
  }

  private realpathNearestAncestor(target: string): string {
    let current = target;
    while (!fsSync.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    try {
      return fsSync.realpathSync(current);
    } catch {
      return current;
    }
  }

  private isCritical(target: string): boolean {
    return this.config.criticalPatterns?.some((pattern) => pattern.test(target)) ?? false;
  }

  private roomIdForPath(resolvedPath: string): string {
    return createHash("sha256").update(resolvedPath).digest("hex");
  }

  private async enforceOperationLimit(sessionId: string): Promise<void> {
    const result = await this.operationRateLimiter.check(sessionId);
    if (!result.allowed) {
      throw new FileLockError("Filesystem operation rate limit exceeded", "rate_limited", {
        sessionId,
        limit: result.limit,
        windowMs: result.windowMs,
        retryAfterMs: result.retryAfterMs,
      });
    }
  }

  async execute(input: FileSystemToolInput, context: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    await this.validateInput(input);
    const logs: string[] = [];

    let lock: { release: () => Promise<void> } | undefined;
    let span: ReturnType<typeof startSpan> | undefined;
    try {
      const resolvedPath = this.resolvePath(input.path);
      const sessionId = input.sessionId ?? context.requestId ?? "anonymous-session";
      await this.enforceOperationLimit(sessionId);
      const roomId = this.roomIdForPath(resolvedPath);
      span = startSpan("filesystem.tool", {
        path: resolvedPath,
        action: input.action,
        sessionId,
        agentId: input.agentId,
        requestId: context.requestId,
      });
      const auditContext = {
        sessionId,
        agentId: input.agentId,
        requestId: context.requestId,
        traceId: span.context.traceId ?? context.requestId,
        spanId: span.context.spanId,
        path: resolvedPath,
        action: input.action,
      };
      const traceContext = {
        traceId: span.context.traceId ?? context.requestId,
        requestId: context.requestId,
        spanId: span.context.spanId,
      };

      if (input.action === "read") {
        lock = await fileLockManager.acquireLock(sessionId, resolvedPath, input.agentId, traceContext);
        try {
          const content = await fs.readFile(resolvedPath, "utf-8");
          appLogger.info({ ...auditContext }, "filesystem read completed");
          span.addEvent("filesystem.read.complete");
          return {
            success: true,
            data: { path: resolvedPath, content },
            duration: Date.now() - started,
          };
        } finally {
          await lock.release().catch((releaseError) => {
            appLogger.warn({ err: normalizeError(releaseError) }, "failed to release filesystem lock");
          });
          lock = undefined;
        }
      }

      lock = await fileLockManager.acquireLock(sessionId, resolvedPath, input.agentId, traceContext);
      let approved = true;

      const requiresReview = input.requiresReview || this.isCritical(resolvedPath);
      if (requiresReview) {
        const before = await fs.readFile(resolvedPath, "utf-8").catch(() => "");
        const diffSummary = this.describeChange(before, input.content ?? "");
        if (context.requestApproval) {
          approved = await context.requestApproval("filesystem_change", { path: resolvedPath, diff: diffSummary });
        } else {
          approved = false;
        }

        if (!approved) {
          await lock.release().catch((releaseError) => {
            appLogger.warn({ err: normalizeError(releaseError), ...auditContext }, "failed to release filesystem lock");
          });
          lock = undefined;
          appLogger.info({ ...auditContext, requiresReview, approved }, "filesystem change rejected");
          return {
            success: false,
            error: "Change requires approval and was not approved",
            duration: Date.now() - started,
          };
        }
      }

      if (input.action === "delete") {
        await fs.rm(resolvedPath, { force: true });
      } else {
        await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
        const content = input.content ?? "";
        applyAgentEditToRoom(roomId, resolvedPath, content);
        await fs.writeFile(resolvedPath, content, "utf-8");
      }

      appLogger.info({ ...auditContext, requiresReview, approved }, "filesystem operation completed");
      span.addEvent("filesystem.write.complete", { requiresReview, approved });

      return {
        success: true,
        data: { path: resolvedPath, action: input.action },
        duration: Date.now() - started,
        logs,
      };
    } catch (error) {
      const normalizedError = normalizeError(error);
      logs.push(JSON.stringify(normalizedError));
      if (error instanceof Error) {
        span?.recordException(error);
      }
      if (error instanceof FileLockError && error.code === "busy") {
        return {
          success: false,
          error: `File busy: ${error.message}`,
          duration: Date.now() - started,
          logs,
          metadata: { reason: error.details },
        };
      } else if (error instanceof FileLockError && error.code === "rate_limited") {
        return {
          success: false,
          error: `Rate limit exceeded: ${error.message}`,
          duration: Date.now() - started,
          logs,
          metadata: { reason: error.details },
        };
      } else if (error instanceof FileLockError && error.code === "unavailable") {
        return {
          success: false,
          error: `File lock manager unavailable: ${error.message}. This is likely an infrastructure issue (e.g., Redis is down). Please try again later or contact support.`,
          duration: Date.now() - started,
          logs,
          metadata: { reason: error.details },
        };
      }

      appLogger.error(
        { err: normalizedError, traceId: span?.context.traceId, spanId: span?.context.spanId },
        "filesystem tool error",
      );
      return { success: false, error: (error as Error).message, duration: Date.now() - started, logs };
    }
    finally {
      span?.end();
      if (lock) {
        await lock.release().catch((releaseError) => {
          appLogger.warn({ err: normalizeError(releaseError) }, "failed to release filesystem lock");
        });
      }
    }
  }

  private describeChange(before: string, after: string): string {
    if (before === after) return "No changes";
    const beforeLines = before.split("\n").length;
    const afterLines = after.split("\n").length;
    return `Updated content (${beforeLines} -> ${afterLines} lines)`;
  }
}
