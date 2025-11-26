/**
 * Configuration Schema Definitions using Zod
 *
 * This module defines typed schemas for the orchestrator's configuration.
 * It provides validation, type inference, and clear error messages for
 * configuration issues at startup time.
 *
 * The schema is designed to be gradually adopted - existing loadConfig.ts
 * logic can be migrated section by section to use these schemas.
 */

import { z } from "zod";

// ============================================================================
// Rate Limiting Schemas
// ============================================================================

export const RateLimitBackendProviderSchema = z.enum(["memory", "redis"]);
export type RateLimitBackendProvider = z.infer<typeof RateLimitBackendProviderSchema>;

export const RateLimitBackendConfigSchema = z.object({
  provider: RateLimitBackendProviderSchema.default("memory"),
  redisUrl: z.string().url().optional(),
}).refine(
  (data) => data.provider !== "redis" || data.redisUrl,
  { message: "redisUrl is required when provider is 'redis'" }
);
export type RateLimitBackendConfig = z.infer<typeof RateLimitBackendConfigSchema>;

export const RateLimitConfigSchema = z.object({
  windowMs: z.number().min(1000).max(3600000).default(60000),
  maxRequests: z.number().min(1).max(10000).default(100),
});
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

export const IdentityAwareRateLimitConfigSchema = RateLimitConfigSchema.extend({
  identityWindowMs: z.number().min(1000).max(3600000).nullable().optional(),
  identityMaxRequests: z.number().min(1).max(10000).nullable().optional(),
});
export type IdentityAwareRateLimitConfig = z.infer<typeof IdentityAwareRateLimitConfigSchema>;

export const ServerRateLimitsConfigSchema = z.object({
  backend: RateLimitBackendConfigSchema,
  plan: IdentityAwareRateLimitConfigSchema,
  chat: IdentityAwareRateLimitConfigSchema,
  auth: IdentityAwareRateLimitConfigSchema,
  secrets: IdentityAwareRateLimitConfigSchema,
  remoteFs: IdentityAwareRateLimitConfigSchema,
});
export type ServerRateLimitsConfig = z.infer<typeof ServerRateLimitsConfigSchema>;

// ============================================================================
// SSE Quota Schemas
// ============================================================================

export const SseQuotaConfigSchema = z.object({
  perIp: z.number().min(1).max(100).default(4),
  perSubject: z.number().min(1).max(50).default(2),
});
export type SseQuotaConfig = z.infer<typeof SseQuotaConfigSchema>;

// ============================================================================
// CORS Schemas
// ============================================================================

export const CorsConfigSchema = z.object({
  allowedOrigins: z.array(z.string()).default(["*"]),
});
export type CorsConfig = z.infer<typeof CorsConfigSchema>;

// ============================================================================
// Request Size Limits
// ============================================================================

export const RequestSizeLimitsConfigSchema = z.object({
  jsonBytes: z.number().min(1024).max(104857600).default(1048576), // 1MB default
  urlEncodedBytes: z.number().min(1024).max(104857600).default(1048576),
});
export type RequestSizeLimitsConfig = z.infer<typeof RequestSizeLimitsConfigSchema>;

// ============================================================================
// TLS Configuration
// ============================================================================

export const TlsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  keyPath: z.string().optional(),
  certPath: z.string().optional(),
  caPaths: z.array(z.string()).default([]),
  requestClientCert: z.boolean().default(false),
}).refine(
  (data) => !data.enabled || (data.keyPath && data.certPath),
  { message: "keyPath and certPath are required when TLS is enabled" }
);
export type TlsConfig = z.infer<typeof TlsConfigSchema>;

// ============================================================================
// Security Headers
// ============================================================================

export const SecurityHeaderValueConfigSchema = z.object({
  enabled: z.boolean().default(true),
  value: z.string(),
});
export type SecurityHeaderValueConfig = z.infer<typeof SecurityHeaderValueConfigSchema>;

export const StrictTransportSecurityHeaderConfigSchema = SecurityHeaderValueConfigSchema.extend({
  requireTls: z.boolean().default(true),
});
export type StrictTransportSecurityHeaderConfig = z.infer<typeof StrictTransportSecurityHeaderConfigSchema>;

