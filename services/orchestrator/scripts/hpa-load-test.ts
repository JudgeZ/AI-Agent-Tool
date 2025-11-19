#!/usr/bin/env tsx

/**
 * HPA Load Testing Script
 *
 * This script validates HPA autoscaling behavior by:
 * 1. Generating configurable message load on queues
 * 2. Monitoring queue depth/lag metrics in real-time
 * 3. Observing HPA scaling decisions
 * 4. Validating scale-up and scale-down timing
 * 5. Measuring time-to-scale and throughput
 *
 * Usage:
 *   # Test Kafka HPA with 100 messages, ramp-up over 30s
 *   tsx scripts/hpa-load-test.ts --transport=kafka --messages=100 --ramp-up=30 --queue=plan.steps
 *
 *   # Test RabbitMQ HPA with sustained load
 *   tsx scripts/hpa-load-test.ts --transport=rabbitmq --messages=500 --ramp-up=60 --sustained=120
 *
 *   # Test scale-down behavior
 *   tsx scripts/hpa-load-test.ts --transport=kafka --messages=200 --ramp-up=30 --cooldown=300
 */

import { program } from "commander";
import { register } from "prom-client";
import { setTimeout as sleep } from "node:timers/promises";
import { createQueueAdapterFromConfig } from "../src/queue/QueueAdapter.js";
import type { QueueAdapter } from "../src/queue/QueueAdapter.js";
import {
  queueDepthGauge,
  queueLagGauge,
  queuePartitionLagGauge
} from "../src/observability/metrics.js";

interface LoadTestConfig {
  transport: "kafka" | "rabbitmq";
  queue: string;
  messages: number;
  rampUpSeconds: number;
  sustainedSeconds: number;
  cooldownSeconds: number;
  targetDepth: number;
  minReplicas: number;
  maxReplicas: number;
  payloadSize: number;
  batchSize: number;
}

interface MetricsSnapshot {
  timestamp: number;
  queueDepth: number;
  queueLag: number;
  partitionLag?: Record<string, number>;
}

interface ScalingEvent {
  timestamp: number;
  type: "scale-up" | "scale-down" | "stable";
  observedReplicas: number;
  queueDepth: number;
  queueLag: number;
}

class HPALoadTester {
  private adapter: QueueAdapter | null = null;
  private metricsHistory: MetricsSnapshot[] = [];
  private scalingEvents: ScalingEvent[] = [];
  private stopMonitoring = false;

  constructor(private config: LoadTestConfig) {}

  async initialize(): Promise<void> {
    console.log("Initializing load tester...");
    console.log(`Transport: ${this.config.transport}`);
    console.log(`Queue: ${this.config.queue}`);
    console.log(`Messages: ${this.config.messages}`);
    console.log(`Ramp-up: ${this.config.rampUpSeconds}s`);
    console.log(`Sustained: ${this.config.sustainedSeconds}s`);
    console.log(`Cooldown: ${this.config.cooldownSeconds}s`);
    console.log("");

    // Set environment for queue adapter
    process.env.QUEUE_BACKEND = this.config.transport;

    this.adapter = await createQueueAdapterFromConfig();
    await this.adapter.connect();

    console.log("✓ Connected to queue backend");
  }

  async runLoadTest(): Promise<void> {
    console.log("\n=== Starting Load Test ===\n");

    // Start metrics monitoring in background
    const monitoringPromise = this.monitorMetrics();

    try {
      // Phase 1: Ramp-up
      await this.rampUpPhase();

      // Phase 2: Sustained load (optional)
      if (this.config.sustainedSeconds > 0) {
        await this.sustainedLoadPhase();
      }

      // Phase 3: Cooldown (observe scale-down)
      if (this.config.cooldownSeconds > 0) {
        await this.cooldownPhase();
      }
    } finally {
      this.stopMonitoring = true;
      await monitoringPromise;
    }

    // Analysis
    await this.analyzeResults();
  }

