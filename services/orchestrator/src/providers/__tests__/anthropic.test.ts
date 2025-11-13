import { describe, it, expect, vi, afterEach } from "vitest";

import type { SecretsStore } from "../../auth/SecretsStore.js";
import { AnthropicProvider } from "../anthropic.js";
import { ProviderError } from "../utils.js";

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

describe("AnthropicProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createProvider(createImpl: ReturnType<typeof vi.fn>, retryAttempts = 2) {
    const secrets = new StubSecretsStore({ "provider:anthropic:apiKey": "sk-ant" });
    const clientFactory = vi.fn().mockResolvedValue({ messages: { create: createImpl } });
    const provider = new AnthropicProvider(secrets, { clientFactory, retryAttempts, defaultModel: "claude-3" });
    return { provider, clientFactory };
  }

  it("returns a chat response with coalesced text and usage mapping", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
        { type: "tool_use", text: "ignored" }
      ],
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 }
    });
    const { provider, clientFactory } = createProvider(create);

    const response = await provider.chat({
      messages: [
        { role: "system", content: "be nice" },
        { role: "user", content: "hi" }
      ]
    });

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      model: "claude-3",
      system: "be nice",
      max_tokens: 1024,
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] }
      ]
    });
    expect(response).toEqual({
      output: "Hello world",
      provider: "anthropic",
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 }
    });
  });

  it("retries once on retryable errors and eventually succeeds", async () => {
    const retryableError = { status: 429, code: "rate_limit", message: "retry me" };
    const create = vi
      .fn()
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "ok" }],
        usage: undefined
      });
    const { provider } = createProvider(create);

    const result = await provider.chat({
      messages: [{ role: "user", content: "hello" }]
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.output).toBe("ok");
    expect(result.usage).toBeUndefined();
  });

  it("propagates normalized errors without retrying non-retryable ones", async () => {
    const nonRetryableError = { status: 400, code: "invalid_request", message: "bad" };
    const create = vi.fn().mockRejectedValue(nonRetryableError);
    const { provider } = createProvider(create);

    await expect(
      provider.chat({ messages: [{ role: "user", content: "hello" }] })
    ).rejects.toMatchObject({
      message: "bad",
      status: 400,
      code: "invalid_request",
      provider: "anthropic",
      retryable: false
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("preserves ProviderError instances thrown by the client", async () => {
    const wrapped = new ProviderError("anthropic failed", { status: 503, provider: "anthropic", retryable: true });
    const create = vi.fn().mockRejectedValue(wrapped);
    const { provider } = createProvider(create, 1);

    await expect(
      provider.chat({ messages: [{ role: "user", content: "ping" }] })
    ).rejects.toBe(wrapped);
  });

  it("recreates the client when the API key rotates", async () => {
    const secrets = new StubSecretsStore({ "provider:anthropic:apiKey": "sk-ant" });
    const firstCreate = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "first" }] });
    const secondCreate = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "second" }] });
    const firstClient = { messages: { create: firstCreate }, close: vi.fn() };
    const secondClient = { messages: { create: secondCreate } };
    const clientFactory = vi
      .fn()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const provider = new AnthropicProvider(secrets, { clientFactory, defaultModel: "claude" });

    const firstResponse = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(firstResponse.output).toBe("first");

    await secrets.set("provider:anthropic:apiKey", "sk-ant-2");

    const secondResponse = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(secondResponse.output).toBe("second");

    await Promise.resolve();

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenNthCalledWith(1, { apiKey: "sk-ant" });
    expect(clientFactory).toHaveBeenNthCalledWith(2, { apiKey: "sk-ant-2" });
    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(firstCreate).toHaveBeenCalledTimes(1);
    expect(secondCreate).toHaveBeenCalledTimes(1);
  });
});
