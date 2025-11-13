import { describe, it, expect, vi } from "vitest";

import type { SecretsStore } from "../../auth/SecretsStore.js";
import { OpenAIProvider } from "../openai.js";

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

describe("OpenAIProvider", () => {
  it("recreates the client when the API key rotates", async () => {
    const secrets = new StubSecretsStore({ "provider:openai:apiKey": "sk-old" });
    const firstCreate = vi
      .fn()
      .mockResolvedValue({
        choices: [{ message: { content: "first" } }],
        usage: undefined
      });
    const secondCreate = vi
      .fn()
      .mockResolvedValue({
        choices: [{ message: { content: "second" } }],
        usage: undefined
      });
    const firstClient = {
      chat: { completions: { create: firstCreate } },
      close: vi.fn()
    };
    const secondClient = {
      chat: { completions: { create: secondCreate } }
    };
    const clientFactory = vi
      .fn()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const provider = new OpenAIProvider(secrets, { clientFactory, defaultModel: "gpt" });

    const firstResponse = await provider.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(firstResponse.output).toBe("first");

    await secrets.set("provider:openai:apiKey", "sk-new");

    const secondResponse = await provider.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(secondResponse.output).toBe("second");

    await Promise.resolve();

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenNthCalledWith(1, { apiKey: "sk-old" });
    expect(clientFactory).toHaveBeenNthCalledWith(2, { apiKey: "sk-new" });
    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(firstCreate).toHaveBeenCalledTimes(1);
    expect(secondCreate).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached client when secret resolution fails", async () => {
    const secrets = new StubSecretsStore({ "provider:openai:apiKey": "sk-stable" });
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    const client = { chat: { completions: { create } } };
    const clientFactory = vi.fn().mockResolvedValue(client);
    const provider = new OpenAIProvider(secrets, { clientFactory, defaultModel: "gpt" });

    const firstResponse = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(firstResponse.output).toBe("ok");
    expect(clientFactory).toHaveBeenCalledTimes(1);

    secrets.setFailure(new Error("vault unavailable"));

    const secondResponse = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(secondResponse.output).toBe("ok");
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
