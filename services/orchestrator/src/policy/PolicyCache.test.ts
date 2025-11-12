import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisState = vi.hoisted(() => {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  const state = {
    store,
    shouldFailConnect: false,
    connect: vi.fn(async () => {
      if (state.shouldFailConnect) {
        throw new Error("connect failed");
      }
    }),
    quit: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    on: vi.fn(),
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) {
        return null;
      }
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
    }),
    createClient: vi.fn(() => ({
      connect: state.connect,
      quit: state.quit,
      disconnect: state.disconnect,
      on: state.on,
      get: state.get,
      set: state.set,
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
      state.createClient.mockClear();
    },
  };

  return state;
});

vi.mock("redis", () => ({
  createClient: redisState.createClient,
}));

import type { AppConfig } from "../config.js";
import { buildPolicyCacheKey, createPolicyDecisionCache } from "./PolicyCache.js";
import type { PolicyDecision } from "./PolicyEnforcer.js";

type PolicyCacheConfig = AppConfig["policy"]["cache"];

const allowDecision: PolicyDecision = { allow: true, deny: [] };

describe("buildPolicyCacheKey", () => {
  it("produces a stable key regardless of object property order", () => {
    const first = buildPolicyCacheKey({ a: 1, b: { c: 2, d: [3, 4] } });
    const second = buildPolicyCacheKey({ b: { d: [3, 4], c: 2 }, a: 1 });
    expect(first).toEqual(second);
  });
});

describe("MemoryPolicyDecisionCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it("evicts cached entries after the TTL expires", async () => {
    const config: PolicyCacheConfig = {
      enabled: true,
      provider: "memory",
      ttlSeconds: 2,
      maxEntries: 10,
    };
    const cache = createPolicyDecisionCache(config);
    expect(cache).not.toBeNull();
    await cache!.set("key", allowDecision);
    expect(await cache!.get("key")).toEqual(allowDecision);
    vi.advanceTimersByTime(2100);
    expect(await cache!.get("key")).toBeNull();
    await cache!.close?.();
  });

  it("trims the oldest entries when maxEntries is reached", async () => {
    const config: PolicyCacheConfig = {
      enabled: true,
      provider: "memory",
      ttlSeconds: 10,
      maxEntries: 2,
    };
    const cache = createPolicyDecisionCache(config);
    expect(cache).not.toBeNull();
    await cache!.set("first", allowDecision);
    await cache!.set("second", allowDecision);
    await cache!.set("third", allowDecision);

    expect(await cache!.get("first")).toBeNull();
    expect(await cache!.get("second")).toEqual(allowDecision);
    expect(await cache!.get("third")).toEqual(allowDecision);
    await cache!.close?.();
  });
});

describe("RedisPolicyDecisionCache", () => {
  beforeEach(() => {
    redisState.reset();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  const redisConfig: PolicyCacheConfig = {
    enabled: true,
    provider: "redis",
    ttlSeconds: 5,
    maxEntries: 2,
    redis: {
      url: "redis://localhost:6379/0",
      keyPrefix: "policy:decision",
    },
  };

  it("stores and retrieves decisions via redis with TTL", async () => {
    const cache = createPolicyDecisionCache(redisConfig);
    expect(cache).not.toBeNull();
    await cache!.set("redis-key", allowDecision);
    expect(redisState.set).toHaveBeenCalledWith(
      "policy:decision:redis-key",
      JSON.stringify(allowDecision),
      expect.objectContaining({ EX: 5 }),
    );
    expect(await cache!.get("redis-key")).toEqual(allowDecision);

    vi.advanceTimersByTime(6000);
    expect(await cache!.get("redis-key")).toBeNull();
    await cache!.close?.();
  });

  it("falls back to memory caching when redis is unavailable", async () => {
    redisState.shouldFailConnect = true;
    const cache = createPolicyDecisionCache(redisConfig);
    expect(cache).not.toBeNull();

    await cache!.set("one", allowDecision);
    await cache!.set("two", allowDecision);
    await cache!.set("three", allowDecision);

    expect(redisState.set).not.toHaveBeenCalled();
    expect(await cache!.get("one")).toBeNull();
    expect(await cache!.get("two")).toEqual(allowDecision);
    expect(await cache!.get("three")).toEqual(allowDecision);
    await cache!.close?.();
  });
});

describe("createPolicyDecisionCache", () => {
  it("returns null when the cache is disabled", () => {
    const config: PolicyCacheConfig = {
      enabled: false,
      provider: "memory",
      ttlSeconds: 60,
      maxEntries: 100,
    };
    expect(createPolicyDecisionCache(config)).toBeNull();
  });
});
