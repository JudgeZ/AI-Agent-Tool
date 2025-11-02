import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";

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
    process.env.PROVIDERS = originalProvidersEnv;
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
});
