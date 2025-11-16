import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";

vi.mock("../network/EgressGuard.js", () => ({
  ensureEgressAllowed: vi.fn()
}));

import type { SecretsStore } from "../auth/SecretsStore.js";
import type { ChatResponse, ModelProvider } from "./interfaces.js";
import { OpenAIProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";
import {
  __resetProviderResilienceForTests,
  clearProviderOverrides,
  routeChat,
  setProviderOverride
} from "./ProviderRegistry.js";
import { ProviderError } from "./utils.js";
import { appLogger } from "../observability/logger.js";
import * as tracing from "../observability/tracing.js";
import * as config from "../config.js";

class MockSecretsStore implements SecretsStore {
  constructor(private readonly values: Record<string, string> = {}) {}
  async get(key: string) {
    return this.values[key];
  }
  async set(key: string, value: string) {
    this.values[key] = value;
  }
  async delete(key: string) {
    delete this.values[key];
  }
}

describe("providers", () => {
  const originalProvidersEnv = process.env.PROVIDERS;
  const originalPassphrase = process.env.LOCAL_SECRETS_PASSPHRASE;

  beforeAll(() => {
    process.env.LOCAL_SECRETS_PASSPHRASE = process.env.LOCAL_SECRETS_PASSPHRASE || "test-passphrase";
  });

  afterAll(() => {
    if (originalPassphrase === undefined) {
      delete process.env.LOCAL_SECRETS_PASSPHRASE;
    } else {
      process.env.LOCAL_SECRETS_PASSPHRASE = originalPassphrase;
    }
  });

  afterEach(() => {
    clearProviderOverrides();
    __resetProviderResilienceForTests();
    config.invalidateConfigCache();
    if (originalProvidersEnv === undefined) {
      delete process.env.PROVIDERS;
    } else {
      process.env.PROVIDERS = originalProvidersEnv;
    }
    vi.restoreAllMocks();
  });

  it("retries transient OpenAI failures and returns usage", async () => {
    const secrets = new MockSecretsStore({ "provider:openai:apiKey": "sk-test" });
    const create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce({
        choices: [{ message: { content: "Hello world" } }],
        usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 }
      });
    const clientFactory = vi.fn().mockResolvedValue({
      chat: { completions: { create } }
    });
    const provider = new OpenAIProvider(secrets, {
      clientFactory,
      retryAttempts: 3,
      defaultModel: "gpt-test"
    });

    const response = await provider.chat({
      model: "gpt-test",
      messages: [
        { role: "system", content: "respond cheerfully" },
        { role: "user", content: "hi" }
      ]
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(response.output).toBe("Hello world");
    expect(response.provider).toBe("openai");
    expect(response.usage).toEqual({ promptTokens: 7, completionTokens: 11, totalTokens: 18 });
  });

  it("falls back to the next provider and surfaces warnings", async () => {
    process.env.PROVIDERS = "openai,mistral";

    const failingProvider: ModelProvider = {
      name: "openai",
      async chat(): Promise<ChatResponse> {
        throw new ProviderError("missing API key", { status: 401, provider: "openai", retryable: false });
      }
    };

    const succeedingProvider: ModelProvider = {
      name: "mistral",
      async chat(): Promise<ChatResponse> {
        return { output: "ok", provider: "mistral", usage: { promptTokens: 1 } };
      }
    };

    const failSpy = vi.spyOn(failingProvider, "chat");
    const succeedSpy = vi.spyOn(succeedingProvider, "chat");

    setProviderOverride("openai", failingProvider);
    setProviderOverride("mistral", succeedingProvider);

    const response = await routeChat({
      messages: [{ role: "user", content: "ping" }]
    });

    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(succeedSpy).toHaveBeenCalledTimes(1);
    expect(response.output).toBe("ok");
    expect(response.provider).toBe("mistral");
    expect(response.warnings).toContain("openai: missing API key");
  });

  it("aggregates provider errors when no provider succeeds", async () => {
    process.env.PROVIDERS = "openai";

    const failingProvider: ModelProvider = {
      name: "openai",
      async chat(): Promise<ChatResponse> {
        throw new ProviderError("auth failed", { status: 401, provider: "openai", retryable: false });
      }
    };

    setProviderOverride("openai", failingProvider);

    await expect(
      routeChat({ messages: [{ role: "user", content: "ping" }] })
    ).rejects.toMatchObject({
      status: 401,
      provider: "router"
    });
  });

  it("surfaces Ollama HTTP errors with helpful messages", async () => {
    const secrets = new MockSecretsStore();
    const json = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 503, json });
    const provider = new OllamaProvider(secrets, { fetch });

    await expect(
      provider.chat({
        messages: [
          { role: "system", content: "respond" },
          { role: "user", content: "ping" }
        ]
      })
    ).rejects.toMatchObject({ message: expect.stringContaining("503"), provider: "local_ollama" });
  });

  it("reorders providers based on routing hints", async () => {
    const baseConfig = config.loadConfig();
    const loadConfigSpy = vi.spyOn(config, "loadConfig").mockReturnValue({
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        enabled: ["openai", "local_ollama"],
        defaultRoute: "balanced"
      }
    });
    const callOrder: string[] = [];
    const lowCostProvider: ModelProvider = {
      name: "local_ollama",
      async chat() {
        callOrder.push("local_ollama");
        throw new ProviderError("offline", { status: 503, provider: "local_ollama", retryable: false });
      }
    };
    const premiumProvider: ModelProvider = {
      name: "openai",
      async chat() {
        callOrder.push("openai");
        return { output: "fallback", provider: "openai" };
      }
    };
    setProviderOverride("local_ollama", lowCostProvider);
    setProviderOverride("openai", premiumProvider);

    const response = await routeChat({
      routing: "low_cost",
      messages: [{ role: "user", content: "ping" }]
    });

    expect(callOrder).toEqual(["local_ollama", "openai"]);
    expect(response.provider).toBe("openai");
    expect(response.warnings).toContain("local_ollama: offline");
    loadConfigSpy.mockRestore();
  });

  it("respects custom balanced routing priority overrides", async () => {
    const baseConfig = config.loadConfig();
    const loadConfigSpy = vi.spyOn(config, "loadConfig").mockReturnValue({
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        enabled: ["openai", "mistral"],
        routingPriority: {
          ...baseConfig.providers.routingPriority,
          balanced: ["mistral", "openai"],
        },
      },
    });
    const callOrder: string[] = [];
    const firstProvider: ModelProvider = {
      name: "mistral",
      async chat() {
        callOrder.push("mistral");
        throw new ProviderError("offline", { status: 503, provider: "mistral", retryable: false });
      },
    };
    const secondProvider: ModelProvider = {
      name: "openai",
      async chat() {
        callOrder.push("openai");
        return { output: "ok", provider: "openai" };
      },
    };
    setProviderOverride("mistral", firstProvider);
    setProviderOverride("openai", secondProvider);

    const response = await routeChat({ messages: [{ role: "user", content: "ping" }] });

    expect(callOrder).toEqual(["mistral", "openai"]);
    expect(response.provider).toBe("openai");
    expect(response.warnings).toContain("mistral: offline");
    loadConfigSpy.mockRestore();
  });

  it("applies provider default temperatures from configuration when not specified", async () => {
    const baseConfig = config.loadConfig();
    const loadConfigSpy = vi.spyOn(config, "loadConfig").mockReturnValue({
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        enabled: ["openai"],
        settings: {
          ...baseConfig.providers.settings,
          openai: {
            ...(baseConfig.providers.settings.openai ?? {}),
            defaultTemperature: 0.55,
          },
        },
      },
    });
    const provider: ModelProvider = {
      name: "openai",
      chat: vi.fn(async request => {
        expect(request.temperature).toBeCloseTo(0.55);
        return { output: "ok", provider: "openai" };
      }),
    };
    setProviderOverride("openai", provider);

    const response = await routeChat({ messages: [{ role: "user", content: "ping" }] });

    expect(provider.chat).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.55, messages: expect.any(Array) }),
    );
    expect(response.provider).toBe("openai");
    loadConfigSpy.mockRestore();
  });

  it("honors explicit provider selections and rejects unknown providers", async () => {
    process.env.PROVIDERS = "openai,mistral";
    const openaiProvider: ModelProvider = {
      name: "openai",
      async chat() {
        throw new ProviderError("should not run", { status: 500, provider: "openai", retryable: false });
      }
    };
    const mistralProvider: ModelProvider = {
      name: "mistral",
      async chat() {
        return { output: "direct", provider: "mistral" };
      }
    };
    setProviderOverride("openai", openaiProvider);
    setProviderOverride("mistral", mistralProvider);

    const response = await routeChat({
      provider: "mistral",
      messages: [{ role: "user", content: "hi" }]
    });

    expect(response.provider).toBe("mistral");

    await expect(
      routeChat({ provider: "azureopenai", messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({ status: 404, provider: "router" });
  });

  it("treats provider hints case-insensitively", async () => {
    process.env.PROVIDERS = "openai";
    const provider: ModelProvider = {
      name: "openai",
      chat: vi.fn(async () => ({ output: "direct", provider: "openai" })),
    };
    setProviderOverride("openai", provider);

    const response = await routeChat({
      provider: "OPENAI",
      messages: [{ role: "user", content: "hi" }]
    });

    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(response.provider).toBe("openai");
  });

  it("warns when a provider ignores the requested temperature", async () => {
    process.env.PROVIDERS = "anthropic";
    const provider: ModelProvider = {
      name: "anthropic",
      async chat(request) {
        expect(request.temperature).toBeUndefined();
        return { output: "ok", provider: "anthropic" };
      }
    };
    setProviderOverride("anthropic", provider);

    const response = await routeChat({
      temperature: 0.65,
      messages: [{ role: "user", content: "ping" }]
    });

    expect(response.provider).toBe("anthropic");
    expect(response.warnings).toContain("anthropic: temperature is not supported and was ignored");
  });

  it("rejects whitespace-only provider hints", async () => {
    process.env.PROVIDERS = "openai";

    await expect(
      routeChat({ provider: "   ", messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({ status: 400, provider: "router" });
  });

  it("fails fast when configuration lists invalid provider names", async () => {
    const baseConfig = config.loadConfig();
    const loadConfigSpy = vi.spyOn(config, "loadConfig").mockReturnValue({
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        enabled: ["openai", "invalid provider name"],
      },
    });

    await expect(routeChat({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      status: 500,
      provider: "router",
      message: expect.stringContaining("Configured provider name"),
    });

    loadConfigSpy.mockRestore();
  });

  it("emits tracing spans and structured logs for provider failures", async () => {
    process.env.PROVIDERS = "openai";
    const failingProvider: ModelProvider = {
      name: "openai",
      async chat() {
        throw new ProviderError("boom", { status: 500, provider: "openai", retryable: false });
      }
    };
    setProviderOverride("openai", failingProvider);

    const loggerMock = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis()
    };
    const loggerSpy = vi.spyOn(appLogger, "child").mockReturnValue(loggerMock as any);

    const spanSpy = vi.spyOn(tracing, "withSpan").mockImplementation(
      async (name, fn, attrs) => {
        const fakeSpan = {
          name,
          attributes: attrs ?? {},
          setAttribute: vi.fn(),
          addEvent: vi.fn(),
          recordException: vi.fn(),
          end: vi.fn(),
          context: { traceId: "trace", spanId: "span" }
        } as any;
        try {
          return await fn(fakeSpan);
        } catch (error) {
          fakeSpan.recordException(error as Error);
          throw error;
        } finally {
          fakeSpan.end();
        }
      }
    );

    await expect(routeChat({ messages: [{ role: "user", content: "hi" }] })).rejects.toBeInstanceOf(ProviderError);

    expect(loggerSpy).toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "provider_attempt.failure", provider: "openai" }),
      expect.stringContaining("boom")
    );
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "provider_routing.failed" }),
      expect.any(String)
    );
    expect(spanSpy).toHaveBeenCalledWith(
      "providers.routeChat",
      expect.any(Function),
      expect.objectContaining({ routing_hint: "balanced", provider_hint: "auto" })
    );
    expect(spanSpy).toHaveBeenCalledWith(
      "providers.routeChat.attempt",
      expect.any(Function),
      expect.objectContaining({ provider: "openai", routing: "balanced" })
    );
  });
});
