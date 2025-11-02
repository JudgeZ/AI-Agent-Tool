import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  type Admin,
  type Consumer,
  type EachMessagePayload,
  Kafka,
  logLevel,
  type Message,
  type Producer,
  type IHeaders
} from "kafkajs";

import {
  queueAckCounter,
  queueDeadLetterCounter,
  queueDepthGauge,
  queueRetryCounter
} from "../observability/metrics.js";
import type {
  DeadLetterOptions,
  EnqueueOptions,
  QueueAdapter,
  QueueHandler,
  QueueMessage,
  RetryOptions
} from "./QueueAdapter.js";

const DEFAULT_BROKERS = ["localhost:9092"];
const DEFAULT_CLIENT_ID = "oss-orchestrator";
const DEFAULT_GROUP_ID = "oss-orchestrator-plan-executor";
const DEFAULT_RETRY_DELAY_MS = 1000;

type Logger = Pick<typeof console, "info" | "warn" | "error">;

type KafkaAdapterOptions = {
  brokers?: string[];
  clientId?: string;
  groupId?: string;
  fromBeginning?: boolean;
  retryDelayMs?: number;
  kafka?: KafkaFactory;
  logger?: Logger;
};

type KafkaFactory = Pick<Kafka, "producer" | "consumer" | "admin">;

function sleep(ms: number): Promise<void> {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }
  return delay(ms);
}

function normalizeOutgoingHeaders(headers: Record<string, string>): Record<string, Buffer> {
  return Object.entries(headers).reduce<Record<string, Buffer>>((acc, [key, value]) => {
    acc[key] = Buffer.from(String(value));
    return acc;
  }, {});
}

function decodeHeaders(headers: IHeaders | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  return Object.entries(headers).reduce<Record<string, string>>((acc, [key, value]) => {
    if (value === undefined || value === null) {
      return acc;
    }
    if (Buffer.isBuffer(value)) {
      acc[key] = value.toString("utf-8");
    } else {
      acc[key] = String(value);
    }
    return acc;
  }, {});
}

function toKafkaMessages(topic: string, payload: unknown, headers: Record<string, string>, key?: string): Message[] {
  return [
    {
      key,
      value: Buffer.from(JSON.stringify(payload)),
      headers: normalizeOutgoingHeaders(headers)
    }
  ];
}

export class KafkaAdapter implements QueueAdapter {
  private readonly brokers: string[];
  private readonly clientId: string;
  private readonly groupId: string;
  private readonly fromBeginning: boolean;
  private readonly retryDelayMs: number;
  private readonly logger: Logger;
  private readonly kafkaFactory: KafkaFactory;

  private producer: Producer | null = null;
  private consumer: Consumer | null = null;
  private admin: Admin | null = null;
  private connecting: Promise<void> | null = null;
  private consumerRunning = false;
  private connected = false;

  private readonly consumers = new Map<string, QueueHandler<any>>();
  private readonly inflightKeys = new Set<string>();

  constructor(options: KafkaAdapterOptions = {}) {
    this.brokers = options.brokers ?? parseBrokerList(process.env.KAFKA_BROKERS) ?? DEFAULT_BROKERS;
    this.clientId = options.clientId ?? process.env.KAFKA_CLIENT_ID ?? DEFAULT_CLIENT_ID;
    this.groupId = options.groupId ?? process.env.KAFKA_GROUP_ID ?? DEFAULT_GROUP_ID;
    this.fromBeginning = options.fromBeginning ?? parseBoolean(process.env.KAFKA_CONSUME_FROM_BEGINNING) ?? false;
    this.retryDelayMs = options.retryDelayMs ?? Number(process.env.KAFKA_RETRY_DELAY_MS ?? DEFAULT_RETRY_DELAY_MS);
    this.logger = options.logger ?? console;

    if (options.kafka) {
      this.kafkaFactory = options.kafka;
    } else {
      this.kafkaFactory = new Kafka({
        clientId: this.clientId,
        brokers: this.brokers,
        logLevel: logLevel.NOTHING
      });
    }
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = (async () => {
      const producer = this.kafkaFactory.producer();
      const consumer = this.kafkaFactory.consumer({ groupId: this.groupId, retry: { retries: 0 } });
      const admin = this.kafkaFactory.admin();

      await Promise.all([producer.connect(), consumer.connect(), admin.connect()]);

      this.producer = producer;
      this.consumer = consumer;
      this.admin = admin;
      this.connected = true;

      await this.ensureConsumerRunning();

      // Subscribe to queues that were registered before connect completed
      await Promise.all(
        Array.from(this.consumers.keys()).map(topic =>
          this.consumer!.subscribe({ topic, fromBeginning: this.fromBeginning })
        )
      );
    })()
      .catch((error: unknown) => {
        this.connecting = null;
        this.connected = false;
        throw error;
      })
      .finally(() => {
        this.connecting = null;
      });

    await this.connecting;
  }

