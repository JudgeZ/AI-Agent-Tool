import { loadConfig } from "../config.js";
import { RabbitMQAdapter } from "./RabbitMQAdapter.js";
import { KafkaAdapter } from "./KafkaAdapter.js";

export type QueueHandler<T = unknown> = (message: QueueMessage<T>) => Promise<void>;

export type EnqueueOptions = {
  idempotencyKey?: string;
  headers?: Record<string, string>;
  delayMs?: number;
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

export function createQueueAdapterFromConfig(): QueueAdapter {
  const config = loadConfig();
  switch (config.messaging.type) {
    case "rabbitmq":
      return new RabbitMQAdapter();
    case "kafka":
      return new KafkaAdapter();
    default:
      throw new Error(`Unsupported messaging type: ${config.messaging.type}`);
  }
}

export async function getQueueAdapter(): Promise<QueueAdapter> {
  if (!adapterPromise) {
    const adapter = createQueueAdapterFromConfig();
    adapterPromise = adapter
      .connect()
      .then(() => adapter)
      .catch(error => {
        adapterPromise = null;
        throw error;
      });
  }
  return adapterPromise;
}

export function resetQueueAdapter(): void {
  adapterPromise = null;
}
