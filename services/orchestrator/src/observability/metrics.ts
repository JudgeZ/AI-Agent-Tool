import { Counter, Gauge, Histogram, register } from "prom-client";

export const QUEUE_DEPTH_NAME = "orchestrator_queue_depth";
export const QUEUE_RETRY_NAME = "orchestrator_queue_retries_total";
export const QUEUE_ACK_NAME = "orchestrator_queue_acks_total";
export const QUEUE_DEADLETTER_NAME = "orchestrator_queue_dead_letters_total";
export const QUEUE_RESULTS_NAME = "orchestrator_queue_results_total";
export const QUEUE_PROCESSING_SECONDS_NAME = "orchestrator_queue_processing_seconds";

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

export const queueDepthGauge = getOrCreateGauge();
export const queueRetryCounter = getOrCreateRetryCounter();
export const queueAckCounter = getOrCreateAckCounter();
export const queueDeadLetterCounter = getOrCreateDeadLetterCounter();
const resultCounter = getOrCreateResultCounter();
const processingHistogram = getOrCreateProcessingHistogram();

export function resetMetrics(): void {
  register.resetMetrics();
  queueDepthGauge.reset();
  queueRetryCounter.reset();
  queueAckCounter.reset();
  queueDeadLetterCounter.reset();
  resultCounter.reset();
  processingHistogram.reset();
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
