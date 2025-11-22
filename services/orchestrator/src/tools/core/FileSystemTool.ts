import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { applyAgentEditToRoom } from "../../collaboration/index.js";
import { appLogger, normalizeError } from "../../observability/logger.js";
import { FileLockError, fileLockManager } from "../../services/FileLockManager.js";
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
          action: { type: "string" },
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

  async execute(input: FileSystemToolInput, context: ToolContext): Promise<ToolResult> {
    const started = Date.now();
    await this.validateInput(input);
    const logs: string[] = [];

    let lock: { release: () => Promise<void> } | undefined;
    let lockReleased = false;
    try {
      const resolvedPath = this.resolvePath(input.path);

      if (input.action === "read") {
        const content = await fs.readFile(resolvedPath, "utf-8");
        return {
          success: true,
          data: { path: resolvedPath, content },
          duration: Date.now() - started,
        };
      }

      const sessionId = input.sessionId ?? context.requestId ?? "anonymous-session";
      lock = await fileLockManager.acquireLock(sessionId, resolvedPath, input.agentId);
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
          await lock.release();
          lockReleased = true;
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
        applyAgentEditToRoom(resolvedPath, resolvedPath, content);
      }

      await lock.release();
      lockReleased = true;

      return {
        success: true,
        data: { path: resolvedPath, action: input.action },
        duration: Date.now() - started,
        logs,
      };
    } catch (error) {
      const normalizedError = normalizeError(error);
      logs.push(JSON.stringify(normalizedError));
      if (error instanceof FileLockError && error.code === "busy") {
        return {
          success: false,
          error: `File busy: ${error.message}`,
          duration: Date.now() - started,
          logs,
          metadata: { reason: error.details },
        };
      }

      appLogger.error({ err: normalizedError }, "filesystem tool error");
      return { success: false, error: (error as Error).message, duration: Date.now() - started, logs };
    }
    finally {
      if (lock && !lockReleased) {
        try {
          await lock.release();
        } catch (releaseError) {
          appLogger.warn({ err: normalizeError(releaseError) }, "failed to release filesystem lock");
        }
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