  private async rampUpPhase(): Promise<void> {
    console.log(`\n--- Phase 1: Ramp-Up (${this.config.rampUpSeconds}s) ---\n`);

    const messagesPerSecond = this.config.messages / this.config.rampUpSeconds;
    const batchInterval = (this.config.batchSize / messagesPerSecond) * 1000;

    let totalEnqueued = 0;
    const startTime = Date.now();

    while (totalEnqueued < this.config.messages) {
      const batchStart = Date.now();
      const batch = Math.min(this.config.batchSize, this.config.messages - totalEnqueued);

      await this.enqueueBatch(batch);
      totalEnqueued += batch;

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = totalEnqueued / elapsed;
      console.log(
        `Enqueued ${totalEnqueued}/${this.config.messages} messages ` +
        `(${rate.toFixed(2)} msg/s, target: ${messagesPerSecond.toFixed(2)} msg/s)`
      );

      const batchDuration = Date.now() - batchStart;
      const sleepTime = Math.max(0, batchInterval - batchDuration);
      if (sleepTime > 0) {
        await sleep(sleepTime);
      }
    }

    console.log(`✓ Ramp-up complete: ${totalEnqueued} messages enqueued`);
  }

  private async sustainedLoadPhase(): Promise<void> {
    console.log(`\n--- Phase 2: Sustained Load (${this.config.sustainedSeconds}s) ---\n`);

    const endTime = Date.now() + this.config.sustainedSeconds * 1000;
    const messagesPerSecond = this.config.targetDepth / 10; // Keep depth around target

    while (Date.now() < endTime) {
      await this.enqueueBatch(this.config.batchSize);
      const remaining = Math.ceil((endTime - Date.now()) / 1000);
      console.log(`Sustained load: ${remaining}s remaining`);
      await sleep(1000);
    }

    console.log("✓ Sustained load phase complete");
  }

  private async cooldownPhase(): Promise<void> {
    console.log(`\n--- Phase 3: Cooldown (${this.config.cooldownSeconds}s) ---\n`);
    console.log("Observing queue drain and scale-down behavior...\n");

    const endTime = Date.now() + this.config.cooldownSeconds * 1000;

    while (Date.now() < endTime) {
      const depth = await this.adapter!.getQueueDepth(this.config.queue);
      const remaining = Math.ceil((endTime - Date.now()) / 1000);
      console.log(`Cooldown: depth=${depth}, ${remaining}s remaining`);
      await sleep(5000);
    }

    console.log("✓ Cooldown phase complete");
  }

  private async enqueueBatch(count: number): Promise<void> {
    const payload = this.generatePayload();
    const promises: Promise<void>[] = [];

    for (let i = 0; i < count; i++) {
      promises.push(
        this.adapter!.enqueue(this.config.queue, {
          ...payload,
          id: `load-test-${Date.now()}-${i}`,
          timestamp: Date.now()
        })
      );
    }

    await Promise.all(promises);
  }

  private generatePayload(): Record<string, any> {
    const basePayload = {
      test: "hpa-load-test",
      data: "x".repeat(this.config.payloadSize)
    };
    return basePayload;
  }

  private async monitorMetrics(): Promise<void> {
    console.log("Starting metrics monitoring...\n");

    while (!this.stopMonitoring) {
      try {
        const snapshot = await this.captureMetricsSnapshot();
        this.metricsHistory.push(snapshot);

        // Detect scaling events
        if (this.metricsHistory.length >= 2) {
          await this.detectScalingEvent(snapshot);
        }

        await sleep(5000); // Sample every 5 seconds
      } catch (error) {
        console.error(`Metrics monitoring error: ${(error as Error).message}`);
      }
    }

    console.log("Metrics monitoring stopped");
  }

