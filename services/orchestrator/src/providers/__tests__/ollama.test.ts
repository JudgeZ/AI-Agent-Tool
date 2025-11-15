import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../network/EgressGuard.js", () => ({
  ensureEgressAllowed: vi.fn()
}));

import type { SecretsStore } from "../../auth/SecretsStore.js";
import { ensureEgressAllowed } from "../../network/EgressGuard.js";
import { OllamaProvider } from "../ollama.js";

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

describe("OllamaProvider", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("enforces egress policy before sending chat requests", async () => {
    const secrets = new StubSecretsStore({ "provider:ollama:baseUrl": "http://ollama.local" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ response: "ok" })
    });
    const provider = new OllamaProvider(secrets, {
      defaultModel: "llama3.1",
      fetch: fetchMock
    });

    await provider.chat({
      model: "llama3.1",
      messages: [{ role: "user", content: "ping" }]
    });

    const ensure = vi.mocked(ensureEgressAllowed);
    expect(ensure).toHaveBeenCalledWith(
      "http://ollama.local/api/chat",
      expect.objectContaining({
        action: "provider.request",
        metadata: expect.objectContaining({ provider: "local_ollama", operation: "chat", model: "llama3.1" })
      })
    );
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]!);
  });

  it("aborts requests that exceed the configured timeout", async () => {
    const secrets = new StubSecretsStore({ "provider:ollama:baseUrl": "http://ollama.local" });
    const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    const provider = new OllamaProvider(secrets, { fetch: fetchMock, timeoutMs: 5 });

    await expect(
      provider.chat({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({ provider: "local_ollama", status: 504 });
  });

  it("rejects invalid timeout configuration", () => {
    const secrets = new StubSecretsStore({ "provider:ollama:baseUrl": "http://ollama.local" });
    expect(() => new OllamaProvider(secrets, { timeoutMs: -5, fetch: vi.fn() as any })).toThrow(
      /timeoutMs must be a positive integer/i,
    );
  });
});
