import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trace, type Tracer } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { __resetLegacyMessagingWarningForTests, invalidateConfigCache, loadConfig } from "./config.js";

const ENV_KEYS = [
  "RUN_MODE",
  "MESSAGE_BUS",
  "MESSAGING_TYPE",
  "PROVIDERS",
  "OAUTH_REDIRECT_BASE",
  "SECRETS_BACKEND",
  "APP_CONFIG",
  "TRACING_ENABLED",
  "OTEL_TRACES_EXPORTER_ENABLED",
  "TRACING_SERVICE_NAME",
  "OTEL_SERVICE_NAME",
  "TRACING_ENVIRONMENT",
  "OTEL_RESOURCE_ATTRIBUTES",
  "DEPLOYMENT_ENVIRONMENT",
  "TRACING_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "TRACING_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "TRACING_SAMPLE_RATIO",
  "OTEL_TRACES_SAMPLER_ARG",
  "SERVER_TLS_ENABLED",
  "SERVER_TLS_CERT_PATH",
  "SERVER_TLS_KEY_PATH",
  "SERVER_TLS_CA_PATHS",
  "SERVER_TLS_REQUEST_CLIENT_CERT",
  "ORCHESTRATOR_TLS_ENABLED",
  "ORCHESTRATOR_CLIENT_CERT",
  "ORCHESTRATOR_CLIENT_KEY",
  "ORCHESTRATOR_CA_CERT",
  "ORCHESTRATOR_TLS_SERVER_NAME",
  "KAFKA_BROKERS",
  "KAFKA_CLIENT_ID",
  "KAFKA_GROUP_ID",
  "KAFKA_CONSUME_FROM_BEGINNING",
  "KAFKA_RETRY_DELAY_MS",
  "KAFKA_TOPIC_PLAN_STEPS",
  "KAFKA_TOPIC_PLAN_COMPLETIONS",
  "KAFKA_TOPIC_PLAN_EVENTS",
  "KAFKA_TOPIC_PLAN_STATE",
  "KAFKA_TOPIC_DEAD_LETTER_SUFFIX",
  "KAFKA_TLS_ENABLED",
  "KAFKA_TLS_CA_PATHS",
  "KAFKA_TLS_CERT_PATH",
  "KAFKA_TLS_KEY_PATH",
  "KAFKA_TLS_REJECT_UNAUTHORIZED",
  "KAFKA_SASL_MECHANISM",
  "KAFKA_SASL_USERNAME",
  "KAFKA_SASL_PASSWORD",
  "KAFKA_ENSURE_TOPICS",
  "KAFKA_TOPIC_PARTITIONS",
  "KAFKA_TOPIC_REPLICATION_FACTOR",
  "KAFKA_TOPIC_DEFAULT_CONFIG",
  "KAFKA_TOPIC_COMPACT_PATTERNS",
  "KAFKA_DEAD_LETTER_SUFFIX",
  "OIDC_ENABLED",
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_BASE",
  "OIDC_SCOPES",
  "OIDC_TENANT_CLAIM",
  "OIDC_AUDIENCE",
  "OIDC_LOGOUT_URL",
  "OIDC_SESSION_COOKIE_NAME",
  "OIDC_SESSION_TTL_SECONDS",
  "OIDC_ROLE_CLAIM",
  "OIDC_DEFAULT_ROLES",
  "OIDC_ROLE_MAPPINGS",
  "OIDC_TENANT_ROLE_MAPPINGS",
  "RETENTION_PLAN_STATE_DAYS",
  "RETENTION_PLAN_ARTIFACT_DAYS",
  "CONTENT_CAPTURE_ENABLED",
  "PLAN_STATE_BACKEND",
  "SSE_MAX_CONNECTIONS_PER_IP",
  "SSE_MAX_CONNECTIONS_PER_SUBJECT"
] as const;

const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
ENV_KEYS.forEach(key => {
  if (process.env[key] !== undefined) {
    originalEnv[key] = process.env[key];
  }
});

