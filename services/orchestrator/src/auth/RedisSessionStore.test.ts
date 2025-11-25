import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Redis client with in-memory storage
const redisState = vi.hoisted(() => {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const sets = new Map<string, Set<string>>();

  const state = {
    store,
    sets,
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
    set: vi.fn(async (key: string, value: string, options?: { EX?: number }) => {
      const ttl = options?.EX;
      const expiresAt = ttl && Number.isFinite(ttl) ? Date.now() + ttl * 1000 : null;
      store.set(key, { value, expiresAt });
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    createClient: vi.fn(() => ({
      connect: state.connect,
      quit: state.quit,
      disconnect: state.disconnect,
      on: state.on,
      get: state.get,
      set: state.set,
      del: state.del,
    })),
    reset() {
      store.clear();
      sets.clear();
      state.shouldFailConnect = false;
      state.connect.mockClear();
      state.quit.mockClear();
      state.disconnect.mockClear();
      state.on.mockClear();
      state.get.mockClear();
      state.set.mockClear();
      state.del.mockClear();
      state.createClient.mockClear();
    },
  };

  return state;
});

vi.mock("redis", () => ({
  createClient: redisState.createClient,
}));

import { RedisSessionStore, type RedisSessionStoreConfig } from "./RedisSessionStore.js";

describe("RedisSessionStore", () => {
  let store: RedisSessionStore;

  const defaultConfig: RedisSessionStoreConfig = {
    redisUrl: "redis://localhost:6379/0",
    keyPrefix: "test-session",
    enableL1Cache: false,
  };

  beforeEach(() => {
    redisState.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  });

  afterEach(async () => {
    await store?.close?.();
    vi.useRealTimers();
  });

  describe("createSession", () => {
    it("should create a session and store in Redis", async () => {
      store = new RedisSessionStore(defaultConfig);

      const session = await store.createSession(
        {
          subject: "user-1",
          email: "user@example.com",
          name: "Test User",
          tenantId: "tenant-1",
          roles: ["admin", "user"],
          scopes: ["read", "write"],
          claims: { customClaim: "value" },
        },
        3600, // 1 hour TTL
      );

      expect(session.subject).toBe("user-1");
      expect(session.email).toBe("user@example.com");
      expect(session.roles).toContain("admin");
      expect(session.roles).toContain("user");
      expect(session.scopes).toContain("read");
      expect(session.scopes).toContain("write");
      expect(redisState.set).toHaveBeenCalledWith(
        `test-session:${session.id}`,
        expect.any(String),
        expect.objectContaining({ EX: 3600 }),
      );
    });

    it("should normalize and dedupe roles", async () => {
      store = new RedisSessionStore(defaultConfig);

      const session = await store.createSession(
        {
          subject: "user-2",
          roles: [" admin ", "user", "admin", ""],
          scopes: [],
          claims: {},
        },
        60,
      );

      expect(session.roles).toEqual(["admin", "user"]);
    });

    it("should handle Redis connection failure gracefully with L1 fallback", async () => {
      redisState.shouldFailConnect = true;
      store = new RedisSessionStore({
        ...defaultConfig,
        enableL1Cache: true,
        l1CacheTtlMs: 30000,
      });

      const session = await store.createSession(
        {
          subject: "user-3",
          roles: [],
          scopes: [],
          claims: {},
        },
        60,
      );

      // Session should be created in L1 cache when Redis fails
      expect(session.subject).toBe("user-3");
      expect(session.id).toBeDefined();
      // Verify session is retrievable from L1 cache
      const retrieved = await store.getSession(session.id);
      expect(retrieved?.subject).toBe("user-3");
    });

    it("should throw when Redis fails and L1 cache is disabled", async () => {
      redisState.shouldFailConnect = true;
      store = new RedisSessionStore(defaultConfig);

      await expect(
        store.createSession(
          {
            subject: "user-3b",
            roles: [],
            scopes: [],
            claims: {},
          },
          60,
        ),
      ).rejects.toThrow("Redis unavailable and L1 cache disabled");
    });

    it("should use custom expiresAt override", async () => {
      store = new RedisSessionStore(defaultConfig);
      const customExpiry = Date.now() + 120000; // 2 minutes

      const session = await store.createSession(
        {
          subject: "user-4",
          roles: [],
          scopes: [],
          claims: {},
        },
        3600, // TTL ignored when override provided
        customExpiry,
      );

      expect(Date.parse(session.expiresAt)).toBe(customExpiry);
    });
  });

  describe("getSession", () => {
    it("should retrieve a session from Redis", async () => {
      store = new RedisSessionStore(defaultConfig);

      const created = await store.createSession(
        {
          subject: "user-get-1",
          roles: ["viewer"],
          scopes: ["read"],
          claims: {},
        },
        3600,
      );

      const retrieved = await store.getSession(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.subject).toBe("user-get-1");
      expect(retrieved?.roles).toContain("viewer");
    });

    it("should return undefined for non-existent session", async () => {
      store = new RedisSessionStore(defaultConfig);

      const result = await store.getSession("non-existent-id");
      expect(result).toBeUndefined();
    });

    it("should return undefined for expired session", async () => {
      store = new RedisSessionStore(defaultConfig);

      const session = await store.createSession(
        {
          subject: "user-expire",
          roles: [],
          scopes: [],
          claims: {},
        },
        1, // 1 second TTL
      );

      expect(await store.getSession(session.id)).toBeDefined();

      // Advance time past expiration
      vi.setSystemTime(new Date("2024-01-01T00:00:02.000Z"));

      expect(await store.getSession(session.id)).toBeUndefined();
    });

    it("should handle Redis connection failure gracefully", async () => {
      store = new RedisSessionStore(defaultConfig);

      const session = await store.createSession(
        {
          subject: "user-fail",
          roles: [],
          scopes: [],
          claims: {},
        },
        3600,
      );

      // Now fail Redis
      redisState.shouldFailConnect = true;
      redisState.get.mockRejectedValueOnce(new Error("Redis unavailable"));

      const result = await store.getSession(session.id);
      expect(result).toBeUndefined();
    });
  });

  describe("revokeSession", () => {
    it("should revoke an existing session", async () => {
      store = new RedisSessionStore(defaultConfig);

      const session = await store.createSession(
        {
          subject: "user-revoke",
          roles: [],
          scopes: [],
          claims: {},
        },
        3600,
      );

      const revoked = await store.revokeSession(session.id);
      expect(revoked).toBe(true);

      const retrieved = await store.getSession(session.id);
      expect(retrieved).toBeUndefined();
    });

    it("should return false for non-existent session", async () => {
      store = new RedisSessionStore(defaultConfig);

      const revoked = await store.revokeSession("non-existent");
      expect(revoked).toBe(false);
    });
  });

  describe("L1 cache", () => {
    it("should cache sessions in L1 when enabled", async () => {
      store = new RedisSessionStore({
        ...defaultConfig,
        enableL1Cache: true,
        l1CacheTtlMs: 5000,
      });

      const session = await store.createSession(
        {
          subject: "user-l1",
          roles: [],
          scopes: [],
          claims: {},
        },
        3600,
      );

      // First get - from Redis
      await store.getSession(session.id);

      // Clear Redis mock call count
      redisState.get.mockClear();

      // Second get - should come from L1 cache
      const cached = await store.getSession(session.id);
      expect(cached?.subject).toBe("user-l1");
      expect(redisState.get).not.toHaveBeenCalled();
    });

    it("should expire L1 cache entries after TTL", async () => {
      store = new RedisSessionStore({
        ...defaultConfig,
        enableL1Cache: true,
        l1CacheTtlMs: 2000,
      });

      const session = await store.createSession(
        {
          subject: "user-l1-expire",
          roles: [],
          scopes: [],
          claims: {},
        },
        3600,
      );

      // First get - caches in L1
      await store.getSession(session.id);
      redisState.get.mockClear();

      // Advance time past L1 TTL
      vi.advanceTimersByTime(2100);

      // Next get should hit Redis again
      await store.getSession(session.id);
      expect(redisState.get).toHaveBeenCalled();
    });

    it("should invalidate L1 cache on revoke", async () => {
      store = new RedisSessionStore({
        ...defaultConfig,
        enableL1Cache: true,
        l1CacheTtlMs: 30000,
      });

      const session = await store.createSession(
        {
          subject: "user-l1-revoke",
          roles: [],
          scopes: [],
          claims: {},
        },
        3600,
      );

      // Cache in L1
      await store.getSession(session.id);

      // Revoke should clear L1
      await store.revokeSession(session.id);

      // Get should return undefined
      const result = await store.getSession(session.id);
      expect(result).toBeUndefined();
    });
  });

  describe("cleanupExpired", () => {
    it("should remove expired entries from L1 cache", async () => {
      store = new RedisSessionStore({
        ...defaultConfig,
        enableL1Cache: true,
        l1CacheTtlMs: 1000,
      });

      // Create and cache a session
      const session = await store.createSession(
        {
          subject: "user-cleanup",
          roles: [],
          scopes: [],
          claims: {},
        },
        3600,
      );
      await store.getSession(session.id);

      // Advance time to expire L1 cache
      vi.advanceTimersByTime(1100);

      // Cleanup should remove expired L1 entries
      await store.cleanupExpired();

      // Should hit Redis again after cleanup
      redisState.get.mockClear();
      await store.getSession(session.id);
      expect(redisState.get).toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("should clear L1 cache", async () => {
      store = new RedisSessionStore({
        ...defaultConfig,
        enableL1Cache: true,
      });

      const session = await store.createSession(
        {
          subject: "user-clear",
          roles: [],
          scopes: [],
          claims: {},
        },
        3600,
      );
      await store.getSession(session.id);

      await store.clear();

      // L1 cache should be cleared
      redisState.get.mockClear();
      await store.getSession(session.id);
      expect(redisState.get).toHaveBeenCalled();
    });
  });

  describe("close", () => {
    it("should close Redis connection", async () => {
      store = new RedisSessionStore(defaultConfig);

      // Trigger connection
      await store.createSession(
        {
          subject: "user-close",
          roles: [],
          scopes: [],
          claims: {},
        },
        3600,
      );

      await store.close();

      expect(redisState.quit).toHaveBeenCalled();
    });

    it("should stop L1 cleanup timer on close", async () => {
      store = new RedisSessionStore({
        ...defaultConfig,
        enableL1Cache: true,
      });

      await store.close();

      // Verify cleanup timer was cleared (no errors after close)
      vi.advanceTimersByTime(120000);
    });
  });
});
