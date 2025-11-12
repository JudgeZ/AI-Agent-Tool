import fs from "fs";
import path from "path";
import YAML from "yaml";

import { appLogger } from "../observability/logger.js";
import { startSpan, type Span, type TracingConfig } from "../observability/tracing.js";
import type { RateLimitBackendConfig } from "../rateLimit/store.js";
import { resolveEnv } from "../utils/env.js";

export type RateLimitConfig = {
  windowMs: number;
  maxRequests: number;
};

export type IdentityRateLimitConfig = RateLimitConfig & {
  identityWindowMs?: number | null;
  identityMaxRequests?: number | null;
};

export type SseQuotaConfig = {
  perIp: number;
  perSubject: number;
};

export type CorsConfig = {
  allowedOrigins: string[];
};

export type RequestSizeLimitsConfig = {
  jsonBytes: number;
  urlEncodedBytes: number;
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

export type ToolAgentTlsConfig = {
  insecure?: boolean;
  certPath?: string;
  keyPath?: string;
  caPaths?: string[];
};

export type KafkaSaslMechanism = "plain" | "scram-sha-256" | "scram-sha-512" | "aws" | "oauthbearer";

export type KafkaSaslConfig = {
  mechanism: KafkaSaslMechanism;
  username?: string;
  password?: string;
  authorizationIdentity?: string;
};

export type KafkaTlsConfig = {
  enabled: boolean;
  caPaths: string[];
  certPath?: string;
  keyPath?: string;
  rejectUnauthorized: boolean;
};

export type KafkaTopicsConfig = {
  planSteps: string;
  planCompletions: string;
  planEvents: string;
  planState: string;
  deadLetterSuffix: string;
};

export type KafkaMessagingConfig = {
  brokers: string[];
  clientId: string;
  consumerGroup: string;
  consumeFromBeginning: boolean;
  retryDelayMs: number;
  topics: KafkaTopicsConfig;
  tls: KafkaTlsConfig;
  sasl?: KafkaSaslConfig;
  ensureTopics: boolean;
  topicPartitions?: number;
  replicationFactor?: number;
  topicConfig: Record<string, string>;
  compactTopics: string[];
};

export type ObservabilityConfig = {
  tracing: TracingConfig;
};

export type ServerRateLimitsConfig = {
  backend: RateLimitBackendConfig;
  plan: RateLimitConfig;
  chat: RateLimitConfig;
  auth: IdentityRateLimitConfig;
};

export type NetworkEgressMode = "enforce" | "report-only" | "allow";

export type NetworkEgressConfig = {
  mode: NetworkEgressMode;
  allow: string[];
};

export type NetworkConfig = {
  egress: NetworkEgressConfig;
};

export type PostgresDatabaseConfig = {
  maxConnections: number;
  minConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  maxConnectionLifetimeMs: number;
  statementTimeoutMs: number;
  queryTimeoutMs: number;
};

export type DatabaseConfig = {
  postgres: PostgresDatabaseConfig;
};

export type PolicyCacheProvider = "memory" | "redis";

export type PolicyCacheRedisConfig = {
  url?: string;
  keyPrefix?: string;
};

export type PolicyCacheConfig = {
  enabled: boolean;
  provider: PolicyCacheProvider;
  ttlSeconds: number;
  maxEntries: number;
  redis?: PolicyCacheRedisConfig;
};

export type PolicyConfig = {
  cache: PolicyCacheConfig;
};

export type ContentCaptureConfig = {
  enabled: boolean;
};

export type PlanStateBackend = "file" | "postgres";

export type PlanStateConfig = {
  backend: PlanStateBackend;
};

export type RetentionConfig = {
  planStateDays: number;
  planArtifactsDays: number;
  contentCapture: ContentCaptureConfig;
};

export type OidcSessionConfig = {
  cookieName: string;
  ttlSeconds: number;
};

export type OidcRolesConfig = {
  claim?: string;
  fallback: string[];
  mappings: Record<string, string[]>;
  tenantMappings: Record<string, Record<string, string[]>>;
};

export type OidcAuthConfig = {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectBaseUrl: string;
  redirectUri: string;
  scopes: string[];
  tenantClaim?: string;
  audience?: string;
  logoutUrl?: string;
  roles: OidcRolesConfig;
  session: OidcSessionConfig;
};

export type AppConfig = {
  runMode: "consumer" | "enterprise";
  messaging: { type: "rabbitmq" | "kafka"; kafka: KafkaMessagingConfig };
  providers: {
    defaultRoute: "balanced" | "high_quality" | "low_cost";
    enabled: string[];
    rateLimit: RateLimitConfig;
    circuitBreaker: CircuitBreakerConfig;
  };
  auth: {
    oauth: { redirectBaseUrl: string };
    oidc: OidcAuthConfig;
  };
  planState: PlanStateConfig;
  retention: RetentionConfig;
  secrets: { backend: "localfile" | "vault" };
  tooling: {
    agentEndpoint: string;
    retryAttempts: number;
    defaultTimeoutMs: number;
    tls?: ToolAgentTlsConfig;
  };
  server: {
    sseKeepAliveMs: number;
    sseSendTimeoutMs: number;
    sseMaxBufferEvents: number;
    sseMaxBufferBytes: number;
    requestLimits: RequestSizeLimitsConfig;
    rateLimits: ServerRateLimitsConfig;
    sseQuotas: SseQuotaConfig;
    tls: TlsConfig;
    trustedProxyCidrs: string[];
    cors: CorsConfig;
  };
  observability: ObservabilityConfig;
  policy: PolicyConfig;
  database: DatabaseConfig;
  network: NetworkConfig;
};

function ensurePositiveRateLimit(value: RateLimitConfig, context: string): RateLimitConfig {
  if (!Number.isFinite(value.windowMs) || value.windowMs <= 0) {
    throw new Error(`${context} windowMs must be a positive number`);
  }
  if (!Number.isFinite(value.maxRequests) || value.maxRequests <= 0) {
    throw new Error(`${context} maxRequests must be a positive number`);
  }
  return value;
}

function sanitizeQuotaValue(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return Math.max(0, Math.floor(fallback));
  }
  const normalized = Math.floor(value);
  return normalized < 0 ? 0 : normalized;
}

function sanitizeRequestLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  if (normalized <= 0) {
    return fallback;
  }
  return normalized;
}

function sanitizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return Math.max(1, Math.floor(fallback));
  }
  const normalized = Math.floor(value);
  if (normalized <= 0) {
    return Math.max(1, Math.floor(fallback));
  }
  return normalized;
}

function sanitizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return Math.max(0, Math.floor(fallback));
  }
  const normalized = Math.floor(value);
  return normalized < 0 ? 0 : normalized;
}

function validateCookieSecure(runMode: AppConfig["runMode"]): void {
  const raw = process.env.COOKIE_SECURE;
  if (raw === undefined) {
    return;
  }
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
    if (nodeEnv === "production") {
      throw new Error("COOKIE_SECURE cannot be false when NODE_ENV=production");
    }
    if (runMode === "enterprise") {
      throw new Error("COOKIE_SECURE cannot be false when RUN_MODE=enterprise");
    }
    appLogger.warn(
      { event: "config.cookie_secure.insecure" },
      "COOKIE_SECURE=false; secure cookies are disabled",
    );
  }
}

type PartialRateLimitConfig = {
  windowMs?: number;
  maxRequests?: number;
};

type PartialIdentityRateLimitConfig = PartialRateLimitConfig & {
  identityWindowMs?: number | null;
  identityMaxRequests?: number | null;
};

type PartialSseQuotaConfig = {
  perIp?: number;
  perSubject?: number;
};

type PartialCorsConfig = {
  allowedOrigins?: string[];
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

type PartialToolAgentTlsConfig = {
  insecure?: boolean;
  certPath?: string;
  keyPath?: string;
  caPaths?: string[];
};

type PartialTracingConfig = {
  enabled?: boolean;
  serviceName?: string;
  environment?: string;
  exporterEndpoint?: string;
  exporterHeaders?: Record<string, string>;
  sampleRatio?: number;
};

type PartialObservabilityConfig = {
  tracing?: PartialTracingConfig;
};

type PartialProvidersConfig = {
  defaultRoute?: AppConfig["providers"]["defaultRoute"];
  enabled?: string[];
  rateLimit?: PartialRateLimitConfig;
  circuitBreaker?: PartialCircuitBreakerConfig;
};

type PartialContentCaptureConfig = {
  enabled?: boolean;
};

type PartialRetentionConfig = {
  planStateDays?: number;
  planArtifactsDays?: number;
  contentCapture?: PartialContentCaptureConfig;
};

type PartialPlanStateConfig = {
  backend?: PlanStateBackend;
};

type PartialAuthConfig = {
  oauth?: Partial<AppConfig["auth"]["oauth"]>;
  oidc?: PartialOidcAuthConfig;
};

type PartialToolingConfig = {
  agentEndpoint?: string;
  retryAttempts?: number;
  defaultTimeoutMs?: number;
  tls?: PartialToolAgentTlsConfig;
};

type PartialRateLimitBackendConfig = {
  provider?: RateLimitBackendConfig["provider"];
  redisUrl?: string;
};

type PartialPolicyCacheRedisConfig = {
  url?: string;
  keyPrefix?: string;
};

type PartialPolicyCacheConfig = {
  enabled?: boolean;
  provider?: PolicyCacheProvider;
  ttlSeconds?: number;
  maxEntries?: number;
  redis?: PartialPolicyCacheRedisConfig;
};

type PartialPolicyConfig = {
  cache?: PartialPolicyCacheConfig;
};

type PartialPostgresDatabaseConfig = {
  maxConnections?: number;
  minConnections?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  maxConnectionLifetimeMs?: number;
  statementTimeoutMs?: number;
  queryTimeoutMs?: number;
};

type PartialDatabaseConfig = {
  postgres?: PartialPostgresDatabaseConfig;
};

type PartialNetworkEgressConfig = {
  mode?: NetworkEgressMode;
  allow?: string[];
};

type PartialNetworkConfig = {
  egress?: PartialNetworkEgressConfig;
};

type PartialAppConfig = {
  runMode?: AppConfig["runMode"];
  messaging?: PartialMessagingConfig;
  providers?: PartialProvidersConfig;
  auth?: PartialAuthConfig;
  planState?: PartialPlanStateConfig;
  retention?: PartialRetentionConfig;
  secrets?: Partial<AppConfig["secrets"]>;
  tooling?: PartialToolingConfig;
  server?: PartialServerConfig;
  observability?: PartialObservabilityConfig;
  policy?: PartialPolicyConfig;
  database?: PartialDatabaseConfig;
  network?: PartialNetworkConfig;
};

const DEFAULT_TRACING_CONFIG: TracingConfig = {
  enabled: false,
  serviceName: "oss-ai-orchestrator",
  environment: "development",
  exporterEndpoint: "http://127.0.0.1:4318/v1/traces",
  exporterHeaders: {},
  sampleRatio: 1
};

const DEFAULT_DEV_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  "http://127.0.0.1:1420",
  "http://localhost:1420",
] as const;

