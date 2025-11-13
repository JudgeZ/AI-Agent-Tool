import { describe, it, expect, vi } from "vitest";

import type { SecretsStore } from "../../auth/SecretsStore.js";
import { MistralProvider } from "../mistral.js";

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
});
