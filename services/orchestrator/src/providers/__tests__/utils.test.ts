import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { SecretsStore } from "../../auth/SecretsStore.js";
import {
  callWithRetry,
  coalesceText,
  decodeBedrockBody,
  ProviderError,
  requireSecret
} from "../utils.js";

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

describe("requireSecret", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns the secret from the store when available", async () => {
    const secrets = new StubSecretsStore({ foo: "store-value" });
    await expect(requireSecret(secrets, "test", { key: "foo", description: "secret" })).resolves.toBe("store-value");
  });

  it("falls back to the environment variable when the store is empty", async () => {
    process.env.BAR_SECRET = "env-value";
    const secrets = new StubSecretsStore();

    await expect(
      requireSecret(secrets, "test", { key: "bar", env: "BAR_SECRET", description: "secret" })
    ).resolves.toBe("env-value");
  });

  it("throws a ProviderError when neither store nor environment has the secret", async () => {
    const secrets = new StubSecretsStore();

    await expect(
      requireSecret(secrets, "test", { key: "missing", description: "secret" })
    ).rejects.toMatchObject({
      message: "test secret is not configured",
      status: 401,
      code: "missing_credentials",
      provider: "test",
      retryable: false
    });
  });
});

describe("callWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately on a successful first attempt", async () => {
    const result = await callWithRetry(async () => "ok");
    expect(result).toBe("ok");
  });

  it("retries once when the first error is retryable", async () => {
    const operation = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new ProviderError("try again", { retryable: true }))
      .mockResolvedValueOnce("success");

    const promise = callWithRetry(() => operation());
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("success");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the error is not retryable", async () => {
    const operation = vi.fn().mockRejectedValue(new ProviderError("fail", { retryable: false }));

    await expect(callWithRetry(() => operation())).rejects.toMatchObject({ message: "fail", retryable: false });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe("coalesceText", () => {
  it("joins text fragments and trims whitespace", () => {
    const result = coalesceText([
      { text: " hello" },
      undefined,
      { text: undefined },
      { text: "world " },
      {}
    ]);

    expect(result).toBe("helloworld");
  });

  it("returns an empty string when all parts are empty", () => {
    expect(coalesceText([{}, undefined])).toBe("");
  });
});

describe("decodeBedrockBody", () => {
  it("returns the input string untouched", async () => {
    await expect(decodeBedrockBody("hello")).resolves.toBe("hello");
  });

  it("decodes buffers and Uint8Arrays", async () => {
    await expect(decodeBedrockBody(Buffer.from("buffer"))).resolves.toBe("buffer");
    await expect(decodeBedrockBody(new Uint8Array(Buffer.from("array")))).resolves.toBe("array");
  });

  it("decodes objects exposing transformToByteArray", async () => {
    const body = {
      async transformToByteArray() {
        return new Uint8Array(Buffer.from("converted"));
      }
    };
    await expect(decodeBedrockBody(body)).resolves.toBe("converted");
  });

  it("returns an empty string when the body is nullish", async () => {
    await expect(decodeBedrockBody(null)).resolves.toBe("");
    await expect(decodeBedrockBody(undefined)).resolves.toBe("");
  });

  it("falls back to String() for unknown shapes", async () => {
    await expect(decodeBedrockBody(123 as unknown as Uint8Array)).resolves.toBe("123");
  });
});