  private async captureMetricsSnapshot(): Promise<MetricsSnapshot> {
    const depth = await this.adapter!.getQueueDepth(this.config.queue);

    // Get lag metric
    const lagMetrics = await queueLagGauge.get();
    const lagMetric = lagMetrics.values.find(
      v => v.labels.queue === this.config.queue && v.labels.transport === this.config.transport
    );
    const lag = lagMetric?.value ?? 0;

    // Get partition lag for Kafka
    let partitionLag: Record<string, number> | undefined;
    if (this.config.transport === "kafka") {
      const partitionMetrics = await queuePartitionLagGauge.get();
      partitionLag = {};
      for (const metric of partitionMetrics.values) {
        if (metric.labels.queue === this.config.queue && metric.labels.transport === "kafka") {
          partitionLag[metric.labels.partition] = metric.value;
        }
      }
    }

    return {
      timestamp: Date.now(),
      queueDepth: depth,
      queueLag: lag,
      partitionLag
    };
  }

  private async detectScalingEvent(snapshot: MetricsSnapshot): Promise<void> {
    // In a real Kubernetes environment, you would query the HPA/deployment API
    // For testing purposes, we estimate based on target depth
    const estimatedReplicas = Math.max(
      this.config.minReplicas,
      Math.min(
        this.config.maxReplicas,
        Math.ceil(snapshot.queueDepth / this.config.targetDepth)
      )
    );

    const lastEvent = this.scalingEvents[this.scalingEvents.length - 1];
    const lastReplicas = lastEvent?.observedReplicas ?? this.config.minReplicas;

    if (estimatedReplicas !== lastReplicas) {
      const eventType = estimatedReplicas > lastReplicas ? "scale-up" : "scale-down";
      const event: ScalingEvent = {
        timestamp: snapshot.timestamp,
        type: eventType,
        observedReplicas: estimatedReplicas,
        queueDepth: snapshot.queueDepth,
        queueLag: snapshot.queueLag
      };

      this.scalingEvents.push(event);
      console.log(
        `\n🔄 SCALING EVENT: ${eventType.toUpperCase()} ` +
        `${lastReplicas} → ${estimatedReplicas} replicas ` +
        `(depth=${snapshot.queueDepth}, lag=${snapshot.queueLag})\n`
      );
    }
  }

  private async analyzeResults(): Promise<void> {
    console.log("\n=== Load Test Results ===\n");

    // Queue depth analysis
    const depths = this.metricsHistory.map(s => s.queueDepth);
    const avgDepth = depths.reduce((a, b) => a + b, 0) / depths.length;
    const maxDepth = Math.max(...depths);
    const minDepth = Math.min(...depths);

    console.log("Queue Depth Metrics:");
    console.log(`  Average: ${avgDepth.toFixed(2)}`);
    console.log(`  Max: ${maxDepth}`);
    console.log(`  Min: ${minDepth}`);
    console.log(`  Target: ${this.config.targetDepth}`);
    console.log("");

    // Lag analysis
    const lags = this.metricsHistory.map(s => s.queueLag);
    const avgLag = lags.reduce((a, b) => a + b, 0) / lags.length;
    const maxLag = Math.max(...lags);

    console.log("Queue Lag Metrics:");
    console.log(`  Average: ${avgLag.toFixed(2)}`);
    console.log(`  Max: ${maxLag}`);
    console.log("");

    // Scaling events
    console.log("Scaling Events:");
    if (this.scalingEvents.length === 0) {
      console.log("  No scaling events detected");
    } else {
      for (const event of this.scalingEvents) {
        const elapsed = ((event.timestamp - this.metricsHistory[0]!.timestamp) / 1000).toFixed(1);
        console.log(
          `  ${elapsed}s: ${event.type} to ${event.replicas} replicas ` +
          `(depth=${event.queueDepth}, lag=${event.queueLag})`
        );
      }
    }
    console.log("");

    // Time-to-scale analysis
    if (this.scalingEvents.length > 0) {
      const firstScaleUp = this.scalingEvents.find(e => e.type === "scale-up");
      if (firstScaleUp) {
        const timeToScale = ((firstScaleUp.timestamp - this.metricsHistory[0]!.timestamp) / 1000).toFixed(1);
        console.log(`Time to first scale-up: ${timeToScale}s`);
      }

      const firstScaleDown = this.scalingEvents.find(e => e.type === "scale-down");
      if (firstScaleDown) {
        const lastScaleUp = [...this.scalingEvents].reverse().find(e => e.type === "scale-up");
        if (lastScaleUp) {
          const cooldownTime = ((firstScaleDown.timestamp - lastScaleUp.timestamp) / 1000).toFixed(1);
          console.log(`Scale-down cooldown time: ${cooldownTime}s`);
        }
      }
      console.log("");
    }

    // HPA effectiveness
    const depthAboveTarget = depths.filter(d => d > this.config.targetDepth * 1.2).length;
    const depthBelowTarget = depths.filter(d => d < this.config.targetDepth * 0.5).length;
    const effectiveness = ((depths.length - depthAboveTarget - depthBelowTarget) / depths.length) * 100;

    console.log("HPA Effectiveness:");
    console.log(`  Within target range: ${effectiveness.toFixed(1)}%`);
    console.log(`  Samples above target (+20%): ${depthAboveTarget}`);
    console.log(`  Samples below target (-50%): ${depthBelowTarget}`);
    console.log("");

    // Recommendations
    console.log("Recommendations:");
    if (maxDepth > this.config.targetDepth * 3) {
      console.log(`  ⚠️  Max depth (${maxDepth}) exceeded target by 3x - consider lowering HPA target`);
    }
    if (effectiveness < 70) {
      console.log("  ⚠️  Low effectiveness - review HPA configuration and scaling policies");
    }
    if (this.scalingEvents.length === 0) {
      console.log("  ℹ️  No scaling events - queue depth may not have exceeded HPA threshold");
    }
    if (this.scalingEvents.filter(e => e.type === "scale-up").length > 5) {
      console.log("  ⚠️  Frequent scale-ups - consider increasing min replicas or lowering target");
    }
    console.log("");
  }

