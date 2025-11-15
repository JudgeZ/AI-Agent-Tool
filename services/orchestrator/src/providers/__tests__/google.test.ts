import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../network/EgressGuard.js", () => ({
  ensureEgressAllowed: vi.fn()
}));

import type { SecretsStore } from "../../auth/SecretsStore.js";
import { GoogleProvider } from "../google.js";

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

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

describe("GoogleProvider", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("aborts Gemini calls that exceed the configured timeout", async () => {
    const secrets = new StubSecretsStore({ "provider:google:apiKey": "sk-test" });
    const fetch = vi.fn((_url: string, init?: FetchInit) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    const provider = new GoogleProvider(secrets, { fetch: fetch as typeof fetch, timeoutMs: 5 });

    await expect(
      provider.chat({ messages: [{ role: "user", content: "hi" }] })
    ).rejects.toMatchObject({ provider: "google", status: 504 });
  });
});
