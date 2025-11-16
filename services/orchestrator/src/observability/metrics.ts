import { Counter, Gauge, Histogram, register } from "prom-client";

export const QUEUE_DEPTH_NAME = "orchestrator_queue_depth";
export const QUEUE_RETRY_NAME = "orchestrator_queue_retries_total";
export const QUEUE_ACK_NAME = "orchestrator_queue_acks_total";
export const QUEUE_DEADLETTER_NAME = "orchestrator_queue_dead_letters_total";
export const QUEUE_RESULTS_NAME = "orchestrator_queue_results_total";
export const QUEUE_PROCESSING_SECONDS_NAME = "orchestrator_queue_processing_seconds";
export const QUEUE_PARTITION_LAG_NAME = "orchestrator_queue_partition_lag";
export const QUEUE_LAG_NAME = "orchestrator_queue_lag";

const DEFAULT_TENANT_LABEL = resolveDefaultTenantLabel();

const VALID_LABEL_VALUE = /[^a-zA-Z0-9_.:-]/g;

function sanitizeLabelValue(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  const sanitized = trimmed.replace(VALID_LABEL_VALUE, "_").slice(0, 256);
  if (!sanitized) {
    return fallback;
  }
  return sanitized;
}

// NOTE: This helper intentionally stays simple and does not handle escaped commas or equals
// characters from the OTEL spec. Provide attributes without escaped delimiters or extend the
// parser before relying on such inputs.
function parseOtelResourceAttributes(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }
  return raw.split(",").reduce<Record<string, string>>((acc, segment) => {
    const entry = segment.trim();
    if (!entry) {
      return acc;
    }
    const [key, ...valueParts] = entry.split("=");
    if (!key || valueParts.length === 0) {
      return acc;
    }
    acc[key.trim()] = valueParts.join("=").trim();
    return acc;
  }, {});
}

function resolveDefaultTenantLabel(): string {
  const attributes = parseOtelResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES);
  const candidate =
    process.env.METRICS_TENANT_LABEL ??
    attributes["tenant.id"] ??
    attributes["deployment.tenant"] ??
    attributes["service.namespace"];
  return sanitizeLabelValue(candidate, "unscoped");
}

export function getDefaultTenantLabel(): string {
  return DEFAULT_TENANT_LABEL;
}

export function resolveTenantLabel(candidate?: string): string {
  return sanitizeLabelValue(candidate, DEFAULT_TENANT_LABEL);
}

export const __testUtils = {
  parseOtelResourceAttributes
};
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
    labelNames: ["queue", "transport", "tenant"]
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
    labelNames: ["queue", "transport", "tenant"]
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
    labelNames: ["queue", "partition", "transport", "tenant"]
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
