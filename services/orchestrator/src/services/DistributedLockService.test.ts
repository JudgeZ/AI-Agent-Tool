import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  DistributedLockService,
  getDistributedLockService,
  resetDistributedLockService,
} from "./DistributedLockService.js";

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  eval: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("redis", () => {
  mocks.createClient.mockImplementation(() => ({
    set: mocks.set,
    eval: mocks.eval,
    connect: mocks.connect,
    quit: mocks.quit,
    on: mocks.on,
  }));
  return { createClient: mocks.createClient };
});

describe("DistributedLockService", () => {
  describe("instance", () => {
    let lockService: DistributedLockService;

    beforeEach(() => {
      vi.clearAllMocks();
      resetDistributedLockService();
      lockService = new DistributedLockService("redis://localhost:6379");
    });

    afterEach(async () => {
      await lockService.disconnect();
    });

    it("acquires a lock successfully", async () => {
      mocks.set.mockResolvedValue("OK");

      const release = await lockService.acquireLock("resource-1", 1000);

      expect(mocks.set).toHaveBeenCalledWith("lock:resource-1", expect.any(String), {
        NX: true,
        PX: 1000,
      });
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

      await expect(lockService.acquireLock("resource-1", 1000, 3, 10)).rejects.toThrow(
        "Failed to acquire lock",
      );
    });

    it("releases lock correctly", async () => {
      mocks.set.mockResolvedValue("OK");
      mocks.eval.mockResolvedValue(1); // Released

      const release = await lockService.acquireLock("resource-1", 1000);
      await release();

      expect(mocks.eval).toHaveBeenCalled();
    });
  });

  describe("getDistributedLockService", () => {
    let originalRedisUrl: string | undefined;
    let originalLockRedisUrl: string | undefined;

    beforeEach(() => {
      vi.clearAllMocks();
      resetDistributedLockService();
      originalRedisUrl = process.env.REDIS_URL;
      originalLockRedisUrl = process.env.LOCK_REDIS_URL;
      delete process.env.REDIS_URL;
      delete process.env.LOCK_REDIS_URL;
    });

    afterEach(() => {
      process.env.REDIS_URL = originalRedisUrl;
      process.env.LOCK_REDIS_URL = originalLockRedisUrl;
      resetDistributedLockService();
    });

    it("reuses the singleton when the url matches", () => {
      const first = getDistributedLockService("redis://custom:6379");
      const second = getDistributedLockService("redis://custom:6379");

      expect(second).toBe(first);
      expect(mocks.createClient).toHaveBeenCalledTimes(1);
      expect(mocks.createClient).toHaveBeenCalledWith({ url: "redis://custom:6379" });
    });

    it("reinitializes the singleton when a different url is provided", () => {
      const first = getDistributedLockService();
      const second = getDistributedLockService("redis://custom:6379");

      expect(second).not.toBe(first);
      expect(mocks.createClient).toHaveBeenNthCalledWith(1, { url: "redis://localhost:6379" });
      expect(mocks.createClient).toHaveBeenNthCalledWith(2, { url: "redis://custom:6379" });
    });
  });
});
