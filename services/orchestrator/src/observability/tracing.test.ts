import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AlwaysOnSampler, ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";

const tracingMocks = vi.hoisted(() => {
  const instrumentationConfig = { tracing: true };
  const getNodeAutoInstrumentationsMock = vi.fn(() => instrumentationConfig);
  const exporterCalls: Array<Record<string, unknown>> = [];
  function MockExporter(options: Record<string, unknown>) {
    exporterCalls.push(options);
  }
  const constructorCalls: Array<Record<string, unknown>> = [];
  const startMock = vi.fn<() => Promise<void>>();
  const shutdownMock = vi.fn<() => Promise<void>>();
  const nodeSdkInstances: Array<{ options: Record<string, unknown> }> = [];

  class MockNodeSDK {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      constructorCalls.push(options);
      nodeSdkInstances.push(this);
    }

    start = startMock;
    shutdown = shutdownMock;
  }

  return {
    instrumentationConfig,
    getNodeAutoInstrumentationsMock,
    exporterCalls,
    constructorCalls,
    startMock,
    shutdownMock,
    nodeSdkInstances,
    MockExporter,
    MockNodeSDK,
  };
});

vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: tracingMocks.getNodeAutoInstrumentationsMock,
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: tracingMocks.MockExporter,
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: tracingMocks.MockNodeSDK,
}));

const {
  instrumentationConfig,
  getNodeAutoInstrumentationsMock,
  exporterCalls,
  constructorCalls,
  startMock,
  shutdownMock,
  nodeSdkInstances,
} = tracingMocks;

import { appLogger } from "./logger.js";
import { ensureTracing, shutdownTracing, startSpan, withSpan, type TracingConfig } from "./tracing.js";

const DISABLED_CONFIG: TracingConfig = {
  enabled: false,
  serviceName: "test-service",
  environment: "test",
  exporterEndpoint: "http://127.0.0.1:4318/v1/traces",
  exporterHeaders: {},
  sampleRatio: 1,
};

function buildConfig(overrides: Partial<TracingConfig> = {}): TracingConfig {
  return {
    enabled: true,
    serviceName: "test-service",
    environment: "test",
    exporterEndpoint: "http://collector/v1/traces",
    exporterHeaders: { Authorization: "Bearer test" },
    sampleRatio: 0.5,
    ...overrides,
  };
}

let appLoggerErrorSpy: ReturnType<typeof vi.spyOn>;

describe("observability/tracing", () => {
  beforeEach(() => {
    exporterCalls.length = 0;
    constructorCalls.length = 0;
    nodeSdkInstances.length = 0;
    getNodeAutoInstrumentationsMock.mockReset();
    getNodeAutoInstrumentationsMock.mockReturnValue(instrumentationConfig);
    startMock.mockReset();
    shutdownMock.mockReset();
    startMock.mockResolvedValue(undefined);
    shutdownMock.mockResolvedValue(undefined);
    appLoggerErrorSpy = vi.spyOn(appLogger, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await shutdownTracing();
    appLoggerErrorSpy.mockRestore();
  });

  it("creates spans with consistent context", () => {
    const span = startSpan("test.span", { foo: "bar", when: new Date("2024-01-01T00:00:00Z") });
    expect(span.context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.context.spanId).toMatch(/^[0-9a-f]{16}$/);
    span.setAttribute("answer", 42);
    span.setAttribute("tags", ["one", "two"]);
    expect(span.attributes).toMatchObject({ foo: "bar", answer: 42, tags: ["one", "two"] });
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
    expect(constructorCalls).toHaveLength(0);
  });

  it("initializes tracing with enabled configuration", async () => {
    const config = buildConfig();

    await ensureTracing(config);

    expect(nodeSdkInstances).toHaveLength(1);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(exporterCalls[0]).toEqual({
      url: config.exporterEndpoint,
      headers: config.exporterHeaders,
    });
    expect(getNodeAutoInstrumentationsMock).toHaveBeenCalledTimes(1);

    const instance = nodeSdkInstances[0];
    const resource = instance.options.resource as { attributes: Record<string, unknown> };
    expect(resource.attributes["service.name"]).toBe(config.serviceName);
    expect(resource.attributes["deployment.environment"]).toBe(config.environment);
    expect(instance.options.instrumentations).toBe(instrumentationConfig);
  });

  it("reuses the active SDK when the configuration is unchanged", async () => {
    const config = buildConfig();
    await ensureTracing(config);
    expect(nodeSdkInstances).toHaveLength(1);
    startMock.mockClear();

    await ensureTracing(config);

    expect(nodeSdkInstances).toHaveLength(1);
    expect(startMock).not.toHaveBeenCalled();
    expect(shutdownMock).not.toHaveBeenCalled();
  });

  it("reinitializes tracing when the configuration changes", async () => {
    const first = buildConfig({ sampleRatio: 0.1 });
    const second = buildConfig({ sampleRatio: 0.2 });

    await ensureTracing(first);
    startMock.mockClear();
    shutdownMock.mockClear();

    await ensureTracing(second);

    expect(nodeSdkInstances).toHaveLength(2);
    expect(shutdownMock).toHaveBeenCalledTimes(1);
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("shuts down the active SDK when tracing is disabled", async () => {
    const enabledConfig = buildConfig();
    await ensureTracing(enabledConfig);
    shutdownMock.mockClear();

    await ensureTracing({ ...enabledConfig, enabled: false });

    expect(shutdownMock).toHaveBeenCalledTimes(1);
    expect(nodeSdkInstances).toHaveLength(1);
  });

  it("logs and rethrows errors when SDK initialization fails", async () => {
    const error = new Error("start failed");
    startMock.mockRejectedValueOnce(error);
    const config = buildConfig();

    await expect(ensureTracing(config)).rejects.toThrow(error);
    expect(appLoggerErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ subsystem: "tracing", err: expect.objectContaining({ message: "start failed" }) }),
      "Failed to initialize tracing",
    );

    startMock.mockResolvedValueOnce(undefined);
    await ensureTracing(config);
    expect(nodeSdkInstances).toHaveLength(2);
  });

  it("creates samplers that respect sample ratio bounds", async () => {
    const alwaysConfig = buildConfig({ sampleRatio: 1.2 });
    await ensureTracing(alwaysConfig);
    const firstSampler = nodeSdkInstances.at(-1)!.options.sampler as ParentBasedSampler;
    expect(firstSampler).toBeInstanceOf(ParentBasedSampler);
    const firstRoot = (firstSampler as unknown as { _root: unknown })._root;
    expect(firstRoot).toBeInstanceOf(AlwaysOnSampler);

    const zeroConfig = buildConfig({ sampleRatio: 0 });
    await ensureTracing(zeroConfig);
    const secondSampler = nodeSdkInstances.at(-1)!.options.sampler as ParentBasedSampler;
    const secondRoot = (secondSampler as unknown as { _root: TraceIdRatioBasedSampler })._root;
    expect(secondRoot).toBeInstanceOf(TraceIdRatioBasedSampler);
    expect((secondRoot as unknown as { _ratio: number })._ratio).toBe(0);
  });
});

