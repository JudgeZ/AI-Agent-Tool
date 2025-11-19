/**
 * RequestCoalescer test suite
 * Tests request deduplication and coalescing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RequestCoalescer } from "./RequestCoalescer";

// Mock logger
vi.mock("../observability/logger", () => ({
  appLogger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

// Mock metrics
vi.mock("../observability/metrics", () => ({
  recordMetric: vi.fn(),
}));

describe("RequestCoalescer", () => {
  let coalescer: RequestCoalescer;

  beforeEach(() => {
    // Use real timers for reliable async testing
    vi.useRealTimers();
    coalescer = new RequestCoalescer({
      windowMs: 100,
      maxCoalesced: 10,
      enableMetrics: false,
    });
  });

  afterEach(() => {
    // No cleanup needed for real timers
  });

  describe("execute", () => {
    it("should execute function and return result", async () => {
      const mockFn = vi.fn().mockResolvedValue("result");
      const result = await coalescer.execute("key1", mockFn);
      expect(result).toBe("result");
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("should coalesce duplicate in-flight requests within window", async () => {
      const mockFn = vi.fn().mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve("result"), 50))
      );

      // Start multiple requests with same key simultaneously
      const p1 = coalescer.execute("same-key", mockFn);
      const p2 = coalescer.execute("same-key", mockFn);
      const p3 = coalescer.execute("same-key", mockFn);

      const results = await Promise.all([p1, p2, p3]);

      // All should get same result
      expect(results).toEqual(["result", "result", "result"]);

      // Function should only be called once
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("should coalesce requests using object keys", async () => {
      const mockFn = vi.fn().mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve("result"), 50))
      );

      const key = { id: 1, type: "test" };

      const p1 = coalescer.execute(key, mockFn);
      const p2 = coalescer.execute(key, mockFn);

      await Promise.all([p1, p2]);

      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("should not coalesce requests with different keys", async () => {
      const mockFn = vi.fn().mockResolvedValue("result");

      const p1 = coalescer.execute("key1", mockFn);
      const p2 = coalescer.execute("key2", mockFn);

      await Promise.all([p1, p2]);

      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it("should handle function errors", async () => {
      const mockFn = vi.fn().mockRejectedValue(new Error("Test error"));
      await expect(coalescer.execute("error-key", mockFn)).rejects.toThrow("Test error");
    });

    it("should propagate errors to all coalesced requests", async () => {
      const mockFn = vi.fn().mockImplementation(() =>
        new Promise((_, reject) => setTimeout(() => reject(new Error("Test error")), 50))
      );

      const p1 = coalescer.execute("error-key", mockFn);
      const p2 = coalescer.execute("error-key", mockFn);

      await expect(p1).rejects.toThrow("Test error");
      await expect(p2).rejects.toThrow("Test error");
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("should not coalesce if window has passed", async () => {
      const mockFn = vi.fn().mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve("result"), 200))
      );

      // First request
      const p1 = coalescer.execute("key", mockFn);

      // Wait past window (100ms)
      await new Promise(resolve => setTimeout(resolve, 150));

      // Second request - should NOT coalesce because window passed
      const p2 = coalescer.execute("key", mockFn);

      await Promise.all([p1, p2]);

      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });
});