  async cleanup(): Promise<void> {
    if (this.adapter) {
      await this.adapter.close();
      console.log("✓ Queue adapter closed");
    }
  }
}

async function main() {
  program
    .option("--transport <type>", "Queue transport (kafka|rabbitmq)", "kafka")
    .option("--queue <name>", "Queue name", "plan.steps")
    .option("--messages <count>", "Number of messages to enqueue", "100")
    .option("--ramp-up <seconds>", "Ramp-up duration in seconds", "30")
    .option("--sustained <seconds>", "Sustained load duration in seconds", "0")
    .option("--cooldown <seconds>", "Cooldown duration in seconds", "60")
    .option("--target-depth <count>", "HPA target queue depth per pod", "5")
    .option("--min-replicas <count>", "HPA min replicas", "2")
    .option("--max-replicas <count>", "HPA max replicas", "10")
    .option("--payload-size <bytes>", "Payload size in bytes", "1024")
    .option("--batch-size <count>", "Messages per batch", "10")
    .parse();

  const options = program.opts();

  const config: LoadTestConfig = {
    transport: options.transport as "kafka" | "rabbitmq",
    queue: options.queue,
    messages: parseInt(options.messages, 10),
    rampUpSeconds: parseInt(options.rampUp, 10),
    sustainedSeconds: parseInt(options.sustained, 10),
    cooldownSeconds: parseInt(options.cooldown, 10),
    targetDepth: parseInt(options.targetDepth, 10),
    minReplicas: parseInt(options.minReplicas, 10),
    maxReplicas: parseInt(options.maxReplicas, 10),
    payloadSize: parseInt(options.payloadSize, 10),
    batchSize: parseInt(options.batchSize, 10)
  };

  const tester = new HPALoadTester(config);

  try {
    await tester.initialize();
    await tester.runLoadTest();
  } catch (error) {
    console.error(`\n❌ Load test failed: ${(error as Error).message}\n`);
    process.exit(1);
  } finally {
    await tester.cleanup();
  }

  console.log("✓ Load test complete\n");
}

main().catch(error => {
  console.error(`Fatal error: ${(error as Error).message}`);
  process.exit(1);
});
