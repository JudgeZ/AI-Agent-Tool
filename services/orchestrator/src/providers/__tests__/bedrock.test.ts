import { describe, it, expect, vi, afterEach } from "vitest";

import type { SecretsStore } from "../../auth/SecretsStore.js";
import { BedrockProvider } from "../bedrock.js";

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

describe("BedrockProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createProvider(invokeModel: ReturnType<typeof vi.fn>, retryAttempts = 2) {
    const secrets = new StubSecretsStore({
      "provider:bedrock:accessKeyId": "AKIA",
      "provider:bedrock:secretAccessKey": "SECRET"
    });
    const clientFactory = vi.fn().mockResolvedValue({ invokeModel });
    const provider = new BedrockProvider(secrets, {
      clientFactory,
      retryAttempts,
      defaultModel: "anthropic.test",
      maxTokens: 256,
      region: "us-west-2"
    });
    return { provider, clientFactory };
  }

  it("parses the response body, aggregates text, and maps usage values", async () => {
    const payload = {
      output: { content: [{ text: "Hello" }, { text: " world" }] },
      usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 }
    };
    const invokeModel = vi.fn().mockResolvedValue({
      body: Buffer.from(JSON.stringify(payload), "utf-8")
    });
    const { provider, clientFactory } = createProvider(invokeModel);

    const response = await provider.chat({
      messages: [
        { role: "system", content: "be polite" },
        { role: "user", content: "hello" }
      ]
    });

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(invokeModel).toHaveBeenCalledWith({
      modelId: "anthropic.test",
      contentType: "application/json",
      accept: "application/json",
      body: expect.any(Buffer)
    });
    expect(response).toEqual({
      output: "Hello world",
      provider: "bedrock",
      usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 }
    });
  });

  it("retries once for retryable service errors", async () => {
    const retryable = {
      $metadata: { httpStatusCode: 503 },
      code: "ServiceUnavailableException",
      message: "down"
    };
    const invokeModel = vi
      .fn()
      .mockRejectedValueOnce(retryable)
      .mockResolvedValueOnce({
        body: Buffer.from(JSON.stringify({ outputText: "ok" }), "utf-8")
      });
    const { provider } = createProvider(invokeModel);

    const response = await provider.chat({ messages: [{ role: "user", content: "ping" }] });

    expect(invokeModel).toHaveBeenCalledTimes(2);
    expect(response.output).toBe("ok");
  });

  it("does not retry non-retryable validation errors", async () => {
    const validationError = {
      $metadata: { httpStatusCode: 400 },
      code: "ValidationException",
      message: "bad"
    };
    const invokeModel = vi.fn().mockRejectedValue(validationError);
    const { provider } = createProvider(invokeModel);

    await expect(
      provider.chat({ messages: [{ role: "user", content: "ping" }] })
    ).rejects.toMatchObject({
      message: "bad",
      status: 400,
      code: "ValidationException",
      provider: "bedrock",
      retryable: false
    });
    expect(invokeModel).toHaveBeenCalledTimes(1);
  });
});
