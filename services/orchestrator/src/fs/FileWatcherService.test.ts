import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => {
  const watchers: any[] = [];

  const mockWatch = vi.fn((root: string) => {
    const watcher = new EventEmitter() as EventEmitter & { close: () => Promise<void> };
    watcher.close = vi.fn(async () => {});
    (watcher as any).root = root;
    watchers.push(watcher);
    return watcher;
  });

  return { watchers, mockWatch };
});

vi.mock("chokidar", () => ({ default: { watch: mocks.mockWatch }, watch: mocks.mockWatch }));

import { FileWatcherService, type FileWatchEvent } from "./FileWatcherService.js";

describe("FileWatcherService", () => {
  const service = new FileWatcherService();

  beforeEach(() => {
    mocks.watchers.length = 0;
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await service.shutdown();
    vi.useRealTimers();
  });

  it("emits relative paths for create/change/delete events", async () => {
    const events: FileWatchEvent[] = [];
    service.getEventStream().on("event", (event) => events.push(event));

    await service.watch("p1", "/workspace/project");
    const watcher = mocks.watchers[0];

    watcher.emit("add", "/workspace/project/src/index.ts");
    watcher.emit("change", "/workspace/project/src/index.ts");
    watcher.emit("unlink", "/workspace/project/src/index.ts");

    vi.runAllTimers();

    expect(events).toEqual([
      { type: "create", path: "src/index.ts", projectId: "p1" },
      { type: "change", path: "src/index.ts", projectId: "p1" },
      { type: "delete", path: "src/index.ts", projectId: "p1" },
    ]);
  });

  it("coalesces unlink/add pairs into rename events", async () => {
    const events: FileWatchEvent[] = [];
    service.getEventStream().on("event", (event) => events.push(event));

    await service.watch("p2", "/workspace/project");
    const watcher = mocks.watchers[0];

    watcher.emit("unlink", "/workspace/project/old.txt");
    watcher.emit("add", "/workspace/project/new.txt");

    vi.runAllTimers();

    expect(events).toEqual([
      { type: "rename", path: "new.txt", oldPath: "old.txt", projectId: "p2" },
    ]);
  });

  it("treats unlink/add for the same path as a change", async () => {
    const events: FileWatchEvent[] = [];
    service.getEventStream().on("event", (event) => events.push(event));

    await service.watch("p2b", "/workspace/project");
    const watcher = mocks.watchers[0];

    watcher.emit("unlink", "/workspace/project/file.txt");
    watcher.emit("add", "/workspace/project/file.txt");

    vi.runAllTimers();

    expect(events).toEqual([{ type: "change", path: "file.txt", projectId: "p2b" }]);
  });

  it("falls back to create when multiple deletes are pending", async () => {
    const events: FileWatchEvent[] = [];
    service.getEventStream().on("event", (event) => events.push(event));

    await service.watch("p3", "/workspace/project");
    const watcher = mocks.watchers[0];

    watcher.emit("unlink", "/workspace/project/first.txt");
    watcher.emit("unlink", "/workspace/project/second.txt");
    watcher.emit("add", "/workspace/project/new.txt");

    vi.runAllTimers();

    expect(events).toEqual([
      { type: "create", path: "new.txt", projectId: "p3" },
      { type: "delete", path: "first.txt", projectId: "p3" },
      { type: "delete", path: "second.txt", projectId: "p3" },
    ]);
  });

  it("emits change for atomic saves even when other deletes are pending", async () => {
    const events: FileWatchEvent[] = [];
    service.getEventStream().on("event", (event) => events.push(event));

    await service.watch("p3b", "/workspace/project");
    const watcher = mocks.watchers[0];

    watcher.emit("unlink", "/workspace/project/file.txt");
    watcher.emit("unlink", "/workspace/project/other.txt");
    watcher.emit("add", "/workspace/project/file.txt");

    vi.runAllTimers();

    expect(events).toEqual([
      { type: "change", path: "file.txt", projectId: "p3b" },
      { type: "delete", path: "other.txt", projectId: "p3b" },
    ]);
  });

  it("ignores events outside the project root", async () => {
    const events: FileWatchEvent[] = [];
    service.getEventStream().on("event", (event) => events.push(event));

    await service.watch("p4", "/workspace/project");
    const watcher = mocks.watchers[0];

    watcher.emit("unlink", "/tmp/outside.txt");
    watcher.emit("add", "/workspace/project/inside.txt");

    vi.runAllTimers();

    expect(events).toEqual([{ type: "create", path: "inside.txt", projectId: "p4" }]);
  });

  it("retains pending deletes when an out-of-root add occurs", async () => {
    const events: FileWatchEvent[] = [];
    service.getEventStream().on("event", (event) => events.push(event));

    await service.watch("p5", "/workspace/project");
    const watcher = mocks.watchers[0];

    watcher.emit("unlink", "/workspace/project/old.txt");
    watcher.emit("add", "/tmp/outside.txt");

    vi.runAllTimers();

    expect(events).toEqual([{ type: "delete", path: "old.txt", projectId: "p5" }]);
  });

  it("normalizes emitted paths to posix separators", async () => {
    const events: FileWatchEvent[] = [];
    service.getEventStream().on("event", (event) => events.push(event));

    await service.watch("p6", "C:\\workspace\\project");
    const watcher = mocks.watchers[0];

    watcher.emit("add", "C:\\workspace\\project\\src\\index.ts");
    watcher.emit("unlink", "C:\\workspace\\project\\old.txt");

    vi.runAllTimers();

    expect(events).toEqual([
      { type: "create", path: "src/index.ts", projectId: "p6" },
      { type: "delete", path: "old.txt", projectId: "p6" },
    ]);
  });

  it("uses the real project root when normalizing watcher paths", async () => {
    const realpathSpy = vi.spyOn(fs, "realpathSync").mockReturnValue("/real/project");

    try {
      const events: FileWatchEvent[] = [];
      service.getEventStream().on("event", (event) => events.push(event));

      await service.watch("p6b", "/workspace/link");
      const watcher = mocks.watchers[0];

      expect((watcher as any).root).toBe("/real/project");

      watcher.emit("unlink", "/real/project/dir/file.txt");

      vi.runAllTimers();

      expect(events).toEqual([{ type: "delete", path: "dir/file.txt", projectId: "p6b" }]);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("de-duplicates pending deletes for the same path regardless of separators", async () => {
    const events: FileWatchEvent[] = [];
    service.getEventStream().on("event", (event) => events.push(event));

    await service.watch("p7", "C\\\\workspace\\\\project");
    const watcher = mocks.watchers[0];

    watcher.emit("unlink", "C\\\\workspace\\\\project\\\\dir\\\\file.txt");
    watcher.emit("unlink", "C:/workspace/project/dir/file.txt");

    vi.runAllTimers();

    expect(events).toEqual([{ type: "delete", path: "dir/file.txt", projectId: "p7" }]);
  });
});

