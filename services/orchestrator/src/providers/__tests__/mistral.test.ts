import { describe, it, expect, vi } from "vitest";

import type { SecretsStore } from "../../auth/SecretsStore.js";
import { MistralProvider } from "../mistral.js";

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

describe("MistralProvider", () => {
  it("recreates the client when the API key rotates", async () => {
    const secrets = new StubSecretsStore({ "provider:mistral:apiKey": "sk-old" });
    const firstChat = vi.fn().mockResolvedValue({ choices: [{ message: { content: "first" } }] });
    const secondChat = vi.fn().mockResolvedValue({ choices: [{ message: { content: "second" } }] });
    const firstClient = { chat: firstChat, close: vi.fn() };
    const secondClient = { chat: secondChat };
    const clientFactory = vi
      .fn()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const provider = new MistralProvider(secrets, { clientFactory, defaultModel: "model" });

    const firstResponse = await provider.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(firstResponse.output).toBe("first");

    await secrets.set("provider:mistral:apiKey", "sk-new");

    const secondResponse = await provider.chat({ messages: [{ role: "user", content: "hello" }] });
    expect(secondResponse.output).toBe("second");

    await Promise.resolve();

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenNthCalledWith(1, { apiKey: "sk-old" });
    expect(clientFactory).toHaveBeenNthCalledWith(2, { apiKey: "sk-new" });
    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(firstChat).toHaveBeenCalledTimes(1);
    expect(secondChat).toHaveBeenCalledTimes(1);
  });

  it("reuses the cached client when secret resolution fails", async () => {
    const secrets = new StubSecretsStore({ "provider:mistral:apiKey": "sk-stable" });
    const chat = vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    const client = { chat };
    const clientFactory = vi.fn().mockResolvedValue(client);
    const provider = new MistralProvider(secrets, { clientFactory, defaultModel: "model" });

    const first = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(first.output).toBe("ok");
    expect(clientFactory).toHaveBeenCalledTimes(1);

    secrets.setFailure(new Error("vault unavailable"));

    const second = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(second.output).toBe("ok");
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(2);
  });
});
