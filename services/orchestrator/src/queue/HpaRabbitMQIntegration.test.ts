import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RabbitMQAdapter } from "./RabbitMQAdapter.js";
import { queueDepthGauge, queueLagGauge } from "../observability/metrics.js";
import type { Channel, ChannelModel } from "amqplib";

/**
 * HPA Integration Tests for RabbitMQ Depth-Based Triggers
 *
 * These tests validate that:
 * 1. RabbitMQ queue depth metrics are correctly exposed for HPA consumption
 * 2. Queue depth reflects actual message backlog in RabbitMQ
 * 3. Metrics are properly labeled for HPA selector matching
 * 4. Lag metrics mirror depth metrics for consistency with Kafka adapter
 * 5. Depth calculations handle edge cases (connection failures, empty queues)
 */

describe("HPA RabbitMQ Integration Tests", () => {
  let adapter: RabbitMQAdapter;
  let mockConnection: ChannelModel;
  let mockChannel: Channel;
  let mockAmqp: any;

  beforeEach(() => {
    // Mock RabbitMQ channel
    mockChannel = {
      assertQueue: vi.fn().mockResolvedValue({ queue: "test-queue", messageCount: 0, consumerCount: 0 }),
      checkQueue: vi.fn().mockResolvedValue({ queue: "test-queue", messageCount: 0, consumerCount: 0 }),
      consume: vi.fn().mockResolvedValue({ consumerTag: "test-consumer" }),
      sendToQueue: vi.fn().mockReturnValue(true),
      ack: vi.fn(),
      nack: vi.fn(),
      prefetch: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    } as any;

    // Mock RabbitMQ connection
    mockConnection = {
      createChannel: vi.fn().mockResolvedValue(mockChannel),
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn()
    } as any;

    // Mock amqplib
    mockAmqp = {
      connect: vi.fn().mockResolvedValue(mockConnection)
    };

    adapter = new RabbitMQAdapter({
      url: "amqp://localhost:5672",
      amqplib: mockAmqp
    });
  });

  afterEach(async () => {
    await adapter.close();
    vi.clearAllMocks();
  });

  describe("RabbitMQ Depth Metric Exposure", () => {
    it("should expose orchestrator_queue_depth metric for HPA consumption", async () => {
      await adapter.connect();

      // Simulate queue with backlog
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 25,
        consumerCount: 2
      } as any);

      const depth = await adapter.getQueueDepth("plan.steps");

      expect(depth).toBe(25);

      // Verify metric is set correctly for HPA to scrape
      const metrics = await queueDepthGauge.get();
      const depthMetric = metrics.values.find(
        v => v.labels.queue === "plan.steps" && v.labels.transport === "rabbitmq"
      );
      expect(depthMetric).toBeDefined();
      expect(depthMetric?.value).toBe(25);
    });

    it("should expose orchestrator_queue_lag metric mirroring depth for consistency", async () => {
      await adapter.connect();

      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 42,
        consumerCount: 3
      } as any);

      const depth = await adapter.getQueueDepth("plan.steps");

      expect(depth).toBe(42);

      // RabbitMQ adapter sets lag = depth for consistency with Kafka adapter
      const lagMetrics = await queueLagGauge.get();
      const lagMetric = lagMetrics.values.find(
        v => v.labels.queue === "plan.steps" && v.labels.transport === "rabbitmq"
      );
      expect(lagMetric).toBeDefined();
      expect(lagMetric?.value).toBe(42);
    });

    it("should handle empty queue correctly", async () => {
      await adapter.connect();

      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 0,
        consumerCount: 2
      } as any);

      const depth = await adapter.getQueueDepth("plan.steps");

      expect(depth).toBe(0);

      const metrics = await queueDepthGauge.get();
      const depthMetric = metrics.values.find(
        v => v.labels.queue === "plan.steps" && v.labels.transport === "rabbitmq"
      );
      expect(depthMetric?.value).toBe(0);
    });

    it("should handle queue that doesn't exist yet", async () => {
      await adapter.connect();

      vi.mocked(mockChannel.checkQueue).mockRejectedValue(new Error("Queue not found"));

      const depth = await adapter.getQueueDepth("nonexistent.queue");

      // Should return 0 on error rather than throwing
      expect(depth).toBe(0);
    });
  });

  describe("HPA Metric Label Matching", () => {
    it("should expose metrics with labels matching HPA selector", async () => {
      await adapter.connect();

      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 15,
        consumerCount: 1
      } as any);

      await adapter.getQueueDepth("plan.steps");

      const metrics = await queueDepthGauge.get();
      const depthMetric = metrics.values.find(
        v => v.labels.queue === "plan.steps"
      );

      // Verify all required labels for HPA selector are present
      expect(depthMetric?.labels).toHaveProperty("queue", "plan.steps");
      expect(depthMetric?.labels).toHaveProperty("transport", "rabbitmq");
      expect(depthMetric?.labels).toHaveProperty("tenant");
    });

    it("should allow HPA to target specific queues via label selector", async () => {
      await adapter.connect();

      // Multiple queues with different depths
      vi.mocked(mockChannel.checkQueue)
        .mockResolvedValueOnce({
          queue: "plan.steps",
          messageCount: 50,
          consumerCount: 2
        } as any)
        .mockResolvedValueOnce({
          queue: "plan.completions",
          messageCount: 5,
          consumerCount: 2
        } as any);

      await adapter.getQueueDepth("plan.steps");
      await adapter.getQueueDepth("plan.completions");

      const metrics = await queueDepthGauge.get();

      const stepsMetric = metrics.values.find(
        v => v.labels.queue === "plan.steps" && v.labels.transport === "rabbitmq"
      );
      const completionsMetric = metrics.values.find(
        v => v.labels.queue === "plan.completions" && v.labels.transport === "rabbitmq"
      );

      expect(stepsMetric?.value).toBe(50);
      expect(completionsMetric?.value).toBe(5);

      // HPA can target plan.steps specifically with selector:
      // queue=plan.steps,transport=rabbitmq
    });
  });

  describe("Depth Calculation Edge Cases", () => {
    it("should handle connection failure gracefully", async () => {
      await adapter.connect();

      // Simulate connection loss
      vi.mocked(mockChannel.checkQueue).mockRejectedValue(new Error("Connection closed"));

      const depth = await adapter.getQueueDepth("plan.steps");

      expect(depth).toBe(0);

      // Metrics should be reset to 0 on error
      const metrics = await queueDepthGauge.get();
      const depthMetric = metrics.values.find(
        v => v.labels.queue === "plan.steps" && v.labels.transport === "rabbitmq"
      );
      expect(depthMetric?.value).toBe(0);
    });

    it("should handle very large queue depths", async () => {
      await adapter.connect();

      // Simulate backlog of 10,000 messages
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 10000,
        consumerCount: 5
      } as any);

      const depth = await adapter.getQueueDepth("plan.steps");

      expect(depth).toBe(10000);

      const metrics = await queueDepthGauge.get();
      const depthMetric = metrics.values.find(
        v => v.labels.queue === "plan.steps" && v.labels.transport === "rabbitmq"
      );
      expect(depthMetric?.value).toBe(10000);
    });

    it("should handle messageCount as non-number gracefully", async () => {
      await adapter.connect();

      // Edge case: messageCount is undefined or non-numeric
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: undefined as any,
        consumerCount: 2
      } as any);

      const depth = await adapter.getQueueDepth("plan.steps");

      expect(depth).toBe(0);
    });
  });

  describe("HPA Scaling Simulation", () => {
    it("should demonstrate depth increase triggering scale-up scenario", async () => {
      await adapter.connect();

      const depthSnapshots: number[] = [];

      // T0: Low depth (under target)
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 3,
        consumerCount: 2
      } as any);
      depthSnapshots.push(await adapter.getQueueDepth("plan.steps"));

      // T1: At target
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 10,
        consumerCount: 2
      } as any);
      depthSnapshots.push(await adapter.getQueueDepth("plan.steps"));

      // T2: Above target (should trigger scale-up)
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 40,
        consumerCount: 2
      } as any);
      depthSnapshots.push(await adapter.getQueueDepth("plan.steps"));

      expect(depthSnapshots).toEqual([3, 10, 40]);

      // If HPA target is 5 messages per pod:
      // At depth=3: 1 pod sufficient
      // At depth=10: 2 pods needed
      // At depth=40: 8 pods needed
      const targetDepthPerPod = 5;
      const requiredPods = Math.ceil(depthSnapshots[2]! / targetDepthPerPod);
      expect(requiredPods).toBe(8);
    });

    it("should demonstrate depth decrease triggering scale-down scenario", async () => {
      await adapter.connect();

      const depthSnapshots: number[] = [];

      // T0: High depth (scaled up to handle load)
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 100,
        consumerCount: 10
      } as any);
      depthSnapshots.push(await adapter.getQueueDepth("plan.steps"));

      // T1: Decreasing depth (processing faster than enqueueing)
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 30,
        consumerCount: 10
      } as any);
      depthSnapshots.push(await adapter.getQueueDepth("plan.steps"));

      // T2: Low depth (can scale down)
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 5,
        consumerCount: 10
      } as any);
      depthSnapshots.push(await adapter.getQueueDepth("plan.steps"));

      expect(depthSnapshots).toEqual([100, 30, 5]);

      const targetDepthPerPod = 5;
      const initialPods = Math.ceil(depthSnapshots[0]! / targetDepthPerPod);
      const finalPods = Math.max(Math.ceil(depthSnapshots[2]! / targetDepthPerPod), 2); // min 2 replicas

      expect(initialPods).toBe(20);
      expect(finalPods).toBe(2); // Scale down to minimum
    });

    it("should demonstrate steady-state with optimal pod count", async () => {
      await adapter.connect();

      // HPA target: 5 messages per pod
      // Current: 25 messages, 5 pods = exactly at target
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 25,
        consumerCount: 5
      } as any);

      const depth = await adapter.getQueueDepth("plan.steps");

      expect(depth).toBe(25);

      const targetDepthPerPod = 5;
      const currentPods = 5;
      const desiredPods = Math.ceil(depth / targetDepthPerPod);

      // HPA should maintain current pod count (no scaling action)
      expect(desiredPods).toBe(currentPods);
    });
  });

  describe("Multi-Queue HPA Scenarios", () => {
    it("should expose independent metrics for different queues", async () => {
      await adapter.connect();

      // Different queues can have different HPA configurations
      vi.mocked(mockChannel.checkQueue)
        .mockResolvedValueOnce({
          queue: "plan.steps",
          messageCount: 50,
          consumerCount: 5
        } as any)
        .mockResolvedValueOnce({
          queue: "plan.completions",
          messageCount: 10,
          consumerCount: 2
        } as any)
        .mockResolvedValueOnce({
          queue: "plan.approvals",
          messageCount: 100,
          consumerCount: 10
        } as any);

      await adapter.getQueueDepth("plan.steps");
      await adapter.getQueueDepth("plan.completions");
      await adapter.getQueueDepth("plan.approvals");

      const metrics = await queueDepthGauge.get();

      const stepsMetric = metrics.values.find(
        v => v.labels.queue === "plan.steps" && v.labels.transport === "rabbitmq"
      );
      const completionsMetric = metrics.values.find(
        v => v.labels.queue === "plan.completions" && v.labels.transport === "rabbitmq"
      );
      const approvalsMetric = metrics.values.find(
        v => v.labels.queue === "plan.approvals" && v.labels.transport === "rabbitmq"
      );

      expect(stepsMetric?.value).toBe(50);
      expect(completionsMetric?.value).toBe(10);
      expect(approvalsMetric?.value).toBe(100);

      // Each queue can have its own HPA with different targets
      // plan.steps: target=10 → needs 5 pods
      // plan.completions: target=5 → needs 2 pods
      // plan.approvals: target=20 → needs 5 pods
    });
  });

  describe("HPA Behavior Under Connection Issues", () => {
    it("should reset metrics to zero when connection is lost", async () => {
      await adapter.connect();

      // First, establish a baseline depth
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 30,
        consumerCount: 3
      } as any);

      let depth = await adapter.getQueueDepth("plan.steps");
      expect(depth).toBe(30);

      // Simulate connection loss
      vi.mocked(mockChannel.checkQueue).mockRejectedValue(new Error("Channel closed"));

      depth = await adapter.getQueueDepth("plan.steps");
      expect(depth).toBe(0);

      // HPA should see depth=0, which will trigger scale-down
      const metrics = await queueDepthGauge.get();
      const depthMetric = metrics.values.find(
        v => v.labels.queue === "plan.steps" && v.labels.transport === "rabbitmq"
      );
      expect(depthMetric?.value).toBe(0);
    });

    it("should recover metrics after reconnection", async () => {
      await adapter.connect();

      // Connection fails
      vi.mocked(mockChannel.checkQueue).mockRejectedValueOnce(new Error("Connection lost"));
      let depth = await adapter.getQueueDepth("plan.steps");
      expect(depth).toBe(0);

      // Connection recovers
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 45,
        consumerCount: 4
      } as any);

      depth = await adapter.getQueueDepth("plan.steps");
      expect(depth).toBe(45);

      const metrics = await queueDepthGauge.get();
      const depthMetric = metrics.values.find(
        v => v.labels.queue === "plan.steps" && v.labels.transport === "rabbitmq"
      );
      expect(depthMetric?.value).toBe(45);
    });
  });

  describe("Multi-Tenant Metric Isolation", () => {
    it("should expose tenant label for multi-tenant HPA configurations", async () => {
      await adapter.connect();

      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "plan.steps",
        messageCount: 20,
        consumerCount: 2
      } as any);

      await adapter.getQueueDepth("plan.steps");

      const metrics = await queueDepthGauge.get();
      const depthMetric = metrics.values.find(
        v => v.labels.queue === "plan.steps" && v.labels.transport === "rabbitmq"
      );

      // Verify tenant label exists for potential tenant-specific HPA
      expect(depthMetric?.labels).toHaveProperty("tenant");
      expect(typeof depthMetric?.labels.tenant).toBe("string");
    });
  });

  describe("Real-time Depth Tracking", () => {
    it("should update depth metrics after enqueue operations", async () => {
      await adapter.connect();

      // Initial empty queue
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "test.queue",
        messageCount: 0,
        consumerCount: 1
      } as any);

      await adapter.getQueueDepth("test.queue");
      let metrics = await queueDepthGauge.get();
      let depthMetric = metrics.values.find(
        v => v.labels.queue === "test.queue" && v.labels.transport === "rabbitmq"
      );
      expect(depthMetric?.value).toBe(0);

      // After enqueuing messages, depth increases
      vi.mocked(mockChannel.checkQueue).mockResolvedValue({
        queue: "test.queue",
        messageCount: 10,
        consumerCount: 1
      } as any);

      // Enqueue triggers refreshDepth internally
      await adapter.enqueue("test.queue", { job: "test-job" });

      metrics = await queueDepthGauge.get();
      depthMetric = metrics.values.find(
        v => v.labels.queue === "test.queue" && v.labels.transport === "rabbitmq"
      );
      expect(depthMetric?.value).toBe(10);
    });
  });
});
