import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockFileLockError extends Error {
    constructor(
      message: string,
      public readonly code: "busy" | "unavailable" | "rate_limited",
      public readonly details?: any,
    ) {
      super(message);
    }
  }

  const releaseMock = vi.fn(async () => {});
  return {
    releaseMock,
    MockFileLockError,
    acquireLockMock: vi.fn(async () => ({ release: releaseMock })),
    applyAgentEditToRoomMock: vi.fn(),
    requestApprovalMock: vi.fn(),
  };
});

vi.mock("../../services/FileLockManager.js", () => ({
  FileLockError: mocks.MockFileLockError,
  fileLockManager: { acquireLock: mocks.acquireLockMock },
}));

vi.mock("../../collaboration/index.js", () => ({ applyAgentEditToRoom: mocks.applyAgentEditToRoomMock }));

vi.mock("../../observability/logger.js", () => ({
  appLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  normalizeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { FileSystemTool } from "./FileSystemTool.js";

let projectRoot: string;
const { releaseMock, acquireLockMock, applyAgentEditToRoomMock, requestApprovalMock, MockFileLockError } = mocks;
const testLogger = {
  child: vi.fn(function () {
    return this;
  }),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "fstool-"));
  acquireLockMock.mockClear();
  releaseMock.mockClear();
  applyAgentEditToRoomMock.mockClear();
  requestApprovalMock.mockReset();
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
});

describe("FileSystemTool", () => {
  it("rejects path traversal attempts", async () => {
    const tool = new FileSystemTool(testLogger, { projectRoot });
    const result = await tool.execute({ path: "../outside.txt", action: "read" }, { requestId: "req1" } as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain("escapes project root");
    expect(acquireLockMock).not.toHaveBeenCalled();
  });

  it("rejects paths that only prefix-match the root", async () => {
    const tool = new FileSystemTool(testLogger, { projectRoot });
    const sibling = `${projectRoot}-other/file.txt`;

    const result = await tool.execute({ path: sibling, action: "read" }, { requestId: "req-1b" } as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain("escapes project root");
    expect(acquireLockMock).not.toHaveBeenCalled();
  });

  it("rejects symlink escapes that resolve outside the project root", async () => {
    const tool = new FileSystemTool(testLogger, { projectRoot });
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "fstool-outside-"));
    const outsideFile = path.join(outsideDir, "secrets.txt");
    await fs.writeFile(outsideFile, "secret");

    const linkPath = path.join(projectRoot, "link.txt");
    await fs.symlink(outsideFile, linkPath);

    const result = await tool.execute(
      { path: linkPath, action: "write", content: "new", sessionId: "symlink" },
      { requestId: "req-1c" } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("escapes project root");
    expect(acquireLockMock).not.toHaveBeenCalled();

    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  it("routes writes through collaboration layer with locking", async () => {
    const tool = new FileSystemTool(testLogger, { projectRoot });
    const target = "notes.txt";

    const result = await tool.execute(
      { path: target, action: "write", content: "hello world", sessionId: "s1", agentId: "agent" },
      { requestId: "req-123" } as any,
    );

    const resolved = path.join(projectRoot, target);
    const roomId = createHash("sha256").update(resolved).digest("hex");

    expect(result.success).toBe(true);
    expect(acquireLockMock).toHaveBeenCalledWith("s1", resolved, "agent", {
      requestId: "req-123",
      traceId: "req-123",
    });
    expect(applyAgentEditToRoomMock).toHaveBeenCalledWith(roomId, resolved, "hello world");
    expect(releaseMock).toHaveBeenCalled();
  });

  it("fails gracefully when locks are busy", async () => {
    acquireLockMock.mockRejectedValueOnce(new MockFileLockError("File is locked", "busy", { reason: "locked" }));
    const tool = new FileSystemTool(testLogger, { projectRoot });

    const result = await tool.execute(
      { path: "blocked.txt", action: "write", content: "data", sessionId: "s2" },
      { requestId: "req-2" } as any,
    );

    expect(result.success).toBe(false);
    expect(result.metadata?.reason).toEqual({ reason: "locked" });
  });

  it("reports infrastructure errors when locks are unavailable", async () => {
    acquireLockMock.mockRejectedValueOnce(
      new MockFileLockError("Redis down", "unavailable", { reason: "connection_failed" }),
    );
    const tool = new FileSystemTool(testLogger, { projectRoot });

    const result = await tool.execute(
      { path: "blocked.txt", action: "write", content: "data", sessionId: "s2" },
      { requestId: "req-2" } as any,
    );

    expect(result.success).toBe(false);
    expect(result.metadata?.reason).toEqual({ reason: "connection_failed" });
    expect(result.error).toContain("File lock manager unavailable");
  });

  it("requests approval for critical changes and releases lock on rejection", async () => {
    const criticalFile = "package-lock.json";
    const tool = new FileSystemTool(testLogger, { projectRoot });
    requestApprovalMock.mockResolvedValue(false);

    const result = await tool.execute(
      { path: criticalFile, action: "write", content: "{}", sessionId: "s3" },
      { requestId: "req-3", requestApproval: requestApprovalMock } as any,
    );

    expect(result.success).toBe(false);
    expect(requestApprovalMock).toHaveBeenCalled();
    expect(releaseMock).toHaveBeenCalled();
  });

  it("deletes files with audit logging", async () => {
    const target = path.join(projectRoot, "remove.txt");
    await fs.writeFile(target, "to-delete");
    const tool = new FileSystemTool(testLogger, { projectRoot });

    const result = await tool.execute(
      { path: "remove.txt", action: "delete", sessionId: "s4", agentId: "agent" },
      { requestId: "req-4" } as any,
    );

    await expect(fs.stat(target)).rejects.toThrow();
    expect(result.success).toBe(true);
    expect(releaseMock).toHaveBeenCalled();
  });

  it("returns rate limit metadata when lock manager throttles", async () => {
    acquireLockMock.mockRejectedValueOnce(
      new MockFileLockError("Too many requests", "rate_limited", { limit: 1, windowMs: 60_000 }),
    );
    const tool = new FileSystemTool(testLogger, { projectRoot });

    const result = await tool.execute(
      { path: "blocked.txt", action: "write", content: "data", sessionId: "s-rate" },
      { requestId: "req-rate" } as any,
    );

    expect(result.success).toBe(false);
    expect(result.metadata?.reason).toEqual({ limit: 1, windowMs: 60_000 });
  });

  it("enforces per-session filesystem operation quotas", async () => {
    const originalLimit = process.env.FILESYSTEM_RATE_LIMIT_PER_MIN;
    process.env.FILESYSTEM_RATE_LIMIT_PER_MIN = "1";
    const tool = new FileSystemTool(testLogger, { projectRoot });

    try {
      const first = await tool.execute(
        { path: "rate.txt", action: "write", content: "one", sessionId: "quota" },
        { requestId: "req-rate-1" } as any,
      );

      const second = await tool.execute(
        { path: "rate.txt", action: "write", content: "two", sessionId: "quota" },
        { requestId: "req-rate-2" } as any,
      );

      expect(first.success).toBe(true);
      expect(second.success).toBe(false);
      expect(second.error).toContain("Rate limit");
      expect(acquireLockMock).toHaveBeenCalledTimes(1);
    } finally {
      process.env.FILESYSTEM_RATE_LIMIT_PER_MIN = originalLimit;
    }
  });
});
