import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DistributedLockService } from "./DistributedLockService.js";

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  eval: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
}));

vi.mock("redis", () => {
  return {
    createClient: vi.fn(() => ({
      set: mocks.set,
      eval: mocks.eval,
      connect: mocks.connect,
      quit: mocks.quit,
      on: mocks.on,
    })),
  };
});

describe("DistributedLockService", () => {
  let lockService: DistributedLockService;

  beforeEach(() => {
    vi.clearAllMocks();
    lockService = new DistributedLockService("redis://localhost:6379");
  });

  afterEach(async () => {
    await lockService.disconnect();
  });

  it("acquires a lock successfully", async () => {
    mocks.set.mockResolvedValue("OK");

    const release = await lockService.acquireLock("resource-1", 1000);

    expect(mocks.set).toHaveBeenCalledWith("lock:resource-1", expect.any(String), { NX: true, PX: 1000 });
    expect(release).toBeTypeOf("function");
  });

  it("retries when lock is busy", async () => {
    mocks.set
      .mockResolvedValueOnce(null) // Busy
      .mockResolvedValueOnce("OK"); // Acquired

    const release = await lockService.acquireLock("resource-1", 1000);
    
    expect(mocks.set).toHaveBeenCalledTimes(2);
    expect(release).toBeTypeOf("function");
  });

  it("throws error after max retries", async () => {
    mocks.set.mockResolvedValue(null); // Always busy

    await expect(lockService.acquireLock("resource-1", 1000, 3, 10)).rejects.toThrow("Failed to acquire lock");
  });

  it("releases lock correctly", async () => {
    mocks.set.mockResolvedValue("OK");
    mocks.eval.mockResolvedValue(1); // Released

    const release = await lockService.acquireLock("resource-1", 1000);
    await release();

    expect(mocks.eval).toHaveBeenCalled();
  });
});
