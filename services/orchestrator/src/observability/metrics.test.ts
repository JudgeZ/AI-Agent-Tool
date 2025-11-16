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
  __testUtils,
  getDefaultTenantLabel,
  queueAckCounter,
  queueDeadLetterCounter,
  queueDepthGauge,
  queueLagGauge,
  queuePartitionLagGauge,
  queueProcessingHistogram,
  queueResultCounter,
  queueRetryCounter,
  resetMetrics,
  resolveTenantLabel
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
    const tenant = getDefaultTenantLabel();
    queueDepthGauge.labels("primary", "test", tenant).set(5);
    queueRetryCounter.labels("primary").inc();
    queueAckCounter.labels("primary").inc(2);
    queueDeadLetterCounter.labels("primary").inc();
    queueLagGauge.labels("primary", "test", tenant).set(3);
    queuePartitionLagGauge.labels("primary", "0", "test", tenant).set(7);
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

  it("sanitizes tenant labels by replacing invalid characters and truncating", () => {
    const sanitized = resolveTenantLabel("  Demo Tenant!@#  ");
    expect(sanitized).toBe("Demo_Tenant___");

    const long = "a".repeat(300);
    expect(resolveTenantLabel(long)).toHaveLength(256);
  });

  it("parses OTEL attributes with equals signs in the value", () => {
    const { parseOtelResourceAttributes } = __testUtils;
    const attrs = parseOtelResourceAttributes("tenant.id=demo,token=base64==");
    expect(attrs["tenant.id"]).toBe("demo");
    expect(attrs.token).toBe("base64==");
  });

  it("handles escaped commas and equals signs in OTEL attributes", () => {
    const { parseOtelResourceAttributes } = __testUtils;
    const attrs = parseOtelResourceAttributes(
      "tenant.id=demo\\,inc,service.name=oss\\=orchestrator"
    );
    expect(attrs["tenant.id"]).toBe("demo,inc");
    expect(attrs["service.name"]).toBe("oss=orchestrator");
  });

  it("ignores malformed OTEL segments and trims whitespace", () => {
    const { parseOtelResourceAttributes } = __testUtils;
    const attrs = parseOtelResourceAttributes("=value, tenant.id = demo , keyonly");
    expect(attrs["tenant.id"]).toBe("demo");
    expect(attrs.keyonly).toBe("");
    expect(Object.keys(attrs)).toHaveLength(2);
  });

  it("returns an empty object when OTEL attributes are undefined", () => {
    const { parseOtelResourceAttributes } = __testUtils;
    expect(parseOtelResourceAttributes(undefined)).toEqual({});
  });
});
