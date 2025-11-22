import { afterEach, describe, expect, it, vi } from "vitest";

import { PerSessionRateLimiter } from "./RateLimiter.js";

describe("PerSessionRateLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prunes stale session entries to keep memory bounded", () => {
    vi.useFakeTimers();
    const limiter = new PerSessionRateLimiter(2, 1_000);

    limiter.check("s1");
    limiter.check("s2");

    const internalLimits = (limiter as any).limits as Map<string, { windowStart: number; count: number }>;
    expect(internalLimits.size).toBe(2);

    // Advance beyond two windows so stale entries are removed during the next check.
    vi.advanceTimersByTime(2_500);

    limiter.check("s3");

    expect(internalLimits.size).toBe(1);
    expect(internalLimits.has("s3")).toBe(true);
  });
});

