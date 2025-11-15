import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../network/EgressGuard.js", () => ({
  ensureEgressAllowed: vi.fn()
}));

import type { SecretsStore } from "../../auth/SecretsStore.js";
import { ensureEgressAllowed } from "../../network/EgressGuard.js";
import { OpenRouterProvider } from "../openrouter.js";

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
});
