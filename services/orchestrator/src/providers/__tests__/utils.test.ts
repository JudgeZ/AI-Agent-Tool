import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../network/EgressGuard.js", () => ({
  ensureEgressAllowed: vi.fn()
}));

import type { SecretsStore } from "../../auth/SecretsStore.js";
import {
  callWithRetry,
  coalesceText,
  decodeBedrockBody,
  ProviderError,
  requireSecret,
  ensureProviderEgress,
  withProviderTimeout
} from "../utils.js";
import { ensureEgressAllowed } from "../../network/EgressGuard.js";

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
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ProviderError("try again", { retryable: true }))
      .mockResolvedValueOnce("success");

    const promise = callWithRetry(operation);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("success");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the error is not retryable", async () => {
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(
      new ProviderError("fail", { retryable: false })
    );

    await expect(callWithRetry(operation)).rejects.toMatchObject({ message: "fail", retryable: false });
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

describe("withProviderTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the operation result when it completes before the deadline", async () => {
    const result = await withProviderTimeout(
      () => Promise.resolve("ok"),
      { provider: "test", timeoutMs: 100, action: "call" },
    );
    expect(result).toBe("ok");
  });

  it("rejects with a ProviderError when the deadline expires", async () => {
    vi.useFakeTimers();
    const pending = withProviderTimeout(
      () => new Promise<never>(() => {}),
      { provider: "test", timeoutMs: 50, action: "call" },
    );
    const expectation = expect(pending).rejects.toMatchObject({ provider: "test", status: 504, code: "timeout" });
    await vi.advanceTimersByTimeAsync(60);
    await expectation;
  });

  it("aborts the provided signal when timing out", async () => {
    vi.useFakeTimers();
    const abortSpy = vi.fn();
    const pending = withProviderTimeout(
      ({ signal }) => {
        signal.addEventListener("abort", abortSpy);
        return new Promise<never>(() => {});
      },
      { provider: "test", timeoutMs: 25, action: "call" },
    );
    const expectation = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(30);
    await expectation;
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it("does not emit unhandled rejections when the timed-out operation later rejects", async () => {
    vi.useFakeTimers();
    const handler = vi.fn();
    const listener = (reason: unknown) => {
      handler(reason);
    };
    const pending = withProviderTimeout(
      () =>
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("late")), 100);
        }),
      { provider: "test", timeoutMs: 10, action: "call" },
    );
    const expectation = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await expectation;
    process.once("unhandledRejection", listener);
    try {
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", listener);
    }
  });
});

describe("ensureProviderEgress", () => {
  afterEach(() => {
    vi.mocked(ensureEgressAllowed).mockClear();
  });

  it("does not mutate the original metadata object", () => {
    const metadata = { correlationId: "abc" };
    ensureProviderEgress("openai", "https://api.openai.com/v1/chat/completions", {
      action: "provider.request",
      metadata,
    });
    expect(metadata).toEqual({ correlationId: "abc" });
    expect(ensureEgressAllowed).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        metadata: expect.objectContaining({ provider: "openai", correlationId: "abc" })
      }),
    );
  });
});
