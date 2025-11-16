import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { RabbitMQAdapter } from "./RabbitMQAdapter.js";
import {
  getDefaultTenantLabel,
  queueAckCounter,
  queueDeadLetterCounter,
  queueDepthGauge,
  queueLagGauge,
  queueRetryCounter,
  resetMetrics
} from "../observability/metrics.js";

import type { ConsumeMessage, Options } from "amqplib";
import type { MetricObjectWithValues, MetricValue } from "prom-client";

type StoredMessage = {
  queue: string;
  content: Buffer;
  options: Options.Publish;
  acked: boolean;
};

class MockChannel {
  private readonly consumers = new Map<string, (msg: ConsumeMessage | null) => void>();
  private readonly queues = new Map<string, StoredMessage[]>();
  private readonly deliveryMap = new WeakMap<ConsumeMessage, StoredMessage>();
  private deliveryTag = 0;

  async prefetch(): Promise<void> {
    // no-op for mock
  }

  async assertQueue(queue: string): Promise<void> {
    if (!this.queues.has(queue)) {
      this.queues.set(queue, []);
    }
  }

  async consume(queue: string, handler: (msg: ConsumeMessage | null) => void): Promise<{ consumerTag: string }> {
    this.consumers.set(queue, handler);
    return { consumerTag: `${queue}-consumer` };
  }

  async sendToQueue(queue: string, content: Buffer, options: Options.Publish): Promise<boolean> {
    const messages = this.queues.get(queue) ?? [];
    const stored: StoredMessage = { queue, content, options, acked: false };
    messages.push(stored);
    this.queues.set(queue, messages);

    const consumer = this.consumers.get(queue);
    if (consumer) {
      const msg = this.createMessage(queue, stored);
      queueMicrotask(() => consumer(msg));
    }

    return true;
  }

  deliverRaw(queue: string, content: Buffer, options: Options.Publish = {}): void {
    const messages = this.queues.get(queue) ?? [];
    const stored: StoredMessage = { queue, content, options, acked: false };
    messages.push(stored);
    this.queues.set(queue, messages);

    const consumer = this.consumers.get(queue);
    if (consumer) {
      const msg = this.createMessage(queue, stored);
      queueMicrotask(() => consumer(msg));
    }
  }

  async checkQueue(queue: string): Promise<{ messageCount: number; consumerCount: number }> {
    return {
      messageCount: this.getDepth(queue),
      consumerCount: this.consumers.has(queue) ? 1 : 0
    };
  }

  ack(msg: ConsumeMessage): void {
    const stored = this.deliveryMap.get(msg);
    if (stored) {
      stored.acked = true;
    }
  }

  async close(): Promise<void> {
    this.consumers.clear();
    this.queues.clear();
  }

  getDepth(queue: string): number {
    const messages = this.queues.get(queue) ?? [];
    return messages.filter(message => !message.acked).length;
  }

  getPublishedCount(queue: string): number {
    return (this.queues.get(queue) ?? []).length;
  }

  private createMessage(queue: string, stored: StoredMessage): ConsumeMessage {
    const properties = stored.options ?? {};
    const msg: ConsumeMessage = {
      content: stored.content,
      fields: {
        consumerTag: `${queue}-consumer`,
        deliveryTag: ++this.deliveryTag,
        redelivered: Boolean(properties.headers?.["x-attempts"] && Number(properties.headers?.["x-attempts"]) > 0),
        exchange: "",
        routingKey: queue
      },
      properties: {
        headers: properties.headers ?? {},
        messageId: properties.messageId ?? "",
        contentType: properties.contentType,
        deliveryMode: properties.persistent ? 2 : undefined
      }
    } as ConsumeMessage;
    this.deliveryMap.set(msg, stored);
    return msg;
  }
}

class MockConnection extends EventEmitter {
  constructor(private readonly channel: MockChannel) {
    super();
  }

  async createChannel(): Promise<MockChannel> {
    return this.channel;
  }

  async close(): Promise<void> {
    this.emit("close");
  }
}