export const DEFAULT_CONFIG: AppConfig = {
  runMode: "consumer",
  messaging: {
    type: "rabbitmq",
    kafka: {
      brokers: ["localhost:9092"],
      clientId: "oss-ai-orchestrator",
      consumerGroup: "oss-ai-orchestrator-plan-executor",
      consumeFromBeginning: false,
      retryDelayMs: 1000,
      topics: {
        planSteps: "plan.steps",
        planCompletions: "plan.completions",
        planEvents: "plan.events",
        planState: "plan.state",
        deadLetterSuffix: ".dead"
      },
      tls: {
        enabled: false,
        caPaths: [],
        certPath: undefined,
        keyPath: undefined,
        rejectUnauthorized: true
      },
      sasl: undefined,
      ensureTopics: true,
      topicPartitions: 1,
      replicationFactor: 1,
      topicConfig: {},
      compactTopics: []
    }
  },
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
  auth: {
    oauth: { redirectBaseUrl: "http://127.0.0.1:8080" },
    oidc: {
      enabled: false,
      issuer: "",
      clientId: "",
      clientSecret: undefined,
      redirectBaseUrl: "http://127.0.0.1:8080",
      redirectUri: "http://127.0.0.1:8080/auth/oidc/callback",
      scopes: ["openid", "profile", "email"],
      tenantClaim: undefined,
      audience: undefined,
      logoutUrl: undefined,
      roles: {
        claim: "roles",
        fallback: [],
        mappings: {},
        tenantMappings: {}
      },
      session: {
        cookieName: "oss_session",
        ttlSeconds: 60 * 60 * 8
      }
    }
  },
  planState: {
    backend: "file"
  },
  retention: {
    planStateDays: 30,
    planArtifactsDays: 30,
    contentCapture: {
      enabled: false
    }
  },
  secrets: { backend: "localfile" },
  tooling: {
    agentEndpoint: "127.0.0.1:50051",
    retryAttempts: 3,
    defaultTimeoutMs: 15000
  },
  server: {
    sseKeepAliveMs: 25000,
    sseSendTimeoutMs: 5000,
    sseMaxBufferEvents: 100,
    sseMaxBufferBytes: 64 * 1024,
    requestLimits: {
      jsonBytes: 1_048_576,
      urlEncodedBytes: 1_048_576,
    },
    rateLimits: {
      backend: {
        provider: "memory",
      },
      plan: {
        windowMs: 60_000,
        maxRequests: 60
      },
      chat: {
        windowMs: 60_000,
        maxRequests: 600
      },
      auth: {
        windowMs: 60_000,
        maxRequests: 120,
        identityWindowMs: 60_000,
        identityMaxRequests: 20,
      }
    },
    sseQuotas: {
      perIp: 4,
      perSubject: 2
    },
    tls: {
      enabled: false,
      keyPath: undefined,
      certPath: undefined,
      caPaths: [],
      requestClientCert: true
    },
    trustedProxyCidrs: [],
    cors: {
      allowedOrigins: [...DEFAULT_DEV_ALLOWED_ORIGINS],
    },
  },
  observability: {
    tracing: { ...DEFAULT_TRACING_CONFIG }
  },
  policy: {
    cache: {
      enabled: false,
      provider: "memory",
      ttlSeconds: 60,
      maxEntries: 10_000,
      redis: {
        keyPrefix: "policy:decision"
      }
    }
  },
  database: {
    postgres: {
      maxConnections: 20,
      minConnections: 2,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 5_000,
      maxConnectionLifetimeMs: 30 * 60_000,
      statementTimeoutMs: 5_000,
      queryTimeoutMs: 5_000,
    }
  },
  network: {
    egress: {
      mode: "enforce",
      allow: [
        "localhost",
        "127.0.0.1",
        "::1",
        "*.example.com",
        "*.svc",
        "*.svc.cluster.local",
      ],
    },
  }
};

type PartialKafkaTopicsConfig = {
  planSteps?: string;
  planCompletions?: string;
  planEvents?: string;
  planState?: string;
  deadLetterSuffix?: string;
};

type PartialKafkaTlsConfig = {
  enabled?: boolean;
  caPaths?: string[];
  certPath?: string;
  keyPath?: string;
  rejectUnauthorized?: boolean;
};

type PartialKafkaSaslConfig = {
  mechanism?: KafkaSaslMechanism;
  username?: string;
  password?: string;
  authorizationIdentity?: string;
};

type PartialKafkaMessagingConfig = {
  brokers?: string[];
  clientId?: string;
  consumerGroup?: string;
  consumeFromBeginning?: boolean;
  retryDelayMs?: number;
  topics?: PartialKafkaTopicsConfig;
  tls?: PartialKafkaTlsConfig;
  sasl?: PartialKafkaSaslConfig | null;
  ensureTopics?: boolean;
  topicPartitions?: number;
  replicationFactor?: number;
  topicConfig?: Record<string, string>;
  compactTopics?: string[];
};

type PartialMessagingConfig = {
  type?: AppConfig["messaging"]["type"];
  kafka?: PartialKafkaMessagingConfig;
};

type PartialServerRateLimitsConfig = {
  backend?: PartialRateLimitBackendConfig;
  plan?: PartialRateLimitConfig;
  chat?: PartialRateLimitConfig;
  auth?: PartialIdentityRateLimitConfig;
};

type PartialRequestSizeLimitsConfig = {
  jsonBytes?: number;
  urlEncodedBytes?: number;
};

type PartialServerConfig = {
  sseKeepAliveMs?: number;
  sseSendTimeoutMs?: number;
  sseMaxBufferEvents?: number;
  sseMaxBufferBytes?: number;
  requestLimits?: PartialRequestSizeLimitsConfig;
  rateLimits?: PartialServerRateLimitsConfig;
  tls?: PartialTlsConfig;
  sseQuotas?: PartialSseQuotaConfig;
  trustedProxyCidrs?: string[];
  cors?: PartialCorsConfig;
};

type PartialOidcSessionConfig = {
  cookieName?: string;
  ttlSeconds?: number;
};

type PartialOidcRolesConfig = {
  claim?: string;
  fallback?: string[];
  mappings?: Record<string, string[]>;
  tenantMappings?: Record<string, Record<string, string[]>>;
};

type PartialOidcAuthConfig = {
  enabled?: boolean;
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  redirectBaseUrl?: string;
  redirectUri?: string;
  scopes?: string[];
  tenantClaim?: string;
  audience?: string;
  logoutUrl?: string;
  roles?: PartialOidcRolesConfig;
  session?: PartialOidcSessionConfig;
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

function asPlanStateBackend(value: unknown): PlanStateBackend | undefined {
  if (value === "file" || value === "postgres") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "file" || normalized === "json" || normalized === "local") {
      return "file";
    }
    if (normalized === "postgres" || normalized === "postgresql" || normalized === "shared") {
      return "postgres";
    }
  }
  return undefined;
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

function parseRateLimitBackendConfig(value: unknown): PartialRateLimitBackendConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const result: PartialRateLimitBackendConfig = {};
  const provider = asRateLimitBackendProvider(record.provider ?? record.type);
  if (provider) {
    result.provider = provider;
  }
  const redisUrl = asString(record.redisUrl ?? record.redis_url ?? record.url);
  if (redisUrl) {
    result.redisUrl = redisUrl;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseIdentityRateLimitConfig(value: unknown): PartialIdentityRateLimitConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const base = parseRateLimitConfig(value);
  const result: PartialIdentityRateLimitConfig = base ? { ...base } : {};
  const identityWindowMs = asNumber(
    record.identityWindowMs ?? record.identity_window_ms ?? record.identityWindow ?? record.identity_window,
  );
  if (identityWindowMs !== undefined) {
    result.identityWindowMs = identityWindowMs;
  }
  const identityMaxRequests = asNumber(
    record.identityMaxRequests ?? record.identity_max_requests ?? record.identityMax ?? record.identity_max,
  );
  if (identityMaxRequests !== undefined) {
    result.identityMaxRequests = identityMaxRequests;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseSseQuotaConfig(value: unknown): PartialSseQuotaConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const perIp = asNumber(record.perIp ?? record.per_ip ?? record.ip);
  const perSubject = asNumber(
    record.perSubject ?? record.per_subject ?? record.perUser ?? record.user ?? record.session,
  );
  const result: PartialSseQuotaConfig = {};
  if (perIp !== undefined) {
    result.perIp = perIp;
  }
  if (perSubject !== undefined) {
    result.perSubject = perSubject;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseCorsConfigRecord(value: unknown): PartialCorsConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const allowedOrigins = parseStringArrayFlexible(
    record.allowedOrigins ?? record.allowed_origins ?? record.origins,
  );
  if (allowedOrigins && allowedOrigins.length > 0) {
    return { allowedOrigins };
  }
  return undefined;
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

function parseToolAgentTlsConfig(value: unknown): PartialToolAgentTlsConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const partial: PartialToolAgentTlsConfig = {};
  const insecure = asBoolean(record.insecure ?? record.insecureSkipVerify ?? record.skipVerify);
  if (insecure !== undefined) {
    partial.insecure = insecure;
  }
  const certPath = asString(record.certPath ?? record.cert_path ?? record.cert);
  if (certPath) {
    partial.certPath = certPath;
  }
  const keyPath = asString(record.keyPath ?? record.key_path ?? record.key);
  if (keyPath) {
    partial.keyPath = keyPath;
  }
  const caPaths = parseStringArrayFlexible(record.caPaths ?? record.ca_paths ?? record.ca);
  if (caPaths) {
    partial.caPaths = caPaths;
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

function asPolicyCacheProvider(value: unknown): PolicyCacheProvider | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "memory" || normalized === "redis") {
    return normalized;
  }
  return undefined;
}

function asRateLimitBackendProvider(value: unknown): RateLimitBackendConfig["provider"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "memory" || normalized === "redis") {
    return normalized;
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

function parsePolicyCacheRedisConfig(value: unknown): PartialPolicyCacheRedisConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const partial: PartialPolicyCacheRedisConfig = {};
  const url = asString(record.url ?? record.connectionString ?? record.redisUrl ?? record.redis_url);
  if (url) {
    partial.url = url;
  }
  const keyPrefix = asString(record.keyPrefix ?? record.key_prefix ?? record.prefix);
  if (keyPrefix) {
    partial.keyPrefix = keyPrefix;
  }
  return Object.keys(partial).length > 0 ? partial : undefined;
}

function parsePolicyCacheConfig(value: unknown): PartialPolicyCacheConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const partial: PartialPolicyCacheConfig = {};
  const enabled = asBoolean(record.enabled);
  if (enabled !== undefined) {
    partial.enabled = enabled;
  }
  const provider = asPolicyCacheProvider(record.provider);
  if (provider) {
    partial.provider = provider;
  }
  const ttlSeconds = asNumber(record.ttlSeconds ?? record.ttl_seconds ?? record.ttl);
  if (ttlSeconds !== undefined) {
    partial.ttlSeconds = ttlSeconds;
  }
  const maxEntries = asNumber(record.maxEntries ?? record.max_entries ?? record.max);
  if (maxEntries !== undefined) {
    partial.maxEntries = maxEntries;
  }
  const redisRecord =
    record.redis !== undefined
      ? parsePolicyCacheRedisConfig(record.redis)
      : parsePolicyCacheRedisConfig({
          url: record.redisUrl ?? record.redis_url,
          keyPrefix: record.redisKeyPrefix ?? record.redis_key_prefix,
        });
  if (redisRecord) {
    partial.redis = redisRecord;
  }
  return Object.keys(partial).length > 0 ? partial : undefined;
}

function asNetworkEgressMode(value: unknown): NetworkEgressMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "enforce" || normalized === "report-only" || normalized === "allow") {
    return normalized;
  }
  return undefined;
}

