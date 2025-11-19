/**
 * SmartBatcher Tests
 * Comprehensive test suite for the adaptive request batching system
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SmartBatcher } from "./SmartBatcher";

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

describe("SmartBatcher", () => {
  let batcher: SmartBatcher<any, any>;
  let processor: any;

  beforeEach(() => {
    vi.useFakeTimers();
    processor = vi.fn().mockImplementation(async (batch: any[]) => {
      return batch.map((item) => `processed-${item}`);
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe("batch processing", () => {
    it("should batch multiple requests", async () => {
      batcher = new SmartBatcher(processor, {
        maxBatchSize: 3,
        maxWaitMs: 100,
        minBatchSize: 2,
        adaptiveSizing: false,
      });

      const p1 = batcher.add(1);
      const p2 = batcher.add(2);
      const p3 = batcher.add(3);

      // Should execute immediately as maxBatchSize is 3
      const results = await Promise.all([p1, p2, p3]);

      expect(processor).toHaveBeenCalledTimes(1);
      expect(processor).toHaveBeenCalledWith([1, 2, 3]);
      expect(results).toEqual(["processed-1", "processed-2", "processed-3"]);
    });

    it("should process after maxWaitMs if minBatchSize not reached", async () => {
      batcher = new SmartBatcher(processor, {
        maxBatchSize: 10,
        maxWaitMs: 100,
        minBatchSize: 5,
        adaptiveSizing: false,
      });

      const p1 = batcher.add("item1");

      // Should not have processed yet
      expect(processor).not.toHaveBeenCalled();

      // Advance time
      vi.advanceTimersByTime(100);

      const result = await p1;
      expect(result).toBe("processed-item1");
      expect(processor).toHaveBeenCalledTimes(1);
    });

    it("should process immediately when maxBatchSize is reached", async () => {
      batcher = new SmartBatcher(processor, {
        maxBatchSize: 2,
        maxWaitMs: 1000,
        adaptiveSizing: false,
      });

      const p1 = batcher.add("item1");
      expect(processor).not.toHaveBeenCalled();

      const p2 = batcher.add("item2");

      // Should execute immediately
      const results = await Promise.all([p1, p2]);

      expect(processor).toHaveBeenCalledTimes(1);
      expect(results).toEqual(["processed-item1", "processed-item2"]);
    });
  });

  describe("error handling", () => {
    it("should handle processor errors", async () => {
      const errorProcessor = vi.fn().mockRejectedValue(new Error("Batch failed"));
      batcher = new SmartBatcher(errorProcessor, {
        maxBatchSize: 2,
        maxWaitMs: 100,
        adaptiveSizing: false,
      });

      const p1 = batcher.add("item1");
      const p2 = batcher.add("item2");

      await expect(p1).rejects.toThrow("Batch failed");
      await expect(p2).rejects.toThrow("Batch failed");
    });

    it("should handle mismatched result counts", async () => {
      const badProcessor = vi.fn().mockResolvedValue(["only-one"]);
      batcher = new SmartBatcher(badProcessor, {
        maxBatchSize: 2,
        maxWaitMs: 100,
        adaptiveSizing: false,
      });

      const p1 = batcher.add("item1");
      const p2 = batcher.add("item2");

      const expectedError = "Batch processor returned 1 outputs for 2 inputs";

      // Both should reject because the batch failed validation
      await expect(p1).rejects.toThrow(expectedError);
      await expect(p2).rejects.toThrow(expectedError);
    });
  });

  describe("adaptive sizing", () => {
    it("should initialize with adaptive sizing enabled", () => {
      batcher = new SmartBatcher(processor, {
        adaptiveSizing: true,
      });
      // We can't easily test internal state without exposing it, 
      // but we can verify it doesn't crash
      expect(batcher).toBeDefined();
    });
  });
});

describe("SmartBatcher Integration", () => {
  it("should work with real async operations", async () => {
    vi.useRealTimers();

    const apiProcessor = async (items: { id: number }[]) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return items.map(i => ({ id: i.id, processed: true }));
    };

    const batcher = new SmartBatcher(apiProcessor, {
      maxBatchSize: 5,
      maxWaitMs: 50,
    });

    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(batcher.add({ id: i }));
    }

    const results = await Promise.all(promises);
    expect(results).toHaveLength(10);
    expect(results[0].processed).toBe(true);
  });
});
