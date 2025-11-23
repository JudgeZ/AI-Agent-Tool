import { afterEach, describe, expect, it, vi } from "vitest";

import { createRateLimitStore } from "../rateLimit/store.js";
import { PerSessionRateLimiter, resolveBackendFromEnv } from "./RateLimiter.js";

describe("PerSessionRateLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares limits across instances when using a shared store", async () => {
    const store = createRateLimitStore({ provider: "memory" }, { prefix: "test:shared" });
    const first = new PerSessionRateLimiter(1, 1_000, { store });
    const second = new PerSessionRateLimiter(1, 1_000, { store });

    const firstDecision = await first.check("session-1");
    const secondDecision = await second.check("session-1");

    expect(firstDecision.allowed).toBe(true);
    expect(secondDecision.allowed).toBe(false);
  });

  it("resets counts via the underlying store", async () => {
    const store = createRateLimitStore({ provider: "memory" }, { prefix: "test:reset" });
    const limiter = new PerSessionRateLimiter(1, 1_000, { store });

    await limiter.check("session-1");
    const blocked = await limiter.check("session-1");
    expect(blocked.allowed).toBe(false);

    await limiter.reset("session-1");
    const allowedAfterReset = await limiter.check("session-1");
    expect(allowedAfterReset.allowed).toBe(true);
  });
});

describe("resolveBackendFromEnv", () => {
  it("defaults to memory when no backend is configured", () => {
    expect(resolveBackendFromEnv({} as NodeJS.ProcessEnv)).toEqual({ provider: "memory" });
  });

  it("prefers redis when a redis url is provided", () => {
    const env = {
      ORCHESTRATOR_RATE_LIMIT_REDIS_URL: "redis://example:6379",
    } satisfies NodeJS.ProcessEnv;

    expect(resolveBackendFromEnv(env)).toEqual({ provider: "redis", redisUrl: "redis://example:6379" });
  });

  it("falls back to memory when redis is requested without a url", () => {
    const env = {
      ORCHESTRATOR_RATE_LIMIT_BACKEND: "redis",
    } satisfies NodeJS.ProcessEnv;

    expect(resolveBackendFromEnv(env)).toEqual({ provider: "memory" });
  });
});
