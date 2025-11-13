import { describe, it, expect, vi, afterEach } from "vitest";

import type { SecretsStore } from "../../auth/SecretsStore.js";
import { AzureOpenAIProvider } from "../azureOpenAI.js";

class StubSecretsStore implements SecretsStore {
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

describe("AzureOpenAIProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createProvider(getChatCompletions: ReturnType<typeof vi.fn>) {
    const secrets = new StubSecretsStore({
      "provider:azureopenai:apiKey": "sk-az",
      "provider:azureopenai:endpoint": "https://example.openai.azure.com"
    });
    const clientFactory = vi.fn().mockResolvedValue({ getChatCompletions });
    const provider = new AzureOpenAIProvider(secrets, {
      clientFactory,
      retryAttempts: 2,
      defaultDeployment: "my-deployment"
    });
    return { provider, clientFactory };
  }

  it("returns a chat response with usage mapping", async () => {
    const getChatCompletions = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "Hello world" } }],
      usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 }
    });
    const { provider, clientFactory } = createProvider(getChatCompletions);

    const response = await provider.chat({
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "hi" }
      ]
    });

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(getChatCompletions).toHaveBeenCalledWith("my-deployment", [
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" }
    ], { temperature: 0.2 });
    expect(response).toEqual({
      output: "Hello world",
      provider: "azureopenai",
      usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 }
    });
  });

  it("retries on retryable errors returned by the client", async () => {
    const retryableError = { statusCode: 429, message: "too many" };
    const getChatCompletions = vi
      .fn()
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] });
    const { provider } = createProvider(getChatCompletions);

    const result = await provider.chat({ messages: [{ role: "user", content: "hi" }] });

    expect(getChatCompletions).toHaveBeenCalledTimes(2);
    expect(result.output).toBe("ok");
    expect(result.usage).toBeUndefined();
  });

  it("does not retry non-retryable errors and exposes normalized details", async () => {
    const nonRetryable = { statusCode: 400, code: "BadRequest", message: "bad" };
    const getChatCompletions = vi.fn().mockRejectedValue(nonRetryable);
    const { provider } = createProvider(getChatCompletions);

    await expect(
      provider.chat({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({
      message: "bad",
      status: 400,
      code: "BadRequest",
      provider: "azureopenai",
      retryable: false
    });
    expect(getChatCompletions).toHaveBeenCalledTimes(1);
  });

  it("recreates the client when credentials change", async () => {
    const secrets = new StubSecretsStore({
      "provider:azureopenai:apiKey": "sk-old",
      "provider:azureopenai:endpoint": "https://first.example.com"
    });
    const firstCall = vi.fn().mockResolvedValue({ choices: [{ message: { content: "first" } }] });
    const secondCall = vi.fn().mockResolvedValue({ choices: [{ message: { content: "second" } }] });
    const firstClient = { getChatCompletions: firstCall, close: vi.fn() };
    const secondClient = { getChatCompletions: secondCall };
    const clientFactory = vi
      .fn()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const provider = new AzureOpenAIProvider(secrets, {
      clientFactory,
      defaultDeployment: "dep",
      retryAttempts: 1
    });

    const firstResponse = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(firstResponse.output).toBe("first");

    await secrets.set("provider:azureopenai:apiKey", "sk-new");
    await secrets.set("provider:azureopenai:endpoint", "https://second.example.com");

    const secondResponse = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(secondResponse.output).toBe("second");

    await Promise.resolve();

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenNthCalledWith(1, {
      apiKey: "sk-old",
      endpoint: "https://first.example.com",
      apiVersion: undefined
    });
    expect(clientFactory).toHaveBeenNthCalledWith(2, {
      apiKey: "sk-new",
      endpoint: "https://second.example.com",
      apiVersion: undefined
    });
    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(firstCall).toHaveBeenCalledTimes(1);
    expect(secondCall).toHaveBeenCalledTimes(1);
  });
});
