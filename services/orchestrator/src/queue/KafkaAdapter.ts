import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  type Admin,
  type Consumer,
  type EachMessagePayload,
  Kafka,
  KafkaJSProtocolError,
  logLevel,
  type Message,
  type Producer,
  type IHeaders,
  type KafkaConfig,
  type SASLOptions
} from "kafkajs";

import {
  getDefaultTenantLabel,
  queueAckCounter,
  queueDeadLetterCounter,
  queueDepthGauge,
  queueLagGauge,
  queuePartitionLagGauge,
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
import type { KafkaSaslConfig, KafkaSaslMechanism, KafkaTlsConfig } from "../config.js";

const DEFAULT_BROKERS = ["localhost:9092"];
const DEFAULT_CLIENT_ID = "oss-orchestrator";
const DEFAULT_GROUP_ID = "oss-orchestrator-plan-executor";
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_TOPIC_PARTITIONS = 1;
const DEFAULT_REPLICATION_FACTOR = 1;
const DEFAULT_DEAD_LETTER_SUFFIX = ".dead";

type TopicMatcher = (value: string) => boolean;

const BUILTIN_COMPACT_MATCHERS: TopicMatcher[] = [
  value => value.endsWith(".state"),
  value => value.endsWith(".state-store"),
  value => value.endsWith(".job-state")
];

type Logger = Pick<typeof console, "info" | "warn" | "error">;

type KafkaAdapterOptions = {
  brokers?: string[];
  clientId?: string;
  groupId?: string;
  fromBeginning?: boolean;
  retryDelayMs?: number;
  kafka?: KafkaFactory;
  logger?: Logger;
  ensureTopics?: boolean;
  topicConfig?: Record<string, string>;
  compactTopicPatterns?: Array<string | RegExp>;
  numPartitions?: number;
  replicationFactor?: number;
  tls?: KafkaTlsConfig;
  sasl?: KafkaSaslConfig;
  deadLetterSuffix?: string;
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

function toKafkaMessages(payload: unknown, headers: Record<string, string>, key?: string): Message[] {
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
  private readonly ensureTopics: boolean;
  private readonly numPartitions: number;
  private readonly replicationFactor: number;
  private readonly topicConfig: Record<string, string>;
  private readonly compactTopicMatchers: TopicMatcher[];
  private readonly deadLetterSuffix: string;
  private readonly tenantLabel: string;
  private readonly transportLabel = "kafka";
  private readonly partitionLagPartitions = new Map<string, Set<string>>();

  private producer: Producer | null = null;
  private consumer: Consumer | null = null;
  private admin: Admin | null = null;
  private connecting: Promise<void> | null = null;
  private consumerRunning = false;
  private connected = false;

  private readonly consumers = new Map<string, QueueHandler<any>>();
  private readonly inflightKeys = new Set<string>();
  private readonly knownTopics = new Set<string>();
  private readonly topicInitPromises = new Map<string, Promise<void>>();

  constructor(options: KafkaAdapterOptions = {}) {
    this.brokers = options.brokers ?? parseBrokerList(process.env.KAFKA_BROKERS) ?? DEFAULT_BROKERS;
    this.clientId = options.clientId ?? process.env.KAFKA_CLIENT_ID ?? DEFAULT_CLIENT_ID;
    this.groupId = options.groupId ?? process.env.KAFKA_GROUP_ID ?? DEFAULT_GROUP_ID;
    this.fromBeginning = options.fromBeginning ?? parseBoolean(process.env.KAFKA_CONSUME_FROM_BEGINNING) ?? false;
    this.retryDelayMs = options.retryDelayMs ?? Number(process.env.KAFKA_RETRY_DELAY_MS ?? DEFAULT_RETRY_DELAY_MS);
    this.logger = options.logger ?? console;
    const ensureTopicsEnv = parseBoolean(process.env.KAFKA_ENSURE_TOPICS);
    this.ensureTopics = options.ensureTopics ?? ensureTopicsEnv ?? true;
    this.numPartitions =
      options.numPartitions ?? parsePositiveInteger(process.env.KAFKA_TOPIC_PARTITIONS) ?? DEFAULT_TOPIC_PARTITIONS;
    this.replicationFactor =
      options.replicationFactor ??
      parsePositiveInteger(process.env.KAFKA_TOPIC_REPLICATION_FACTOR) ??
      DEFAULT_REPLICATION_FACTOR;
    const defaultTopicConfig = options.topicConfig ?? parseTopicConfig(process.env.KAFKA_TOPIC_DEFAULT_CONFIG) ?? {};
    this.topicConfig = { ...defaultTopicConfig };
    const compactPatterns = options.compactTopicPatterns ?? parseList(process.env.KAFKA_TOPIC_COMPACT_PATTERNS) ?? [];
    const compiledPatterns = compactPatterns.map(pattern =>
      pattern instanceof RegExp ? ((value: string) => pattern.test(value)) : compileTopicPattern(pattern)
    );
    this.compactTopicMatchers = [...BUILTIN_COMPACT_MATCHERS, ...compiledPatterns];
    this.deadLetterSuffix =
      options.deadLetterSuffix ?? process.env.KAFKA_DEAD_LETTER_SUFFIX ?? DEFAULT_DEAD_LETTER_SUFFIX;
    this.tenantLabel = getDefaultTenantLabel();

    const tlsConfig = options.tls ?? parseTlsConfigFromEnv();
    const saslConfig = options.sasl ?? parseSaslConfigFromEnv();
    const ssl = resolveKafkaSslOptions(tlsConfig, this.logger);
    const sasl = resolveKafkaSaslOptions(saslConfig, this.logger);

    if (options.kafka) {
      this.kafkaFactory = options.kafka;
    } else {
      const kafkaOptions: KafkaConfig = {
        clientId: this.clientId,
        brokers: this.brokers,
        logLevel: logLevel.NOTHING
      };
      if (ssl !== undefined) {
        kafkaOptions.ssl = ssl;
      }
      if (sasl) {
        kafkaOptions.sasl = sasl;
      }
      this.kafkaFactory = new Kafka(kafkaOptions);
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
        Array.from(this.consumers.keys()).map(async topic => {
          await this.ensureTopicExists(topic);
          await this.consumer!.subscribe({ topic, fromBeginning: this.fromBeginning });
        })
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
    this.knownTopics.clear();
    this.topicInitPromises.clear();

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
    await this.ensureTopicExists(queue);
    await this.consumer!.subscribe({ topic: queue, fromBeginning: this.fromBeginning });
  }

  async getQueueDepth(queue: string): Promise<number> {
    await this.ensureConnected();
    if (!this.admin) {
      return 0;
    }

    try {
      await this.ensureTopicExists(queue);
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

      let totalLag = 0n;
      const partitionIds = new Set<string>();
      for (const partition of topicOffsets) {
        const latest = BigInt(partition.offset);
        const committedRaw = groupOffsetMap.get(partition.partition);
        const committed = committedRaw && committedRaw !== "-1" ? BigInt(committedRaw) : latest;
        const partitionLag = latest > committed ? latest - committed : 0n;
        const partitionId = partition.partition.toString();
        queuePartitionLagGauge
          .labels(queue, partitionId, this.transportLabel, this.tenantLabel)
          .set(Number(partitionLag));
        partitionIds.add(partitionId);
        totalLag += partitionLag;
      }
      this.partitionLagPartitions.set(queue, partitionIds);
      const totalLagNumber = Number(totalLag);
      queueLagGauge.labels(queue, this.transportLabel, this.tenantLabel).set(totalLagNumber);
      return totalLagNumber;
    } catch (error) {
      this.logger.warn?.(`Failed to fetch Kafka lag for ${queue}: ${(error as Error).message}`);
      queueLagGauge.labels(queue, this.transportLabel, this.tenantLabel).set(0);
      const knownPartitions = this.partitionLagPartitions.get(queue);
      if (knownPartitions) {
        for (const partitionId of knownPartitions) {
          queuePartitionLagGauge
            .labels(queue, partitionId, this.transportLabel, this.tenantLabel)
            .set(0);
        }
      }
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

  private async ensureTopicExists(topic: string): Promise<void> {
    if (!this.ensureTopics || this.knownTopics.has(topic)) {
      return;
    }
    const existing = this.topicInitPromises.get(topic);
    if (existing) {
      await existing;
      return;
    }

    const initPromise = (async () => {
      const admin = this.admin;
      if (!admin) {
        throw new Error("Kafka admin unavailable");
      }
      const configEntries = this.buildTopicConfigEntries(topic);
      try {
        await admin.createTopics({
          waitForLeaders: true,
          topics: [
            {
              topic,
              numPartitions: this.numPartitions,
              replicationFactor: this.replicationFactor,
              configEntries: configEntries.length > 0 ? configEntries : undefined
            }
          ]
        });
      } catch (error: unknown) {
        if (!isTopicExistsError(error)) {
          throw error;
        }
      }
      this.knownTopics.add(topic);
    })();

    this.topicInitPromises.set(topic, initPromise);
    try {
      await initPromise;
    } finally {
      this.topicInitPromises.delete(topic);
    }
  }

  private buildTopicConfigEntries(topic: string): Array<{ name: string; value: string }> {
    const config: Record<string, string> = { ...this.topicConfig };
    if (this.shouldCompactTopic(topic)) {
      config["cleanup.policy"] = config["cleanup.policy"] ?? "compact";
      config["retention.ms"] = config["retention.ms"] ?? "-1";
      config["delete.retention.ms"] = config["delete.retention.ms"] ?? "86400000";
    }
    return Object.entries(config).map(([name, value]) => ({ name, value }));
  }

  private shouldCompactTopic(topic: string): boolean {
    return matchesAny(this.compactTopicMatchers, topic);
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
        const targetTopic = options?.queue ?? `${topic}${this.deadLetterSuffix}`;
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
      const maxAttemptsEnv = process.env.QUEUE_MAX_ATTEMPTS;
      const maxAttempts = Number.isFinite(Number(maxAttemptsEnv)) ? Number(maxAttemptsEnv) : 3;
      if (attempts + 1 >= maxAttempts) {
        await queueMessage.deadLetter({ reason: "max_attempts_exceeded" });
      } else {
        await queueMessage.retry();
      }
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

    await this.ensureTopicExists(topic);

    const resolvedAttempt = Number.isFinite(attempt) ? Number(attempt) : 0;
    const headers: Record<string, string> = {
      ...sanitizeHeaders(overrideHeaders),
      "x-attempts": String(resolvedAttempt)
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

    const messagePayload = this.preparePayloadForAttempt(payload, resolvedAttempt);

    try {
      await this.producer.send({
        topic,
        messages: toKafkaMessages(messagePayload, headers, idempotencyKey)
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
      queueDepthGauge.labels(queue, this.transportLabel, this.tenantLabel).set(depth);
    } catch (error: unknown) {
      this.logger.warn?.(`Failed to refresh Kafka depth for ${queue}: ${(error as Error).message}`);
      queueDepthGauge.labels(queue, this.transportLabel, this.tenantLabel).set(0);
      queueLagGauge.labels(queue, this.transportLabel, this.tenantLabel).set(0);
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
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
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

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const intValue = Math.floor(parsed);
  return intValue > 0 ? intValue : undefined;
}

function parseTopicConfig(value: string | undefined): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }
  const config: Record<string, string> = {};
  for (const fragment of value.split(/[;,]/)) {
    const entry = fragment.trim();
    if (!entry) {
      continue;
    }
    const [rawKey, ...rest] = entry.split("=");
    const key = rawKey?.trim();
    if (!key) {
      continue;
    }
    const val = rest.join("=").trim();
    if (!val) {
      continue;
    }
    config[key] = val;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const items = value
    .split(",")
    .map(item => item.trim())
    .filter(item => item.length > 0);
  return items.length > 0 ? items : undefined;
}
function parseSaslMechanism(value: string | undefined): KafkaSaslMechanism | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "plain":
    case "scram-sha-256":
    case "scram-sha-512":
    case "aws":
      return normalized as KafkaSaslMechanism;
    case "oauthbearer":
    case "oauthbearertoken":
      return "oauthbearer";
    default:
      return undefined;
  }
}
function parseTlsConfigFromEnv(): KafkaTlsConfig | undefined {
  const enabled = parseBoolean(process.env.KAFKA_TLS_ENABLED);
  const caPaths = parseList(process.env.KAFKA_TLS_CA_PATHS);
  const certPath = process.env.KAFKA_TLS_CERT_PATH?.trim();
  const keyPath = process.env.KAFKA_TLS_KEY_PATH?.trim();
  const rejectUnauthorized = parseBoolean(process.env.KAFKA_TLS_REJECT_UNAUTHORIZED);
  const anyConfigured =
    enabled !== undefined ||
    (caPaths && caPaths.length > 0) ||
    (certPath && certPath.length > 0) ||
    (keyPath && keyPath.length > 0) ||
    rejectUnauthorized !== undefined;
  if (!anyConfigured) {
    return undefined;
  }
  return {
    enabled: enabled ?? true,
    caPaths: caPaths ?? [],
    certPath: certPath || undefined,
    keyPath: keyPath || undefined,
    rejectUnauthorized: rejectUnauthorized ?? true
  };
}
function parseSaslConfigFromEnv(): KafkaSaslConfig | undefined {
  const mechanism = parseSaslMechanism(process.env.KAFKA_SASL_MECHANISM);
  if (!mechanism) {
    return undefined;
  }
  const username = process.env.KAFKA_SASL_USERNAME?.trim();
  const password = process.env.KAFKA_SASL_PASSWORD?.trim();
  const authorizationIdentity = process.env.KAFKA_SASL_AUTHORIZATION_IDENTITY?.trim();
  return {
    mechanism,
    username: username && username.length > 0 ? username : undefined,
    password: password && password.length > 0 ? password : undefined,
    authorizationIdentity:
      authorizationIdentity && authorizationIdentity.length > 0 ? authorizationIdentity : undefined
  };
}
function readFileBuffer(filePath: string): Buffer {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  try {
    return fs.readFileSync(resolved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read Kafka TLS file at ${resolved}: ${message}`);
  }
}
function resolveKafkaSslOptions(
  tls: KafkaTlsConfig | undefined,
  logger: Logger
): KafkaConfig["ssl"] | undefined {
  if (!tls || !tls.enabled) {
    return undefined;
  }
  const ca = tls.caPaths?.map(readFileBuffer).filter(buffer => buffer.length > 0);
  const cert = tls.certPath ? readFileBuffer(tls.certPath) : undefined;
  const key = tls.keyPath ? readFileBuffer(tls.keyPath) : undefined;
  if (!tls.rejectUnauthorized) {
    logger.warn?.("Kafka TLS rejectUnauthorized=false reduces security; prefer trusted certificates");
  }
  return {
    rejectUnauthorized: tls.rejectUnauthorized,
    ca: ca && ca.length > 0 ? ca : undefined,
    cert,
    key
  };
}
function resolveKafkaSaslOptions(config: KafkaSaslConfig | undefined, logger: Logger): SASLOptions | undefined {
  if (!config) {
    return undefined;
  }
  switch (config.mechanism) {
    case "plain":
    case "scram-sha-256":
    case "scram-sha-512": {
      if (!config.username || !config.password) {
        throw new Error(`Kafka SASL ${config.mechanism} requires both username and password`);
      }
      return {
        mechanism: config.mechanism,
        username: config.username,
        password: config.password
      };
    }
    case "aws": {
      if (!config.username || !config.password) {
        throw new Error("Kafka SASL aws requires username/accessKeyId and password/secretAccessKey");
      }
      return {
        mechanism: "aws",
        accessKeyId: config.username,
        secretAccessKey: config.password,
        authorizationIdentity: config.authorizationIdentity ?? config.username ?? ""
      };
    }
    case "oauthbearer":
      logger.warn?.("Kafka SASL oauthbearer requires custom token provider; skipping SASL configuration");
      return undefined;
    default:
      logger.warn?.(`Kafka SASL mechanism ${config.mechanism as string} is not supported; skipping SASL configuration`);
      return undefined;
  }
}

function compileTopicPattern(pattern: string): TopicMatcher {
  if (!/^[A-Za-z0-9._-]*(\*[A-Za-z0-9._-]*)*$/.test(pattern)) {
    throw new Error("Kafka compact topic patterns may only include alphanumerics, '.', '-', '_', and '*'");
  }
  if (pattern.length === 0) {
    return (value: string) => value.length === 0;
  }
  if (pattern === "*") {
    return () => true;
  }
  const segments = pattern.split("*");
  const startsWithWildcard = pattern.startsWith("*");
  const endsWithWildcard = pattern.endsWith("*");
  return (value: string) => {
    let cursor = 0;
    if (!startsWithWildcard) {
      const first = segments[0] ?? "";
      if (!value.startsWith(first)) {
        return false;
      }
      cursor = first.length;
    }
    for (let index = startsWithWildcard ? 0 : 1; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) {
        continue;
      }
      const foundAt = value.indexOf(segment, cursor);
      if (foundAt === -1) {
        return false;
      }
      cursor = foundAt + segment.length;
    }
    if (!endsWithWildcard) {
      const lastSegment = segments[segments.length - 1] ?? "";
      return value.endsWith(lastSegment);
    }
    return true;
  };
}

function matchesAny(matchers: TopicMatcher[], value: string): boolean {
  return matchers.some(matcher => {
    try {
      return matcher(value);
    } catch {
      return false;
    }
  });
}

function isTopicExistsError(error: unknown): boolean {
  return error instanceof KafkaJSProtocolError && error.type === "TOPIC_ALREADY_EXISTS";
}