  async close(): Promise<void> {
    this.connected = false;
    const [producer, consumer, admin] = [this.producer, this.consumer, this.admin];
    this.producer = null;
    this.consumer = null;
    this.admin = null;
    this.consumerRunning = false;
    this.consumers.clear();
    this.inflightKeys.clear();

    await Promise.all([
      producer?.disconnect().catch((error: unknown) =>
        this.logger.warn?.(`Kafka producer close failed: ${(error as Error).message}`)
      ),
      consumer?.disconnect().catch((error: unknown) =>
        this.logger.warn?.(`Kafka consumer close failed: ${(error as Error).message}`)
      ),
      admin?.disconnect().catch((error: unknown) =>
        this.logger.warn?.(`Kafka admin close failed: ${(error as Error).message}`)
      )
    ]);
  }

  async enqueue<T>(queue: string, payload: T, options?: EnqueueOptions): Promise<void> {
    await this.ensureConnected();
    await this.publish(queue, payload, { ...options, attempt: 0 });
  }

  async consume<T>(queue: string, handler: QueueHandler<T>): Promise<void> {
    this.consumers.set(queue, handler as QueueHandler<any>);
    await this.ensureConnected();
    await this.consumer!.subscribe({ topic: queue, fromBeginning: this.fromBeginning });
  }

