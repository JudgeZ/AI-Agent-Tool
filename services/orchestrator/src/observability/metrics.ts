import { Counter, Gauge, Histogram, register } from "prom-client";

export const QUEUE_DEPTH_NAME = "orchestrator_queue_depth";
export const QUEUE_RETRY_NAME = "orchestrator_queue_retries_total";
export const QUEUE_ACK_NAME = "orchestrator_queue_acks_total";
export const QUEUE_DEADLETTER_NAME = "orchestrator_queue_dead_letters_total";
export const QUEUE_RESULTS_NAME = "orchestrator_queue_results_total";
export const QUEUE_PROCESSING_SECONDS_NAME = "orchestrator_queue_processing_seconds";
export const QUEUE_PARTITION_LAG_NAME = "orchestrator_queue_partition_lag";
export const QUEUE_LAG_NAME = "orchestrator_queue_lag";
const RATE_LIMIT_HITS_NAME = "limit_hits_total";
const RATE_LIMIT_BLOCKED_NAME = "limit_blocked_total";
function getOrCreateRateLimitHitCounter(): Counter<string> {
  const existing = register.getSingleMetric(RATE_LIMIT_HITS_NAME) as Counter<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Counter({
    name: RATE_LIMIT_HITS_NAME,
    help: "Total number of requests allowed by rate limiting",
    labelNames: ["endpoint", "identity_type"]
  });
}

function getOrCreateRateLimitBlockedCounter(): Counter<string> {
  const existing = register.getSingleMetric(RATE_LIMIT_BLOCKED_NAME) as Counter<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Counter({
    name: RATE_LIMIT_BLOCKED_NAME,
    help: "Total number of requests blocked by rate limiting",
    labelNames: ["endpoint", "identity_type"]
  });
}

function getOrCreateGauge(): Gauge<string> {
  const existing = register.getSingleMetric(QUEUE_DEPTH_NAME) as Gauge<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Gauge({
    name: QUEUE_DEPTH_NAME,
    help: "Number of messages waiting in orchestrator queues",
    labelNames: ["queue"]
  });
}

function getOrCreateRetryCounter(): Counter<string> {
  const existing = register.getSingleMetric(QUEUE_RETRY_NAME) as Counter<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Counter({
    name: QUEUE_RETRY_NAME,
    help: "Total number of orchestrator queue retries",
    labelNames: ["queue"]
  });
}

function getOrCreateAckCounter(): Counter<string> {
  const existing = register.getSingleMetric(QUEUE_ACK_NAME) as Counter<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Counter({
    name: QUEUE_ACK_NAME,
    help: "Total number of orchestrator queue acknowledgements",
    labelNames: ["queue"]
  });
}

function getOrCreateDeadLetterCounter(): Counter<string> {
  const existing = register.getSingleMetric(QUEUE_DEADLETTER_NAME) as Counter<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Counter({
    name: QUEUE_DEADLETTER_NAME,
    help: "Total number of orchestrator queue dead-letter operations",
    labelNames: ["queue"]
  });
}

function getOrCreateLagGauge(): Gauge<string> {
  const existing = register.getSingleMetric(QUEUE_LAG_NAME) as Gauge<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Gauge({
    name: QUEUE_LAG_NAME,
    help: "Total consumer lag for orchestrator queues (messages)",
    labelNames: ["queue"]
  });
}

function getOrCreatePartitionLagGauge(): Gauge<string> {
  const existing = register.getSingleMetric(QUEUE_PARTITION_LAG_NAME) as Gauge<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Gauge({
    name: QUEUE_PARTITION_LAG_NAME,
    help: "Consumer lag for orchestrator queues by partition",
    labelNames: ["queue", "partition"]
  });
}

export const queueDepthGauge = getOrCreateGauge();
export const queueRetryCounter = getOrCreateRetryCounter();
export const queueAckCounter = getOrCreateAckCounter();
export const queueDeadLetterCounter = getOrCreateDeadLetterCounter();
export const queueLagGauge = getOrCreateLagGauge();
export const queuePartitionLagGauge = getOrCreatePartitionLagGauge();
const resultCounter = getOrCreateResultCounter();
const processingHistogram = getOrCreateProcessingHistogram();
const rateLimitHitCounter = getOrCreateRateLimitHitCounter();
const rateLimitBlockedCounter = getOrCreateRateLimitBlockedCounter();

export function resetMetrics(): void {
  register.resetMetrics();
  queueDepthGauge.reset();
  queueRetryCounter.reset();
  queueAckCounter.reset();
  queueDeadLetterCounter.reset();
  queueLagGauge.reset();
  queuePartitionLagGauge.reset();
  resultCounter.reset();
  processingHistogram.reset();
  rateLimitHitCounter.reset();
  rateLimitBlockedCounter.reset();
}

function getOrCreateResultCounter(): Counter<string> {
  const existing = register.getSingleMetric(QUEUE_RESULTS_NAME) as Counter<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Counter({
    name: QUEUE_RESULTS_NAME,
    help: "Total number of orchestrator queue processing results",
    labelNames: ["queue", "result"]
  });
}

function getOrCreateProcessingHistogram(): Histogram<string> {
  const existing = register.getSingleMetric(QUEUE_PROCESSING_SECONDS_NAME) as Histogram<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Histogram({
    name: QUEUE_PROCESSING_SECONDS_NAME,
    help: "Observed latency of orchestrator queue message processing in seconds",
    labelNames: ["queue"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]
  });
}

export const queueResultCounter = resultCounter;
export const queueProcessingHistogram = processingHistogram;

export function getMetricsContentType(): string {
  return register.contentType;
}

export function getMetricsSnapshot(): Promise<string> {
  return register.metrics();
}

export function recordRateLimitOutcome(endpoint: string, identityType: string, allowed: boolean): void {
  const labels = { endpoint, identity_type: identityType };
  if (allowed) {
    rateLimitHitCounter.labels(labels).inc();
    return;
  }
  rateLimitBlockedCounter.labels(labels).inc();
}
