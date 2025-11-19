import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KafkaAdapter } from "./KafkaAdapter.js";
import {
  queueLagGauge,
  queuePartitionLagGauge,
  queueDepthGauge,
} from "../observability/metrics.js";
import type { Kafka, Producer, Consumer, Admin } from "kafkajs";

/**
 * HPA Integration Tests for Kafka Lag-Based Triggers
 *
 * These tests validate that:
 * 1. Kafka lag metrics are correctly exposed for HPA consumption
 * 2. Partition-level lag metrics are tracked accurately
 * 3. Queue depth metrics reflect actual message backlog
 * 4. Metrics are properly labeled for HPA selector matching
 * 5. Lag calculations handle edge cases (empty queues, consumer group offsets)
 */

describe("HPA Kafka Integration Tests", () => {
  let adapter: KafkaAdapter;
  let mockProducer: Producer;
  let mockConsumer: Consumer;
  let mockAdmin: Admin;
  let mockKafka: Kafka;

  beforeEach(() => {
    // Mock Kafka components
    mockProducer = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    } as any;

    mockConsumer = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue(undefined),
      commitOffsets: vi.fn().mockResolvedValue(undefined),
    } as any;

    mockAdmin = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      createTopics: vi.fn().mockResolvedValue(undefined),
      fetchTopicOffsets: vi.fn().mockResolvedValue([]),
      fetchOffsets: vi.fn().mockResolvedValue([]),
    } as any;

    mockKafka = {
      producer: vi.fn().mockReturnValue(mockProducer),
      consumer: vi.fn().mockReturnValue(mockConsumer),
      admin: vi.fn().mockReturnValue(mockAdmin),
    } as any;

    adapter = new KafkaAdapter({
      brokers: ["localhost:9092"],
      clientId: "test-client",
      groupId: "test-group",
      kafka: mockKafka,
      ensureTopics: false,
    });
  });

  afterEach(async () => {
    await adapter.close();
    vi.clearAllMocks();
  });

  describe("Kafka Lag Metric Exposure", () => {
    it("should expose orchestrator_queue_lag metric for HPA consumption", async () => {
      await adapter.connect();

      // Simulate topic with lag
      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "100", high: "100", low: "0" },
        { partition: 1, offset: "150", high: "150", low: "0" },
      ]);

      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [
            { partition: 0, offset: "80", metadata: null },
            { partition: 1, offset: "120", metadata: null },
          ],
        },
      ]);

      const depth = await adapter.getQueueDepth("plan.steps");

      // Total lag should be (100-80) + (150-120) = 50
      expect(depth).toBe(50);

      // Verify metric is set correctly for HPA to scrape
      const metrics = await queueLagGauge.get();
      const lagMetric = metrics.values.find(
        (v) =>
          v.labels.queue === "plan.steps" && v.labels.transport === "kafka",
      );
      expect(lagMetric).toBeDefined();
      expect(lagMetric?.value).toBe(50);
    });

    it("should expose per-partition lag metrics for granular HPA decisions", async () => {
      await adapter.connect();

      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "100", high: "100", low: "0" },
        { partition: 1, offset: "200", high: "200", low: "0" },
        { partition: 2, offset: "50", high: "50", low: "0" },
      ]);

      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [
            { partition: 0, offset: "90", metadata: null },
            { partition: 1, offset: "150", metadata: null },
            { partition: 2, offset: "50", metadata: null },
          ],
        },
      ]);

      await adapter.getQueueDepth("plan.steps");

      const metrics = await queuePartitionLagGauge.get();
      const partitionMetrics = metrics.values.filter(
        (v) =>
          v.labels.queue === "plan.steps" && v.labels.transport === "kafka",
      );

      // Should have 3 partition metrics
      expect(partitionMetrics).toHaveLength(3);

      // Verify individual partition lags
      const partition0 = partitionMetrics.find(
        (v) => v.labels.partition === "0",
      );
      const partition1 = partitionMetrics.find(
        (v) => v.labels.partition === "1",
      );
      const partition2 = partitionMetrics.find(
        (v) => v.labels.partition === "2",
      );

      expect(partition0?.value).toBe(10); // 100 - 90
      expect(partition1?.value).toBe(50); // 200 - 150
      expect(partition2?.value).toBe(0); // 50 - 50
    });

    it("should handle consumer group with no committed offsets", async () => {
      await adapter.connect();

      // Topic has messages but consumer group has never committed
      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "100", high: "100", low: "0" },
      ]);

      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [
            { partition: 0, offset: "-1", metadata: null }, // -1 indicates no committed offset
          ],
        },
      ]);

      const depth = await adapter.getQueueDepth("plan.steps");

      // When no offset is committed, lag should be 0 (consumer assumes latest)
      expect(depth).toBe(0);
    });

    it("should handle empty topic correctly", async () => {
      await adapter.connect();

      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "0", high: "0", low: "0" },
      ]);

      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [{ partition: 0, offset: "0", metadata: null }],
        },
      ]);

      const depth = await adapter.getQueueDepth("plan.steps");

      expect(depth).toBe(0);

      const metrics = await queueLagGauge.get();
      const lagMetric = metrics.values.find(
        (v) =>
          v.labels.queue === "plan.steps" && v.labels.transport === "kafka",
      );
      expect(lagMetric?.value).toBe(0);
    });
  });

  describe("HPA Metric Label Matching", () => {
    it("should expose metrics with labels matching HPA selector", async () => {
      await adapter.connect();

      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "50", high: "50", low: "0" },
      ]);

      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [{ partition: 0, offset: "25", metadata: null }],
        },
      ]);

      await adapter.getQueueDepth("plan.steps");

      const metrics = await queueLagGauge.get();
      const lagMetric = metrics.values.find(
        (v) => v.labels.queue === "plan.steps",
      );

      // Verify all required labels for HPA selector are present
      expect(lagMetric?.labels).toHaveProperty("queue", "plan.steps");
      expect(lagMetric?.labels).toHaveProperty("transport", "kafka");
      expect(lagMetric?.labels).toHaveProperty("tenant");
    });

    it("should update queue depth gauge for HPA depth-based scaling", async () => {
      await adapter.connect();

      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "100", high: "100", low: "0" },
      ]);

      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [{ partition: 0, offset: "60", metadata: null }],
        },
      ]);

      await adapter.getQueueDepth("plan.steps");

      const depthMetrics = await queueDepthGauge.get();
      const depthMetric = depthMetrics.values.find(
        (v) =>
          v.labels.queue === "plan.steps" && v.labels.transport === "kafka",
      );

      expect(depthMetric?.value).toBe(40);
    });
  });

  describe("Lag Calculation Edge Cases", () => {
    it("should handle consumer ahead of high watermark gracefully", async () => {
      await adapter.connect();

      // Edge case: consumer offset somehow ahead (should not happen in practice)
      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "100", high: "100", low: "0" },
      ]);

      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [{ partition: 0, offset: "150", metadata: null }], // Ahead somehow
        },
      ]);

      const depth = await adapter.getQueueDepth("plan.steps");

      // Should not return negative lag
      expect(depth).toBeGreaterThanOrEqual(0);
    });

    it("should handle multiple partitions with mixed lag states", async () => {
      await adapter.connect();

      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "100", high: "100", low: "0" }, // Some lag
        { partition: 1, offset: "50", high: "50", low: "0" }, // No lag
        { partition: 2, offset: "200", high: "200", low: "0" }, // High lag
      ]);

      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [
            { partition: 0, offset: "80", metadata: null }, // Lag: 20
            { partition: 1, offset: "50", metadata: null }, // Lag: 0
            { partition: 2, offset: "100", metadata: null }, // Lag: 100
          ],
        },
      ]);

      const depth = await adapter.getQueueDepth("plan.steps");

      expect(depth).toBe(120); // 20 + 0 + 100
    });

    it("should reset metrics to zero on connection failure", async () => {
      await adapter.connect();

      // First successful query
      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "100", high: "100", low: "0" },
      ]);

      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [{ partition: 0, offset: "50", metadata: null }],
        },
      ]);

      await adapter.getQueueDepth("plan.steps");

      // Simulate connection failure
      vi.mocked(mockAdmin.fetchTopicOffsets).mockRejectedValue(
        new Error("Connection lost"),
      );

      const depth = await adapter.getQueueDepth("plan.steps");

      expect(depth).toBe(0);

      const metrics = await queueLagGauge.get();
      const lagMetric = metrics.values.find(
        (v) =>
          v.labels.queue === "plan.steps" && v.labels.transport === "kafka",
      );
      expect(lagMetric?.value).toBe(0);
    });
  });

  describe("HPA Scaling Simulation", () => {
    it("should demonstrate lag increase triggering scale-up scenario", async () => {
      await adapter.connect();

      // Scenario: System under load, lag is increasing
      const lagSnapshots: number[] = [];

      // T0: Low lag
      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "10", high: "10", low: "0" },
      ]);
      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [{ partition: 0, offset: "8", metadata: null }],
        },
      ]);
      lagSnapshots.push(await adapter.getQueueDepth("plan.steps"));

      // T1: Medium lag (HPA target: 5)
      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "50", high: "50", low: "0" },
      ]);
      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [{ partition: 0, offset: "45", metadata: null }],
        },
      ]);
      lagSnapshots.push(await adapter.getQueueDepth("plan.steps"));

      // T2: High lag (should trigger scale-up)
      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "100", high: "100", low: "0" },
      ]);
      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [{ partition: 0, offset: "80", metadata: null }],
        },
      ]);
      lagSnapshots.push(await adapter.getQueueDepth("plan.steps"));

      expect(lagSnapshots).toEqual([2, 5, 20]);

      // If HPA target is 5 per pod:
      // At lag=2: 1 pod sufficient
      // At lag=5: 1 pod at target
      // At lag=20: Would trigger scale to 4 pods
      const targetLagPerPod = 5;
      const requiredPods = Math.ceil(lagSnapshots[2]! / targetLagPerPod);
      expect(requiredPods).toBe(4);
    });

    it("should demonstrate lag decrease triggering scale-down scenario", async () => {
      await adapter.connect();

      const lagSnapshots: number[] = [];

      // T0: High lag (scaled up)
      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "100", high: "100", low: "0" },
      ]);
      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [{ partition: 0, offset: "50", metadata: null }],
        },
      ]);
      lagSnapshots.push(await adapter.getQueueDepth("plan.steps"));

      // T1: Decreasing lag
      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "100", high: "100", low: "0" },
      ]);
      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [{ partition: 0, offset: "85", metadata: null }],
        },
      ]);
      lagSnapshots.push(await adapter.getQueueDepth("plan.steps"));

      // T2: Low lag (can scale down)
      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "100", high: "100", low: "0" },
      ]);
      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [{ partition: 0, offset: "98", metadata: null }],
        },
      ]);
      lagSnapshots.push(await adapter.getQueueDepth("plan.steps"));

      expect(lagSnapshots).toEqual([50, 15, 2]);

      const targetLagPerPod = 5;
      const initialPods = Math.ceil(lagSnapshots[0]! / targetLagPerPod);
      const finalPods = Math.max(
        Math.ceil(lagSnapshots[2]! / targetLagPerPod),
        2,
      ); // min 2 replicas

      expect(initialPods).toBe(10);
      expect(finalPods).toBe(2);
    });
  });

  describe("Multi-Tenant Metric Isolation", () => {
    it("should expose tenant label for multi-tenant HPA configurations", async () => {
      await adapter.connect();

      vi.mocked(mockAdmin.fetchTopicOffsets).mockResolvedValue([
        { partition: 0, offset: "50", high: "50", low: "0" },
      ]);

      vi.mocked(mockAdmin.fetchOffsets).mockResolvedValue([
        {
          topic: "plan.steps",
          partitions: [{ partition: 0, offset: "30", metadata: null }],
        },
      ]);

      await adapter.getQueueDepth("plan.steps");

      const metrics = await queueLagGauge.get();
      const lagMetric = metrics.values.find(
        (v) =>
          v.labels.queue === "plan.steps" && v.labels.transport === "kafka",
      );

      // Verify tenant label exists for potential tenant-specific HPA
      expect(lagMetric?.labels).toHaveProperty("tenant");
      expect(typeof lagMetric?.labels.tenant).toBe("string");
    });
  });
});
