import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { register } from "prom-client";

import {
  QUEUE_ACK_NAME,
  QUEUE_DEADLETTER_NAME,
  QUEUE_DEPTH_NAME,
  QUEUE_LAG_NAME,
  QUEUE_PARTITION_LAG_NAME,
  QUEUE_PROCESSING_SECONDS_NAME,
  QUEUE_RESULTS_NAME,
  QUEUE_RETRY_NAME,
  queueAckCounter,
  queueDeadLetterCounter,
  queueDepthGauge,
  queueLagGauge,
  queuePartitionLagGauge,
  queueProcessingHistogram,
  queueResultCounter,
  queueRetryCounter,
  resetMetrics
} from "./metrics";

describe("metrics", () => {
  beforeEach(() => {
    resetMetrics();
  });

  afterEach(() => {
    resetMetrics();
  });

  it("reuses cached collectors for each metric", () => {
    expect(register.getSingleMetric(QUEUE_DEPTH_NAME)).toBe(queueDepthGauge);
    expect(register.getSingleMetric(QUEUE_RETRY_NAME)).toBe(queueRetryCounter);
    expect(register.getSingleMetric(QUEUE_ACK_NAME)).toBe(queueAckCounter);
    expect(register.getSingleMetric(QUEUE_DEADLETTER_NAME)).toBe(
      queueDeadLetterCounter
    );
    expect(register.getSingleMetric(QUEUE_LAG_NAME)).toBe(queueLagGauge);
    expect(register.getSingleMetric(QUEUE_PARTITION_LAG_NAME)).toBe(
      queuePartitionLagGauge
    );
    expect(register.getSingleMetric(QUEUE_RESULTS_NAME)).toBe(queueResultCounter);
    expect(register.getSingleMetric(QUEUE_PROCESSING_SECONDS_NAME)).toBe(
      queueProcessingHistogram
    );
  });

  it("resets all metric values", async () => {
    queueDepthGauge.labels("primary").set(5);
    queueRetryCounter.labels("primary").inc();
    queueAckCounter.labels("primary").inc(2);
    queueDeadLetterCounter.labels("primary").inc();
    queueLagGauge.labels("primary").set(3);
    queuePartitionLagGauge.labels("primary", "0").set(7);
    queueResultCounter.labels("primary", "success").inc(4);
    queueProcessingHistogram.labels("primary").observe(0.5);

    expect((await queueRetryCounter.get()).values[0]?.value).toBe(1);

    resetMetrics();

    expect((await queueDepthGauge.get()).values).toHaveLength(0);
    expect((await queueRetryCounter.get()).values).toHaveLength(0);
    expect((await queueAckCounter.get()).values).toHaveLength(0);
    expect((await queueDeadLetterCounter.get()).values).toHaveLength(0);
    expect((await queueLagGauge.get()).values).toHaveLength(0);
    expect((await queuePartitionLagGauge.get()).values).toHaveLength(0);
    expect((await queueResultCounter.get()).values).toHaveLength(0);
    expect((await queueProcessingHistogram.get()).values).toHaveLength(0);

    expect(register.getSingleMetric(QUEUE_RETRY_NAME)).toBe(queueRetryCounter);
  });
});
