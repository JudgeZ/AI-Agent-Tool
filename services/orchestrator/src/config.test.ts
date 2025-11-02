import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { __resetLegacyMessagingWarningForTests, loadConfig } from "./config.js";

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
  "ORCHESTRATOR_TLS_SERVER_NAME"
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
    warnSpy = vi.spyOn(console, "warn");
    warnSpy.mockImplementation(() => {});
  });

  afterEach(() => {
    tempDirs.splice(0).forEach(dir => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    restoreEnv();
    warnSpy.mockRestore();
  });

  it("loads configuration values from a YAML file", () => {
    const configPath = createTempConfigFile(`
runMode: enterprise
messaging:
  type: kafka
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
    expect(config.providers.defaultRoute).toBe("high_quality");
    expect(config.providers.enabled).toEqual(["anthropic", "openai"]);
    expect(config.providers.rateLimit).toEqual({ windowMs: 30000, maxRequests: 50 });
    expect(config.providers.circuitBreaker).toEqual({ failureThreshold: 7, resetTimeoutMs: 45000 });
    expect(config.auth.oauth.redirectBaseUrl).toBe("https://example.com/callback");
    expect(config.secrets.backend).toBe("vault");
    expect(config.server.sseKeepAliveMs).toBe(10000);
    expect(config.server.rateLimits.plan).toEqual({ windowMs: 120000, maxRequests: 20 });
    expect(config.server.rateLimits.chat).toEqual({ windowMs: 30000, maxRequests: 200 });
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
  });

  it("derives configuration from environment variables when file values are absent", () => {
    delete process.env.APP_CONFIG;
    process.env.RUN_MODE = "enterprise";
    process.env.MESSAGE_BUS = "kafka";
    process.env.PROVIDERS = "anthropic, openai";
    process.env.OAUTH_REDIRECT_BASE = "https://env.example.com/callback";
    process.env.SECRETS_BACKEND = "vault";

    const config = loadConfig();

    expect(config.runMode).toBe("enterprise");
    expect(config.messaging.type).toBe("kafka");
    expect(config.providers.defaultRoute).toBe("balanced");
    expect(config.providers.enabled).toEqual(["anthropic", "openai"]);
    expect(config.auth.oauth.redirectBaseUrl).toBe("https://env.example.com/callback");
    expect(config.secrets.backend).toBe("vault");
    expect(config.providers.rateLimit).toEqual({ windowMs: 60000, maxRequests: 120 });
    expect(config.providers.circuitBreaker).toEqual({ failureThreshold: 5, resetTimeoutMs: 30000 });
    expect(config.server.rateLimits.plan).toEqual({ windowMs: 60000, maxRequests: 60 });
    expect(config.server.rateLimits.chat).toEqual({ windowMs: 60000, maxRequests: 600 });
    expect(config.server.tls.enabled).toBe(false);
    expect(config.server.tls.caPaths).toEqual([]);
    expect(config.observability.tracing).toEqual({
      enabled: false,
      serviceName: "oss-ai-orchestrator",
      environment: "development",
      exporterEndpoint: "http://127.0.0.1:4318/v1/traces",
      exporterHeaders: {},
      sampleRatio: 1
    });
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
providers:
  defaultRoute: high_quality
  enabled:
    - anthropic
    - google
auth:
  oauth:
    redirectBaseUrl: "https://file.example.com/callback"
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

  it("defaults to vault secrets in enterprise mode when unspecified", () => {
    const configPath = createTempConfigFile("runMode: enterprise\n");
    process.env.APP_CONFIG = configPath;

    const config = loadConfig();

    expect(config.secrets.backend).toBe("vault");
  });
});