const tempDirs: string[] = [];

function createTempConfigFile(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-config-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "app.yaml");
  fs.writeFileSync(filePath, contents, "utf-8");
  return filePath;
}

function restoreEnv(): void {
  ENV_KEYS.forEach(key => {
    const original = originalEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  });
}

describe("loadConfig", () => {
  let warnSpy: MockInstance<typeof console.warn>;

  beforeEach(() => {
    restoreEnv();
    __resetLegacyMessagingWarningForTests();
    invalidateConfigCache();
    warnSpy = vi.spyOn(console, "warn");
    warnSpy.mockImplementation(() => {});
  });

  afterEach(() => {
    tempDirs.splice(0).forEach(dir => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    restoreEnv();
    invalidateConfigCache();
    warnSpy.mockRestore();
  });

  it("loads configuration values from a YAML file", () => {
    const configPath = createTempConfigFile(`
runMode: enterprise
messaging:
  type: kafka
  kafka:
    brokers:
      - kafka-1:9092
      - kafka-2:9092
    clientId: orchestrator
    consumerGroup: plan-workers
    consumeFromBeginning: true
    retryDelayMs: 500
    topics:
      planSteps: plan.steps.custom
      planCompletions: plan.completions.custom
      planEvents: plan.events.custom
      planState: plan.state.custom
      deadLetterSuffix: ".dlq"
    tls:
      enabled: true
      caPaths:
        - /etc/kafka/ca.pem
      certPath: /etc/kafka/client.crt
      keyPath: /etc/kafka/client.key
      rejectUnauthorized: true
    sasl:
      mechanism: plain
      username: kafka-user
      password: kafka-pass
providers:
  defaultRoute: high_quality
  enabled:
    - anthropic
    - openai
  rateLimit:
    windowMs: 30000
    maxRequests: 50
  circuitBreaker:
    failureThreshold: 7
    resetTimeoutMs: 45000
auth:
  oauth:
    redirectBaseUrl: "https://example.com/callback"
  oidc:
    enabled: true
    issuer: https://oidc.example.com
    clientId: yaml-client
    clientSecret: yaml-secret
    redirectBaseUrl: https://app.example.com
    scopes:
      - openid
      - profile
      - email
    tenantClaim: org_id
    audience: api://default
    logoutUrl: https://oidc.example.com/logout
    session:
      cookieName: yaml_session
      ttlSeconds: 14400
secrets:
  backend: vault
server:
  sseKeepAliveMs: 10000
  rateLimits:
    plan:
      windowMs: 120000
      maxRequests: 20
    chat:
      windowMs: 30000
      maxRequests: 200
    auth:
      windowMs: 45000
      maxRequests: 50
  sseQuotas:
    perIp: 3
    perSubject: 1
  tls:
    enabled: true
    keyPath: "/etc/orchestrator/tls/server.key"
    certPath: "/etc/orchestrator/tls/server.crt"
    caPaths:
      - "/etc/orchestrator/tls/ca.crt"
    requestClientCert: true
observability:
  tracing:
    enabled: true
    serviceName: orchestrator-svc
    environment: staging
    exporterEndpoint: "https://otel.example.com/v1/traces"
    exporterHeaders:
      authorization: "Bearer token"
    sampleRatio: 0.25
`);
    process.env.APP_CONFIG = configPath;

    const config = loadConfig();

    expect(config.runMode).toBe("enterprise");
    expect(config.messaging.type).toBe("kafka");
    expect(config.messaging.kafka).toEqual({
      brokers: ["kafka-1:9092", "kafka-2:9092"],
      clientId: "orchestrator",
      consumerGroup: "plan-workers",
      consumeFromBeginning: true,
      retryDelayMs: 500,
      topics: {
        planSteps: "plan.steps.custom",
        planCompletions: "plan.completions.custom",
        planEvents: "plan.events.custom",
        planState: "plan.state.custom",
        deadLetterSuffix: ".dlq"
      },
      tls: {
        enabled: true,
        caPaths: ["/etc/kafka/ca.pem"],
        certPath: "/etc/kafka/client.crt",
        keyPath: "/etc/kafka/client.key",
        rejectUnauthorized: true
      },
      sasl: {
        mechanism: "plain",
        username: "kafka-user",
        password: "kafka-pass"
      },
      ensureTopics: true,
      topicPartitions: 1,
      replicationFactor: 1,
      topicConfig: {},
      compactTopics: []
    });
    expect(config.providers.defaultRoute).toBe("high_quality");
    expect(config.providers.enabled).toEqual(["anthropic", "openai"]);
    expect(config.auth.oauth.redirectBaseUrl).toBe("https://example.com/callback");
    expect(config.auth.oidc).toEqual({
      enabled: true,
      issuer: "https://oidc.example.com",
      clientId: "yaml-client",
      clientSecret: "yaml-secret",
      redirectBaseUrl: "https://app.example.com",
      redirectUri: "https://app.example.com/auth/oidc/callback",
      scopes: ["openid", "profile", "email"],
      tenantClaim: "org_id",
      audience: "api://default",
      logoutUrl: "https://oidc.example.com/logout",
      roles: {
        claim: "roles",
        fallback: [],
        mappings: {},
        tenantMappings: {}
      },
      session: {
        cookieName: "yaml_session",
        ttlSeconds: 14400
      }
    });
    expect(config.planState.backend).toBe("postgres");
    expect(config.secrets.backend).toBe("vault");
    expect(config.server.sseKeepAliveMs).toBe(10000);
    expect(config.server.rateLimits.plan).toEqual({ windowMs: 120000, maxRequests: 20 });
    expect(config.server.rateLimits.chat).toEqual({ windowMs: 30000, maxRequests: 200 });
    expect(config.server.rateLimits.auth).toEqual({ windowMs: 45000, maxRequests: 50 });
    expect(config.server.sseQuotas).toEqual({ perIp: 3, perSubject: 1 });
    expect(config.server.tls).toEqual({
      enabled: true,
      keyPath: "/etc/orchestrator/tls/server.key",
      certPath: "/etc/orchestrator/tls/server.crt",
      caPaths: ["/etc/orchestrator/tls/ca.crt"],
      requestClientCert: true
    });
    expect(config.observability.tracing.enabled).toBe(true);
    expect(config.observability.tracing.serviceName).toBe("orchestrator-svc");
    expect(config.observability.tracing.environment).toBe("staging");
    expect(config.observability.tracing.exporterEndpoint).toBe("https://otel.example.com/v1/traces");
    expect(config.observability.tracing.exporterHeaders).toEqual({ authorization: "Bearer token" });
    expect(config.observability.tracing.sampleRatio).toBeCloseTo(0.25);
    expect(config.retention).toEqual({
      planStateDays: 30,
      planArtifactsDays: 30,
      contentCapture: {
        enabled: false
      }
    });
  });

  it("memoizes configuration reads until the file changes", () => {
    const configPath = createTempConfigFile(`
runMode: enterprise
`);
    process.env.APP_CONFIG = configPath;
    const readSpy = vi.spyOn(fs, "readFileSync");

    const first = loadConfig();
    const second = loadConfig();

    expect(second).toBe(first);
    expect(readSpy).toHaveBeenCalledTimes(1);

    fs.writeFileSync(configPath, "runMode: consumer\n", "utf-8");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(configPath, future, future);

    const third = loadConfig();

    expect(third).not.toBe(first);
    expect(third.runMode).toBe("consumer");
    expect(readSpy).toHaveBeenCalledTimes(2);

    readSpy.mockRestore();
  });

  it("derives configuration from environment variables when file values are absent", () => {
    delete process.env.APP_CONFIG;
    process.env.RUN_MODE = "enterprise";
    process.env.MESSAGE_BUS = "kafka";
    process.env.PROVIDERS = "anthropic, openai";
    process.env.OAUTH_REDIRECT_BASE = "https://env.example.com/callback";
    process.env.SECRETS_BACKEND = "vault";
    process.env.OIDC_ENABLED = "true";
    process.env.OIDC_ISSUER_URL = "https://env-issuer.example.com";
    process.env.OIDC_CLIENT_ID = "env-client";
    process.env.OIDC_CLIENT_SECRET = "env-secret";
    process.env.OIDC_REDIRECT_BASE = "https://env.app";
    process.env.OIDC_SCOPES = "openid email";
    process.env.OIDC_SESSION_COOKIE_NAME = "env_session";
    process.env.OIDC_SESSION_TTL_SECONDS = "1800";
    process.env.SSE_MAX_CONNECTIONS_PER_IP = "7";
    process.env.SSE_MAX_CONNECTIONS_PER_SUBJECT = "4";

    const config = loadConfig();

    expect(config.runMode).toBe("enterprise");
    expect(config.messaging.type).toBe("kafka");
    expect(config.providers.defaultRoute).toBe("balanced");
    expect(config.providers.enabled).toEqual(["anthropic", "openai"]);
    expect(config.auth.oauth.redirectBaseUrl).toBe("https://env.example.com/callback");
    expect(config.auth.oidc.enabled).toBe(true);
    expect(config.auth.oidc.issuer).toBe("https://env-issuer.example.com");
    expect(config.auth.oidc.clientId).toBe("env-client");
    expect(config.auth.oidc.clientSecret).toBe("env-secret");
    expect(config.auth.oidc.redirectBaseUrl).toBe("https://env.app");
    expect(config.auth.oidc.redirectUri).toBe("https://env.app/auth/oidc/callback");
    expect(config.auth.oidc.scopes).toEqual(["openid", "email"]);
    expect(config.auth.oidc.session.cookieName).toBe("env_session");
    expect(config.auth.oidc.session.ttlSeconds).toBe(1800);
    expect(config.auth.oidc.tenantClaim).toBeUndefined();
    expect(config.auth.oidc.logoutUrl).toBeUndefined();
    expect(config.auth.oidc.roles).toEqual({
      claim: "roles",
      fallback: [],
      mappings: {},
      tenantMappings: {}
    });
    expect(config.planState.backend).toBe("postgres");
    expect(config.server.rateLimits.plan).toEqual({ windowMs: 60000, maxRequests: 60 });
    expect(config.server.rateLimits.chat).toEqual({ windowMs: 60000, maxRequests: 600 });
    expect(config.server.rateLimits.auth).toEqual({ windowMs: 60000, maxRequests: 120 });
    expect(config.server.sseQuotas).toEqual({ perIp: 7, perSubject: 4 });
    expect(config.retention).toEqual({
      planStateDays: 30,
      planArtifactsDays: 30,
      contentCapture: {
        enabled: false
      }
    });
    expect(config.secrets.backend).toBe("vault");
  });

  it("enables server TLS from environment variables", () => {
    delete process.env.APP_CONFIG;
    process.env.SERVER_TLS_ENABLED = "true";
    process.env.SERVER_TLS_CERT_PATH = "/certs/server.crt";
    process.env.SERVER_TLS_KEY_PATH = "/certs/server.key";
    process.env.SERVER_TLS_CA_PATHS = "/certs/ca.crt,/certs/secondary.crt";
    process.env.SERVER_TLS_REQUEST_CLIENT_CERT = "false";

    const config = loadConfig();

    expect(config.server.tls.enabled).toBe(true);
    expect(config.server.tls.certPath).toBe("/certs/server.crt");
    expect(config.server.tls.keyPath).toBe("/certs/server.key");
    expect(config.server.tls.caPaths).toEqual(["/certs/ca.crt", "/certs/secondary.crt"]);
    expect(config.server.tls.requestClientCert).toBe(false);
  });

  it("configures tracing from environment variables", () => {
    delete process.env.APP_CONFIG;
    process.env.TRACING_ENABLED = "true";
    process.env.TRACING_SERVICE_NAME = "custom-svc";
    process.env.TRACING_ENVIRONMENT = "production";
    process.env.TRACING_OTLP_ENDPOINT = "https://otel.example.com";
    process.env.TRACING_OTLP_HEADERS = "authorization=Bearer abc, x-tenant=demo";
    process.env.TRACING_SAMPLE_RATIO = "0.5";

    const config = loadConfig();

    expect(config.observability.tracing.enabled).toBe(true);
    expect(config.observability.tracing.serviceName).toBe("custom-svc");
    expect(config.observability.tracing.environment).toBe("production");
    expect(config.observability.tracing.exporterEndpoint).toBe("https://otel.example.com/v1/traces");
    expect(config.observability.tracing.exporterHeaders).toEqual({
      authorization: "Bearer abc",
      "x-tenant": "demo"
    });
    expect(config.observability.tracing.sampleRatio).toBeCloseTo(0.5);
  });

  it("prefers MESSAGING_TYPE over MESSAGE_BUS when both are provided", () => {
    delete process.env.APP_CONFIG;
    process.env.MESSAGE_BUS = "rabbitmq";
    process.env.MESSAGING_TYPE = "kafka";

    const config = loadConfig();

    expect(config.messaging.type).toBe("kafka");
  });

  it("falls back to MESSAGE_BUS when MESSAGING_TYPE is unset and warns", () => {
    delete process.env.APP_CONFIG;
    delete process.env.MESSAGING_TYPE;
    process.env.MESSAGE_BUS = "kafka";

    const config = loadConfig();

    expect(config.messaging.type).toBe("kafka");
    expect(warnSpy).toHaveBeenCalledWith("MESSAGE_BUS is deprecated; use MESSAGING_TYPE instead");
  });

  it("merges file configuration with environment overrides using existing precedence", () => {
    const configPath = createTempConfigFile(`
runMode: enterprise
messaging:
  type: kafka
  kafka:
    brokers:
      - kafka-1:9092
      - kafka-2:9092
    clientId: orchestrator
    consumerGroup: plan-workers
    consumeFromBeginning: true
    retryDelayMs: 500
    topics:
      planSteps: plan.steps.custom
      planCompletions: plan.completions.custom
      planEvents: plan.events.custom
      planState: plan.state.custom
      deadLetterSuffix: ".dlq"
    tls:
      enabled: true
      caPaths:
        - /etc/kafka/ca.pem
      certPath: /etc/kafka/client.crt
      keyPath: /etc/kafka/client.key
      rejectUnauthorized: true
    sasl:
      mechanism: plain
      username: kafka-user
      password: kafka-pass
providers:
  defaultRoute: high_quality
  enabled:
    - anthropic
    - google
auth:
  oauth:
    redirectBaseUrl: "https://file.example.com/callback"
  oidc:
    enabled: true
    issuer: https://oidc.example.com
    clientId: yaml-client
    clientSecret: yaml-secret
    redirectBaseUrl: https://app.example.com
    scopes:
      - openid
      - profile
      - email
    tenantClaim: org_id
    audience: api://default
    logoutUrl: https://oidc.example.com/logout
    session:
      cookieName: yaml_session
      ttlSeconds: 14400
secrets:
  backend: vault
`);
    process.env.APP_CONFIG = configPath;
    process.env.RUN_MODE = "consumer";
    process.env.MESSAGE_BUS = "rabbitmq";
    process.env.PROVIDERS = "openai, mistral";
    process.env.OAUTH_REDIRECT_BASE = "https://env.example.com/callback";
    process.env.SECRETS_BACKEND = "localfile";

    const config = loadConfig();

    expect(config.runMode).toBe("enterprise");
    expect(config.messaging.type).toBe("kafka");
    expect(config.providers.defaultRoute).toBe("high_quality");
    expect(config.providers.enabled).toEqual(["openai", "mistral"]);
    expect(config.auth.oauth.redirectBaseUrl).toBe("https://env.example.com/callback");
    expect(config.secrets.backend).toBe("localfile");
    expect(config.providers.rateLimit).toEqual({ windowMs: 60000, maxRequests: 120 });
    expect(config.providers.circuitBreaker).toEqual({ failureThreshold: 5, resetTimeoutMs: 30000 });
    expect(config.server.rateLimits.plan).toEqual({ windowMs: 60000, maxRequests: 60 });
    expect(config.server.rateLimits.chat).toEqual({ windowMs: 60000, maxRequests: 600 });
    expect(config.server.rateLimits.auth).toEqual({ windowMs: 60000, maxRequests: 120 });
    expect(config.observability.tracing).toEqual({
      enabled: false,
      serviceName: "oss-ai-orchestrator",
      environment: "development",
      exporterEndpoint: "http://127.0.0.1:4318/v1/traces",
      exporterHeaders: {},
      sampleRatio: 1
    });
  });
  it("throws when the configuration file cannot be parsed", () => {
    const configPath = createTempConfigFile(`
runMode: consumer
providers:
  enabled: [invalid
`);
    process.env.APP_CONFIG = configPath;

    expect(() => loadConfig()).toThrow(/Failed to parse configuration file/);
  });

  it("ends tracing spans when the configuration root is not an object", () => {
    const configPath = createTempConfigFile(`"invalid-root"`);
    process.env.APP_CONFIG = configPath;

    const spanEnd = vi.fn();
    const otelSpan = {
      spanContext: () => ({ traceId: "trace-id", spanId: "span-id" }),
      setAttribute: vi.fn(),
      addEvent: vi.fn(),
      recordException: vi.fn(),
      setStatus: vi.fn(),
      end: spanEnd
    };
    const tracerStartSpan = vi.fn(() => otelSpan);
    const tracerSpy = vi.spyOn(trace, "getTracer").mockReturnValue({
      startSpan: tracerStartSpan
    } as unknown as Tracer);

    try {
      expect(() => loadConfig()).not.toThrow();
      expect(tracerStartSpan).toHaveBeenCalledTimes(1);
      expect(tracerStartSpan).toHaveBeenCalledWith(
        "config.file.invalid",
        expect.objectContaining({ attributes: { reason: "non_object_root" } })
      );
      expect(spanEnd).toHaveBeenCalledTimes(1);
    } finally {
      tracerSpy.mockRestore();
    }
  });

  it("honors empty providers arrays from file configuration", () => {
    const configPath = createTempConfigFile(`
providers:
  enabled: []
`);
    process.env.APP_CONFIG = configPath;

    const config = loadConfig();

    expect(config.providers.enabled).toEqual([]);
  });

  it("allows disabling providers via PROVIDERS env var", () => {
    delete process.env.APP_CONFIG;
    process.env.PROVIDERS = "";

    const config = loadConfig();

    expect(config.providers.enabled).toEqual([]);
  });

  it("throws when provider rate limits are non-positive", () => {
    const configPath = createTempConfigFile(`
providers:
  rateLimit:
    windowMs: 0
    maxRequests: 10
`);
    process.env.APP_CONFIG = configPath;

    expect(() => loadConfig()).toThrow("providers.rateLimit windowMs must be a positive number");
  });

  it("throws when HTTP rate limits are non-positive", () => {
    const configPath = createTempConfigFile(`
server:
  rateLimits:
    plan:
      windowMs: -1
      maxRequests: 10
    chat:
      windowMs: 1000
      maxRequests: 0
`);
    process.env.APP_CONFIG = configPath;

    expect(() => loadConfig()).toThrow("server.rateLimits.plan windowMs must be a positive number");
  });

  it("throws when the auth rate limit max requests are non-positive", () => {
    const configPath = createTempConfigFile(`
server:
  rateLimits:
    plan:
      windowMs: 1000
      maxRequests: 10
    chat:
      windowMs: 1000
      maxRequests: 10
    auth:
      windowMs: 1000
      maxRequests: 0
`);
    process.env.APP_CONFIG = configPath;

    expect(() => loadConfig()).toThrow("server.rateLimits.auth maxRequests must be a positive number");
  });

  it("throws when OIDC is enabled without a client secret", () => {
    const configPath = createTempConfigFile(`
auth:
  oidc:
    enabled: true
    issuer: https://issuer.example.com
    clientId: example-client
`);
    process.env.APP_CONFIG = configPath;

    expect(() => loadConfig()).toThrow(
      "OIDC client secret must be configured when OIDC authentication is enabled",
    );
  });

  it("accepts minimal positive rate limit values", () => {
    const configPath = createTempConfigFile(`
providers:
  rateLimit:
    windowMs: 1
    maxRequests: 1
server:
  rateLimits:
    plan:
      windowMs: 1
      maxRequests: 1
    chat:
      windowMs: 1
      maxRequests: 1
    auth:
      windowMs: 1
      maxRequests: 1
`);
    process.env.APP_CONFIG = configPath;

    const config = loadConfig();

    expect(config.providers.rateLimit).toEqual({ windowMs: 1, maxRequests: 1 });
    expect(config.server.rateLimits.plan).toEqual({ windowMs: 1, maxRequests: 1 });
    expect(config.server.rateLimits.chat).toEqual({ windowMs: 1, maxRequests: 1 });
    expect(config.server.rateLimits.auth).toEqual({ windowMs: 1, maxRequests: 1 });
  });

  it("defaults to vault secrets in enterprise mode when unspecified", () => {
    const configPath = createTempConfigFile("runMode: enterprise\n");
    process.env.APP_CONFIG = configPath;

    const config = loadConfig();

    expect(config.secrets.backend).toBe("vault");
  });

  it("parses OIDC role configuration from environment variables", () => {
    delete process.env.APP_CONFIG;
    process.env.OIDC_ENABLED = "true";
    process.env.OIDC_ISSUER_URL = "https://roles-issuer.example.com";
    process.env.OIDC_CLIENT_ID = "roles-client";
    process.env.OIDC_CLIENT_SECRET = "roles-secret";
    process.env.OIDC_ROLE_CLAIM = "groups";
    process.env.OIDC_DEFAULT_ROLES = "viewer,editor";
    process.env.OIDC_ROLE_MAPPINGS = JSON.stringify({
      editor: ["repo.write", "test.run"],
      approver: ["plan.approve"]
    });
    process.env.OIDC_TENANT_ROLE_MAPPINGS = JSON.stringify({
      "tenant-a": {
        admin: ["network.egress", "plan.approve"],
        qa: ["test.run"]
      }
    });
    process.env.RETENTION_PLAN_STATE_DAYS = "5";
    process.env.RETENTION_PLAN_ARTIFACT_DAYS = "10";
    process.env.CONTENT_CAPTURE_ENABLED = "true";

    const config = loadConfig();

    expect(config.auth.oidc.roles).toEqual({
      claim: "groups",
      fallback: ["editor", "viewer"],
      mappings: {
        approver: ["plan.approve"],
        editor: ["repo.write", "test.run"]
      },
      tenantMappings: {
        "tenant-a": {
          admin: ["network.egress", "plan.approve"],
          qa: ["test.run"]
        }
      }
    });
    expect(config.retention).toEqual({
      planStateDays: 5,
      planArtifactsDays: 10,
      contentCapture: {
        enabled: true
      }
    });

    delete process.env.OIDC_ROLE_CLAIM;
    delete process.env.OIDC_DEFAULT_ROLES;
    delete process.env.OIDC_ROLE_MAPPINGS;
    delete process.env.OIDC_TENANT_ROLE_MAPPINGS;
    delete process.env.OIDC_ENABLED;
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    delete process.env.RETENTION_PLAN_STATE_DAYS;
    delete process.env.RETENTION_PLAN_ARTIFACT_DAYS;
    delete process.env.CONTENT_CAPTURE_ENABLED;
  });
});
