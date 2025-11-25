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
    sAdd: vi.fn(async (key: string, ...members: string[]) => {
      if (!sets.has(key)) {
        sets.set(key, new Set());
      }
      const set = sets.get(key)!;
      let added = 0;
      for (const m of members.flat()) {
        if (!set.has(m)) {
          set.add(m);
          added++;
        }
      }
      return added;
    }),
    sRem: vi.fn(async (key: string, member: string) => {
      const set = sets.get(key);
      if (!set) return 0;
      return set.delete(member) ? 1 : 0;
    }),
    sMembers: vi.fn(async (key: string) => {
      const set = sets.get(key);
      return set ? Array.from(set) : [];
    }),
    sIsMember: vi.fn(async (key: string, member: string) => {
      const set = sets.get(key);
      return set?.has(member) ? 1 : 0;
    }),
    scan: vi.fn(async (cursor: number, options?: { MATCH?: string; COUNT?: number }) => {
      const keys = Array.from(store.keys());
      const pattern = options?.MATCH?.replace(/\*/g, ".*") ?? ".*";
      const regex = new RegExp(`^${pattern}$`);
      const matched = keys.filter((k) => regex.test(k));
      // Simulate pagination
      const start = cursor;
      const count = options?.COUNT ?? 100;
      const slice = matched.slice(start, start + count);
      const nextCursor = start + count >= matched.length ? 0 : start + count;
      return { cursor: nextCursor, keys: slice };
    }),
    createClient: vi.fn(() => ({
      connect: state.connect,
      quit: state.quit,
      disconnect: state.disconnect,
      on: state.on,
      get: state.get,
      set: state.set,
      del: state.del,
      sAdd: state.sAdd,
      sRem: state.sRem,
      sMembers: state.sMembers,
      sIsMember: state.sIsMember,
      scan: state.scan,
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
      state.sAdd.mockClear();
      state.sRem.mockClear();
      state.sMembers.mockClear();
      state.sIsMember.mockClear();
      state.scan.mockClear();
      state.createClient.mockClear();
    },
  };

  return state;
});

vi.mock("redis", () => ({
  createClient: redisState.createClient,
}));

import { ContextScope } from "./AgentCommunication.js";
import { RedisSharedContext, type RedisSharedContextConfig } from "./RedisSharedContext.js";

