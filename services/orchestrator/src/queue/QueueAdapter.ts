import { loadConfig } from "../config.js";
import { createDedupeService, type IDedupeService } from "../services/DedupeService.js";
import { RabbitMQAdapter } from "./RabbitMQAdapter.js";
import { KafkaAdapter } from "./KafkaAdapter.js";

export type QueueHandler<T = unknown> = (message: QueueMessage<T>) => Promise<void>;

export type EnqueueOptions = {
  idempotencyKey?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  skipDedupe?: boolean;
};

export type RetryOptions = {
  delayMs?: number;
};

export type DeadLetterOptions = {
  reason?: string;
  queue?: string;
};

export interface QueueMessage<T = unknown> {
  id: string;
  payload: T;
  headers: Record<string, string>;
  attempts: number;
  ack(): Promise<void>;
  retry(options?: RetryOptions): Promise<void>;
  deadLetter(options?: DeadLetterOptions): Promise<void>;
}

export interface QueueAdapter {
  connect(): Promise<void>;
  close(): Promise<void>;
  enqueue<T>(queue: string, payload: T, options?: EnqueueOptions): Promise<void>;
  consume<T>(queue: string, handler: QueueHandler<T>): Promise<void>;
  getQueueDepth(queue: string): Promise<number>;
}

let adapterPromise: Promise<QueueAdapter> | null = null;

/**
 * Creates a queue adapter from config with the provided dedupe service.
 * @param dedupeService - The dedupe service to use for idempotency
 */
export function createQueueAdapterWithDedupe(dedupeService: IDedupeService): QueueAdapter {
  const config = loadConfig();
  switch (config.messaging.type) {
    case "rabbitmq":
      return new RabbitMQAdapter({ dedupeService });
    case "kafka": {
      const kafkaCfg = config.messaging.kafka;
      return new KafkaAdapter({
        brokers: kafkaCfg.brokers,
        clientId: kafkaCfg.clientId,
        groupId: kafkaCfg.consumerGroup,
        fromBeginning: kafkaCfg.consumeFromBeginning,
        retryDelayMs: kafkaCfg.retryDelayMs,
        tls: kafkaCfg.tls,
        sasl: kafkaCfg.sasl,
        deadLetterSuffix: kafkaCfg.topics.deadLetterSuffix,
        ensureTopics: kafkaCfg.ensureTopics,
        numPartitions: kafkaCfg.topicPartitions,
        replicationFactor: kafkaCfg.replicationFactor,
        topicConfig: kafkaCfg.topicConfig,
        compactTopicPatterns: kafkaCfg.compactTopics,
        dedupeService,
      });
    }
    default:
      throw new Error(`Unsupported messaging type: ${config.messaging.type}`);
  }
}

export async function getQueueAdapter(): Promise<QueueAdapter> {
  if (!adapterPromise) {
    const config = loadConfig();
    adapterPromise = (async () => {
      const dedupeService = await createDedupeService(config.messaging.dedupe);
      const adapter = createQueueAdapterWithDedupe(dedupeService);
      await adapter.connect();
      return adapter;
    })().catch(error => {
      adapterPromise = null;
      throw error;
    });
  }
  return adapterPromise;
}

export function resetQueueAdapter(): void {
  adapterPromise = null;
}