export const SecurityHeadersConfigSchema = z.object({
  contentSecurityPolicy: SecurityHeaderValueConfigSchema.default({
    enabled: true,
    value: "default-src 'self'",
  }),
  strictTransportSecurity: StrictTransportSecurityHeaderConfigSchema.default({
    enabled: true,
    value: "max-age=31536000; includeSubDomains",
    requireTls: true,
  }),
  xFrameOptions: SecurityHeaderValueConfigSchema.default({
    enabled: true,
    value: "DENY",
  }),
  xContentTypeOptions: SecurityHeaderValueConfigSchema.default({
    enabled: true,
    value: "nosniff",
  }),
  referrerPolicy: SecurityHeaderValueConfigSchema.default({
    enabled: true,
    value: "strict-origin-when-cross-origin",
  }),
  permissionsPolicy: SecurityHeaderValueConfigSchema.default({
    enabled: false,
    value: "",
  }),
  crossOriginOpenerPolicy: SecurityHeaderValueConfigSchema.default({
    enabled: true,
    value: "same-origin",
  }),
  crossOriginResourcePolicy: SecurityHeaderValueConfigSchema.default({
    enabled: true,
    value: "same-origin",
  }),
  crossOriginEmbedderPolicy: SecurityHeaderValueConfigSchema.default({
    enabled: false,
    value: "require-corp",
  }),
  xDnsPrefetchControl: SecurityHeaderValueConfigSchema.default({
    enabled: true,
    value: "off",
  }),
});
export type SecurityHeadersConfig = z.infer<typeof SecurityHeadersConfigSchema>;

// ============================================================================
// Kafka Configuration
// ============================================================================

export const KafkaSaslMechanismSchema = z.enum([
  "plain",
  "scram-sha-256",
  "scram-sha-512",
  "aws",
  "oauthbearer",
]);
export type KafkaSaslMechanism = z.infer<typeof KafkaSaslMechanismSchema>;

export const KafkaSaslConfigSchema = z.object({
  mechanism: KafkaSaslMechanismSchema,
  username: z.string().optional(),
  password: z.string().optional(),
  authorizationIdentity: z.string().optional(),
});
export type KafkaSaslConfig = z.infer<typeof KafkaSaslConfigSchema>;

export const KafkaTlsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  caPaths: z.array(z.string()).default([]),
  certPath: z.string().optional(),
  keyPath: z.string().optional(),
  rejectUnauthorized: z.boolean().default(true),
});
export type KafkaTlsConfig = z.infer<typeof KafkaTlsConfigSchema>;

export const KafkaTopicsConfigSchema = z.object({
  planSteps: z.string().default("plan-steps"),
  planCompletions: z.string().default("plan-completions"),
  planEvents: z.string().default("plan-events"),
  planState: z.string().default("plan-state"),
  deadLetterSuffix: z.string().default("-dlq"),
});
export type KafkaTopicsConfig = z.infer<typeof KafkaTopicsConfigSchema>;

export const KafkaMessagingConfigSchema = z.object({
  brokers: z.array(z.string()).min(1),
  clientId: z.string().default("orchestrator"),
  consumerGroup: z.string().default("orchestrator-group"),
  consumeFromBeginning: z.boolean().default(false),
  retryDelayMs: z.number().min(100).max(60000).default(1000),
  topics: KafkaTopicsConfigSchema.default({}),
  tls: KafkaTlsConfigSchema.default({}),
  sasl: KafkaSaslConfigSchema.optional(),
  ensureTopics: z.boolean().default(true),
  topicPartitions: z.number().min(1).max(100).optional(),
  replicationFactor: z.number().min(1).max(10).optional(),
  topicConfig: z.record(z.string(), z.string()).default({}),
  compactTopics: z.array(z.string()).default([]),
});
export type KafkaMessagingConfig = z.infer<typeof KafkaMessagingConfigSchema>;

// ============================================================================
// RabbitMQ Configuration
// ============================================================================

export const RabbitMqMessagingConfigSchema = z.object({
  // Note: URL should be provided via RABBITMQ_URL env var with credentials
  // Example: amqp://user:password@host:5672 - never commit credentials
  url: z.string().url(),
  exchange: z.string().default("orchestrator"),
  queues: z.object({
    planSteps: z.string().default("plan-steps"),
    planCompletions: z.string().default("plan-completions"),
    deadLetter: z.string().default("dead-letter"),
  }).default({}),
  prefetch: z.number().min(1).max(100).default(10),
  retryDelayMs: z.number().min(100).max(60000).default(1000),
  maxRetries: z.number().min(0).max(10).default(3),
});
export type RabbitMqMessagingConfig = z.infer<typeof RabbitMqMessagingConfigSchema>;