async function getMetricValue(
  metric: { get(): Promise<MetricObjectWithValues<MetricValue<string>>> },
  labels: Record<string, string>
): Promise<number> {
  const data = await metric.get();
  const match = data.values.find(entry =>
    Object.entries(labels).every(([key, value]) => entry.labels?.[key] === value)
  );
  return match ? Number(match.value) : 0;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

describe("RabbitMQAdapter", () => {
  let channel: MockChannel;
  let adapter: RabbitMQAdapter;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const PLAN_ID = "plan-550e8400-e29b-41d4-a716-446655440000";
  const tenantLabel = getDefaultTenantLabel();
  const rabbitLabels = () => ({
    queue: "plan.steps",
    transport: "rabbitmq",
    tenant: tenantLabel
  });

  beforeEach(async () => {
    resetMetrics();
    channel = new MockChannel();
    const connection = new MockConnection(channel);
    const mockAmqp = { connect: vi.fn().mockResolvedValue(connection) } as unknown as typeof import("amqplib");
    adapter = new RabbitMQAdapter({ amqplib: mockAmqp, logger });
    await adapter.connect();
  });

  it("acknowledges messages and updates queue depth", async () => {
    await adapter.consume("plan.steps", async message => {
      expect(message.payload).toEqual({ task: "index" });
      expect(message.attempts).toBe(0);
      await message.ack();
    });

    await adapter.enqueue("plan.steps", { task: "index" }, { idempotencyKey: `${PLAN_ID}:s1` });

    await flushMicrotasks();

    expect(channel.getDepth("plan.steps")).toBe(0);
    const depthMetric = await getMetricValue(queueDepthGauge, rabbitLabels());
    expect(depthMetric).toBe(0);
    const lagMetric = await getMetricValue(queueLagGauge, rabbitLabels());
    expect(lagMetric).toBe(0);
    const ackMetric = await getMetricValue(queueAckCounter, { queue: "plan.steps" });
    expect(ackMetric).toBe(1);
  });

  it("retries messages when instructed", async () => {
    let seenAttempts: number[] = [];
    await adapter.consume("plan.steps", async message => {
      seenAttempts.push(message.attempts);
      if (message.attempts === 0) {
        await message.retry({ delayMs: 0 });
        return;
      }
      await message.ack();
    });

    await adapter.enqueue("plan.steps", { task: "apply" }, { idempotencyKey: `${PLAN_ID}:s2` });

    await flushMicrotasks();
    await flushMicrotasks();

    expect(seenAttempts).toEqual([0, 1]);
    expect(channel.getPublishedCount("plan.steps")).toBe(2);
    const retryMetric = await getMetricValue(queueRetryCounter, { queue: "plan.steps" });
    expect(retryMetric).toBe(1);
  });

  it("routes failed messages to a dead-letter queue", async () => {
    await adapter.consume("plan.steps", async message => {
      await message.deadLetter({ reason: "validation" });
    });

    await adapter.enqueue("plan.steps", { task: "apply" }, { idempotencyKey: `${PLAN_ID}:s3` });

    await flushMicrotasks();

    expect(channel.getDepth("plan.steps")).toBe(0);
    expect(channel.getPublishedCount("plan.steps.dead")).toBe(1);
    const deadMetric = await getMetricValue(queueDeadLetterCounter, { queue: "plan.steps" });
    expect(deadMetric).toBe(1);
  });

  it("acknowledges poison messages when JSON parsing fails", async () => {
    const handler = vi.fn();
    await adapter.consume("plan.steps", async message => {
      handler(message);
    });

    channel.deliverRaw("plan.steps", Buffer.from("not-json"), {
      headers: { "x-idempotency-key": "invalid:message" },
      messageId: "invalid:message"
    });

    await flushMicrotasks();

    expect(handler).not.toHaveBeenCalled();
    expect(channel.getDepth("plan.steps")).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse message from plan.steps")
    );
  });

  it("deduplicates idempotency keys until the message is acknowledged", async () => {
    const consumed: Array<Parameters<Parameters<typeof adapter.consume>[1]>[0]> = [];
    let heldMessage: Parameters<Parameters<typeof adapter.consume>[1]>[0] | undefined;

    await adapter.consume("plan.steps", async message => {
      consumed.push(message);
      if (consumed.length === 1) {
        heldMessage = message;
        return;
      }
      await message.ack();
    });

    const key = `${PLAN_ID}:dedupe`;

    await adapter.enqueue("plan.steps", { task: "first" }, { idempotencyKey: key });
    await flushMicrotasks();

    expect(channel.getPublishedCount("plan.steps")).toBe(1);
    expect(consumed).toHaveLength(1);

    await adapter.enqueue("plan.steps", { task: "second" }, { idempotencyKey: key });
    await flushMicrotasks();

    expect(channel.getPublishedCount("plan.steps")).toBe(1);
    expect(consumed).toHaveLength(1);

    await heldMessage?.ack();
    await flushMicrotasks();

    await adapter.enqueue("plan.steps", { task: "third" }, { idempotencyKey: key });
    await flushMicrotasks();

    expect(channel.getPublishedCount("plan.steps")).toBe(2);
    expect(consumed).toHaveLength(2);
  });

  it("releases idempotency keys after dead-lettering", async () => {
    const consumed: Array<Parameters<Parameters<typeof adapter.consume>[1]>[0]> = [];

    await adapter.consume("plan.steps", async message => {
      consumed.push(message);
      if (consumed.length === 1) {
        await message.deadLetter({ reason: "invalid" });
        return;
      }
      await message.ack();
    });

    const key = `${PLAN_ID}:dead`;

    await adapter.enqueue("plan.steps", { task: "first" }, { idempotencyKey: key });
    await flushMicrotasks();

    expect(channel.getPublishedCount("plan.steps.dead")).toBe(1);
    expect(consumed).toHaveLength(1);

    await adapter.enqueue("plan.steps", { task: "second" }, { idempotencyKey: key });
    await flushMicrotasks();

    expect(channel.getPublishedCount("plan.steps")).toBe(2);
    expect(consumed).toHaveLength(2);
  });

  it("releases idempotency keys when publishing fails", async () => {
    const key = `${PLAN_ID}:failure`;
    const originalSend = channel.sendToQueue.bind(channel);
    const sendSpy = vi.spyOn(channel, "sendToQueue");
    sendSpy
      .mockImplementationOnce(() => {
        throw new Error("send failed");
      })
      .mockImplementation(originalSend);

    await expect(
      adapter.enqueue("plan.steps", { task: "first" }, { idempotencyKey: key }),
    ).rejects.toThrow("send failed");

    expect(channel.getPublishedCount("plan.steps")).toBe(0);

    await adapter.consume("plan.steps", async message => {
      await message.ack();
    });

    await adapter.enqueue("plan.steps", { task: "second" }, { idempotencyKey: key });
    await flushMicrotasks();

    expect(channel.getPublishedCount("plan.steps")).toBe(1);
  });

  it("publishes duplicate keys when dedupe is skipped", async () => {
    const received: Array<{ task: string }> = [];

    await adapter.consume("plan.steps", async message => {
      received.push(message.payload as { task: string });
      // Intentionally acknowledge after capture to ensure no redelivery
      await message.ack();
    });

    const key = `${PLAN_ID}:skip`;
    await adapter.enqueue("plan.steps", { task: "first" }, { idempotencyKey: key, skipDedupe: true });
    await adapter.enqueue("plan.steps", { task: "second" }, { idempotencyKey: key, skipDedupe: true });

    await flushMicrotasks();

    expect(channel.getPublishedCount("plan.steps")).toBe(2);
    expect(received.map(item => item.task)).toEqual(["first", "second"]);
  });

  it("annotates job payloads with retry attempts", async () => {
    const payloads: Array<{ job: { id: string; attempt: number } }> = [];

    await adapter.consume("plan.steps", async message => {
      payloads.push(message.payload as { job: { id: string; attempt: number } });
      if (message.attempts === 0) {
        await message.retry({ delayMs: 0 });
        return;
      }
      await message.ack();
    });

    await adapter.enqueue("plan.steps", { job: { id: "job-1" } }, { idempotencyKey: `${PLAN_ID}:job` });

    await flushMicrotasks();

    expect(payloads).toHaveLength(2);
    expect(payloads[0].job).toEqual({ id: "job-1", attempt: 0 });
    expect(payloads[1].job).toEqual({ id: "job-1", attempt: 1 });
  });

  it("resets depth and lag metrics when refreshDepth fails", async () => {
    queueDepthGauge.labels("plan.steps", "rabbitmq", tenantLabel).set(5);
    queueLagGauge.labels("plan.steps", "rabbitmq", tenantLabel).set(7);

    const spy = vi
      .spyOn(adapter, "getQueueDepth")
      .mockRejectedValueOnce(new Error("depth boom"));
    const refreshDepth = (adapter as unknown as {
      refreshDepth(queue: string): Promise<void>;
    }).refreshDepth.bind(adapter);

    await refreshDepth("plan.steps");

    expect(await getMetricValue(queueDepthGauge, rabbitLabels())).toBe(0);
    expect(await getMetricValue(queueLagGauge, rabbitLabels())).toBe(0);
    spy.mockRestore();
  });
});
