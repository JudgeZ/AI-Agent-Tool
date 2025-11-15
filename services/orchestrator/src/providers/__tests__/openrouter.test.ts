import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../network/EgressGuard.js", () => ({
  ensureEgressAllowed: vi.fn()
}));

import type { SecretsStore } from "../../auth/SecretsStore.js";
import { ensureEgressAllowed } from "../../network/EgressGuard.js";
import { OpenRouterProvider } from "../openrouter.js";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

describe("OpenRouterProvider", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("enforces egress policy before issuing chat completions", async () => {
    const secrets = new StubSecretsStore({ "provider:openrouter:apiKey": "sk-test" });
    const chat = vi.fn().mockResolvedValue({
      success: true,
      data: {
        choices: [{ message: { content: "ok" } }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          total_tokens: 3
        }
      }
    });
    const clientFactory = vi.fn().mockResolvedValue({ chat });
    const provider = new OpenRouterProvider(secrets, { clientFactory, defaultModel: "openrouter/test" });

    const response = await provider.chat({
      messages: [{ role: "user", content: "hi" }]
    });

    expect(response).toEqual({
      output: "ok",
      provider: "openrouter",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }
    });

    const ensure = vi.mocked(ensureEgressAllowed);
    expect(ensure).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/chat/completions",
      expect.objectContaining({
        action: "provider.request",
        metadata: expect.objectContaining({ provider: "openrouter", operation: "chat", model: "openrouter/test" })
      })
    );
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(chat.mock.invocationCallOrder[0]!);
  });

  it("forwards temperature overrides", async () => {
    const secrets = new StubSecretsStore({ "provider:openrouter:apiKey": "sk-temp" });
    const chat = vi.fn().mockResolvedValue({
      success: true,
      data: { choices: [{ message: { content: "ok" } }] }
    });
    const clientFactory = vi.fn().mockResolvedValue({ chat });
    const provider = new OpenRouterProvider(secrets, { clientFactory, defaultModel: "openrouter/test" });

    await provider.chat({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.6
    });

    expect(chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ model: "openrouter/test", temperature: 0.6 })
    );
  });

  it("disposes cached clients when the API key rotates", async () => {
    const secrets = new StubSecretsStore({ "provider:openrouter:apiKey": "sk-old" });
    const firstClient = {
      chat: vi.fn().mockResolvedValue({ success: true, data: { choices: [{ message: { content: "first" } }] } }),
      close: vi.fn()
    };
    const secondClient = {
      chat: vi.fn().mockResolvedValue({ success: true, data: { choices: [{ message: { content: "second" } }] } }),
      close: vi.fn()
    };
    const clientFactory = vi
      .fn()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const provider = new OpenRouterProvider(secrets, { clientFactory, defaultModel: "openrouter/test" });

    const first = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(first.output).toBe("first");

    await secrets.set("provider:openrouter:apiKey", "sk-new");

    const second = await provider.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(second.output).toBe("second");

    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(firstClient.close).toHaveBeenCalledTimes(1);
  });

  it("defers disposing old clients until in-flight requests finish", async () => {
    const secrets = new StubSecretsStore({ "provider:openrouter:apiKey": "sk-old" });
    const firstDeferred = createDeferred<{ success: true; data: { choices: Array<{ message: { content: string } }> } }>();
    const firstClient = {
      chat: vi.fn().mockReturnValue(firstDeferred.promise),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const secondClient = {
      chat: vi.fn().mockResolvedValue({ success: true, data: { choices: [{ message: { content: "second" } }] } }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const clientFactory = vi
      .fn()
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);
    const provider = new OpenRouterProvider(secrets, { clientFactory, defaultModel: "openrouter/test" });

    const firstCall = provider.chat({ messages: [{ role: "user", content: "hi" }] });
    await Promise.resolve();

    await secrets.set("provider:openrouter:apiKey", "sk-new");
    const secondCall = provider.chat({ messages: [{ role: "user", content: "hey" }] });

    expect(firstClient.close).not.toHaveBeenCalled();

    firstDeferred.resolve({ success: true, data: { choices: [{ message: { content: "first" } }] } });

    const [first, second] = await Promise.all([firstCall, secondCall]);
    expect(first.output).toBe("first");
    expect(second.output).toBe("second");
    expect(firstClient.close).toHaveBeenCalledTimes(1);
  });
});