// ============================================================================
// Database Configuration
// ============================================================================

export const PostgresDatabaseConfigSchema = z.object({
  maxConnections: z.number().min(1).max(100).default(10),
  minConnections: z.number().min(0).max(50).default(2),
  idleTimeoutMs: z.number().min(1000).max(3600000).default(30000),
  connectionTimeoutMs: z.number().min(1000).max(60000).default(5000),
  maxConnectionLifetimeMs: z.number().min(60000).max(86400000).default(3600000),
  statementTimeoutMs: z.number().min(1000).max(300000).default(5000),
  queryTimeoutMs: z.number().min(1000).max(300000).default(5000),
});
export type PostgresDatabaseConfig = z.infer<typeof PostgresDatabaseConfigSchema>;

export const DatabaseConfigSchema = z.object({
  postgres: PostgresDatabaseConfigSchema.default({}),
});
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

// ============================================================================
// Network/Egress Configuration
// ============================================================================

export const NetworkEgressModeSchema = z.enum(["enforce", "report-only", "allow"]);
export type NetworkEgressMode = z.infer<typeof NetworkEgressModeSchema>;

export const NetworkEgressConfigSchema = z.object({
  mode: NetworkEgressModeSchema.default("allow"),
  allow: z.array(z.string()).default([]),
});
export type NetworkEgressConfig = z.infer<typeof NetworkEgressConfigSchema>;

export const NetworkConfigSchema = z.object({
  egress: NetworkEgressConfigSchema.default({}),
});
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;

// ============================================================================
// Provider Configuration
// ============================================================================

export const ProviderRuntimeConfigSchema = z.object({
  defaultTemperature: z.number().min(0).max(2).optional(),
  timeoutMs: z.number().min(1000).max(600000).optional(), // Max 10 minutes
});
export type ProviderRuntimeConfig = z.infer<typeof ProviderRuntimeConfigSchema>;

export const ProviderSettingsConfigSchema = z.record(z.string(), ProviderRuntimeConfigSchema);
export type ProviderSettingsConfig = z.infer<typeof ProviderSettingsConfigSchema>;

export const ProviderRoutingPrioritySchema = z.object({
  balanced: z.array(z.string()).default([]),
  high_quality: z.array(z.string()).default([]),
  low_cost: z.array(z.string()).default([]),
});
export type ProviderRoutingPriority = z.infer<typeof ProviderRoutingPrioritySchema>;

// ============================================================================
// Policy Configuration
// ============================================================================

export const PolicyCacheProviderSchema = z.enum(["memory", "redis"]);
export type PolicyCacheProvider = z.infer<typeof PolicyCacheProviderSchema>;

export const PolicyCacheRedisConfigSchema = z.object({
  url: z.string().url().optional(),
  keyPrefix: z.string().default("policy:"),
});
export type PolicyCacheRedisConfig = z.infer<typeof PolicyCacheRedisConfigSchema>;

export const PolicyCacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  provider: PolicyCacheProviderSchema.default("memory"),
  ttlSeconds: z.number().min(1).max(86400).default(300),
  maxEntries: z.number().min(100).max(100000).default(10000),
  redis: PolicyCacheRedisConfigSchema.optional(),
});
export type PolicyCacheConfig = z.infer<typeof PolicyCacheConfigSchema>;

export const PolicyConfigSchema = z.object({
  cache: PolicyCacheConfigSchema.default({}),
});
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

// ============================================================================
// Observability Configuration
// ============================================================================

export const TracingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  serviceName: z.string().default("orchestrator"),
  jaegerEndpoint: z.string().url().optional(),
  samplingRatio: z.number().min(0).max(1).default(1.0),
});
export type TracingConfig = z.infer<typeof TracingConfigSchema>;

export const ObservabilityConfigSchema = z.object({
  tracing: TracingConfigSchema.default({}),
});
export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;

// ============================================================================
// Session Store Configuration
// ============================================================================

