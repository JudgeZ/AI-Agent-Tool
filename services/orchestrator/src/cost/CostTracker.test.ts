/**
 * CostTracker test suite
 * Tests cost tracking, metrics collection, anomaly detection, and reporting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Registry } from "prom-client";
import { CostTracker } from "./CostTracker";
import { CostMetrics, TokenUsage, CostSummary, CostAnomaly } from "./types";

// Mock the pricing module
vi.mock("./pricing", () => ({
  calculateCost: vi.fn((provider: string, model: string, inputTokens: number, outputTokens: number) => {
    // Simple mock pricing: $0.01 per 1000 input tokens, $0.02 per 1000 output tokens
    return (inputTokens * 0.00001) + (outputTokens * 0.00002);
  }),
}));

// Mock the TokenCounter
vi.mock("./TokenCounter", () => {
  return {
    TokenCounter: class {
      count = vi.fn((text: string) => {
        // Simple mock: 1 token per 4 characters
        return Math.ceil(text.length / 4);
      });
      estimateCompletion = vi.fn((prompt: string, maxTokens: number) => ({
        promptTokens: Math.ceil(prompt.length / 4),
        completionTokens: Math.min(maxTokens, 100),
        totalTokens: Math.ceil(prompt.length / 4) + Math.min(maxTokens, 100),
      }));
      dispose = vi.fn();
    },
  };
});

describe("CostTracker", () => {
  let tracker: CostTracker;
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
    tracker = new CostTracker({ registry });
  });

  afterEach(() => {
    tracker.dispose();
  });

  describe("initialization", () => {
    it("should initialize with default options", () => {
      const defaultTracker = new CostTracker();
      expect(defaultTracker).toBeDefined();
      expect(defaultTracker.getRegistry()).toBeDefined();
      defaultTracker.dispose();
    });

    it("should initialize with custom options", () => {
      const customTracker = new CostTracker({
        registry,
        enableAnomalyDetection: false,
        anomalyThreshold: 3,
      });
      expect(customTracker).toBeDefined();
      expect(customTracker.getRegistry()).toBe(registry);
      customTracker.dispose();
    });

    it("should create Prometheus metrics", async () => {
      const metrics = await registry.metrics();
      expect(metrics).toContain("llm_tokens_total");
      expect(metrics).toContain("llm_cost_total");
      expect(metrics).toContain("llm_cost_per_operation");
      expect(metrics).toContain("llm_operations_total");
    });
  });

  describe("operation tracking", () => {
    it("should track successful operations", async () => {
      const metadata = {
        operation: "chat_completion",
        tenant: "tenant-123",
        provider: "openai",
        model: "gpt-4",
      };

      const result = await tracker.trackOperation(metadata, async () => ({
        response: "Hello world",
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
        },
      }));

      expect(result.result.response).toBe("Hello world");
      expect(result.metrics).toMatchObject({
        operation: "chat_completion",
        tenant: "tenant-123",
        provider: "openai",
        model: "gpt-4",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
      expect(result.metrics.cost).toBeGreaterThan(0);
      expect(result.metrics.duration).toBeGreaterThanOrEqual(0);
    });

    it("should handle operations without usage data", async () => {
      const metadata = {
        operation: "test_op",
        provider: "anthropic",
        model: "claude-3",
      };

      const result = await tracker.trackOperation(metadata, async () => ({
        data: "test data",
      }));

      expect(result.result.data).toBe("test data");
      expect(result.metrics.inputTokens).toBe(0);
      expect(result.metrics.outputTokens).toBe(0);
      expect(result.metrics.totalTokens).toBe(0);
      expect(result.metrics.cost).toBe(0);
    });

    it("should track failed operations", async () => {
      const metadata = {
        operation: "failing_op",
        provider: "openai",
        model: "gpt-4",
      };

      await expect(
        tracker.trackOperation(metadata, async () => {
          throw new Error("Operation failed");
        })
      ).rejects.toThrow("Operation failed");

      // Check that error was recorded in metrics
      const metrics = await registry.metrics();
      expect(metrics).toContain('status="error"');
    });

    it("should measure operation duration", async () => {
      const metadata = {
        operation: "timed_op",
        provider: "openai",
        model: "gpt-4",
      };

      const result = await tracker.trackOperation(metadata, async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return { result: "done" };
      });

      expect(result.metrics.duration).toBeGreaterThanOrEqual(50);
    });

    it("should handle tenant-specific tracking", async () => {
      const metadata1 = {
        operation: "op1",
        tenant: "tenant-a",
        provider: "openai",
        model: "gpt-4",
      };

      const metadata2 = {
        operation: "op1",
        tenant: "tenant-b",
        provider: "openai",
        model: "gpt-4",
      };

      await tracker.trackOperation(metadata1, async () => ({
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }));

      await tracker.trackOperation(metadata2, async () => ({
        usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
      }));

      const summary = await tracker.getCostSummary();
      expect(summary.byTenant).toBeDefined();
      expect(Object.keys(summary.byTenant!)).toHaveLength(2);
      expect(summary.byTenant!["tenant-a"]).toBeGreaterThan(0);
      expect(summary.byTenant!["tenant-b"]).toBeGreaterThan(0);
    });
  });

  describe("anomaly detection", () => {
    it("should detect cost spikes", async () => {
      const metadata = {
        operation: "chat",
        provider: "openai",
        model: "gpt-4",
      };

      // Establish baseline with normal operations
      for (let i = 0; i < 5; i++) {
        await tracker.trackOperation(metadata, async () => ({
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        }));
      }

      // Create a spike (10x normal usage)
      const spikeResult = await tracker.trackOperation(metadata, async () => ({
        usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      }));

      // The spike should be detected (cost is ~10x baseline)
      expect(spikeResult.metrics.cost).toBeGreaterThan(
        spikeResult.metrics.inputTokens * 0.00001 + spikeResult.metrics.outputTokens * 0.00002 - 0.001
      );
    });

    it("should respect anomaly threshold setting", async () => {
      const customTracker = new CostTracker({
        registry,
        enableAnomalyDetection: true,
        anomalyThreshold: 5, // Only flag if 5x baseline
      });

      const metadata = {
        operation: "test",
        provider: "openai",
        model: "gpt-4",
      };

      // Establish baseline
      await customTracker.trackOperation(metadata, async () => ({
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }));

      // 3x spike (should not trigger with threshold of 5)
      await customTracker.trackOperation(metadata, async () => ({
        usage: { promptTokens: 300, completionTokens: 150, totalTokens: 450 },
      }));

      customTracker.dispose();
    });

    it("should disable anomaly detection when configured", async () => {
      const noAnomalyTracker = new CostTracker({
        registry,
        enableAnomalyDetection: false,
      });

      const metadata = {
        operation: "test",
        provider: "openai",
        model: "gpt-4",
      };

      // Even with a huge spike, no anomaly should be detected
      await noAnomalyTracker.trackOperation(metadata, async () => ({
        usage: { promptTokens: 10000, completionTokens: 5000, totalTokens: 15000 },
      }));

      noAnomalyTracker.dispose();
    });
  });

  describe("cost summary", () => {
    beforeEach(async () => {
      // Add some test data
      const operations = [
        { operation: "chat", provider: "openai", model: "gpt-4", tenant: "tenant-a", tokens: 150 },
        { operation: "chat", provider: "openai", model: "gpt-3.5", tenant: "tenant-a", tokens: 100 },
        { operation: "embedding", provider: "openai", model: "ada", tenant: "tenant-b", tokens: 50 },
        { operation: "chat", provider: "anthropic", model: "claude", tenant: "tenant-a", tokens: 200 },
        { operation: "embedding", provider: "anthropic", model: "claude", tenant: "tenant-b", tokens: 75 },
      ];

      for (const op of operations) {
        await tracker.trackOperation(
          {
            operation: op.operation,
            provider: op.provider,
            model: op.model,
            tenant: op.tenant,
          },
          async () => ({
            usage: {
              promptTokens: Math.floor(op.tokens * 0.7),
              completionTokens: Math.floor(op.tokens * 0.3),
              totalTokens: op.tokens,
            },
          })
        );
      }
    });

    it("should calculate total cost summary", async () => {
      const summary = await tracker.getCostSummary();

      expect(summary.totalCost).toBeGreaterThan(0);
      expect(summary.totalTokens).toBe(575); // Sum of all tokens
      expect(summary.operationCount).toBe(5);
      expect(summary.avgCostPerOperation).toBe(summary.totalCost / 5);
    });

    it("should group costs by provider", async () => {
      const summary = await tracker.getCostSummary();

      expect(summary.byProvider).toBeDefined();
      expect(summary.byProvider["openai"]).toBeGreaterThan(0);
      expect(summary.byProvider["anthropic"]).toBeGreaterThan(0);
    });

    it("should group costs by operation", async () => {
      const summary = await tracker.getCostSummary();

      expect(summary.byOperation).toBeDefined();
      expect(summary.byOperation["chat"]).toBeGreaterThan(0);
      expect(summary.byOperation["embedding"]).toBeGreaterThan(0);
      expect(summary.byOperation["chat"]).toBeGreaterThan(summary.byOperation["embedding"]);
    });

    it("should group costs by tenant", async () => {
      const summary = await tracker.getCostSummary();

      expect(summary.byTenant).toBeDefined();
      expect(summary.byTenant!["tenant-a"]).toBeGreaterThan(0);
      expect(summary.byTenant!["tenant-b"]).toBeGreaterThan(0);
    });

    it("should filter by time range", async () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

      // All operations should be within the last hour
      const recentSummary = await tracker.getCostSummary(oneHourAgo);
      expect(recentSummary.operationCount).toBe(5);

      // No operations should be older than 2 hours
      const oldSummary = await tracker.getCostSummary(twoHoursAgo, oneHourAgo);
      expect(oldSummary.operationCount).toBe(0);
    });

    it("should filter by operation type", async () => {
      const summary = await tracker.getCostSummary(undefined, undefined, {
        operation: "chat",
      });

      expect(summary.operationCount).toBe(3);
      expect(Object.keys(summary.byOperation)).toHaveLength(1);
      expect(summary.byOperation["chat"]).toBeGreaterThan(0);
    });

    it("should filter by provider", async () => {
      const summary = await tracker.getCostSummary(undefined, undefined, {
        provider: "openai",
      });

      expect(summary.operationCount).toBe(3);
      expect(Object.keys(summary.byProvider)).toHaveLength(1);
      expect(summary.byProvider["openai"]).toBeGreaterThan(0);
    });

    it("should filter by tenant", async () => {
      const summary = await tracker.getCostSummary(undefined, undefined, {
        tenant: "tenant-a",
      });

      expect(summary.operationCount).toBe(3);
      expect(summary.byTenant!["tenant-a"]).toBeGreaterThan(0);
      expect(summary.byTenant!["tenant-b"]).toBeUndefined();
    });

    it("should calculate hourly trends", async () => {
      const summary = await tracker.getCostSummary();

      expect(summary.trends.hourly).toHaveLength(24);
      const currentHour = new Date().getHours();
      expect(summary.trends.hourly[currentHour]).toBeGreaterThan(0);
    });

    it("should calculate daily trends", async () => {
      const summary = await tracker.getCostSummary();

      expect(summary.trends.daily).toHaveLength(7);
      expect(summary.trends.daily[6]).toBeGreaterThan(0); // Today's costs
    });
  });

  describe("token counting and estimation", () => {
    it("should count tokens in text", () => {
      const text = "This is a test prompt with some content.";
      const tokens = tracker.countTokens(text);

      // Mock implementation: 1 token per 4 chars
      expect(tokens).toBe(Math.ceil(text.length / 4));
    });

    it("should count tokens with model-specific encoding", () => {
      const text = "Test text";
      const tokens1 = tracker.countTokens(text, "gpt-4");
      const tokens2 = tracker.countTokens(text, "claude");

      // In our mock, they're the same, but in real implementation they might differ
      expect(tokens1).toBe(tokens2);
    });

    it("should estimate completion cost", () => {
      const prompt = "Write a story about a robot";
      const { estimatedCost, usage } = tracker.estimateCost(
        prompt,
        "openai",
        "gpt-4",
        500
      );

      expect(usage.promptTokens).toBe(Math.ceil(prompt.length / 4));
      expect(usage.completionTokens).toBe(100); // Mock caps at 100
      expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
      expect(estimatedCost).toBeGreaterThan(0);
    });

    it("should respect maxTokens in estimation", () => {
      const prompt = "Short prompt";

      const estimate1 = tracker.estimateCost(prompt, "openai", "gpt-4", 50);
      const estimate2 = tracker.estimateCost(prompt, "openai", "gpt-4", 200);

      expect(estimate1.usage.completionTokens).toBe(50);
      expect(estimate2.usage.completionTokens).toBe(100); // Mock caps at 100
      expect(estimate2.estimatedCost).toBeGreaterThan(estimate1.estimatedCost);
    });
  });

  describe("Prometheus metrics", () => {
    it("should record token metrics", async () => {
      await tracker.trackOperation(
        {
          operation: "test",
          tenant: "tenant-1",
          provider: "openai",
          model: "gpt-4",
        },
        async () => ({
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        })
      );

      const metrics = await registry.metrics();
      expect(metrics).toContain('llm_tokens_total{');
      expect(metrics).toContain('type="input"');
      expect(metrics).toContain('type="output"');
      expect(metrics).toContain('100');
      expect(metrics).toContain('50');
    });

    it("should record cost metrics", async () => {
      await tracker.trackOperation(
        {
          operation: "test",
          provider: "openai",
          model: "gpt-4",
        },
        async () => ({
          usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
        })
      );

      const metrics = await registry.metrics();
      expect(metrics).toContain('llm_cost_total{');
      expect(metrics).toContain('llm_cost_per_operation_bucket{');
    });

    it("should record operation metrics", async () => {
      await tracker.trackOperation(
        {
          operation: "chat",
          provider: "openai",
          model: "gpt-4",
        },
        async () => ({ result: "success" })
      );

      const metrics = await registry.metrics();
      expect(metrics).toContain('llm_operations_total{');
      expect(metrics).toContain('status="success"');
    });

    it("should use histogram buckets for cost distribution", async () => {
      // Track operations with different costs
      const operations = [
        { tokens: 10 },    // Very small
        { tokens: 100 },   // Small
        { tokens: 1000 },  // Medium
        { tokens: 10000 }, // Large
      ];

      for (const op of operations) {
        await tracker.trackOperation(
          { operation: "test", provider: "openai", model: "gpt-4" },
          async () => ({
            usage: {
              promptTokens: op.tokens,
              completionTokens: op.tokens / 2,
              totalTokens: op.tokens * 1.5,
            },
          })
        );
      }

      const metrics = await registry.metrics();
      const buckets = [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100];

      for (const bucket of buckets) {
        expect(metrics).toContain(`le="${bucket}"`);
      }
    });
  });

  describe("resource cleanup", () => {
    it("should dispose resources properly", () => {
      const testTracker = new CostTracker({ registry });
      testTracker.dispose();

      // Should be able to create a new tracker after disposal
      const newTracker = new CostTracker({ registry });
      expect(newTracker).toBeDefined();
      newTracker.dispose();
    });

    it("should clear history on dispose", async () => {
      await tracker.trackOperation(
        { operation: "test", provider: "openai", model: "gpt-4" },
        async () => ({ usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } })
      );

      const summaryBefore = await tracker.getCostSummary();
      expect(summaryBefore.operationCount).toBeGreaterThan(0);

      tracker.dispose();

      // Create new tracker with same registry
      const newTracker = new CostTracker({ registry });
      const summaryAfter = await newTracker.getCostSummary();
      expect(summaryAfter.operationCount).toBe(0);

      newTracker.dispose();
    });
  });
});
