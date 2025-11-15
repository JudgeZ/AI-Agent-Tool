import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../network/EgressGuard.js", () => ({
  ensureEgressAllowed: vi.fn()
}));

import type { SecretsStore } from "../../auth/SecretsStore.js";
import { BedrockProvider } from "../bedrock.js";

class StubSecretsStore implements SecretsStore {
  private failure?: Error;

  constructor(private readonly values: Record<string, string> = {}) {}

  setFailure(error: Error | undefined) {
    this.failure = error;
  }

  async get(key: string) {
    if (this.failure) {
      throw this.failure;
    }
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

  it("recreates the client when access keys rotate", async () => {
    const secrets = new StubSecretsStore({
      "provider:bedrock:accessKeyId": "AKIAOLD",
      "provider:bedrock:secretAccessKey": "SECRETOLD"
    });
    const firstInvoke = vi.fn().mockResolvedValue({
      body: Buffer.from(JSON.stringify({ outputText: "first" }), "utf-8")
    });
    const secondInvoke = vi.fn().mockResolvedValue({
      body: Buffer.from(JSON.stringify({ outputText: "second" }), "utf-8")
    });
    const firstClient = { invokeModel: firstInvoke, destroy: vi.fn() };
    const secondClient = { invokeModel: secondInvoke };
    const clientFactory = vi
      .fn()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const provider = new BedrockProvider(secrets, {
      clientFactory,
      defaultModel: "model",
      region: "us-east-2"
    });

    const firstResponse = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(firstResponse.output).toBe("first");

    await secrets.set("provider:bedrock:accessKeyId", "AKIANEW");
    await secrets.set("provider:bedrock:secretAccessKey", "SECRETNEW");

    const secondResponse = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(secondResponse.output).toBe("second");

    await Promise.resolve();

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenNthCalledWith(1, {
      region: "us-east-2",
      credentials: { accessKeyId: "AKIAOLD", secretAccessKey: "SECRETOLD", sessionToken: undefined }
    });
    expect(clientFactory).toHaveBeenNthCalledWith(2, {
      region: "us-east-2",
      credentials: { accessKeyId: "AKIANEW", secretAccessKey: "SECRETNEW", sessionToken: undefined }
    });
    expect(firstClient.destroy).toHaveBeenCalledTimes(1);
    expect(firstInvoke).toHaveBeenCalledTimes(1);
    expect(secondInvoke).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached client when secret resolution fails", async () => {
    const secrets = new StubSecretsStore({
      "provider:bedrock:accessKeyId": "AKIA",
      "provider:bedrock:secretAccessKey": "SECRET"
    });
    const invokeModel = vi.fn().mockResolvedValue({
      body: Buffer.from(JSON.stringify({ outputText: "ok" }), "utf-8")
    });
    const client = { invokeModel };
    const clientFactory = vi.fn().mockResolvedValue(client);
    const provider = new BedrockProvider(secrets, {
      clientFactory,
      defaultModel: "model",
      region: "us-east-1"
    });

    const first = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(first.output).toBe("ok");
    expect(clientFactory).toHaveBeenCalledTimes(1);

    secrets.setFailure(new Error("vault unavailable"));

    const second = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(second.output).toBe("ok");
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(invokeModel).toHaveBeenCalledTimes(2);
  });
});