export const SessionStoreProviderSchema = z.enum(["memory", "redis"]);
export type SessionStoreProvider = z.infer<typeof SessionStoreProviderSchema>;

export const SessionStoreConfigSchema = z.object({
  provider: SessionStoreProviderSchema.default("memory"),
  redisUrl: z.string().url().optional(),
  ttlSeconds: z.number().min(60).max(86400).default(3600),
  keyPrefix: z.string().default("session:"),
}).refine(
  (data) => data.provider !== "redis" || data.redisUrl,
  { message: "redisUrl is required when provider is 'redis'" }
);
export type SessionStoreConfig = z.infer<typeof SessionStoreConfigSchema>;

// ============================================================================
// Dynamic Planner Configuration
// ============================================================================

export const PlannerModeSchema = z.enum(["static", "dynamic", "hybrid"]);
export type PlannerMode = z.infer<typeof PlannerModeSchema>;

export const DynamicPlannerConfigSchema = z.object({
  mode: PlannerModeSchema.default("static"),
  plansDirectory: z.string().default("config/plans"),
  watchForChanges: z.boolean().default(false),
  defaultConcurrencyLimit: z.number().min(1).max(50).default(10),
});
export type DynamicPlannerConfig = z.infer<typeof DynamicPlannerConfigSchema>;

// ============================================================================
// Server Configuration
// ============================================================================

export const ServerConfigSchema = z.object({
  port: z.number().min(1).max(65535).default(4000),
  host: z.string().default("0.0.0.0"),
  rateLimits: ServerRateLimitsConfigSchema.optional(),
  sseQuota: SseQuotaConfigSchema.default({}),
  cors: CorsConfigSchema.default({}),
  requestSizeLimits: RequestSizeLimitsConfigSchema.default({}),
  tls: TlsConfigSchema.default({}),
  securityHeaders: SecurityHeadersConfigSchema.default({}),
  sessionStore: SessionStoreConfigSchema.default({}),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

// ============================================================================
// Messaging Configuration (Union of Kafka/RabbitMQ/NATS)
// ============================================================================

export const MessagingProviderSchema = z.enum(["kafka", "rabbitmq", "nats", "memory"]);
export type MessagingProvider = z.infer<typeof MessagingProviderSchema>;

export const MessagingConfigSchema = z.object({
  provider: MessagingProviderSchema.default("memory"),
  kafka: KafkaMessagingConfigSchema.optional(),
  rabbitmq: RabbitMqMessagingConfigSchema.optional(),
});
export type MessagingConfig = z.infer<typeof MessagingConfigSchema>;

// ============================================================================
// Root Configuration Schema
// ============================================================================

export const OrchestratorConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  database: DatabaseConfigSchema.default({}),
  messaging: MessagingConfigSchema.default({}),
  network: NetworkConfigSchema.default({}),
  policy: PolicyConfigSchema.default({}),
  observability: ObservabilityConfigSchema.default({}),
  planner: DynamicPlannerConfigSchema.default({}),
  providers: ProviderSettingsConfigSchema.default({}),
  providerRouting: ProviderRoutingPrioritySchema.default({}),
});
export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate and parse configuration, returning a strongly-typed result.
 * @param input - Raw configuration input
 * @returns Validated OrchestratorConfig
 * @throws ZodError if validation fails
 */
export function validateConfig(input: unknown): OrchestratorConfig {
  return OrchestratorConfigSchema.parse(input);
}

/**
 * Validate configuration with safe error handling.
 * Returns the parsed config or undefined with logged errors.
 * @param input - Raw configuration input
 * @returns Validated config or undefined
 */
export function validateConfigSafe(input: unknown): OrchestratorConfig | undefined {
  const result = OrchestratorConfigSchema.safeParse(input);
  if (!result.success) {
    console.error("Configuration validation failed:", result.error.format());
    return undefined;
  }
  return result.data;
}

/**
 * Get default configuration with all defaults applied.
 */
export function getDefaultConfig(): OrchestratorConfig {
  return OrchestratorConfigSchema.parse({});
}

/**
 * Merge partial configuration with defaults.
 * @param partial - Partial configuration to merge
 * @returns Complete configuration with defaults
 */
export function mergeWithDefaults(partial: Partial<OrchestratorConfig>): OrchestratorConfig {
  return OrchestratorConfigSchema.parse(partial);
}
