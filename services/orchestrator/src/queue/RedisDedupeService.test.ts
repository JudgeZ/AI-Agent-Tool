import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Redis client with in-memory storage
const redisState = vi.hoisted(() => {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  const state = {
    store,
    shouldFailConnect: false,
    connect: vi.fn(async () => {
      if (state.shouldFailConnect) {
        throw new Error("Redis connection failed");
      }
    }),
    quit: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    on: vi.fn(),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    set: vi.fn(async (key: string, value: string, options?: { NX?: boolean; PX?: number }) => {
      // Check if key exists when NX is specified
      if (options?.NX) {
        const existing = store.get(key);
        if (existing) {
          // Check if expired
          if (existing.expiresAt !== null && existing.expiresAt <= Date.now()) {
            store.delete(key);
          } else {
            return null; // Key exists, NX fails
          }
        }
      }
      const ttl = options?.PX;
      const expiresAt = ttl && Number.isFinite(ttl) ? Date.now() + ttl : null;
      store.set(key, { value, expiresAt });
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    exists: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return 0;
      if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
        store.delete(key);
        return 0;
      }
      return 1;
    }),
    createClient: vi.fn(() => ({
      connect: state.connect,
      quit: state.quit,
      disconnect: state.disconnect,
      on: state.on,
      get: state.get,
      set: state.set,
      del: state.del,
      exists: state.exists,
    })),
    reset() {
      store.clear();
      state.shouldFailConnect = false;
      state.connect.mockClear();
      state.quit.mockClear();
      state.disconnect.mockClear();
      state.on.mockClear();
      state.get.mockClear();
      state.set.mockClear();
      state.del.mockClear();
      state.exists.mockClear();
      state.createClient.mockClear();
    },
  };

  return state;
});

vi.mock("redis", () => ({
  createClient: redisState.createClient,
}));

import { RedisDedupeService, type RedisDedupeServiceConfig } from "./RedisDedupeService.js";

describe("RedisDedupeService", () => {
  let service: RedisDedupeService;

  const defaultConfig: RedisDedupeServiceConfig = {
    redisUrl: "redis://localhost:6379/0",
    keyPrefix: "test-dedupe",
  };

  beforeEach(() => {
    redisState.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  });

  afterEach(async () => {
    await service?.close?.();
    vi.useRealTimers();
  });

  describe("claim", () => {
    it("should successfully claim an unclaimed key", async () => {
      service = new RedisDedupeService(defaultConfig);

      const claimed = await service.claim("message-1", 5000);

      expect(claimed).toBe(true);
      expect(redisState.set).toHaveBeenCalledWith(
        "test-dedupe:message-1",
        "1",
        expect.objectContaining({ NX: true, PX: 5000 }),
      );
    });

    it("should fail to claim an already claimed key", async () => {
      service = new RedisDedupeService(defaultConfig);

      // First claim succeeds
      const first = await service.claim("message-2", 5000);
      expect(first).toBe(true);

      // Second claim fails
      const second = await service.claim("message-2", 5000);
      expect(second).toBe(false);
    });

    it("should allow claiming after TTL expires", async () => {
      service = new RedisDedupeService(defaultConfig);

      // Claim with 2 second TTL
      const first = await service.claim("message-3", 2000);
      expect(first).toBe(true);

      // Advance time past TTL
      vi.advanceTimersByTime(2100);

      // Should be able to claim again
      const second = await service.claim("message-3", 5000);
      expect(second).toBe(true);
    });

    it("should return false when Redis is unavailable", async () => {
      redisState.shouldFailConnect = true;
      service = new RedisDedupeService(defaultConfig);

      const claimed = await service.claim("message-fail", 5000);
      expect(claimed).toBe(false);
    });

    it("should handle concurrent claims atomically", async () => {
      service = new RedisDedupeService(defaultConfig);

      // Simulate concurrent claims
      const results = await Promise.all([
        service.claim("concurrent-key", 5000),
        service.claim("concurrent-key", 5000),
        service.claim("concurrent-key", 5000),
      ]);

      // Only one should succeed
      const successCount = results.filter(Boolean).length;
      expect(successCount).toBe(1);
    });
  });

  describe("release", () => {
    it("should release a claimed key", async () => {
      service = new RedisDedupeService(defaultConfig);

      await service.claim("release-key", 5000);
      await service.release("release-key");

      expect(redisState.del).toHaveBeenCalledWith("test-dedupe:release-key");

      // Should be able to claim again
      const claimed = await service.claim("release-key", 5000);
      expect(claimed).toBe(true);
    });

    it("should not throw when releasing non-existent key", async () => {
      service = new RedisDedupeService(defaultConfig);

      await expect(service.release("non-existent")).resolves.not.toThrow();
    });

    it("should handle Redis failure gracefully", async () => {
      service = new RedisDedupeService(defaultConfig);

      await service.claim("fail-release", 5000);

      redisState.del.mockRejectedValueOnce(new Error("Redis unavailable"));

      // Should not throw
      await expect(service.release("fail-release")).resolves.not.toThrow();
    });
  });

  describe("isClaimed", () => {
    it("should return true for claimed key", async () => {
      service = new RedisDedupeService(defaultConfig);

      await service.claim("check-claimed", 5000);
      const result = await service.isClaimed("check-claimed");

      expect(result).toBe(true);
    });

    it("should return false for unclaimed key", async () => {
      service = new RedisDedupeService(defaultConfig);

      const result = await service.isClaimed("unclaimed-key");
      expect(result).toBe(false);
    });

    it("should return false for expired claim", async () => {
      service = new RedisDedupeService(defaultConfig);

      await service.claim("expired-check", 1000);

      vi.advanceTimersByTime(1100);

      const result = await service.isClaimed("expired-check");
      expect(result).toBe(false);
    });

    it("should return false when Redis is unavailable", async () => {
      redisState.shouldFailConnect = true;
      service = new RedisDedupeService(defaultConfig);

      const result = await service.isClaimed("fail-check");
      expect(result).toBe(false);
    });
  });

  describe("close", () => {
    it("should close Redis connection", async () => {
      service = new RedisDedupeService(defaultConfig);

      // Trigger connection
      await service.claim("close-test", 5000);

      await service.close();

      expect(redisState.quit).toHaveBeenCalled();
    });

    it("should prevent operations after close", async () => {
      service = new RedisDedupeService(defaultConfig);

      // Trigger connection
      await service.claim("before-close", 5000);
      await service.close();

      // Operations should fail gracefully
      const claimed = await service.claim("after-close", 5000);
      expect(claimed).toBe(false);
    });
  });

  describe("key prefix", () => {
    it("should use custom key prefix", async () => {
      service = new RedisDedupeService({
        redisUrl: "redis://localhost:6379/0",
        keyPrefix: "custom-prefix",
      });

      await service.claim("prefixed-key", 5000);

      expect(redisState.set).toHaveBeenCalledWith(
        "custom-prefix:prefixed-key",
        expect.any(String),
        expect.any(Object),
      );
    });

    it("should use default key prefix when not specified", async () => {
      service = new RedisDedupeService({
        redisUrl: "redis://localhost:6379/0",
      });

      await service.claim("default-prefix-key", 5000);

      expect(redisState.set).toHaveBeenCalledWith(
        "dedupe:default-prefix-key",
        expect.any(String),
        expect.any(Object),
      );
    });
  });
});