  async getQueueDepth(queue: string): Promise<number> {
    await this.ensureConnected();
    if (!this.admin) {
      return 0;
    }

    try {
      const topicOffsets = await this.admin.fetchTopicOffsets(queue);
      const groupOffsets = await this.admin.fetchOffsets({ groupId: this.groupId, topics: [queue] });

      const groupOffsetMap = new Map<number, string>();
      for (const topicEntry of groupOffsets) {
        if (topicEntry.topic !== queue) {
          continue;
        }
        for (const partition of topicEntry.partitions) {
          groupOffsetMap.set(partition.partition, partition.offset);
        }
      }

      let lag = 0n;
      for (const partition of topicOffsets) {
        const latest = BigInt(partition.offset);
        const committedRaw = groupOffsetMap.get(partition.partition);
        const committed = committedRaw && committedRaw !== "-1" ? BigInt(committedRaw) : latest;
        if (latest > committed) {
          lag += latest - committed;
        }
      }
      return Number(lag);
    } catch (error) {
      this.logger.warn?.(`Failed to fetch Kafka lag for ${queue}: ${(error as Error).message}`);
      return 0;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  private async ensureConsumerRunning(): Promise<void> {
    if (this.consumerRunning) {
      return;
    }
    if (!this.consumer) {
      return;
    }
    this.consumerRunning = true;
    void this.consumer
      .run({
        autoCommit: false,
        eachMessage: async (payload: EachMessagePayload) => {
          try {
            await this.handleMessage(payload);
          } catch (error: unknown) {
            this.logger.error?.(`Kafka message handler error: ${(error as Error).message}`);
          }
        }
      })
      .catch((error: unknown) => {
        this.logger.error?.(`Kafka consumer run failed: ${(error as Error).message}`);
      })
      .finally(() => {
        this.consumerRunning = false;
      });
  }

  private async handleMessage({ topic, partition, message }: EachMessagePayload): Promise<void> {
    const handler = this.consumers.get(topic);
    if (!handler) {
      await this.commitOffset(topic, partition, message.offset);
      return;
    }

    const headers = decodeHeaders(message.headers);
    const attempts = Number(headers["x-attempts"] ?? 0);
    const idempotencyKey = headers["x-idempotency-key"];

    let payload: unknown;
    try {
      payload = message.value ? JSON.parse(message.value.toString("utf-8")) : null;
    } catch (error: unknown) {
      this.logger.error?.(`Failed to parse Kafka message from ${topic}: ${(error as Error).message}`);
      await this.commitOffset(topic, partition, message.offset);
      if (idempotencyKey) {
        this.releaseKey(idempotencyKey);
      }
      await this.refreshDepth(topic);
      return;
    }

    let acknowledged = false;
    const commit = async () => {
      if (acknowledged) {
        return;
      }
      acknowledged = true;
      await this.commitOffset(topic, partition, message.offset);
      if (idempotencyKey) {
        this.releaseKey(idempotencyKey);
      }
      await this.refreshDepth(topic);
    };

    const queueMessage: QueueMessage<unknown> = {
      id: message.key?.toString("utf-8") ?? idempotencyKey ?? randomUUID(),
      payload: this.preparePayloadForAttempt(payload, attempts),
      headers,
      attempts,
      ack: async () => {
        queueAckCounter.labels(topic).inc();
        await commit();
      },
      retry: async (options?: RetryOptions) => {
        queueRetryCounter.labels(topic).inc();
        const nextAttempt = attempts + 1;
        const nextPayload = this.preparePayloadForAttempt(payload, nextAttempt);
        await this.publish(topic, nextPayload, {
          idempotencyKey,
          headers,
          attempt: nextAttempt,
          skipDedupe: true,
          delayMs: options?.delayMs ?? this.retryDelayMs
        });
        await queueMessage.ack();
      },
      deadLetter: async (options?: DeadLetterOptions) => {
        const reason = options?.reason ?? "unspecified";
        const targetTopic = options?.queue ?? `${topic}.dead`;
        queueDeadLetterCounter.labels(topic).inc();
        const deadHeaders = { ...headers, "x-dead-letter-reason": reason };
        await this.publish(targetTopic, payload, {
          headers: deadHeaders,
          skipDedupe: true
        });
        await queueMessage.ack();
      }
    };

    try {
      await handler(queueMessage);
    } catch (error: unknown) {
      this.logger.error?.(`Queue handler for ${topic} failed: ${(error as Error).message}`);
      await queueMessage.retry();
    }
  }

  private async publish<T>(topic: string, payload: T, options: PublishOptions = {}): Promise<void> {
    await this.ensureConnected();
    if (!this.producer) {
      throw new Error("Kafka producer unavailable");
    }

    const { idempotencyKey, headers: overrideHeaders, skipDedupe, attempt, delayMs } = options;

    if (delayMs && delayMs > 0) {
      await sleep(delayMs);
    }

    const headers: Record<string, string> = {
      ...sanitizeHeaders(overrideHeaders),
      "x-attempts": String(Number.isFinite(attempt) ? attempt : 0)
    };

    let addedKey = false;
    if (idempotencyKey) {
      headers["x-idempotency-key"] = idempotencyKey;
      if (!skipDedupe && this.inflightKeys.has(idempotencyKey)) {
        return;
      }
      addedKey = !this.inflightKeys.has(idempotencyKey);
      this.inflightKeys.add(idempotencyKey);
    }

    try {
      await this.producer.send({
        topic,
        messages: toKafkaMessages(topic, payload, headers, idempotencyKey)
      });
    } catch (error: unknown) {
      if (idempotencyKey && addedKey) {
        this.releaseKey(idempotencyKey);
      }
      throw error;
    }

    await this.refreshDepth(topic);
  }

  private async refreshDepth(queue: string): Promise<void> {
    try {
      const depth = await this.getQueueDepth(queue);
      queueDepthGauge.labels(queue).set(depth);
    } catch (error: unknown) {
      this.logger.warn?.(`Failed to refresh Kafka depth for ${queue}: ${(error as Error).message}`);
    }
  }

  private releaseKey(key: string): void {
    this.inflightKeys.delete(key);
  }

  private async commitOffset(topic: string, partition: number, offset: string): Promise<void> {
    if (!this.consumer) {
      return;
    }
    const nextOffset = (BigInt(offset) + 1n).toString();
    await this.consumer.commitOffsets([{ topic, partition, offset: nextOffset }]);
  }

  private preparePayloadForAttempt<T>(payload: T, attempt: number): T {
    if (payload && typeof payload === "object") {
      const maybeRecord = payload as Record<string, unknown>;
      const job = maybeRecord.job;
      if (job && typeof job === "object" && job !== null) {
        return {
          ...maybeRecord,
          job: {
            ...(job as Record<string, unknown>),
            attempt
          }
        } as T;
      }
    }
    return payload;
  }
}

type PublishOptions = EnqueueOptions & {
  skipDedupe?: boolean;
  attempt?: number;
};

function parseBrokerList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const brokers = value
    .split(",")
    .map(item => item.trim())
    .filter(item => item.length > 0);
  return brokers.length > 0 ? brokers : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  return undefined;
}

function sanitizeHeaders(headers?: Record<string, string | undefined>): Record<string, string> {
  if (!headers) {
    return {};
  }
  return Object.entries(headers).reduce<Record<string, string>>((acc, [key, value]) => {
    if (value === undefined || value === null) {
      return acc;
    }
    acc[key] = String(value);
    return acc;
  }, {});
}

