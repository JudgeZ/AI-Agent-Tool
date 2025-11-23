import { Counter, Gauge, Histogram, register } from "prom-client";

export const QUEUE_DEPTH_NAME = "orchestrator_queue_depth";
export const QUEUE_RETRY_NAME = "orchestrator_queue_retries_total";
export const QUEUE_ACK_NAME = "orchestrator_queue_acks_total";
export const QUEUE_DEADLETTER_NAME = "orchestrator_queue_dead_letters_total";
export const QUEUE_RESULTS_NAME = "orchestrator_queue_results_total";
export const QUEUE_PROCESSING_SECONDS_NAME = "orchestrator_queue_processing_seconds";
export const QUEUE_PARTITION_LAG_NAME = "orchestrator_queue_partition_lag";
export const QUEUE_LAG_NAME = "orchestrator_queue_lag";

// Resolve once at module load. Callers should ensure OTEL_RESOURCE_ATTRIBUTES and
// METRICS_TENANT_LABEL are configured before importing this module.
const DEFAULT_TENANT_LABEL = resolveDefaultTenantLabel();

// Allowed characters align with the Prometheus data model for label values
// (alphanumeric plus `_`, `.`, `:`, and `-`). Everything else is replaced.
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
  return sanitized;
}

function parseOtelResourceAttributes(raw: string | undefined): Record<string, string> {
  if (!raw) {
    return {};
  }

  const pairs: Array<{ key: string; value: string }> = [];
  let current = "";
  let key = "";
  let inKey = true;
  let escape = false;

  const pushPair = (): void => {
    if (!key && current === "") {
      return;
    }
    const finalKey = key.trim();
    if (!finalKey) {
      key = "";
      current = "";
      inKey = true;
      return;
    }
    pairs.push({ key: finalKey, value: current.trim() });
    key = "";
    current = "";
    inKey = true;
  };

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]!;
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (inKey && char === "=") {
      key = current;
      current = "";
      inKey = false;
      continue;
    }
    if (!inKey && char === ",") {
      pushPair();
      continue;
    }
    current += char;
  }

  if (!inKey) {
    pairs.push({ key: key.trim(), value: current.trim() });
  } else if (current.trim() !== "") {
    pairs.push({ key: current.trim(), value: "" });
  }

  const unescapeOtel = (value: string): string => value.replace(/\\([,=\\])/g, "$1");

  return pairs.reduce<Record<string, string>>((acc, pair) => {
    const normalizedKey = unescapeOtel(pair.key);
    if (!normalizedKey) {
      return acc;
    }
    acc[normalizedKey] = unescapeOtel(pair.value);
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
  // Exported for adapters/tests that might sanitize dynamic overrides when we
  // support multi-tenant routing beyond the default label.
  return sanitizeLabelValue(candidate, DEFAULT_TENANT_LABEL);
}

export const __testUtils = {
  parseOtelResourceAttributes
};
const RATE_LIMIT_HITS_NAME = "limit_hits_total";
const RATE_LIMIT_BLOCKED_NAME = "limit_blocked_total";
const FILE_LOCK_ATTEMPT_NAME = "orchestrator_file_lock_attempts_total";
const FILE_LOCK_ATTEMPT_SECONDS_NAME = "orchestrator_file_lock_attempt_seconds";
const FILE_LOCK_RELEASE_NAME = "orchestrator_file_lock_release_total";
const FILE_LOCK_RATE_LIMIT_NAME = "orchestrator_file_lock_rate_limit_total";
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

function getOrCreateFileLockAttemptCounter(): Counter<string> {
  const existing = register.getSingleMetric(FILE_LOCK_ATTEMPT_NAME) as Counter<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Counter({
    name: FILE_LOCK_ATTEMPT_NAME,
    help: "Count of file lock attempts by operation and outcome",
    labelNames: ["operation", "outcome"],
  });
}

function getOrCreateFileLockAttemptHistogram(): Histogram<string> {
  const existing = register.getSingleMetric(FILE_LOCK_ATTEMPT_SECONDS_NAME) as Histogram<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Histogram({
    name: FILE_LOCK_ATTEMPT_SECONDS_NAME,
    help: "Latency of file lock attempts in seconds",
    labelNames: ["operation", "outcome"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  });
}

function getOrCreateFileLockReleaseCounter(): Counter<string> {
  const existing = register.getSingleMetric(FILE_LOCK_RELEASE_NAME) as Counter<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Counter({
    name: FILE_LOCK_RELEASE_NAME,
    help: "Count of file lock releases by outcome",
    labelNames: ["outcome"],
  });
}

function getOrCreateFileLockRateLimitCounter(): Counter<string> {
  const existing = register.getSingleMetric(FILE_LOCK_RATE_LIMIT_NAME) as Counter<string> | undefined;
  if (existing) {
    return existing;
  }
  return new Counter({
    name: FILE_LOCK_RATE_LIMIT_NAME,
    help: "Count of file lock rate limit outcomes",
    labelNames: ["result"],
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
const fileLockAttemptCounter = getOrCreateFileLockAttemptCounter();
const fileLockAttemptHistogram = getOrCreateFileLockAttemptHistogram();
const fileLockReleaseCounter = getOrCreateFileLockReleaseCounter();
const fileLockRateLimitCounter = getOrCreateFileLockRateLimitCounter();

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
  fileLockAttemptCounter.reset();
  fileLockAttemptHistogram.reset();
  fileLockReleaseCounter.reset();
  fileLockRateLimitCounter.reset();
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

type FileLockOperation = "acquire" | "restore";
type FileLockOutcome = "success" | "busy" | "error" | "rate_limited";

export function recordFileLockAttempt(
  operation: FileLockOperation,
  outcome: FileLockOutcome,
  durationMs: number,
): void {
  const labels = { operation, outcome };
  fileLockAttemptCounter.labels(labels).inc();
  fileLockAttemptHistogram.labels(labels).observe(durationMs / 1000);
}

export function recordFileLockRelease(outcome: "success" | "error"): void {
  fileLockReleaseCounter.labels({ outcome }).inc();
}

export function recordFileLockRateLimit(result: "allowed" | "blocked"): void {
  fileLockRateLimitCounter.labels({ result }).inc();
}

export function recordMetric(name: string, value: number, labels: Record<string, string> = {}): void {
  let metric = register.getSingleMetric(name);
  if (!metric) {
    if (name.endsWith("_total") || name.endsWith("_tokens")) {
      metric = new Counter({ name, help: `Metric ${name}` });
    } else {
      metric = new Gauge({ name, help: `Metric ${name}` });
    }
  }

  if (metric instanceof Counter) {
    metric.inc(labels, value);
  } else if (metric instanceof Gauge) {
    metric.set(labels, value);
  } else if (metric instanceof Histogram) {
    metric.observe(labels, value);
  }
}