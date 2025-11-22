import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  const redisClient: any = {
    isOpen: false,
    connect: vi.fn(async () => {
      redisClient.isOpen = true;
    }),
    quit: vi.fn(async () => {
      redisClient.isOpen = false;
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    on: vi.fn(),
  };

  return {
    store,
    redisClient,
    mockAcquireLock: vi.fn(async (_resource: string) => vi.fn(async () => {})),
    mockIsRoomBusy: vi.fn(() => false),
    mockConnect: vi.fn(async () => {}),
  };
});

vi.mock("../collaboration/index.js", () => ({ isRoomBusy: mocks.mockIsRoomBusy }));
vi.mock("./DistributedLockService.js", () => ({
  getDistributedLockService: async () => ({
    acquireLock: mocks.mockAcquireLock,
    connect: mocks.mockConnect,
    getClient: () => mocks.redisClient,
  }),
}));

// Import after mocks are set up
import { FileLockError, FileLockManager } from "./FileLockManager.js";

const { store: mockStore, redisClient: mockRedisClient, mockAcquireLock, mockIsRoomBusy } = mocks;
const sessionKey = (sessionId: string) => `session:locks:${sessionId}`;

describe("FileLockManager", () => {
  beforeEach(() => {
    mockStore.clear();
    vi.clearAllMocks();
    mockRedisClient.isOpen = false;
    mockIsRoomBusy.mockReturnValue(false);
  });

  it("acquires locks with normalized keys and persists history", async () => {
    const manager = new FileLockManager("redis://example");
    const lock = await manager.acquireLock("s1", "project/file.txt", "agent-1");

    expect(lock.path).toBe("/project/file.txt");
    expect(mockAcquireLock).toHaveBeenCalledWith("file:/project/file.txt", 30_000);

    const stored = JSON.parse(mockStore.get(sessionKey("s1")) ?? "[]");
    expect(stored).toEqual(["/project/file.txt"]);

    await manager.releaseSessionLocks("s1");
    const afterRelease = JSON.parse(mockStore.get(sessionKey("s1")) ?? "[]");
    expect(afterRelease).toEqual([]);
  });

  it("restores locks from persisted history", async () => {
    mockStore.set(sessionKey("rehydrate"), JSON.stringify(["/foo.txt", "/bar/baz.md"]));
    const manager = new FileLockManager("redis://example");

    await manager.restoreSessionLocks("rehydrate");

    expect(mockAcquireLock).toHaveBeenCalledWith("file:/foo.txt", 30_000);
    expect(mockAcquireLock).toHaveBeenCalledWith("file:/bar/baz.md", 30_000);
  });

  it("returns busy errors when room is active", async () => {
    mockIsRoomBusy.mockReturnValue(true);
    const manager = new FileLockManager("redis://example");

    await expect(manager.acquireLock("s1", "busy/file.txt")).rejects.toBeInstanceOf(FileLockError);
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  it("propagates unavailable errors when redis cannot connect", async () => {
    mockRedisClient.connect.mockRejectedValueOnce(new Error("redis down"));
    const manager = new FileLockManager("redis://example");

    await expect(manager.acquireLock("s1", "file.txt")).rejects.toMatchObject({ code: "unavailable" });
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  it("rolls back and surfaces errors when persisting history fails", async () => {
    const releaseSpy = vi.fn(async () => {});
    mockAcquireLock.mockResolvedValueOnce(releaseSpy);
    mockRedisClient.set.mockRejectedValueOnce(new Error("persist failed"));

    const manager = new FileLockManager("redis://example");

    await expect(manager.acquireLock("s1", "project/ok.txt")).rejects.toMatchObject({ code: "unavailable" });
    expect(releaseSpy).toHaveBeenCalled();
  });

  it("wraps errors during restore acquisitions as unavailable", async () => {
    mockStore.set(sessionKey("rehydrate"), JSON.stringify(["/foo.txt"]));
    const manager = new FileLockManager("redis://example");
    mockAcquireLock.mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(manager.restoreSessionLocks("rehydrate")).resolves.not.toThrow();
    expect(mockAcquireLock).toHaveBeenCalledWith("file:/foo.txt", 30_000);
  });

  it("skips restore when history is invalid JSON", async () => {
    mockStore.set(sessionKey("rehydrate"), "not-json");
    const manager = new FileLockManager("redis://example");

    await manager.restoreSessionLocks("rehydrate");

    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  it("rejects invalid session identifiers", async () => {
    const manager = new FileLockManager("redis://example");
    await expect(manager.acquireLock("bad:id", "project/file.txt")).rejects.toBeInstanceOf(FileLockError);
  });
});