describe("RedisSharedContext", () => {
  let context: RedisSharedContext;

  const defaultConfig: RedisSharedContextConfig = {
    redisUrl: "redis://localhost:6379/0",
    keyPrefix: "test-context",
  };

  beforeEach(() => {
    redisState.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
  });

  afterEach(async () => {
    await context?.shutdown();
    vi.useRealTimers();
  });

  describe("set", () => {
    it("should store a value with default scope", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("key1", { data: "value" }, "agent1");

      expect(redisState.set).toHaveBeenCalledWith(
        "test-context:entry:key1",
        expect.stringContaining("agent1"),
        expect.any(Object),
      );
    });

    it("should store a value with specific scope", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("key2", "private-data", "agent1", ContextScope.PRIVATE);

      const stored = redisState.set.mock.calls[0][1];
      expect(stored).toContain("PRIVATE");
    });

    it("should store a value with TTL", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("key3", "temp-data", "agent1", ContextScope.GLOBAL, 60);

      expect(redisState.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ EX: 60 }),
      );
    });

    it("should emit context:set event", async () => {
      context = new RedisSharedContext(defaultConfig);
      const setSpy = vi.fn();
      context.on("context:set", setSpy);

      await context.set("key4", "data", "agent1");

      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "key4",
          ownerId: "agent1",
        }),
      );
    });
  });

  describe("get", () => {
    it("should retrieve a value owned by requester", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("get-key", { foo: "bar" }, "agent1");
      const value = await context.get("get-key", "agent1");

      expect(value).toEqual({ foo: "bar" });
    });

    it("should retrieve a global value by any agent", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("global-key", "shared-data", "agent1", ContextScope.GLOBAL);
      const value = await context.get("global-key", "agent2");

      expect(value).toBe("shared-data");
    });

    it("should deny access to private value from other agent", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("private-key", "secret", "agent1", ContextScope.PRIVATE);

      await expect(context.get("private-key", "agent2")).rejects.toThrow("Access denied");
    });

    it("should return undefined for non-existent key", async () => {
      context = new RedisSharedContext(defaultConfig);

      const value = await context.get("non-existent", "agent1");
      expect(value).toBeUndefined();
    });

    it("should emit context:get event", async () => {
      context = new RedisSharedContext(defaultConfig);
      await context.set("emit-key", "data", "agent1");

      const getSpy = vi.fn();
      context.on("context:get", getSpy);

      await context.get("emit-key", "agent1");

      expect(getSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "emit-key",
          requesterId: "agent1",
        }),
      );
    });
  });

  describe("delete", () => {
    it("should delete a value owned by requester", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("delete-key", "data", "agent1");
      const deleted = await context.delete("delete-key", "agent1");

      expect(deleted).toBe(true);
      expect(redisState.del).toHaveBeenCalled();
    });

    it("should deny deletion by non-owner", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("owned-key", "data", "agent1");

      await expect(context.delete("owned-key", "agent2")).rejects.toThrow("Access denied");
    });

    it("should return false for non-existent key", async () => {
      context = new RedisSharedContext(defaultConfig);

      const deleted = await context.delete("missing-key", "agent1");
      expect(deleted).toBe(false);
    });

    it("should emit context:delete event", async () => {
      context = new RedisSharedContext(defaultConfig);
      await context.set("delete-emit-key", "data", "agent1");

      const deleteSpy = vi.fn();
      context.on("context:delete", deleteSpy);

      await context.delete("delete-emit-key", "agent1");

      expect(deleteSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "delete-emit-key",
          requesterId: "agent1",
        }),
      );
    });
  });

  describe("share", () => {
    it("should add agents to ACL for shared value", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("share-key", "data", "agent1", ContextScope.SHARED);
      await context.share("share-key", "agent1", ["agent2", "agent3"]);

      expect(redisState.sAdd).toHaveBeenCalledWith(
        "test-context:acl:share-key",
        "agent2",
      );
      expect(redisState.sAdd).toHaveBeenCalledWith(
        "test-context:acl:share-key",
        "agent3",
      );
    });

    it("should deny sharing by non-owner", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("no-share", "data", "agent1", ContextScope.SHARED);

      await expect(
        context.share("no-share", "agent2", ["agent3"]),
      ).rejects.toThrow("Only the owner can share");
    });

    it("should emit context:shared event", async () => {
      context = new RedisSharedContext(defaultConfig);
      await context.set("share-emit", "data", "agent1", ContextScope.SHARED);

      const shareSpy = vi.fn();
      context.on("context:shared", shareSpy);

      await context.share("share-emit", "agent1", ["agent2"]);

      expect(shareSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "share-emit",
          ownerId: "agent1",
          sharedWith: ["agent2"],
        }),
      );
    });
  });

  describe("query", () => {
    beforeEach(async () => {
      context = new RedisSharedContext(defaultConfig);

      // Set up test data
      await context.set("query-1", "data1", "agent1", ContextScope.GLOBAL);
      await context.set("query-2", "data2", "agent1", ContextScope.GLOBAL);
      await context.set("query-3", "data3", "agent2", ContextScope.GLOBAL);
    });

    it("should return entries matching owner filter", async () => {
      const results = await context.query({ ownerId: "agent1" }, "agent1");

      expect(results.length).toBe(2);
      expect(results.every((e) => e.ownerId === "agent1")).toBe(true);
    });

    it("should return entries matching scope filter", async () => {
      await context.set("private-q", "secret", "agent1", ContextScope.PRIVATE);

      const results = await context.query({ scope: ContextScope.GLOBAL }, "agent1");

      expect(results.every((e) => e.scope === ContextScope.GLOBAL)).toBe(true);
    });

    it("should respect pagination parameters", async () => {
      const results = await context.query(
        { limit: 2, offset: 0 },
        "agent1",
      );

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("should only return accessible entries", async () => {
      await context.set("private-entry", "secret", "agent2", ContextScope.PRIVATE);

      const results = await context.query({}, "agent1");

      // Should not include agent2's private entry
      const privateEntry = results.find((e) => e.scope === ContextScope.PRIVATE && e.ownerId === "agent2");
      expect(privateEntry).toBeUndefined();
    });
  });

  describe("getEntryCount", () => {
    it("should return count of entries", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("count-1", "data", "agent1");
      await context.set("count-2", "data", "agent1");

      const count = await context.getEntryCount();

      expect(count).toBe(2);
    });

    it("should return 0 when no entries", async () => {
      context = new RedisSharedContext(defaultConfig);

      const count = await context.getEntryCount();

      expect(count).toBe(0);
    });
  });

  describe("getKeys", () => {
    it("should return all keys", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("key-a", "data", "agent1");
      await context.set("key-b", "data", "agent1");

      const keys = await context.getKeys();

      expect(keys).toContain("key-a");
      expect(keys).toContain("key-b");
    });

    it("should filter by scope", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("global-k", "data", "agent1", ContextScope.GLOBAL);
      await context.set("private-k", "data", "agent1", ContextScope.PRIVATE);

      const globalKeys = await context.getKeys(ContextScope.GLOBAL);

      expect(globalKeys).toContain("global-k");
      expect(globalKeys).not.toContain("private-k");
    });
  });

  describe("shutdown", () => {
    it("should close Redis connection", async () => {
      context = new RedisSharedContext(defaultConfig);

      // Trigger connection
      await context.set("shutdown-key", "data", "agent1");

      await context.shutdown();

      expect(redisState.quit).toHaveBeenCalled();
    });

    it("should return empty results after shutdown", async () => {
      context = new RedisSharedContext(defaultConfig);

      await context.set("before-shutdown", "data", "agent1");
      await context.shutdown();

      const value = await context.get("before-shutdown", "agent1");
      expect(value).toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("should handle Redis connection failure gracefully", async () => {
      redisState.shouldFailConnect = true;
      context = new RedisSharedContext(defaultConfig);

      // Should not throw
      await context.set("fail-key", "data", "agent1");

      const value = await context.get("fail-key", "agent1");
      expect(value).toBeUndefined();
    });
  });

  describe("iteration limits", () => {
    it("should respect MAX_SCAN_ITERATIONS in query", async () => {
      context = new RedisSharedContext(defaultConfig);

      // Create many entries
      for (let i = 0; i < 10; i++) {
        await context.set(`bulk-key-${i}`, `data-${i}`, "agent1", ContextScope.GLOBAL);
      }

      const results = await context.query({}, "agent1");

      // Should return results without hanging
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