function parseNetworkEgressRecord(value: unknown): PartialNetworkEgressConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const result: PartialNetworkEgressConfig = {};
  const mode = asNetworkEgressMode(record.mode ?? record.policy ?? record.state);
  if (mode) {
    result.mode = mode;
  }
  const allow = parseStringArrayFlexible(record.allow ?? record.allowList ?? record.whitelist);
  if (allow && allow.length > 0) {
    result.allow = allow;
  }
  return Object.keys(result).length > 0 ? result : undefined;
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
function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
function parseStringArrayFlexible(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const entries = value
      .map(item => {
        if (typeof item === "string") {
          return item.trim();
        }
        if (typeof item === "number") {
          return String(item);
        }
        return undefined;
      })
      .filter((entry): entry is string => !!entry && entry.length > 0);
    return entries.length > 0 ? entries : undefined;
  }
  if (typeof value === "string") {
    return parseStringList(value);
  }
  return undefined;
}

function normalizeOriginString(origin: string): string | undefined {
  const trimmed = origin.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "*") {
    return "*";
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

function normalizeOriginList(origins: readonly string[] | undefined): string[] {
  if (!origins || origins.length === 0) {
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of origins) {
    const normalized = normalizeOriginString(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeEgressAllowList(allow: readonly string[] | undefined, fallback: readonly string[]): string[] {
  const source = allow && allow.length > 0 ? allow : fallback;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of source) {
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
function parseKafkaMechanism(value: unknown): KafkaSaslMechanism | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "plain":
    case "scram-sha-256":
    case "scram-sha-512":
    case "aws":
      return normalized as KafkaSaslMechanism;
    case "oauthbearer":
    case "oauthbearertoken":
      return "oauthbearer";
    default:
      return undefined;
  }
}
function parseKafkaTopicsRecord(value: unknown): PartialKafkaTopicsConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const result: PartialKafkaTopicsConfig = {};
  const planSteps = asString(record.planSteps ?? record.plan_steps);
  if (planSteps) {
    result.planSteps = planSteps;
  }
  const planCompletions = asString(record.planCompletions ?? record.plan_completions);
  if (planCompletions) {
    result.planCompletions = planCompletions;
  }
  const planEvents = asString(record.planEvents ?? record.plan_events);
  if (planEvents) {
    result.planEvents = planEvents;
  }
  const planState = asString(record.planState ?? record.plan_state);
  if (planState) {
    result.planState = planState;
  }
  const deadLetterSuffix = asString(record.deadLetterSuffix ?? record.dead_letter_suffix ?? record.deadLetter);
  if (deadLetterSuffix) {
    result.deadLetterSuffix = deadLetterSuffix;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
function parseKafkaTlsRecord(value: unknown): PartialKafkaTlsConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const result: PartialKafkaTlsConfig = {};
  const enabled = asBoolean(record.enabled);
  if (enabled !== undefined) {
    result.enabled = enabled;
  }
  const caPaths = parseStringArrayFlexible(record.caPaths ?? record.ca_paths ?? record.ca);
  if (caPaths) {
    result.caPaths = caPaths;
  }
  const certPath = asString(record.certPath ?? record.cert_path ?? record.cert);
  if (certPath) {
    result.certPath = certPath;
  }
  const keyPath = asString(record.keyPath ?? record.key_path ?? record.key);
  if (keyPath) {
    result.keyPath = keyPath;
  }
  const rejectUnauthorized = asBoolean(record.rejectUnauthorized ?? record.reject_unauthorized);
  if (rejectUnauthorized !== undefined) {
    result.rejectUnauthorized = rejectUnauthorized;
  } else {
    const skipVerify = asBoolean(record.skipVerify ?? record.insecureSkipVerify ?? record.insecureSkipTlsVerify);
    if (skipVerify !== undefined) {
      result.rejectUnauthorized = !skipVerify;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
function parseKafkaSaslRecord(value: unknown): PartialKafkaSaslConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const result: PartialKafkaSaslConfig = {};
  const mechanism = parseKafkaMechanism(record.mechanism ?? record.type);
  if (mechanism) {
    result.mechanism = mechanism;
  }
  const username = asString(record.username ?? record.user ?? record.clientId ?? record.principal);
  if (username) {
    result.username = username;
  }
  const password = asString(record.password ?? record.pass ?? record.secret);
  if (password) {
    result.password = password;
  }
  const authorizationIdentity = asString(
    record.authorizationIdentity ?? record.authorization_identity ?? record.authzIdentity ?? record.authz_identity
  );
  if (authorizationIdentity) {
    result.authorizationIdentity = authorizationIdentity;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
function parseKafkaMessagingRecord(value: unknown): PartialKafkaMessagingConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const result: PartialKafkaMessagingConfig = {};
  const brokers = parseStringArrayFlexible(record.brokers);
  if (brokers) {
    result.brokers = brokers;
  }
  const clientId = asString(record.clientId ?? record.client_id ?? record.client);
  if (clientId) {
    result.clientId = clientId;
  }
  const consumerGroup = asString(record.consumerGroup ?? record.groupId ?? record.consumer_group ?? record.group);
  if (consumerGroup) {
    result.consumerGroup = consumerGroup;
  }
  const consumeFromBeginning = asBoolean(
    record.consumeFromBeginning ?? record.fromBeginning ?? record.startFromEarliest
  );
  if (consumeFromBeginning !== undefined) {
    result.consumeFromBeginning = consumeFromBeginning;
  }
  const retryDelayMs = asNumber(record.retryDelayMs ?? record.retry_delay_ms ?? record.retryDelay);
  if (retryDelayMs !== undefined) {
    result.retryDelayMs = retryDelayMs;
  }
  const topics = parseKafkaTopicsRecord(record.topics);
  if (topics) {
    result.topics = topics;
  }
  const tls = parseKafkaTlsRecord(record.tls);
  if (tls) {
    result.tls = tls;
  }
  if (record.sasl === null) {
    result.sasl = null;
  } else {
    const sasl = parseKafkaSaslRecord(record.sasl);
    if (sasl) {
      result.sasl = sasl;
    }
  }
  const ensureTopics = asBoolean(record.ensureTopics ?? record.ensure_topics);
  if (ensureTopics !== undefined) {
    result.ensureTopics = ensureTopics;
  }
  const topicPartitions = asNumber(record.topicPartitions ?? record.topic_partitions);
  if (topicPartitions !== undefined) {
    result.topicPartitions = topicPartitions;
  }
  const replicationFactor = asNumber(record.replicationFactor ?? record.replication_factor);
  if (replicationFactor !== undefined) {
    result.replicationFactor = replicationFactor;
  }
  const topicConfigString = asString(record.topicDefaultConfig ?? record.topic_default_config);
  if (topicConfigString) {
    const parsedConfig = parseTopicConfig(topicConfigString);
    if (parsedConfig) {
      result.topicConfig = parsedConfig;
    }
  }
  const compactTopics = parseStringArrayFlexible(record.compactTopics ?? record.compact_topics);
  if (compactTopics && compactTopics.length > 0) {
    result.compactTopics = compactTopics;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseTopicConfig(value: string): Record<string, string> | undefined {
  const record = asRecord(YAML.parse(value));
  if (!record) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string") {
      result[key] = raw;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseScopesString(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const items = value
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(item => item.length > 0);
  return items.length > 0 ? Array.from(new Set(items)) : undefined;
}

function parseScopesValue(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const arrayValue = parseStringArrayFlexible(value);
  if (arrayValue && arrayValue.length > 0) {
    return arrayValue;
  }
  if (typeof value === "string") {
    return parseScopesString(value);
  }
  return undefined;
}

function normalizeScopes(scopes: string[]): string[] {
  const normalized = scopes
    .map(scope => scope.trim())
    .filter(scope => scope.length > 0);
  const set = new Set(normalized);
  set.add("openid");
  return Array.from(set);
}

function normalizeRetentionDays(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.round(value);
}

function parseOidcSessionRecord(value: unknown): PartialOidcSessionConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const result: PartialOidcSessionConfig = {};
  const cookieName = asString(record.cookieName ?? record.cookie_name);
  if (cookieName) {
    result.cookieName = cookieName;
  }
  const ttlSeconds = asNumber(record.ttlSeconds ?? record.ttl_seconds ?? record.ttl);
  if (ttlSeconds !== undefined) {
    result.ttlSeconds = ttlSeconds;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseOidcConfigRecord(value: unknown): PartialOidcAuthConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const result: PartialOidcAuthConfig = {};
  const enabled = asBoolean(record.enabled);
  if (enabled !== undefined) {
    result.enabled = enabled;
  }
  const issuer = asString(record.issuer ?? record.issuerUrl ?? record.issuer_url);
  if (issuer) {
    result.issuer = issuer;
  }
  const clientId = asString(record.clientId ?? record.client_id);
  if (clientId) {
    result.clientId = clientId;
  }
  const clientSecret = asString(record.clientSecret ?? record.client_secret);
  if (clientSecret) {
    result.clientSecret = clientSecret;
  }
  const redirectBase = asString(record.redirectBaseUrl ?? record.redirect_base_url ?? record.redirectBase);
  if (redirectBase) {
    result.redirectBaseUrl = redirectBase;
  }
  const redirectUri = asString(record.redirectUri ?? record.redirect_uri);
  if (redirectUri) {
    result.redirectUri = redirectUri;
  }
  const scopes = parseScopesValue(record.scopes);
  if (scopes) {
    result.scopes = scopes;
  }
  const tenantClaim = asString(record.tenantClaim ?? record.tenant_claim ?? record.tenant);
  if (tenantClaim) {
    result.tenantClaim = tenantClaim;
  }
  const audience = asString(record.audience ?? record.aud);
  if (audience) {
    result.audience = audience;
  }
  const logoutUrl = asString(record.logoutUrl ?? record.logout_url ?? record.endSessionEndpoint ?? record.end_session_endpoint);
  if (logoutUrl) {
    result.logoutUrl = logoutUrl;
  }
  const session = parseOidcSessionRecord(record.session);
  if (session) {
    result.session = session;
  }
  const roles = parseOidcRolesRecord(record.roles);
  if (roles) {
    result.roles = roles;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseOidcRolesRecord(value: unknown): PartialOidcRolesConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const result: PartialOidcRolesConfig = {};
  const claim = asString(record.claim ?? record.roleClaim ?? record.claimName ?? record.claim_field);
  if (claim) {
    result.claim = claim;
  }
  const fallback = parseRolesValue(record.fallback ?? record.default ?? record.defaults ?? record.static);
  if (fallback) {
    result.fallback = normalizeStringSet(fallback);
  }
  const mappings =
    parseRoleMappingsRecord(record.mappings ?? record.mapping ?? record.bindings ?? record.roleMappings) ?? undefined;
  if (mappings) {
    result.mappings = mappings;
  }
  const tenantMappings =
    parseTenantRoleMappingsRecord(
      record.tenantMappings ?? record.tenant_mapping ?? record.tenants ?? record.tenantRoleMappings
    ) ?? undefined;
  if (tenantMappings) {
    result.tenantMappings = tenantMappings;
  }
  return Object.keys(result).length > 0 ? result : undefined;
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

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.replace(/\/+$/, "");
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
  appLogger.warn(
    { event: "config.legacy_message_bus" },
    "MESSAGE_BUS is deprecated; use MESSAGING_TYPE instead",
  );
}

export function __resetLegacyMessagingWarningForTests(): void {
  legacyMessageBusWarningIssued = false;
}

function parseRolesString(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function parseRolesValue(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const arrayValue = parseStringArrayFlexible(value);
  if (arrayValue && arrayValue.length > 0) {
    return arrayValue;
  }
  if (typeof value === "string") {
    const parsed = parseRolesString(value);
    return parsed.length > 0 ? parsed : undefined;
  }
  return undefined;
}

function normalizeStringSet(values: string[]): string[] {
  const normalized = values
    .map(value => value.trim())
    .filter(value => value.length > 0);
  return Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b));
}

function parseRoleMappingsRecord(value: unknown): Record<string, string[]> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const result: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(record)) {
    const mappingKey = key.trim();
    if (!mappingKey) {
      continue;
    }
    const roles = parseRolesValue(raw);
    if (roles && roles.length > 0) {
      result[mappingKey] = normalizeStringSet(roles);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseTenantRoleMappingsRecord(
  value: unknown
): Record<string, Record<string, string[]>> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const result: Record<string, Record<string, string[]>> = {};
  for (const [tenant, raw] of Object.entries(record)) {
    const tenantKey = tenant.trim();
    if (!tenantKey) {
      continue;
    }
    const mapping = parseRoleMappingsRecord(raw);
    if (mapping) {
      result[tenantKey] = mapping;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseRetentionConfigRecord(value: unknown): PartialRetentionConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const result: PartialRetentionConfig = {};
  const planStateDays = asNumber(record.planStateDays ?? record.plan_state_days ?? record.stateDays);
  if (planStateDays !== undefined) {
    result.planStateDays = planStateDays;
  }
  const planArtifactsDays = asNumber(record.planArtifactsDays ?? record.plan_artifacts_days ?? record.artifactDays);
  if (planArtifactsDays !== undefined) {
    result.planArtifactsDays = planArtifactsDays;
  }
  const contentCaptureRecord = asRecord(record.contentCapture ?? record.content_capture ?? record.capture);
  if (contentCaptureRecord) {
    const enabled = asBoolean(contentCaptureRecord.enabled ?? contentCaptureRecord.default);
    if (enabled !== undefined) {
      result.contentCapture = { enabled };
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parsePostgresDatabaseRecord(value: unknown): PartialPostgresDatabaseConfig | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const result: PartialPostgresDatabaseConfig = {};
  const maxConnections = asNumber(record.maxConnections ?? record.max_connections ?? record.max);
  if (maxConnections !== undefined) {
    result.maxConnections = maxConnections;
  }
  const minConnections = asNumber(record.minConnections ?? record.min_connections ?? record.min);
  if (minConnections !== undefined) {
    result.minConnections = minConnections;
  }
  const idleTimeoutMs = asNumber(record.idleTimeoutMs ?? record.idle_timeout_ms ?? record.idleTimeout);
  if (idleTimeoutMs !== undefined) {
    result.idleTimeoutMs = idleTimeoutMs;
  }
  const connectionTimeoutMs = asNumber(
    record.connectionTimeoutMs ?? record.connection_timeout_ms ?? record.connectionTimeout,
  );
  if (connectionTimeoutMs !== undefined) {
    result.connectionTimeoutMs = connectionTimeoutMs;
  }
  const maxConnectionLifetimeMs = asNumber(
    record.maxConnectionLifetimeMs ?? record.max_connection_lifetime_ms ?? record.maxLifetimeMs,
  );
  if (maxConnectionLifetimeMs !== undefined) {
    result.maxConnectionLifetimeMs = maxConnectionLifetimeMs;
  }
  const statementTimeoutMs = asNumber(record.statementTimeoutMs ?? record.statement_timeout_ms);
  if (statementTimeoutMs !== undefined) {
    result.statementTimeoutMs = statementTimeoutMs;
  }
  const queryTimeoutMs = asNumber(record.queryTimeoutMs ?? record.query_timeout_ms);
  if (queryTimeoutMs !== undefined) {
    result.queryTimeoutMs = queryTimeoutMs;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

type ConfigCacheState = {
  path: string;
  mtimeMs: number | null;
  config: AppConfig;
};

type ConfigFileMetadata = {
  exists: boolean;
  mtimeMs: number | null;
};

let configCache: ConfigCacheState | undefined;

function readConfigFileMetadata(filePath: string): ConfigFileMetadata {
  try {
    const stats = fs.statSync(filePath);
    return { exists: true, mtimeMs: stats.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { exists: false, mtimeMs: null };
    }
    throw error;
  }
}

function getCachedConfig(filePath: string, metadata: ConfigFileMetadata): AppConfig | undefined {
  if (!configCache || configCache.path !== filePath) {
    return undefined;
  }

  if (!metadata.exists) {
    return configCache.mtimeMs === null ? configCache.config : undefined;
  }

  if (configCache.mtimeMs === null) {
    return undefined;
  }

  return metadata.mtimeMs === configCache.mtimeMs ? configCache.config : undefined;
}

export function invalidateConfigCache(): void {
  configCache = undefined;
}

export function loadConfig(): AppConfig {
  const cfgPath = process.env.APP_CONFIG || path.join(process.cwd(), "config", "app.yaml");
  const metadataBefore = readConfigFileMetadata(cfgPath);
  const cached = getCachedConfig(cfgPath, metadataBefore);
  if (cached) {
    return cached;
  }

  let fileCfg: PartialAppConfig = {};
  if (metadataBefore.exists) {
    try {
      const rawFile = fs.readFileSync(cfgPath, "utf-8");
      const parsed = YAML.parse(rawFile);
      const doc = asRecord(parsed);
      if (doc) {
        const messagingRecord = asRecord(doc.messaging);
        const providers = asRecord(doc.providers);
        const auth = asRecord(doc.auth);
        const oauth = asRecord(auth?.oauth);
        const oidc = asRecord(auth?.oidc);
        const secrets = asRecord(doc.secrets);
        const tooling = asRecord(doc.tooling);
        const server = asRecord(doc.server);
        const observability = asRecord(doc.observability);
        const tracing = parseTracingConfigRecord(observability?.tracing);
        const retention = parseRetentionConfigRecord(doc.retention);
        const planStateRecord = asRecord(doc.planState ?? doc.plan_state);
        const databaseRecord = asRecord(doc.database);
        const networkRecord = asRecord(doc.network);
        const planStateBackendFromFile = planStateRecord
          ? asPlanStateBackend(planStateRecord.backend)
          : undefined;
        const policyRecord = asRecord(doc.policy);
        const policyCache = policyRecord
          ? parsePolicyCacheConfig(
              policyRecord.cache ??
                policyRecord.cacheConfig ??
                policyRecord.cache_config ??
                policyRecord.decisionCache ??
                policyRecord.decision_cache,
            )
          : undefined;

        const providerRateLimit = providers ? parseRateLimitConfig(providers.rateLimit) : undefined;
        const providerCircuitBreaker = providers ? parseCircuitBreakerConfig(providers.circuitBreaker) : undefined;
        const serverRateLimits = server ? asRecord(server.rateLimits) : undefined;
        const serverRateLimitBackend = serverRateLimits
          ? parseRateLimitBackendConfig(
              serverRateLimits.backend ??
                serverRateLimits.store ??
                serverRateLimits.backendConfig ??
                serverRateLimits.backend_config,
            )
          : undefined;
        const serverRateLimitAuth = serverRateLimits ? parseIdentityRateLimitConfig(serverRateLimits.auth) : undefined;
        const serverSseQuotas = server
          ? parseSseQuotaConfig(server.sseQuotas ?? server.sse_quotas ?? server.quotas)
          : undefined;
        const serverSseSendTimeout = server
          ? asNumber(server.sseSendTimeoutMs ?? server.sse_send_timeout_ms ?? server.sseTimeoutMs)
          : undefined;
        const serverSseMaxBufferEvents = server
          ? asNumber(server.sseMaxBufferEvents ?? server.sse_max_buffer_events ?? server.sseBufferEvents)
          : undefined;
        const serverSseMaxBufferBytes = server
          ? asNumber(server.sseMaxBufferBytes ?? server.sse_max_buffer_bytes ?? server.sseBufferBytes)
          : undefined;
        const serverTrustedProxies = server
          ? parseStringArrayFlexible(
              server.trustedProxyCidrs ??
                server.trusted_proxy_cidrs ??
                server.trustedProxies ??
                server.trusted_proxies,
            )
          : undefined;
        const serverCors = server
          ? parseCorsConfigRecord(server.cors ?? server.corsConfig ?? server.cors_config)
          : undefined;
        const kafkaMessaging = messagingRecord ? parseKafkaMessagingRecord(messagingRecord.kafka) : undefined;
        const fileOidc = parseOidcConfigRecord(oidc);
        const postgresConfig = databaseRecord
          ? parsePostgresDatabaseRecord(databaseRecord.postgres ?? databaseRecord.pg)
          : undefined;
        const networkEgress = networkRecord
          ? parseNetworkEgressRecord(
              networkRecord.egress ??
                networkRecord.egressConfig ??
                networkRecord.egress_config ??
                networkRecord.egressPolicy ??
                networkRecord.egress_policy,
            )
          : undefined;

        const authPartial: PartialAuthConfig = {};
        let hasAuthConfig = false;
        if (oauth) {
          authPartial.oauth = {
            redirectBaseUrl: typeof oauth.redirectBaseUrl === "string" ? oauth.redirectBaseUrl : undefined
          };
          hasAuthConfig = true;
        }
        if (fileOidc) {
          authPartial.oidc = fileOidc;
          hasAuthConfig = true;
        }

        fileCfg = {
          runMode: asRunMode(doc.runMode),
          messaging: messagingRecord
            ? {
                type: asMessagingType(messagingRecord.type),
                kafka: kafkaMessaging
              }
            : undefined,
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
          auth: hasAuthConfig ? authPartial : undefined,
          planState: planStateBackendFromFile ? { backend: planStateBackendFromFile } : undefined,
          retention,
          secrets: { backend: asSecretsBackend(secrets?.backend) },
          tooling: tooling
            ? {
                agentEndpoint: typeof tooling.agentEndpoint === "string" ? tooling.agentEndpoint : undefined,
                retryAttempts: asNumber(tooling.retryAttempts),
                defaultTimeoutMs: asNumber(tooling.defaultTimeoutMs),
                tls: parseToolAgentTlsConfig(tooling.tls ?? tooling.agentTls ?? tooling.tlsConfig)
              }
            : undefined,
          server: server
            ? {
                sseKeepAliveMs: asNumber(server.sseKeepAliveMs),
                sseSendTimeoutMs: serverSseSendTimeout,
                sseMaxBufferEvents: serverSseMaxBufferEvents,
                sseMaxBufferBytes: serverSseMaxBufferBytes,
                rateLimits: serverRateLimits
                  ? {
                      backend: serverRateLimitBackend,
                      plan: parseRateLimitConfig(serverRateLimits.plan),
                      chat: parseRateLimitConfig(serverRateLimits.chat),
                      auth: serverRateLimitAuth,
                    }
                  : undefined,
                tls: parseTlsConfig(server.tls),
                sseQuotas: serverSseQuotas,
                trustedProxyCidrs: serverTrustedProxies,
                cors: serverCors,
              }
            : undefined,
          observability: tracing ? { tracing } : undefined,
          policy: policyCache ? { cache: policyCache } : undefined,
          database: postgresConfig ? { postgres: postgresConfig } : undefined,
          network: networkEgress ? { egress: networkEgress } : undefined,
        };
      } else {
        const span = startSpan("config.file.invalid", { reason: "non_object_root" });
        try {
          // Span intentionally started to capture invalid configuration file structure.
        } finally {
          span.end();
        }
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
  const envAgentTlsInsecure = asBoolean(process.env.TOOL_AGENT_TLS_INSECURE);
  const envAgentTlsCertPath = asString(process.env.TOOL_AGENT_TLS_CERT_PATH);
  const envAgentTlsKeyPath = asString(process.env.TOOL_AGENT_TLS_KEY_PATH);
  const envAgentTlsCaPaths = parseStringList(process.env.TOOL_AGENT_TLS_CA_PATHS);
  const envSseKeepAlive = asNumber(process.env.SSE_KEEP_ALIVE_MS);
  const envSseSendTimeout = asNumber(process.env.SSE_SEND_TIMEOUT_MS);
  const envSseMaxBufferEvents = asNumber(process.env.SSE_MAX_BUFFER_EVENTS);
  const envSseMaxBufferBytes = asNumber(process.env.SSE_MAX_BUFFER_BYTES);
  const envSseMaxConnectionsPerIp = asNumber(process.env.SSE_MAX_CONNECTIONS_PER_IP);
  const envSseMaxConnectionsPerSubject = asNumber(process.env.SSE_MAX_CONNECTIONS_PER_SUBJECT);
  const envTrustedProxyCidrs = parseStringList(
    process.env.SERVER_TRUSTED_PROXY_CIDRS ?? process.env.TRUSTED_PROXY_CIDRS,
  );
  const envServerCorsAllowedOrigins = parseStringList(
    process.env.SERVER_CORS_ALLOWED_ORIGINS ?? process.env.CORS_ALLOWED_ORIGINS,
  );
  const envServerRequestLimitJson = asNumber(process.env.SERVER_REQUEST_LIMIT_JSON_BYTES);
  const envServerRequestLimitUrlEncoded = asNumber(
    process.env.SERVER_REQUEST_LIMIT_URLENCODED_BYTES,
  );
  const envRateLimitBackendProvider = asRateLimitBackendProvider(
    process.env.PROVIDER_RATE_LIMIT_BACKEND ??
      process.env.SERVER_RATE_LIMIT_BACKEND ??
      process.env.RATE_LIMIT_BACKEND,
  );
  const envRateLimitBackendRedisUrl = asString(
    process.env.PROVIDER_RATE_LIMIT_REDIS_URL ??
      process.env.SERVER_RATE_LIMIT_REDIS_URL ??
      process.env.RATE_LIMIT_REDIS_URL,
  );
  const envPolicyCacheEnabled = asBoolean(process.env.POLICY_CACHE_ENABLED);
  const envPolicyCacheProvider = asPolicyCacheProvider(process.env.POLICY_CACHE_PROVIDER);
  const envPolicyCacheTtlSeconds = asNumber(process.env.POLICY_CACHE_TTL_SECONDS);
  const envPolicyCacheMaxEntries = asNumber(process.env.POLICY_CACHE_MAX_ENTRIES);
  const envPolicyCacheRedisUrl = asString(process.env.POLICY_CACHE_REDIS_URL);
  const envPolicyCacheRedisKeyPrefix = asString(process.env.POLICY_CACHE_REDIS_KEY_PREFIX);
  const envNetworkEgressMode = asNetworkEgressMode(
    process.env.NETWORK_EGRESS_MODE ?? process.env.EGRESS_MODE,
  );
  const envNetworkEgressAllow = parseStringList(
    process.env.NETWORK_EGRESS_ALLOW ??
      process.env.EGRESS_ALLOW ??
      process.env.ORCHESTRATOR_EGRESS_ALLOW,
  );
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
  const envKafkaBrokers = parseStringList(process.env.KAFKA_BROKERS);
  const envKafkaClientId = asString(process.env.KAFKA_CLIENT_ID);
  const envKafkaGroupId = asString(process.env.KAFKA_GROUP_ID);
  const envKafkaConsumeFromBeginning = asBoolean(process.env.KAFKA_CONSUME_FROM_BEGINNING);
  const envKafkaRetryDelayMs = asNumber(process.env.KAFKA_RETRY_DELAY_MS);
  const envKafkaTopicPlanSteps = asString(process.env.KAFKA_TOPIC_PLAN_STEPS);
  const envKafkaTopicPlanCompletions = asString(process.env.KAFKA_TOPIC_PLAN_COMPLETIONS);
  const envKafkaTopicPlanEvents = asString(process.env.KAFKA_TOPIC_PLAN_EVENTS);
  const envKafkaTopicPlanState = asString(process.env.KAFKA_TOPIC_PLAN_STATE);
  const envKafkaTopicDeadLetterSuffix = asString(process.env.KAFKA_TOPIC_DEAD_LETTER_SUFFIX);
  const envKafkaTlsEnabled = asBoolean(process.env.KAFKA_TLS_ENABLED);
  const envKafkaTlsCaPaths = parseStringList(process.env.KAFKA_TLS_CA_PATHS);
  const envKafkaTlsCertPath = asString(process.env.KAFKA_TLS_CERT_PATH);
  const envKafkaTlsKeyPath = asString(process.env.KAFKA_TLS_KEY_PATH);
  const envKafkaTlsRejectUnauthorized = asBoolean(process.env.KAFKA_TLS_REJECT_UNAUTHORIZED);
  const envKafkaSaslMechanism = parseKafkaMechanism(process.env.KAFKA_SASL_MECHANISM);
  const envKafkaSaslUsername = asString(process.env.KAFKA_SASL_USERNAME);
  const envKafkaSaslPassword = asString(process.env.KAFKA_SASL_PASSWORD);
  const envKafkaSaslAuthorizationIdentity = asString(process.env.KAFKA_SASL_AUTHORIZATION_IDENTITY);
  const envKafkaEnsureTopics = asBoolean(process.env.KAFKA_ENSURE_TOPICS);
  const envKafkaTopicPartitions = asNumber(process.env.KAFKA_TOPIC_PARTITIONS);
  const envKafkaReplicationFactor = asNumber(process.env.KAFKA_TOPIC_REPLICATION_FACTOR);
  const envKafkaTopicDefaultConfig = process.env.KAFKA_TOPIC_DEFAULT_CONFIG;
  const envKafkaCompactPatterns = parseScopesString(process.env.KAFKA_TOPIC_COMPACT_PATTERNS);
  const envOidcEnabled = asBoolean(process.env.OIDC_ENABLED);
  const envOidcIssuer = process.env.OIDC_ISSUER_URL?.trim();
  const envOidcClientId = process.env.OIDC_CLIENT_ID?.trim();
  const envOidcClientSecret = resolveEnv("OIDC_CLIENT_SECRET")?.trim();
  const envOidcRedirectBase = process.env.OIDC_REDIRECT_BASE?.trim();
  const envOidcScopes = parseScopesString(process.env.OIDC_SCOPES);
  const envOidcTenantClaim = process.env.OIDC_TENANT_CLAIM?.trim();
  const envOidcAudience = process.env.OIDC_AUDIENCE?.trim();
  const envOidcLogoutUrl = process.env.OIDC_LOGOUT_URL?.trim();
  const envOidcSessionCookieName = process.env.OIDC_SESSION_COOKIE_NAME?.trim();
  const envOidcSessionTtl = asNumber(process.env.OIDC_SESSION_TTL_SECONDS);
  const envPlanStateRetentionDays = asNumber(process.env.RETENTION_PLAN_STATE_DAYS);
  const envPlanArtifactRetentionDays = asNumber(process.env.RETENTION_PLAN_ARTIFACT_DAYS);
  const envPlanStateBackend = asPlanStateBackend(process.env.PLAN_STATE_BACKEND);
  const envContentCaptureEnabled = asBoolean(process.env.CONTENT_CAPTURE_ENABLED);
  const envPostgresMinConnections = asNumber(process.env.POSTGRES_MIN_CONNECTIONS);
  const envPostgresStatementTimeoutMs = asNumber(process.env.POSTGRES_STATEMENT_TIMEOUT_MS);
  const envPostgresQueryTimeoutMs = asNumber(process.env.POSTGRES_QUERY_TIMEOUT_MS);
  const envOidcRoleClaim = process.env.OIDC_ROLE_CLAIM?.trim();
  const envOidcFallbackRoles = parseRolesValue(process.env.OIDC_DEFAULT_ROLES);
  const envOidcRoleMappingsValue = parseJsonEnv(process.env.OIDC_ROLE_MAPPINGS, "OIDC_ROLE_MAPPINGS");
  const envOidcRoleMappings = envOidcRoleMappingsValue
    ? parseRoleMappingsRecord(envOidcRoleMappingsValue)
    : undefined;
  const envOidcTenantRoleMappingsValue = parseJsonEnv(
    process.env.OIDC_TENANT_ROLE_MAPPINGS,
    "OIDC_TENANT_ROLE_MAPPINGS"
  );
  const envOidcTenantRoleMappings = envOidcTenantRoleMappingsValue
    ? parseTenantRoleMappingsRecord(envOidcTenantRoleMappingsValue)
    : undefined;

  const providersEnabledFromEnv = envProviders !== undefined
    ? envProviders
        .split(",")
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0)
    : undefined;

  const providersEnabledFromFile = fileCfg.providers?.enabled;
  const defaultKafka = DEFAULT_CONFIG.messaging.kafka;
  const fileKafkaConfig = fileCfg.messaging?.kafka;
  const fileKafkaSasl = fileKafkaConfig?.sasl === null ? undefined : fileKafkaConfig?.sasl;
  const kafkaBrokers = envKafkaBrokers ?? fileKafkaConfig?.brokers ?? defaultKafka.brokers;
  const kafkaClientId = envKafkaClientId ?? fileKafkaConfig?.clientId ?? defaultKafka.clientId;
  const kafkaConsumerGroup = envKafkaGroupId ?? fileKafkaConfig?.consumerGroup ?? defaultKafka.consumerGroup;
  const kafkaConsumeFromBeginning =
    envKafkaConsumeFromBeginning ?? fileKafkaConfig?.consumeFromBeginning ?? defaultKafka.consumeFromBeginning;
  const kafkaRetryDelayMs = envKafkaRetryDelayMs ?? fileKafkaConfig?.retryDelayMs ?? defaultKafka.retryDelayMs;
  const kafkaTopics: KafkaTopicsConfig = {
    planSteps: envKafkaTopicPlanSteps ?? fileKafkaConfig?.topics?.planSteps ?? defaultKafka.topics.planSteps,
    planCompletions:
      envKafkaTopicPlanCompletions ?? fileKafkaConfig?.topics?.planCompletions ?? defaultKafka.topics.planCompletions,
    planEvents: envKafkaTopicPlanEvents ?? fileKafkaConfig?.topics?.planEvents ?? defaultKafka.topics.planEvents,
    planState: envKafkaTopicPlanState ?? fileKafkaConfig?.topics?.planState ?? defaultKafka.topics.planState,
    deadLetterSuffix:
      envKafkaTopicDeadLetterSuffix ?? fileKafkaConfig?.topics?.deadLetterSuffix ?? defaultKafka.topics.deadLetterSuffix
  };
  const kafkaTls: KafkaTlsConfig = {
    enabled: envKafkaTlsEnabled ?? fileKafkaConfig?.tls?.enabled ?? defaultKafka.tls.enabled,
    caPaths: envKafkaTlsCaPaths ?? fileKafkaConfig?.tls?.caPaths ?? defaultKafka.tls.caPaths,
    certPath: envKafkaTlsCertPath ?? fileKafkaConfig?.tls?.certPath ?? defaultKafka.tls.certPath,
    keyPath: envKafkaTlsKeyPath ?? fileKafkaConfig?.tls?.keyPath ?? defaultKafka.tls.keyPath,
    rejectUnauthorized:
      envKafkaTlsRejectUnauthorized ?? fileKafkaConfig?.tls?.rejectUnauthorized ?? defaultKafka.tls.rejectUnauthorized
  };
  const resolvedSaslMechanism = envKafkaSaslMechanism ?? fileKafkaSasl?.mechanism;
  let kafkaSasl: KafkaSaslConfig | undefined;
  if (resolvedSaslMechanism) {
    kafkaSasl = {
      mechanism: resolvedSaslMechanism,
      username: envKafkaSaslUsername ?? fileKafkaSasl?.username,
      password: envKafkaSaslPassword ?? fileKafkaSasl?.password,
      authorizationIdentity:
        envKafkaSaslAuthorizationIdentity ?? fileKafkaSasl?.authorizationIdentity
    };
  }
  const kafkaEnsureTopics = envKafkaEnsureTopics ?? fileKafkaConfig?.ensureTopics ?? defaultKafka.ensureTopics;
  const kafkaTopicPartitions = envKafkaTopicPartitions ?? fileKafkaConfig?.topicPartitions ?? defaultKafka.topicPartitions;
  const kafkaReplicationFactor = envKafkaReplicationFactor ?? fileKafkaConfig?.replicationFactor ?? defaultKafka.replicationFactor;
  const kafkaTopicConfig = envKafkaTopicDefaultConfig
    ? parseTopicConfig(envKafkaTopicDefaultConfig) ?? fileKafkaConfig?.topicConfig ?? defaultKafka.topicConfig
    : fileKafkaConfig?.topicConfig ?? defaultKafka.topicConfig;
  const kafkaCompactTopics = envKafkaCompactPatterns ?? fileKafkaConfig?.compactTopics ?? defaultKafka.compactTopics;
  const messagingType = fileCfg.messaging?.type ?? envMessageType ?? DEFAULT_CONFIG.messaging.type;
  const kafkaConfig: KafkaMessagingConfig = {
    brokers: kafkaBrokers,
    clientId: kafkaClientId,
    consumerGroup: kafkaConsumerGroup,
    consumeFromBeginning: kafkaConsumeFromBeginning,
    retryDelayMs: kafkaRetryDelayMs,
    topics: kafkaTopics,
    tls: kafkaTls,
    sasl: kafkaSasl,
    ensureTopics: kafkaEnsureTopics,
    topicPartitions: kafkaTopicPartitions,
    replicationFactor: kafkaReplicationFactor,
    topicConfig: kafkaTopicConfig,
    compactTopics: kafkaCompactTopics
  };

  const runMode = fileCfg.runMode ?? envRunMode ?? DEFAULT_CONFIG.runMode;
  const defaultPlanStateBackend = runMode === "enterprise" ? "postgres" : DEFAULT_CONFIG.planState.backend;
  const planStateBackend = envPlanStateBackend ?? fileCfg.planState?.backend ?? defaultPlanStateBackend;

  validateCookieSecure(runMode);

  const secretsDefault = runMode === "enterprise" ? "vault" : DEFAULT_CONFIG.secrets.backend;
  const providersEnabledDefault = DEFAULT_CONFIG.providers.enabled;
  const envEnabled = providersEnabledFromEnv?.map(provider => provider);
  const fileEnabled = providersEnabledFromFile?.map(provider => provider);

  const providerRateLimitConfig = ensurePositiveRateLimit(
    {
      windowMs: fileCfg.providers?.rateLimit?.windowMs ?? DEFAULT_CONFIG.providers.rateLimit.windowMs,
      maxRequests: fileCfg.providers?.rateLimit?.maxRequests ?? DEFAULT_CONFIG.providers.rateLimit.maxRequests
    },
    "providers.rateLimit"
  );

  const providerCircuitBreakerConfig: CircuitBreakerConfig = {
    failureThreshold:
      fileCfg.providers?.circuitBreaker?.failureThreshold ?? DEFAULT_CONFIG.providers.circuitBreaker.failureThreshold,
    resetTimeoutMs:
      fileCfg.providers?.circuitBreaker?.resetTimeoutMs ?? DEFAULT_CONFIG.providers.circuitBreaker.resetTimeoutMs
  };

  const serverPlanRateLimit = ensurePositiveRateLimit(
    {
      windowMs: fileCfg.server?.rateLimits?.plan?.windowMs ?? DEFAULT_CONFIG.server.rateLimits.plan.windowMs,
      maxRequests: fileCfg.server?.rateLimits?.plan?.maxRequests ?? DEFAULT_CONFIG.server.rateLimits.plan.maxRequests
    },
    "server.rateLimits.plan"
  );

  const serverChatRateLimit = ensurePositiveRateLimit(
    {
      windowMs: fileCfg.server?.rateLimits?.chat?.windowMs ?? DEFAULT_CONFIG.server.rateLimits.chat.windowMs,
      maxRequests: fileCfg.server?.rateLimits?.chat?.maxRequests ?? DEFAULT_CONFIG.server.rateLimits.chat.maxRequests
    },
    "server.rateLimits.chat"
  );

  const serverAuthBaseRateLimit = ensurePositiveRateLimit(
    {
      windowMs: fileCfg.server?.rateLimits?.auth?.windowMs ?? DEFAULT_CONFIG.server.rateLimits.auth.windowMs,
      maxRequests: fileCfg.server?.rateLimits?.auth?.maxRequests ?? DEFAULT_CONFIG.server.rateLimits.auth.maxRequests,
    },
    "server.rateLimits.auth",
  );

  const authIdentityWindowMs = sanitizeNonNegativeInteger(
    fileCfg.server?.rateLimits?.auth?.identityWindowMs ?? DEFAULT_CONFIG.server.rateLimits.auth.identityWindowMs,
    DEFAULT_CONFIG.server.rateLimits.auth.identityWindowMs,
  );
  const authIdentityMaxRequests = sanitizeNonNegativeInteger(
    fileCfg.server?.rateLimits?.auth?.identityMaxRequests ?? DEFAULT_CONFIG.server.rateLimits.auth.identityMaxRequests,
    DEFAULT_CONFIG.server.rateLimits.auth.identityMaxRequests,
  );

  const serverAuthRateLimit: IdentityRateLimitConfig = {
    ...serverAuthBaseRateLimit,
    identityWindowMs: authIdentityWindowMs,
    identityMaxRequests: authIdentityMaxRequests,
  };

  const serverRequestLimits: RequestSizeLimitsConfig = {
    jsonBytes: sanitizeRequestLimit(
      envServerRequestLimitJson ?? fileCfg.server?.requestLimits?.jsonBytes,
      DEFAULT_CONFIG.server.requestLimits.jsonBytes,
    ),
    urlEncodedBytes: sanitizeRequestLimit(
      envServerRequestLimitUrlEncoded ?? fileCfg.server?.requestLimits?.urlEncodedBytes,
      DEFAULT_CONFIG.server.requestLimits.urlEncodedBytes,
    ),
  };

  const serverSseQuotaConfig: SseQuotaConfig = {
    perIp: sanitizeQuotaValue(
      envSseMaxConnectionsPerIp ??
        fileCfg.server?.sseQuotas?.perIp ??
        DEFAULT_CONFIG.server.sseQuotas.perIp,
      DEFAULT_CONFIG.server.sseQuotas.perIp,
    ),
    perSubject: sanitizeQuotaValue(
      envSseMaxConnectionsPerSubject ??
        fileCfg.server?.sseQuotas?.perSubject ??
        DEFAULT_CONFIG.server.sseQuotas.perSubject,
      DEFAULT_CONFIG.server.sseQuotas.perSubject,
    ),
  };

  const serverSseSendTimeoutMs = sanitizePositiveInteger(
    envSseSendTimeout ?? fileCfg.server?.sseSendTimeoutMs,
    DEFAULT_CONFIG.server.sseSendTimeoutMs,
  );
  const serverSseMaxBufferEvents = sanitizeNonNegativeInteger(
    envSseMaxBufferEvents ?? fileCfg.server?.sseMaxBufferEvents,
    DEFAULT_CONFIG.server.sseMaxBufferEvents,
  );
  const serverSseMaxBufferBytes = sanitizeNonNegativeInteger(
    envSseMaxBufferBytes ?? fileCfg.server?.sseMaxBufferBytes,
    DEFAULT_CONFIG.server.sseMaxBufferBytes,
  );

  const fileServerBackend = fileCfg.server?.rateLimits?.backend;
  const serverRateLimitBackend: RateLimitBackendConfig = {
    provider:
      envRateLimitBackendProvider ??
      fileServerBackend?.provider ??
      DEFAULT_CONFIG.server.rateLimits.backend.provider,
    redisUrl:
      envRateLimitBackendRedisUrl ??
      fileServerBackend?.redisUrl ??
      DEFAULT_CONFIG.server.rateLimits.backend.redisUrl,
  };

  const resolvedTrustedProxyCidrs =
    envTrustedProxyCidrs ??
    fileCfg.server?.trustedProxyCidrs ??
    DEFAULT_CONFIG.server.trustedProxyCidrs;
  const normalizedTrustedProxyCidrs = resolvedTrustedProxyCidrs
    ? resolvedTrustedProxyCidrs
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0)
    : [];

  const fileCorsAllowedOrigins = fileCfg.server?.cors?.allowedOrigins;
  const corsAllowedOriginsSource =
    envServerCorsAllowedOrigins ?? fileCorsAllowedOrigins ??
    (runMode === "enterprise" ? [] : DEFAULT_CONFIG.server.cors.allowedOrigins);
  const normalizedCorsAllowedOrigins = normalizeOriginList(corsAllowedOriginsSource);

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

  const filePostgres = fileCfg.database?.postgres;
  const postgresConfig: PostgresDatabaseConfig = {
    maxConnections: sanitizePositiveInteger(
      filePostgres?.maxConnections ?? DEFAULT_CONFIG.database.postgres.maxConnections,
      DEFAULT_CONFIG.database.postgres.maxConnections,
    ),
    minConnections: sanitizeNonNegativeInteger(
      envPostgresMinConnections ?? filePostgres?.minConnections,
      DEFAULT_CONFIG.database.postgres.minConnections,
    ),
    idleTimeoutMs: sanitizeNonNegativeInteger(
      filePostgres?.idleTimeoutMs ?? DEFAULT_CONFIG.database.postgres.idleTimeoutMs,
      DEFAULT_CONFIG.database.postgres.idleTimeoutMs,
    ),
    connectionTimeoutMs: sanitizeNonNegativeInteger(
      filePostgres?.connectionTimeoutMs ?? DEFAULT_CONFIG.database.postgres.connectionTimeoutMs,
      DEFAULT_CONFIG.database.postgres.connectionTimeoutMs,
    ),
    maxConnectionLifetimeMs: sanitizePositiveInteger(
      filePostgres?.maxConnectionLifetimeMs ?? DEFAULT_CONFIG.database.postgres.maxConnectionLifetimeMs,
      DEFAULT_CONFIG.database.postgres.maxConnectionLifetimeMs,
    ),
    statementTimeoutMs: sanitizeNonNegativeInteger(
      envPostgresStatementTimeoutMs ?? filePostgres?.statementTimeoutMs,
      DEFAULT_CONFIG.database.postgres.statementTimeoutMs,
    ),
    queryTimeoutMs: sanitizeNonNegativeInteger(
      envPostgresQueryTimeoutMs ?? filePostgres?.queryTimeoutMs,
      DEFAULT_CONFIG.database.postgres.queryTimeoutMs,
    ),
  };

  const fileNetworkEgress = fileCfg.network?.egress;
  const networkEgressMode =
    envNetworkEgressMode ?? fileNetworkEgress?.mode ?? DEFAULT_CONFIG.network.egress.mode;
  const networkEgressAllow = normalizeEgressAllowList(
    envNetworkEgressAllow ?? fileNetworkEgress?.allow,
    DEFAULT_CONFIG.network.egress.allow,
  );

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

  const oauthRedirectBaseRaw =
    envRedirectBaseUrl ?? fileCfg.auth?.oauth?.redirectBaseUrl ?? DEFAULT_CONFIG.auth.oauth.redirectBaseUrl;
  const oauthRedirectBase = normalizeBaseUrl(oauthRedirectBaseRaw);
  const fileOidcConfig = fileCfg.auth?.oidc;
  const oidcRedirectBaseCandidate =
    envOidcRedirectBase ?? fileOidcConfig?.redirectBaseUrl ?? oauthRedirectBase ?? DEFAULT_CONFIG.auth.oidc.redirectBaseUrl;
  const oidcRedirectBaseNormalized = normalizeBaseUrl(
    oidcRedirectBaseCandidate || DEFAULT_CONFIG.auth.oidc.redirectBaseUrl
  );
  const oidcRedirectBase =
    oidcRedirectBaseNormalized || normalizeBaseUrl(DEFAULT_CONFIG.auth.oidc.redirectBaseUrl) || oauthRedirectBase;
  const resolvedOidcScopes = normalizeScopes(
    envOidcScopes ?? fileOidcConfig?.scopes ?? DEFAULT_CONFIG.auth.oidc.scopes
  );
  const resolvedOidcSessionCookieName =
    envOidcSessionCookieName ?? fileOidcConfig?.session?.cookieName ?? DEFAULT_CONFIG.auth.oidc.session.cookieName;
  const resolvedOidcSessionTtlSeconds =
    envOidcSessionTtl ?? fileOidcConfig?.session?.ttlSeconds ?? DEFAULT_CONFIG.auth.oidc.session.ttlSeconds;
  const resolvedOidcEnabled = envOidcEnabled ?? fileOidcConfig?.enabled ?? DEFAULT_CONFIG.auth.oidc.enabled;
  const resolvedOidcIssuer = (envOidcIssuer ?? fileOidcConfig?.issuer ?? DEFAULT_CONFIG.auth.oidc.issuer).trim();
  const resolvedOidcClientId = envOidcClientId ?? fileOidcConfig?.clientId ?? DEFAULT_CONFIG.auth.oidc.clientId;
  const resolvedOidcClientSecret = envOidcClientSecret ?? fileOidcConfig?.clientSecret ?? DEFAULT_CONFIG.auth.oidc.clientSecret;
  const resolvedOidcRedirectUri =
    fileOidcConfig?.redirectUri ?? `${oidcRedirectBase || oauthRedirectBase}/auth/oidc/callback`;
  const resolvedOidcTenantClaim =
    envOidcTenantClaim ?? fileOidcConfig?.tenantClaim ?? DEFAULT_CONFIG.auth.oidc.tenantClaim;
  const resolvedOidcAudience = envOidcAudience ?? fileOidcConfig?.audience ?? DEFAULT_CONFIG.auth.oidc.audience;
  const resolvedOidcLogoutUrl = envOidcLogoutUrl ?? fileOidcConfig?.logoutUrl ?? DEFAULT_CONFIG.auth.oidc.logoutUrl;
  const resolvedOidcRoleClaim =
    envOidcRoleClaim ?? fileOidcConfig?.roles?.claim ?? DEFAULT_CONFIG.auth.oidc.roles.claim;
  const resolvedOidcFallbackRolesSource =
    envOidcFallbackRoles ?? fileOidcConfig?.roles?.fallback ?? DEFAULT_CONFIG.auth.oidc.roles.fallback;
  const resolvedOidcFallbackRoles = normalizeStringSet(resolvedOidcFallbackRolesSource ?? []);
  const resolvedOidcRoleMappings =
    envOidcRoleMappings ?? fileOidcConfig?.roles?.mappings ?? DEFAULT_CONFIG.auth.oidc.roles.mappings;
  const resolvedOidcTenantRoleMappings =
    envOidcTenantRoleMappings ??
    fileOidcConfig?.roles?.tenantMappings ??
    DEFAULT_CONFIG.auth.oidc.roles.tenantMappings;

  if (resolvedOidcEnabled) {
    if (!resolvedOidcIssuer) {
      throw new Error("OIDC issuer must be configured when OIDC authentication is enabled");
    }
    if (!resolvedOidcClientId) {
      throw new Error("OIDC client ID must be configured when OIDC authentication is enabled");
    }
    if (!resolvedOidcClientSecret) {
      throw new Error("OIDC client secret must be configured when OIDC authentication is enabled");
    }
  }

  const retentionPlanStateDays = normalizeRetentionDays(
    envPlanStateRetentionDays ?? fileCfg.retention?.planStateDays,
    DEFAULT_CONFIG.retention.planStateDays
  );
  const retentionPlanArtifactsDays = normalizeRetentionDays(
    envPlanArtifactRetentionDays ?? fileCfg.retention?.planArtifactsDays,
    DEFAULT_CONFIG.retention.planArtifactsDays
  );
  const resolvedContentCaptureEnabled =
    envContentCaptureEnabled ??
    fileCfg.retention?.contentCapture?.enabled ??
    DEFAULT_CONFIG.retention.contentCapture.enabled;

  const resolvedToolAgentTlsInsecure =
    envAgentTlsInsecure ?? fileCfg.tooling?.tls?.insecure;
  const resolvedToolAgentTlsCertPath =
    envAgentTlsCertPath ?? fileCfg.tooling?.tls?.certPath;
  const resolvedToolAgentTlsKeyPath =
    envAgentTlsKeyPath ?? fileCfg.tooling?.tls?.keyPath;
  const resolvedToolAgentTlsCaPaths =
    envAgentTlsCaPaths ?? fileCfg.tooling?.tls?.caPaths;
  const toolAgentTls: ToolAgentTlsConfig | undefined = (() => {
    const hasCaPaths = resolvedToolAgentTlsCaPaths && resolvedToolAgentTlsCaPaths.length > 0;
    if (
      resolvedToolAgentTlsInsecure === undefined &&
      !resolvedToolAgentTlsCertPath &&
      !resolvedToolAgentTlsKeyPath &&
      !hasCaPaths
    ) {
      return undefined;
    }
    const tlsConfig: ToolAgentTlsConfig = {};
    if (resolvedToolAgentTlsInsecure !== undefined) {
      tlsConfig.insecure = resolvedToolAgentTlsInsecure;
    }
    if (resolvedToolAgentTlsCertPath) {
      tlsConfig.certPath = resolvedToolAgentTlsCertPath;
    }
    if (resolvedToolAgentTlsKeyPath) {
      tlsConfig.keyPath = resolvedToolAgentTlsKeyPath;
    }
    if (hasCaPaths) {
      tlsConfig.caPaths = resolvedToolAgentTlsCaPaths;
    }
    return tlsConfig;
  })();

  const filePolicyCache = fileCfg.policy?.cache;
  const resolvedPolicyCacheEnabled =
    envPolicyCacheEnabled ?? filePolicyCache?.enabled ?? DEFAULT_CONFIG.policy.cache.enabled;
  const resolvedPolicyCacheProvider =
    envPolicyCacheProvider ?? filePolicyCache?.provider ?? DEFAULT_CONFIG.policy.cache.provider;
  const resolvedPolicyCacheTtlSeconds = sanitizePositiveInteger(
    envPolicyCacheTtlSeconds ?? filePolicyCache?.ttlSeconds,
    DEFAULT_CONFIG.policy.cache.ttlSeconds,
  );
  const resolvedPolicyCacheMaxEntries = sanitizePositiveInteger(
    envPolicyCacheMaxEntries ?? filePolicyCache?.maxEntries,
    DEFAULT_CONFIG.policy.cache.maxEntries,
  );
  const filePolicyCacheRedis = filePolicyCache?.redis;
  const resolvedPolicyCacheRedisUrl =
    envPolicyCacheRedisUrl ?? filePolicyCacheRedis?.url ?? DEFAULT_CONFIG.policy.cache.redis?.url;
  const resolvedPolicyCacheRedisKeyPrefix =
    envPolicyCacheRedisKeyPrefix ??
    filePolicyCacheRedis?.keyPrefix ??
    DEFAULT_CONFIG.policy.cache.redis?.keyPrefix;
  const resolvedPolicyCacheRedis =
    resolvedPolicyCacheRedisUrl || resolvedPolicyCacheRedisKeyPrefix
      ? {
          url: resolvedPolicyCacheRedisUrl,
          keyPrefix: resolvedPolicyCacheRedisKeyPrefix,
        }
      : undefined;

  const resolvedConfig: AppConfig = {
    runMode,
    messaging: {
      type: messagingType,
      kafka: kafkaConfig
    },
    providers: {
      defaultRoute: fileCfg.providers?.defaultRoute ?? DEFAULT_CONFIG.providers.defaultRoute,
      enabled: envEnabled ?? fileEnabled ?? [...providersEnabledDefault],
      rateLimit: providerRateLimitConfig,
      circuitBreaker: providerCircuitBreakerConfig
    },
    auth: {
      oauth: {
        redirectBaseUrl: oauthRedirectBase
      },
      oidc: {
        enabled: resolvedOidcEnabled,
        issuer: resolvedOidcIssuer,
        clientId: resolvedOidcClientId,
        clientSecret: resolvedOidcClientSecret,
        redirectBaseUrl: oidcRedirectBase,
        redirectUri: resolvedOidcRedirectUri,
        scopes: resolvedOidcScopes,
        tenantClaim: resolvedOidcTenantClaim,
        audience: resolvedOidcAudience,
        logoutUrl: resolvedOidcLogoutUrl,
        roles: {
          claim: resolvedOidcRoleClaim,
          fallback: [...resolvedOidcFallbackRoles],
          mappings: Object.fromEntries(
            Object.entries(resolvedOidcRoleMappings ?? {}).map(([role, caps]) => [role, [...caps]])
          ),
          tenantMappings: Object.fromEntries(
            Object.entries(resolvedOidcTenantRoleMappings ?? {}).map(([tenant, mapping]) => [
              tenant,
              Object.fromEntries(Object.entries(mapping).map(([role, caps]) => [role, [...caps]]))
            ])
          )
        },
        session: {
          cookieName: resolvedOidcSessionCookieName,
          ttlSeconds: resolvedOidcSessionTtlSeconds
        }
      }
    },
    planState: {
      backend: planStateBackend
    },
    retention: {
      planStateDays: retentionPlanStateDays,
      planArtifactsDays: retentionPlanArtifactsDays,
      contentCapture: {
        enabled: resolvedContentCaptureEnabled
      }
    },
    secrets: {
      backend: envSecretsBackend ?? fileCfg.secrets?.backend ?? secretsDefault
    },
    tooling: {
      agentEndpoint: envAgentEndpoint ?? fileCfg.tooling?.agentEndpoint ?? DEFAULT_CONFIG.tooling.agentEndpoint,
      retryAttempts: envAgentRetries ?? fileCfg.tooling?.retryAttempts ?? DEFAULT_CONFIG.tooling.retryAttempts,
      defaultTimeoutMs: envAgentTimeout ?? fileCfg.tooling?.defaultTimeoutMs ?? DEFAULT_CONFIG.tooling.defaultTimeoutMs,
      tls: toolAgentTls
    },
    server: {
      sseKeepAliveMs:
        envSseKeepAlive ?? fileCfg.server?.sseKeepAliveMs ?? DEFAULT_CONFIG.server.sseKeepAliveMs,
      sseSendTimeoutMs: serverSseSendTimeoutMs,
      sseMaxBufferEvents: serverSseMaxBufferEvents,
      sseMaxBufferBytes: serverSseMaxBufferBytes,
      requestLimits: serverRequestLimits,
      rateLimits: {
        backend: serverRateLimitBackend,
        plan: serverPlanRateLimit,
        chat: serverChatRateLimit,
        auth: serverAuthRateLimit
      },
      sseQuotas: serverSseQuotaConfig,
      tls: {
        enabled: tlsEnabled,
        keyPath: tlsKeyPath,
        certPath: tlsCertPath,
        caPaths: tlsCaPaths ?? [],
        requestClientCert: tlsRequestClientCert
      },
      trustedProxyCidrs: [...normalizedTrustedProxyCidrs],
      cors: {
        allowedOrigins: [...normalizedCorsAllowedOrigins],
      },
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
    },
    policy: {
      cache: {
        enabled: resolvedPolicyCacheEnabled,
        provider: resolvedPolicyCacheProvider ?? DEFAULT_CONFIG.policy.cache.provider,
        ttlSeconds: resolvedPolicyCacheTtlSeconds,
        maxEntries: resolvedPolicyCacheMaxEntries,
        redis: resolvedPolicyCacheRedis
      }
    },
    database: {
      postgres: postgresConfig,
    },
    network: {
      egress: {
        mode: networkEgressMode,
        allow: [...networkEgressAllow],
      },
    },
  };
  const metadataAfter = readConfigFileMetadata(cfgPath);
  configCache = {
    path: cfgPath,
    mtimeMs: metadataAfter.exists ? metadataAfter.mtimeMs ?? null : null,
    config: resolvedConfig,
  };
  return resolvedConfig;
}

function parseJsonEnv(value: string | undefined, context: string): unknown | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    throw new Error(`${context} must be valid JSON: ${reason}`);
  }
}
