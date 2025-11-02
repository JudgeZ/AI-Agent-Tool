import fs from "fs";
import path from "path";
import YAML from "yaml";

import { startSpan, type Span, type TracingConfig } from "./observability/tracing.js";

export type RateLimitConfig = {
  windowMs: number;
  maxRequests: number;
};

export type CircuitBreakerConfig = {
  failureThreshold: number;
  resetTimeoutMs: number;
};

export type TlsConfig = {
  enabled: boolean;
  keyPath?: string;
  certPath?: string;
  caPaths: string[];
  requestClientCert: boolean;
};

export type ObservabilityConfig = {
  tracing: TracingConfig;
};

export type AppConfig = {
  runMode: "consumer" | "enterprise";
  messaging: { type: "rabbitmq" | "kafka" };
  providers: {
    defaultRoute: "balanced" | "high_quality" | "low_cost";
    enabled: string[];
    rateLimit: RateLimitConfig;
    circuitBreaker: CircuitBreakerConfig;
  };
  auth: { oauth: { redirectBaseUrl: string } };
  secrets: { backend: "localfile" | "vault" };
  tooling: {
    agentEndpoint: string;
    retryAttempts: number;
    defaultTimeoutMs: number;
  };
  server: {
    sseKeepAliveMs: number;
    rateLimits: {
      plan: RateLimitConfig;
      chat: RateLimitConfig;
    };
    tls: TlsConfig;
  };
  observability: ObservabilityConfig;
};

type PartialRateLimitConfig = {
  windowMs?: number;
  maxRequests?: number;
};

type PartialCircuitBreakerConfig = {
  failureThreshold?: number;
  resetTimeoutMs?: number;
};

type PartialTlsConfig = {
  enabled?: boolean;
  keyPath?: string;
  certPath?: string;
  caPaths?: string[];
  requestClientCert?: boolean;
};

type PartialTracingConfig = {
  enabled?: boolean;
  serviceName?: string;
  environment?: string;
  exporterEndpoint?: string;
  exporterHeaders?: Record<string, string>;
  sampleRatio?: number;
};

type PartialProvidersConfig = {
  defaultRoute?: AppConfig["providers"]["defaultRoute"];
  enabled?: string[];
  rateLimit?: PartialRateLimitConfig;
  circuitBreaker?: PartialCircuitBreakerConfig;
};

type PartialServerConfig = {
  sseKeepAliveMs?: number;
  rateLimits?: {
    plan?: PartialRateLimitConfig;
    chat?: PartialRateLimitConfig;
  };
  tls?: PartialTlsConfig;
};

type PartialObservabilityConfig = {
  tracing?: PartialTracingConfig;
};

const DEFAULT_TRACING_CONFIG: TracingConfig = {
  enabled: false,
  serviceName: "oss-ai-orchestrator",
  environment: "development",
  exporterEndpoint: "http://127.0.0.1:4318/v1/traces",
  exporterHeaders: {},
  sampleRatio: 1
};

type PartialAppConfig = {
  runMode?: AppConfig["runMode"];
  messaging?: Partial<AppConfig["messaging"]>;
  providers?: PartialProvidersConfig;
  auth?: { oauth?: Partial<AppConfig["auth"]["oauth"]> };
  secrets?: Partial<AppConfig["secrets"]>;
  tooling?: Partial<AppConfig["tooling"]>;
  server?: PartialServerConfig;
  observability?: PartialObservabilityConfig;
};

