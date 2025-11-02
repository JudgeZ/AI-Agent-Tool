import { afterEach, describe, expect, it } from "vitest";

import { ensureTracing, shutdownTracing, startSpan, withSpan, type TracingConfig } from "./tracing.js";

const DISABLED_CONFIG: TracingConfig = {
  enabled: false,
  serviceName: "test-service",
  environment: "test",
  exporterEndpoint: "http://127.0.0.1:4318/v1/traces",
  exporterHeaders: {},
  sampleRatio: 1
};

describe("observability/tracing", () => {
  afterEach(async () => {
    await shutdownTracing();
  });

  it("creates spans with consistent context", () => {
    const span = startSpan("test.span", { foo: "bar" });
    expect(span.context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.context.spanId).toMatch(/^[0-9a-f]{16}$/);
    span.setAttribute("answer", 42);
    expect(span.attributes).toMatchObject({ foo: "bar", answer: 42 });
    span.addEvent("unit-test", { status: "ok" });
    span.end();
  });

  it("wraps callbacks with withSpan", async () => {
    const result = await withSpan("test.withSpan", async span => {
      span.setAttribute("inside", true);
      return span.context.traceId;
    });
    expect(result).toMatch(/^[0-9a-f]{32}$/);
  });

  it("allows tracing configuration to be applied multiple times", async () => {
    await ensureTracing(DISABLED_CONFIG);
    await ensureTracing(DISABLED_CONFIG);
  });
});

