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

    beforeEach(async () => {
      vi.clearAllMocks();
      await resetDistributedLockService();
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

    beforeEach(async () => {
      vi.clearAllMocks();
      await resetDistributedLockService();
      originalRedisUrl = process.env.REDIS_URL;
      originalLockRedisUrl = process.env.LOCK_REDIS_URL;
      delete process.env.REDIS_URL;
      delete process.env.LOCK_REDIS_URL;
    });

    afterEach(async () => {
      process.env.REDIS_URL = originalRedisUrl;
      process.env.LOCK_REDIS_URL = originalLockRedisUrl;
      await resetDistributedLockService();
    });

    it("reuses the singleton when the url matches", async () => {
      const first = await getDistributedLockService("redis://custom:6379");
      const second = await getDistributedLockService("redis://custom:6379");

      expect(second).toBe(first);
      expect(mocks.createClient).toHaveBeenCalledTimes(1);
      expect(mocks.createClient).toHaveBeenCalledWith({ url: "redis://custom:6379" });
    });

    it("throws when switching redis URLs without reset", async () => {
      await getDistributedLockService();

      await expect(getDistributedLockService("redis://custom:6379")).rejects.toThrow(
        /already initialized for a different Redis URL/i,
      );
      expect(mocks.createClient).toHaveBeenCalledTimes(1);
    });

    it("prefers lock-specific redis URL when provided", async () => {
      process.env.REDIS_URL = "redis://default:6379";
      process.env.LOCK_REDIS_URL = "redis://lock-specific:6379";

      const service = await getDistributedLockService();

      expect(service).toBeDefined();
      expect(mocks.createClient).toHaveBeenCalledWith({ url: "redis://lock-specific:6379" });
    });
  });
});
