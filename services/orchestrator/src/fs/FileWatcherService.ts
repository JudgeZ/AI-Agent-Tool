import fs from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import { appLogger, normalizeError } from "../observability/logger.js";

export type FileEventType = "create" | "delete" | "rename" | "change";

export interface FileWatchEvent {
  type: FileEventType;
  path: string;
  oldPath?: string;
  projectId: string;
}

export class FileWatcherService extends EventEmitter {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly projectRoots = new Map<string, string>();
  private readonly pendingDeletes = new Map<
    string,
    Map<string, { timer: NodeJS.Timeout; originalPath: string }>
  >();
  private static readonly DEFAULT_RENAME_WINDOW_MS = 500;
  // Unlink/add pairs within this window are coalesced into renames; longer gaps emit separate delete/create events.
  private readonly renameWindowMs = (() => {
    const configured = Number(process.env.FILE_WATCHER_RENAME_WINDOW_MS);
    if (Number.isFinite(configured) && configured > 0) {
      return configured;
    }
    return FileWatcherService.DEFAULT_RENAME_WINDOW_MS;
  })();

  async watch(projectId: string, projectRoot: string): Promise<void> {
    if (this.watchers.has(projectId)) {
      return;
    }

    const resolvedRoot = path.resolve(projectRoot.replace(/\\/g, "/"));
    const normalizedRoot = this.realpathSafe(resolvedRoot);
    this.projectRoots.set(projectId, normalizedRoot);
    this.pendingDeletes.set(projectId, new Map());
    const watcher = chokidar.watch(normalizedRoot, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200 },
    });

    watcher
      .on("add", (filePath) => this.handleAdd(projectId, filePath))
      .on("change", (filePath) => this.emitEvent("change", projectId, filePath))
      .on("unlink", (filePath) => this.scheduleDelete(projectId, filePath))
      .on("error", (err) =>
        appLogger.warn({ err: normalizeError(err), projectId }, "file watcher error"),
      );

    this.watchers.set(projectId, watcher);
  }

  private realpathSafe(target: string): string {
    try {
      return fs.realpathSync(target);
    } catch {
      return target;
    }
  }

  private toProjectPath(projectId: string, targetPath: string): string | undefined {
    const root = this.projectRoots.get(projectId);
    if (!root) return undefined;
    const normalizedTarget = targetPath.replace(/\\/g, "/");
    const relative = path.relative(root, normalizedTarget);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }
    const normalized = relative.replace(/\\/g, "/");
    return normalized || path.basename(normalizedTarget).replace(/\\/g, "/");
  }

  private emitEvent(type: FileEventType, projectId: string, filePath: string, oldPath?: string) {
    const normalizedPath = this.toProjectPath(projectId, filePath);
    if (!normalizedPath) {
      appLogger.debug({ projectId, filePath }, "skipping file watcher event outside project root");
      return;
    }

    const normalizedOldPath = oldPath ? this.toProjectPath(projectId, oldPath) : undefined;
    if (oldPath && !normalizedOldPath) {
      appLogger.debug(
        { projectId, filePath, oldPath },
        "skipping file watcher rename outside project root",
      );
      return;
    }

    const event: FileWatchEvent = {
      type,
      path: normalizedPath,
      oldPath: normalizedOldPath,
      projectId,
    };
    this.emit("event", event);
  }

  private handleAdd(projectId: string, filePath: string): void {
    const normalizedPath = this.toProjectPath(projectId, filePath);
    if (!normalizedPath) {
      appLogger.debug({ projectId, filePath }, "skipping add outside project root");
      return;
    }

    const pending = this.pendingDeletes.get(projectId);
    if (pending?.has(normalizedPath)) {
      const entry = pending.get(normalizedPath)!;
      clearTimeout(entry.timer);
      pending.delete(normalizedPath);
      this.emitEvent("change", projectId, filePath);
      return;
    }

    if (pending && pending.size === 1) {
      const nextValue = pending.entries().next().value;
      if (nextValue) {
        const [oldPathKey, entry] = nextValue;
        clearTimeout(entry.timer);
        pending.delete(oldPathKey);
        this.emitEvent("rename", projectId, filePath, entry.originalPath);
        return;
      }
      appLogger.warn({ projectId, filePath }, "pending delete map unexpectedly empty during rename detection");
    }

    this.emitEvent("create", projectId, filePath);
  }

  private scheduleDelete(projectId: string, filePath: string): void {
    const normalizedPath = this.toProjectPath(projectId, filePath);
    if (!normalizedPath) {
      appLogger.debug({ projectId, filePath }, "skipping delete outside project root");
      return;
    }

    const pending =
      this.pendingDeletes.get(projectId) ??
      new Map<string, { timer: NodeJS.Timeout; originalPath: string }>();
    this.pendingDeletes.set(projectId, pending);

    const existing = pending.get(normalizedPath);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      this.emitEvent("delete", projectId, filePath);
      pending.delete(normalizedPath);
    }, this.renameWindowMs);

    pending.set(normalizedPath, { timer, originalPath: filePath });
  }

  getEventStream(): EventEmitter {
    return this;
  }

  async stop(projectId: string): Promise<void> {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return;
    await watcher.close();
    this.watchers.delete(projectId);
    const pending = this.pendingDeletes.get(projectId);
    if (pending) {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
      }
      this.pendingDeletes.delete(projectId);
    }
    this.projectRoots.delete(projectId);
  }

  async shutdown(): Promise<void> {
    for (const [projectId, watcher] of this.watchers.entries()) {
      try {
        await watcher.close();
      } catch (error) {
        appLogger.warn({ err: normalizeError(error), projectId }, "failed to close watcher");
      }
    }
    this.watchers.clear();
    for (const pending of this.pendingDeletes.values()) {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
      }
    }
    this.pendingDeletes.clear();
    this.projectRoots.clear();
  }
}

export const fileWatcherService = new FileWatcherService();