const DEFAULT_CONFIG: AppConfig = {
  runMode: "consumer",
  messaging: { type: "rabbitmq" },
  providers: {
    defaultRoute: "balanced",
    enabled: ["openai", "local_ollama"],
    rateLimit: {
      windowMs: 60_000,
      maxRequests: 120
    },
    circuitBreaker: {
      failureThreshold: 5,
      resetTimeoutMs: 30_000
    }
  },
  auth: { oauth: { redirectBaseUrl: "http://127.0.0.1:8080" } },
  secrets: { backend: "localfile" },
  tooling: {
    agentEndpoint: "127.0.0.1:50051",
    retryAttempts: 3,
    defaultTimeoutMs: 15000
  },
  server: {
    sseKeepAliveMs: 25000,
    rateLimits: {
      plan: {
        windowMs: 60_000,
        maxRequests: 60
      },
      chat: {
        windowMs: 60_000,
        maxRequests: 600
      }
    },
    tls: {
      enabled: false,
      keyPath: undefined,
      certPath: undefined,
      caPaths: [],
      requestClientCert: true
    }
  },
  observability: {
    tracing: { ...DEFAULT_TRACING_CONFIG }
  }
};

export class ConfigLoadError extends Error {
  readonly cause: Error;

  constructor(message: string, cause: Error) {
    super(`${message}: ${cause.message}`);
    this.name = "ConfigLoadError";
    this.cause = cause;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asRunMode(value: unknown): AppConfig["runMode"] | undefined {
  return value === "consumer" || value === "enterprise" ? value : undefined;
}

function asMessagingType(value: unknown): AppConfig["messaging"]["type"] | undefined {
  return value === "rabbitmq" || value === "kafka" ? value : undefined;
}

function asDefaultRoute(value: unknown): AppConfig["providers"]["defaultRoute"] | undefined {
  return value === "balanced" || value === "high_quality" || value === "low_cost" ? value : undefined;
}

function asSecretsBackend(value: unknown): AppConfig["secrets"]["backend"] | undefined {
  return value === "localfile" || value === "vault" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value
    .filter(item => typeof item === "string")
    .map(item => item.trim())
    .filter(item => item.length > 0);
}

function parseRateLimitConfig(value: unknown): PartialRateLimitConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const windowMs = asNumber(record.windowMs);
  const maxRequests = asNumber(record.maxRequests ?? record.max);
  const result: PartialRateLimitConfig = {};
  if (windowMs !== undefined) {
    result.windowMs = windowMs;
  }
  if (maxRequests !== undefined) {
    result.maxRequests = maxRequests;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseCircuitBreakerConfig(value: unknown): PartialCircuitBreakerConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const failureThreshold = asNumber(record.failureThreshold);
  const resetTimeoutMs = asNumber(record.resetTimeoutMs);
  const result: PartialCircuitBreakerConfig = {};
  if (failureThreshold !== undefined) {
    result.failureThreshold = failureThreshold;
  }
  if (resetTimeoutMs !== undefined) {
    result.resetTimeoutMs = resetTimeoutMs;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseTlsConfig(value: unknown): PartialTlsConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const partial: PartialTlsConfig = {};
  const enabled = asBoolean(record.enabled);
  if (enabled !== undefined) {
    partial.enabled = enabled;
  }
  if (typeof record.keyPath === "string" && record.keyPath.trim()) {
    partial.keyPath = record.keyPath.trim();
  }
  if (typeof record.certPath === "string" && record.certPath.trim()) {
    partial.certPath = record.certPath.trim();
  }
  if (record.caPaths !== undefined) {
    const caPaths = Array.isArray(record.caPaths)
      ? record.caPaths
          .filter(item => typeof item === "string")
          .map(item => (item as string).trim())
          .filter(Boolean)
      : typeof record.caPaths === "string"
        ? record.caPaths
            .split(",")
            .map(item => item.trim())
            .filter(item => item.length > 0)
        : undefined;
    if (caPaths && caPaths.length > 0) {
      partial.caPaths = caPaths;
    }
  }
  const requestClientCert = asBoolean(record.requestClientCert);
  if (requestClientCert !== undefined) {
    partial.requestClientCert = requestClientCert;
  }
  return Object.keys(partial).length > 0 ? partial : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const entries: Array<[string, string]> = [];
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      entries.push([key, String(raw)]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseTracingConfigRecord(value: unknown): PartialTracingConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const partial: PartialTracingConfig = {};
  const enabled = asBoolean(record.enabled);
  if (enabled !== undefined) {
    partial.enabled = enabled;
  }
  if (typeof record.serviceName === "string" && record.serviceName.trim()) {
    partial.serviceName = record.serviceName.trim();
  }
  if (typeof record.environment === "string" && record.environment.trim()) {
    partial.environment = record.environment.trim();
  }
  if (typeof record.exporterEndpoint === "string" && record.exporterEndpoint.trim()) {
    partial.exporterEndpoint = record.exporterEndpoint.trim();
  }
  const headers = asStringRecord(record.exporterHeaders);
  if (headers) {
    partial.exporterHeaders = headers;
  }
  const sampleRatio = asNumber(record.sampleRatio);
  if (sampleRatio !== undefined) {
    partial.sampleRatio = sampleRatio;
  }
  return Object.keys(partial).length > 0 ? partial : undefined;
}

function parseHeadersString(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const entry of trimmed.split(",")) {
    const pair = entry.trim();
    if (!pair) {
      continue;
    }
    const [rawKey, ...rest] = pair.split("=");
    const key = rawKey?.trim();
    if (!key) {
      continue;
    }
    const valuePart = rest.join("=").trim();
    result[key] = valuePart;
  }
  return result;
}

function parseStringList(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const items = value
    .split(",")
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

function normalizeSampleRatio(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) {
    return Math.min(1, Math.max(0, fallback));
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function normalizeOtlpEndpoint(value: string, defaultValue: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return defaultValue;
  }
  const sanitized = trimmed.replace(/\/+$/, "");
  if (sanitized.endsWith("/v1/traces")) {
    return sanitized;
  }
  return `${sanitized}/v1/traces`;
}

function extractResourceAttribute(resourceString: string | undefined, key: string): string | undefined {
  if (!resourceString) {
    return undefined;
  }
  const target = `${key}=`;
  for (const segment of resourceString.split(",")) {
    const entry = segment.trim();
    if (!entry.startsWith(target)) {
      continue;
    }
    return entry.slice(target.length).trim();
  }
  return undefined;
}

let legacyMessageBusWarningIssued = false;

function warnLegacyMessageBus(value: string | undefined): void {
  if (legacyMessageBusWarningIssued || !value) {
    return;
  }
  legacyMessageBusWarningIssued = true;
  // eslint-disable-next-line no-console
  console.warn("MESSAGE_BUS is deprecated; use MESSAGING_TYPE instead");
}

export function __resetLegacyMessagingWarningForTests(): void {
  legacyMessageBusWarningIssued = false;
}

export function loadConfig(): AppConfig {
  const cfgPath = process.env.APP_CONFIG || path.join(process.cwd(), "config", "app.yaml");
  let fileCfg: PartialAppConfig = {};
  if (fs.existsSync(cfgPath)) {
    try {
      const rawFile = fs.readFileSync(cfgPath, "utf-8");
      const parsed = YAML.parse(rawFile);
      const doc = asRecord(parsed);
      if (doc) {
        const messaging = asRecord(doc.messaging);
        const providers = asRecord(doc.providers);
        const auth = asRecord(doc.auth);
        const oauth = asRecord(auth?.oauth);
        const secrets = asRecord(doc.secrets);
        const tooling = asRecord(doc.tooling);
        const server = asRecord(doc.server);
        const observability = asRecord(doc.observability);
        const tracing = parseTracingConfigRecord(observability?.tracing);

        const providerRateLimit = providers ? parseRateLimitConfig(providers.rateLimit) : undefined;
        const providerCircuitBreaker = providers ? parseCircuitBreakerConfig(providers.circuitBreaker) : undefined;
        const serverRateLimits = server ? asRecord(server.rateLimits) : undefined;

        fileCfg = {
          runMode: asRunMode(doc.runMode),
          messaging: messaging ? { type: asMessagingType(messaging.type) } : undefined,
          providers: providers
            ? {
                defaultRoute: asDefaultRoute(providers.defaultRoute),
                enabled: Array.isArray(providers.enabled)
                  ? asStringArray(providers.enabled) ?? []
                  : providers.enabled === undefined
                  ? undefined
                  : [],
                rateLimit: providerRateLimit,
                circuitBreaker: providerCircuitBreaker
              }
            : undefined,
          auth: oauth
            ? {
                oauth: {
                  redirectBaseUrl: typeof oauth.redirectBaseUrl === "string" ? oauth.redirectBaseUrl : undefined
                }
              }
            : undefined,
          secrets: { backend: asSecretsBackend(secrets?.backend) },
          tooling: tooling
            ? {
                agentEndpoint: typeof tooling.agentEndpoint === "string" ? tooling.agentEndpoint : undefined,
                retryAttempts: asNumber(tooling.retryAttempts),
                defaultTimeoutMs: asNumber(tooling.defaultTimeoutMs)
              }
            : undefined,
          server: server
            ? {
                sseKeepAliveMs: asNumber(server.sseKeepAliveMs),
                rateLimits: serverRateLimits
                  ? {
                      plan: parseRateLimitConfig(serverRateLimits.plan),
                      chat: parseRateLimitConfig(serverRateLimits.chat)
                    }
                  : undefined,
                tls: parseTlsConfig(server.tls)
              }
            : undefined,
          observability: tracing ? { tracing } : undefined
        };
      } else {
        startSpan("config.file.invalid", { reason: "non_object_root" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse configuration file at ${cfgPath}: ${message}`);
    }
  }

  const envRunMode = asRunMode(process.env.RUN_MODE);
  let envMessageType = asMessagingType(process.env.MESSAGING_TYPE);
  const rawLegacyMessageBus = process.env.MESSAGE_BUS;
  if (!envMessageType && rawLegacyMessageBus !== undefined) {
    const legacyValue = asMessagingType(rawLegacyMessageBus);
    if (legacyValue) {
      envMessageType = legacyValue;
    }
    warnLegacyMessageBus(rawLegacyMessageBus);
  }
  if (!envMessageType) {
    const envQueueBackend = asMessagingType(process.env.QUEUE_BACKEND);
    if (envQueueBackend) {
      envMessageType = envQueueBackend;
    }
  }
  const envProviders = process.env.PROVIDERS;
  const envRedirectBaseUrl = process.env.OAUTH_REDIRECT_BASE;
  const envSecretsBackend = asSecretsBackend(process.env.SECRETS_BACKEND);
  const envAgentEndpoint = process.env.TOOL_AGENT_ENDPOINT;
  const envAgentRetries = asNumber(process.env.TOOL_AGENT_RETRIES);
  const envAgentTimeout = asNumber(process.env.TOOL_AGENT_TIMEOUT_MS);
  const envSseKeepAlive = asNumber(process.env.SSE_KEEP_ALIVE_MS);
  const envTracingEnabled = asBoolean(process.env.TRACING_ENABLED ?? process.env.OTEL_TRACES_EXPORTER_ENABLED);
  const envTracingServiceName = process.env.TRACING_SERVICE_NAME ?? process.env.OTEL_SERVICE_NAME;
  const envTracingEnvironment =
    process.env.TRACING_ENVIRONMENT ??
    extractResourceAttribute(process.env.OTEL_RESOURCE_ATTRIBUTES, "deployment.environment") ??
    process.env.DEPLOYMENT_ENVIRONMENT;
  const envTracingEndpointRaw =
    process.env.TRACING_OTLP_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const envTracingHeadersString =
    process.env.TRACING_OTLP_HEADERS ??
    process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ??
    process.env.OTEL_EXPORTER_OTLP_HEADERS;
  const envTracingSampleRatio = asNumber(process.env.TRACING_SAMPLE_RATIO ?? process.env.OTEL_TRACES_SAMPLER_ARG);
  const envServerTlsEnabled = asBoolean(process.env.SERVER_TLS_ENABLED);
  const envServerTlsKeyPath = process.env.SERVER_TLS_KEY_PATH;
  const envServerTlsCertPath = process.env.SERVER_TLS_CERT_PATH;
  const envServerTlsCaPaths = parseStringList(process.env.SERVER_TLS_CA_PATHS);
  const envServerTlsRequestClientCert = asBoolean(process.env.SERVER_TLS_REQUEST_CLIENT_CERT);

  const providersEnabledFromEnv = envProviders !== undefined
    ? envProviders
        .split(",")
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0)
    : undefined;

  const providersEnabledFromFile = fileCfg.providers?.enabled;

  const runMode = fileCfg.runMode ?? envRunMode ?? DEFAULT_CONFIG.runMode;

  const secretsDefault = runMode === "enterprise" ? "vault" : DEFAULT_CONFIG.secrets.backend;
  const providersEnabledDefault = DEFAULT_CONFIG.providers.enabled;
  const envEnabled = providersEnabledFromEnv?.map(provider => provider);
  const fileEnabled = providersEnabledFromFile?.map(provider => provider);

  const providerRateLimitConfig: RateLimitConfig = {
    windowMs: fileCfg.providers?.rateLimit?.windowMs ?? DEFAULT_CONFIG.providers.rateLimit.windowMs,
    maxRequests: fileCfg.providers?.rateLimit?.maxRequests ?? DEFAULT_CONFIG.providers.rateLimit.maxRequests
  };

  const providerCircuitBreakerConfig: CircuitBreakerConfig = {
    failureThreshold:
      fileCfg.providers?.circuitBreaker?.failureThreshold ?? DEFAULT_CONFIG.providers.circuitBreaker.failureThreshold,
    resetTimeoutMs:
      fileCfg.providers?.circuitBreaker?.resetTimeoutMs ?? DEFAULT_CONFIG.providers.circuitBreaker.resetTimeoutMs
  };

  const serverPlanRateLimit: RateLimitConfig = {
    windowMs: fileCfg.server?.rateLimits?.plan?.windowMs ?? DEFAULT_CONFIG.server.rateLimits.plan.windowMs,
    maxRequests: fileCfg.server?.rateLimits?.plan?.maxRequests ?? DEFAULT_CONFIG.server.rateLimits.plan.maxRequests
  };

  const serverChatRateLimit: RateLimitConfig = {
    windowMs: fileCfg.server?.rateLimits?.chat?.windowMs ?? DEFAULT_CONFIG.server.rateLimits.chat.windowMs,
    maxRequests: fileCfg.server?.rateLimits?.chat?.maxRequests ?? DEFAULT_CONFIG.server.rateLimits.chat.maxRequests
  };

  const fileTls = fileCfg.server?.tls;
  const tlsEnabled = envServerTlsEnabled ?? fileTls?.enabled ?? DEFAULT_CONFIG.server.tls.enabled;
  const tlsKeyPath = envServerTlsKeyPath ?? fileTls?.keyPath ?? DEFAULT_CONFIG.server.tls.keyPath;
  const tlsCertPath = envServerTlsCertPath ?? fileTls?.certPath ?? DEFAULT_CONFIG.server.tls.certPath;
  const tlsCaPaths = envServerTlsCaPaths ?? fileTls?.caPaths ?? DEFAULT_CONFIG.server.tls.caPaths;
  const tlsRequestClientCert =
    envServerTlsRequestClientCert ??
    fileTls?.requestClientCert ??
    DEFAULT_CONFIG.server.tls.requestClientCert;

  if (tlsEnabled) {
    if (!tlsKeyPath || !tlsCertPath) {
      throw new Error("TLS enabled but SERVER_TLS_KEY_PATH and SERVER_TLS_CERT_PATH are not fully specified");
    }
  }

  const fileTracing = fileCfg.observability?.tracing;
  const sanitizedServiceName = envTracingServiceName?.trim();
  const sanitizedEnvironment = envTracingEnvironment?.trim();
  const tracingEnabled = envTracingEnabled ?? fileTracing?.enabled ?? DEFAULT_TRACING_CONFIG.enabled;
  const tracingServiceName =
    (sanitizedServiceName && sanitizedServiceName.length > 0 ? sanitizedServiceName : undefined) ??
    fileTracing?.serviceName ??
    DEFAULT_TRACING_CONFIG.serviceName;
  const tracingEnvironment =
    (sanitizedEnvironment && sanitizedEnvironment.length > 0 ? sanitizedEnvironment : undefined) ??
    fileTracing?.environment ??
    DEFAULT_TRACING_CONFIG.environment;
  const tracingEndpointSource =
    envTracingEndpointRaw ??
    fileTracing?.exporterEndpoint ??
    DEFAULT_TRACING_CONFIG.exporterEndpoint;
  const tracingEndpoint = normalizeOtlpEndpoint(tracingEndpointSource, DEFAULT_TRACING_CONFIG.exporterEndpoint);
  const envTracingHeaders = parseHeadersString(envTracingHeadersString);
  const tracingHeaders =
    envTracingHeaders !== undefined
      ? envTracingHeaders
      : fileTracing?.exporterHeaders
        ? { ...fileTracing.exporterHeaders }
        : { ...DEFAULT_TRACING_CONFIG.exporterHeaders };
  const tracingSampleRatioCandidate =
    envTracingSampleRatio ?? fileTracing?.sampleRatio ?? DEFAULT_TRACING_CONFIG.sampleRatio;
  const tracingSampleRatio = normalizeSampleRatio(tracingSampleRatioCandidate, DEFAULT_TRACING_CONFIG.sampleRatio);

  return {
    runMode,
    messaging: {
      type: fileCfg.messaging?.type ?? envMessageType ?? DEFAULT_CONFIG.messaging.type
    },
    providers: {
      defaultRoute: fileCfg.providers?.defaultRoute ?? DEFAULT_CONFIG.providers.defaultRoute,
      enabled: envEnabled ?? fileEnabled ?? [...providersEnabledDefault],
      rateLimit: providerRateLimitConfig,
      circuitBreaker: providerCircuitBreakerConfig
    },
    auth: {
      oauth: {
        redirectBaseUrl:
          envRedirectBaseUrl ??
          fileCfg.auth?.oauth?.redirectBaseUrl ??
          DEFAULT_CONFIG.auth.oauth.redirectBaseUrl
      }
    },
    secrets: {
      backend: envSecretsBackend ?? fileCfg.secrets?.backend ?? secretsDefault
    },
    tooling: {
      agentEndpoint: envAgentEndpoint ?? fileCfg.tooling?.agentEndpoint ?? DEFAULT_CONFIG.tooling.agentEndpoint,
      retryAttempts: envAgentRetries ?? fileCfg.tooling?.retryAttempts ?? DEFAULT_CONFIG.tooling.retryAttempts,
      defaultTimeoutMs: envAgentTimeout ?? fileCfg.tooling?.defaultTimeoutMs ?? DEFAULT_CONFIG.tooling.defaultTimeoutMs
    },
    server: {
      sseKeepAliveMs:
        envSseKeepAlive ?? fileCfg.server?.sseKeepAliveMs ?? DEFAULT_CONFIG.server.sseKeepAliveMs,
      rateLimits: {
        plan: serverPlanRateLimit,
        chat: serverChatRateLimit
      },
      tls: {
        enabled: tlsEnabled,
        keyPath: tlsKeyPath,
        certPath: tlsCertPath,
        caPaths: tlsCaPaths ?? [],
        requestClientCert: tlsRequestClientCert
      }
    },
    observability: {
      tracing: {
        enabled: tracingEnabled,
        serviceName: tracingServiceName,
        environment: tracingEnvironment,
        exporterEndpoint: tracingEndpoint,
        exporterHeaders: tracingHeaders,
        sampleRatio: tracingSampleRatio
      }
    }
  };
}
