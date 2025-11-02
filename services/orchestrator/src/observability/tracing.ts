import {
  context,
  diag,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span as OtelSpan
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  AlwaysOnSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler
} from "@opentelemetry/sdk-trace-base";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "oss-ai-agent-tool.orchestrator";
const TRACER_VERSION = process.env.npm_package_version ?? "0.0.0";

function logTracingError(message: string, error: unknown): void {
  diag.error(message, error);
  // eslint-disable-next-line no-console
  console.error("[tracing]", message, error);
}

export type TracingConfig = {
  enabled: boolean;
  serviceName: string;
  environment: string;
  exporterEndpoint: string;
  exporterHeaders: Record<string, string>;
  sampleRatio: number;
};

export type SpanContext = {
  traceId: string;
  spanId: string;
};

export type Span = {
  name: string;
  context: SpanContext;
  attributes: Record<string, unknown>;
  setAttribute: (key: string, value: unknown) => void;
  addEvent: (name: string, attributes?: Record<string, unknown>) => void;
  recordException: (error: Error) => void;
  end: () => void;
};

let activeSdk: NodeSDK | null = null;
let activeConfigKey: string | null = null;
let initializationPromise: Promise<void> | null = null;

function getTracer() {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

function normalizeAttributeValue(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toAttributes(attributes: Record<string, unknown>): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const normalized = normalizeAttributeValue(value);
    if (normalized !== undefined) {
      result[key] = normalized;
    }
  }
  return result;
}

function wrapSpan(otelSpan: OtelSpan, name: string, attributes: Record<string, unknown>): Span {
  const internalAttributes = { ...attributes };
  const spanContext = otelSpan.spanContext();
  let ended = false;

  return {
    name,
    context: {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId
    },
    attributes: internalAttributes,
    setAttribute: (key, value) => {
      internalAttributes[key] = value;
      const normalized = normalizeAttributeValue(value);
      if (normalized !== undefined) {
        otelSpan.setAttribute(key, normalized);
      }
    },
    addEvent: (eventName, eventAttributes) => {
      otelSpan.addEvent(eventName, toAttributes(eventAttributes ?? {}));
    },
    recordException: error => {
      otelSpan.recordException(error);
      otelSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    },
    end: () => {
      if (ended) {
        return;
      }
      ended = true;
      otelSpan.end();
    }
  };
}

export function startSpan(name: string, attributes: Record<string, unknown> = {}): Span {
  const tracer = getTracer();
  const otelSpan = tracer.startSpan(name, { attributes: toAttributes(attributes) });
  return wrapSpan(otelSpan, name, attributes);
}

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes: Record<string, unknown> = {}
): Promise<T> {
  const tracer = getTracer();
  const otelSpan = tracer.startSpan(name, { attributes: toAttributes(attributes) });
  const span = wrapSpan(otelSpan, name, attributes);

  return await context.with(trace.setSpan(context.active(), otelSpan), async () => {
    try {
      return await fn(span);
    } catch (error) {
      if (error instanceof Error) {
        span.recordException(error);
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

function getConfigKey(config: TracingConfig): string {
  const headersEntries = Object.entries(config.exporterHeaders)
    .map(([key, value]) => `${key}:${value}`)
    .sort()
    .join("|");
  return [
    config.enabled ? "1" : "0",
    config.serviceName,
    config.environment,
    config.exporterEndpoint,
    headersEntries,
    config.sampleRatio.toFixed(4)
  ].join("::");
}

function createSampler(sampleRatio: number): ParentBasedSampler {
  if (sampleRatio >= 1) {
    return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
  if (sampleRatio <= 0) {
    return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0) });
  }
  return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRatio) });
}

export async function ensureTracing(config: TracingConfig): Promise<void> {
  const desiredConfigKey = getConfigKey(config);

  if (!config.enabled) {
    if (initializationPromise) {
      await initializationPromise.catch(() => {});
    }
    if (activeSdk) {
      const sdkToShutdown = activeSdk;
      activeSdk = null;
      activeConfigKey = null;
      await sdkToShutdown.shutdown().catch((error: unknown) => {
        logTracingError("Failed to shutdown tracing SDK", error);
      });
    }
    return;
  }

  if (activeSdk && activeConfigKey === desiredConfigKey) {
    return;
  }

  if (initializationPromise) {
    await initializationPromise;
    if (activeSdk && activeConfigKey === desiredConfigKey) {
      return;
    }
  }

  if (activeSdk) {
    const sdkToShutdown = activeSdk;
    activeSdk = null;
    activeConfigKey = null;
    await sdkToShutdown.shutdown().catch((error: unknown) => {
      logTracingError("Failed to shutdown previous tracing SDK", error);
    });
  }

  const exporter = new OTLPTraceExporter({
    url: config.exporterEndpoint,
    headers: config.exporterHeaders
  });

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: config.environment,
    [SemanticResourceAttributes.SERVICE_VERSION]: TRACER_VERSION
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: exporter,
    sampler: createSampler(config.sampleRatio)
  });

  const startPromise = Promise.resolve(sdk.start());

  initializationPromise = startPromise
    .then(() => {
      activeSdk = sdk;
      activeConfigKey = desiredConfigKey;
    })
    .catch((error: unknown) => {
      logTracingError("Failed to initialize tracing", error);
      activeSdk = null;
      activeConfigKey = null;
      throw error;
    })
    .finally(() => {
      initializationPromise = null;
    });

  await initializationPromise;
}

export async function shutdownTracing(): Promise<void> {
  if (initializationPromise) {
    await initializationPromise.catch(() => {});
  }
  if (!activeSdk) {
    return;
  }
  const sdk = activeSdk;
  activeSdk = null;
  activeConfigKey = null;
  await sdk.shutdown().catch((error: unknown) => {
    logTracingError("Failed to shutdown tracing SDK", error);
  });
}
