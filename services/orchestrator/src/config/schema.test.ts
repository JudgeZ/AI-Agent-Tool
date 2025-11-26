import { describe, it, expect } from "vitest";
import {
  validateConfig,
  validateConfigSafe,
  getDefaultConfig,
  mergeWithDefaults,
  OrchestratorConfigSchema,
  RateLimitBackendConfigSchema,
  ServerConfigSchema,
  TlsConfigSchema,
  KafkaMessagingConfigSchema,
  SessionStoreConfigSchema,
  DynamicPlannerConfigSchema,
  NetworkEgressConfigSchema,
  PolicyCacheConfigSchema,
} from "./schema.js";

describe("Configuration Schema", () => {
  describe("OrchestratorConfigSchema", () => {
    it("accepts empty config with all defaults", () => {
      const result = OrchestratorConfigSchema.parse({});
      expect(result.server).toBeDefined();
      expect(result.database).toBeDefined();
      expect(result.messaging).toBeDefined();
      expect(result.network).toBeDefined();
      expect(result.policy).toBeDefined();
      expect(result.observability).toBeDefined();
      expect(result.planner).toBeDefined();
    });

    it("applies default values correctly", () => {
      const result = OrchestratorConfigSchema.parse({});
      expect(result.server.port).toBe(4000);
      expect(result.server.host).toBe("0.0.0.0");
      expect(result.planner.mode).toBe("static");
      expect(result.messaging.provider).toBe("memory");
    });

    it("accepts partial configuration", () => {
      const result = OrchestratorConfigSchema.parse({
        server: { port: 8080 },
        planner: { mode: "dynamic" },
      });
      expect(result.server.port).toBe(8080);
      expect(result.server.host).toBe("0.0.0.0"); // default
      expect(result.planner.mode).toBe("dynamic");
    });
  });

  describe("RateLimitBackendConfigSchema", () => {
    it("accepts memory provider without redisUrl", () => {
      const result = RateLimitBackendConfigSchema.parse({
        provider: "memory",
      });
      expect(result.provider).toBe("memory");
    });

    it("requires redisUrl for redis provider", () => {
      expect(() =>
        RateLimitBackendConfigSchema.parse({
          provider: "redis",
        })
      ).toThrow("redisUrl is required when provider is 'redis'");
    });

    it("accepts redis provider with redisUrl", () => {
      const result = RateLimitBackendConfigSchema.parse({
        provider: "redis",
        redisUrl: "redis://localhost:6379",
      });
      expect(result.provider).toBe("redis");
      expect(result.redisUrl).toBe("redis://localhost:6379");
    });
  });

  describe("ServerConfigSchema", () => {
    it("applies default port and host", () => {
      const result = ServerConfigSchema.parse({});
      expect(result.port).toBe(4000);
      expect(result.host).toBe("0.0.0.0");
    });

    it("rejects invalid port numbers", () => {
      expect(() => ServerConfigSchema.parse({ port: 0 })).toThrow();
      expect(() => ServerConfigSchema.parse({ port: 70000 })).toThrow();
    });

    it("accepts valid port numbers", () => {
      const result = ServerConfigSchema.parse({ port: 8080 });
      expect(result.port).toBe(8080);
    });

    it("includes default security headers", () => {
      const result = ServerConfigSchema.parse({});
      expect(result.securityHeaders.xFrameOptions.enabled).toBe(true);
      expect(result.securityHeaders.xFrameOptions.value).toBe("DENY");
      expect(result.securityHeaders.xContentTypeOptions.value).toBe("nosniff");
    });
  });

  describe("TlsConfigSchema", () => {
    it("defaults to TLS disabled", () => {
      const result = TlsConfigSchema.parse({});
      expect(result.enabled).toBe(false);
    });

    it("requires keyPath and certPath when enabled", () => {
      expect(() =>
        TlsConfigSchema.parse({ enabled: true })
      ).toThrow("keyPath and certPath are required when TLS is enabled");
    });

    it("accepts enabled TLS with paths", () => {
      const result = TlsConfigSchema.parse({
        enabled: true,
        keyPath: "/path/to/key.pem",
        certPath: "/path/to/cert.pem",
      });
      expect(result.enabled).toBe(true);
      expect(result.keyPath).toBe("/path/to/key.pem");
      expect(result.certPath).toBe("/path/to/cert.pem");
    });
  });

  describe("KafkaMessagingConfigSchema", () => {
    it("requires at least one broker", () => {
      expect(() =>
        KafkaMessagingConfigSchema.parse({ brokers: [] })
      ).toThrow();
    });

    it("accepts valid Kafka config", () => {
      const result = KafkaMessagingConfigSchema.parse({
        brokers: ["localhost:9092"],
      });
      expect(result.brokers).toEqual(["localhost:9092"]);
      expect(result.clientId).toBe("orchestrator");
      expect(result.consumerGroup).toBe("orchestrator-group");
    });

    it("applies default topic names", () => {
      const result = KafkaMessagingConfigSchema.parse({
        brokers: ["localhost:9092"],
      });
      expect(result.topics.planSteps).toBe("plan-steps");
      expect(result.topics.planCompletions).toBe("plan-completions");
      expect(result.topics.deadLetterSuffix).toBe("-dlq");
    });

    it("accepts SASL configuration", () => {
      const result = KafkaMessagingConfigSchema.parse({
        brokers: ["localhost:9092"],
        sasl: {
          mechanism: "scram-sha-256",
          username: "user",
          password: "pass",
        },
      });
      expect(result.sasl?.mechanism).toBe("scram-sha-256");
      expect(result.sasl?.username).toBe("user");
    });
  });

  describe("SessionStoreConfigSchema", () => {
    it("defaults to memory provider", () => {
      const result = SessionStoreConfigSchema.parse({});
      expect(result.provider).toBe("memory");
    });

    it("requires redisUrl for redis provider", () => {
      expect(() =>
        SessionStoreConfigSchema.parse({ provider: "redis" })
      ).toThrow("redisUrl is required when provider is 'redis'");
    });

    it("accepts redis with URL", () => {
      const result = SessionStoreConfigSchema.parse({
        provider: "redis",
        redisUrl: "redis://localhost:6379",
      });
      expect(result.provider).toBe("redis");
      expect(result.redisUrl).toBe("redis://localhost:6379");
    });

    it("applies default TTL and prefix", () => {
      const result = SessionStoreConfigSchema.parse({});
      expect(result.ttlSeconds).toBe(3600);
      expect(result.keyPrefix).toBe("session:");
    });
  });

  describe("DynamicPlannerConfigSchema", () => {
    it("defaults to static mode", () => {
      const result = DynamicPlannerConfigSchema.parse({});
      expect(result.mode).toBe("static");
    });

    it("accepts all planner modes", () => {
      for (const mode of ["static", "dynamic", "hybrid"]) {
        const result = DynamicPlannerConfigSchema.parse({ mode });
        expect(result.mode).toBe(mode);
      }
    });

    it("applies default plans directory", () => {
      const result = DynamicPlannerConfigSchema.parse({});
      expect(result.plansDirectory).toBe("config/plans");
    });

    it("defaults watchForChanges to false", () => {
      const result = DynamicPlannerConfigSchema.parse({});
      expect(result.watchForChanges).toBe(false);
    });

    it("applies default concurrency limit", () => {
      const result = DynamicPlannerConfigSchema.parse({});
      expect(result.defaultConcurrencyLimit).toBe(10);
    });

    it("validates concurrency limit range", () => {
      expect(() =>
        DynamicPlannerConfigSchema.parse({ defaultConcurrencyLimit: 0 })
      ).toThrow();
      expect(() =>
        DynamicPlannerConfigSchema.parse({ defaultConcurrencyLimit: 100 })
      ).toThrow();

      const result = DynamicPlannerConfigSchema.parse({
        defaultConcurrencyLimit: 25,
      });
      expect(result.defaultConcurrencyLimit).toBe(25);
    });
  });

  describe("NetworkEgressConfigSchema", () => {
    it("defaults to allow mode", () => {
      const result = NetworkEgressConfigSchema.parse({});
      expect(result.mode).toBe("allow");
    });

    it("accepts all egress modes", () => {
      for (const mode of ["enforce", "report-only", "allow"]) {
        const result = NetworkEgressConfigSchema.parse({ mode });
        expect(result.mode).toBe(mode);
      }
    });

    it("defaults allow list to empty", () => {
      const result = NetworkEgressConfigSchema.parse({});
      expect(result.allow).toEqual([]);
    });

    it("accepts allow list", () => {
      const result = NetworkEgressConfigSchema.parse({
        mode: "enforce",
        allow: ["api.example.com", "*.github.com"],
      });
      expect(result.allow).toEqual(["api.example.com", "*.github.com"]);
    });
  });

  describe("PolicyCacheConfigSchema", () => {
    it("defaults to enabled with memory provider", () => {
      const result = PolicyCacheConfigSchema.parse({});
      expect(result.enabled).toBe(true);
      expect(result.provider).toBe("memory");
    });

    it("applies default TTL and max entries", () => {
      const result = PolicyCacheConfigSchema.parse({});
      expect(result.ttlSeconds).toBe(300);
      expect(result.maxEntries).toBe(10000);
    });

    it("accepts redis provider with config", () => {
      const result = PolicyCacheConfigSchema.parse({
        provider: "redis",
        redis: {
          url: "redis://localhost:6379",
          keyPrefix: "custom:",
        },
      });
      expect(result.provider).toBe("redis");
      expect(result.redis?.url).toBe("redis://localhost:6379");
      expect(result.redis?.keyPrefix).toBe("custom:");
    });
  });

  describe("validateConfig", () => {
    it("validates and returns typed config", () => {
      const result = validateConfig({
        server: { port: 3000 },
      });
      expect(result.server.port).toBe(3000);
    });

    it("throws on invalid config", () => {
      expect(() =>
        validateConfig({
          server: { port: "invalid" },
        })
      ).toThrow();
    });
  });

  describe("validateConfigSafe", () => {
    it("returns config on valid input", () => {
      const result = validateConfigSafe({
        server: { port: 3000 },
      });
      expect(result).toBeDefined();
      expect(result?.server.port).toBe(3000);
    });

    it("returns undefined on invalid input", () => {
      const result = validateConfigSafe({
        server: { port: "invalid" },
      });
      expect(result).toBeUndefined();
    });
  });

  describe("getDefaultConfig", () => {
    it("returns complete config with all defaults", () => {
      const result = getDefaultConfig();
      expect(result.server.port).toBe(4000);
      expect(result.planner.mode).toBe("static");
      expect(result.messaging.provider).toBe("memory");
    });
  });

  describe("mergeWithDefaults", () => {
    it("merges partial config with defaults", () => {
      const result = mergeWithDefaults({
        server: { port: 8080 },
      });
      expect(result.server.port).toBe(8080);
      expect(result.server.host).toBe("0.0.0.0");
      expect(result.planner.mode).toBe("static");
    });
  });
});
