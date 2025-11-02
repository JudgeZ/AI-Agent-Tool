import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderError } from "./utils.js";
import { CircuitBreaker, RateLimiter } from "./resilience.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("queues requests that exceed the configured rate", async () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 1 });
    const order: number[] = [];

    const first = limiter.schedule("provider", async () => {
      order.push(1);
      return 1;
    });

    await first;
    expect(order).toEqual([1]);

    const secondPromise = limiter.schedule("provider", async () => {
      order.push(2);
      return 2;
    });

    await Promise.resolve();
    expect(order).toEqual([1]);

    await vi.advanceTimersByTimeAsync(1000);
    const second = await secondPromise;

    expect(second).toBe(2);
    expect(order).toEqual([1, 2]);
  });
});

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("opens after consecutive failures and recovers after the reset window", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });

    await expect(
      breaker.execute("provider", async () => {
        throw new Error("first failure");
      })
    ).rejects.toThrow("first failure");

    await expect(
      breaker.execute("provider", async () => {
        throw new Error("second failure");
      })
    ).rejects.toThrow("second failure");

    await expect(
      breaker.execute("provider", async () => "should not run")
    ).rejects.toBeInstanceOf(ProviderError);

    await vi.advanceTimersByTimeAsync(1000);

    const result = await breaker.execute("provider", async () => "recovered");
    expect(result).toBe("recovered");
  });
});

