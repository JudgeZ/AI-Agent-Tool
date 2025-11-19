import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicProvider } from "../anthropic.js";
import { OpenAIProvider } from "../openai.js";
import type { SecretsStore } from "../../auth/SecretsStore.js";
import { ProviderError } from "../utils.js";

vi.mock("../../cache/index.js", () => ({
  getCompletionCache: () => ({
    getCompletion: vi.fn().mockResolvedValue(null),
    cacheCompletion: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../../cost/index.js", () => ({
  getCostTracker: () => ({
    trackUsage: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe("Provider Failover Scenarios", () => {
  let mockSecretsStore: SecretsStore;

  beforeEach(() => {
    mockSecretsStore = {
      get: vi.fn().mockResolvedValue("test-api-key"),
      set: vi.fn(),
      delete: vi.fn(),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Primary provider failure with fallback", () => {
    it("should fail over to secondary provider when primary fails", async () => {
      // Mock primary provider to fail
      const mockPrimaryClient = {
        messages: {
          create: vi.fn().mockRejectedValue(new Error("Service unavailable")),
        },
      };

      // Mock secondary provider to succeed
      const mockSecondaryClient = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: "Response from fallback" } }],
              usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 },
            }),
          },
        },
      };

      const primaryProvider = new AnthropicProvider(mockSecretsStore, {
        clientFactory: () => mockPrimaryClient as any,
      });
      const secondaryProvider = new OpenAIProvider(mockSecretsStore, {
        clientFactory: () => mockSecondaryClient as any,
      });

      const testRequest = {
        model: undefined,
        messages: [{ role: "user" as const, content: "Test message" }],
      };

      // Try primary first
      let response;
      try {
        response = await primaryProvider.chat(testRequest);
      } catch (primaryError) {
        // Fallback to secondary
        expect(primaryError).toBeInstanceOf(Error);
        response = await secondaryProvider.chat(testRequest);
      }

      expect(response).toBeDefined();
      expect(response.output).toBeTruthy();
    });
  });

  describe("Rate limit handling", () => {
    it("should handle rate limit errors correctly", async () => {
      const mockClient = {
        messages: {
          create: vi
            .fn()
            .mockRejectedValueOnce({
              status: 429,
              message: "Rate limit exceeded",
            })
            .mockResolvedValueOnce({
              content: [{ type: "text", text: "Success after retry" }],
              usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
            }),
        },
      };

      const provider = new AnthropicProvider(mockSecretsStore, {
        clientFactory: () => mockClient as any,
      });

      const response = await provider.chat({
        model: undefined,
        messages: [{ role: "user", content: "Test" }],
      });

      expect(response.output).toBe("Success after retry");
      expect(mockClient.messages.create).toHaveBeenCalledTimes(2);
    });

    it("should mark rate limit errors as retryable", async () => {
      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue({
            status: 429,
            message: "Rate limit exceeded",
          }),
        },
      };

      const provider = new AnthropicProvider(mockSecretsStore, {
        clientFactory: () => mockClient as any,
      });

      try {
        await provider.chat({
          model: undefined,
          messages: [{ role: "user", content: "Test" }],
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        if (error instanceof ProviderError) {
          expect(error.retryable).toBe(true);
          expect(error.status).toBe(429);
        }
      }
    });
  });

  describe("Timeout handling", () => {
    it("should handle timeout errors with retry", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi
              .fn()
              .mockImplementationOnce(
                () =>
                  new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Timeout")), 1500)
                  )
              )
              .mockResolvedValueOnce({
                choices: [{ message: { content: "Success after timeout" } }],
                usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
              }),
          },
        },
      };

      const provider = new OpenAIProvider(mockSecretsStore, {
        timeoutMs: 1000,
        clientFactory: () => mockClient as any,
      });

      const response = await provider.chat({
        model: undefined,
        messages: [{ role: "user", content: "Test" }],
      });

      expect(response.output).toBeDefined();
    });

    it("should mark timeout errors as retryable", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi
              .fn()
              .mockImplementation(
                () =>
                  new Promise((_, reject) =>
                    setTimeout(() => reject(new Error("Timeout")), 200)
                  )
              ),
          },
        },
      };

      const provider = new OpenAIProvider(mockSecretsStore, {
        timeoutMs: 100,
        retryAttempts: 1, // Only one retry
        clientFactory: () => mockClient as any,
      });

      try {
        await provider.chat({
          model: undefined,
          messages: [{ role: "user", content: "Test" }],
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        if (error instanceof ProviderError) {
          expect(error.retryable).toBe(true);
        }
      }
    });
  });

  describe("Credential rotation during requests", () => {
    it("should handle credential changes mid-request", async () => {
      let callCount = 0;
      mockSecretsStore.get = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve(callCount === 1 ? "key-1" : "key-2");
      });

      const mockClient1 = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "Response 1" }],
            usage: { input_tokens: 5, output_tokens: 10, total_tokens: 15 },
          }),
        },
      };

      // We need a factory that returns a new client or the same one, but the provider logic
      // checks for credential changes. The provider calls factory when credentials change.
      // So we can return the same mock or different ones.
      // For this test, returning the same mock is fine as we just want to verify get() is called.
      const provider = new AnthropicProvider(mockSecretsStore, {
        clientFactory: () => mockClient1 as any,
      });

      const response1 = await provider.chat({
        model: undefined,
        messages: [{ role: "user", content: "Test 1" }],
      });

      expect(response1.output).toBe("Response 1");

      // Simulate credential rotation
      // Second request should use new credentials

      const response2 = await provider.chat({
        model: undefined,
        messages: [{ role: "user", content: "Test 2" }],
      });

      expect(response2.output).toBeDefined();
      expect(mockSecretsStore.get).toHaveBeenCalledTimes(2);
    });
  });

  describe("Network errors", () => {
    it("should handle ECONNREFUSED errors", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockRejectedValue({
              code: "ECONNREFUSED",
              message: "Connection refused",
            }),
          },
        },
      };

      const provider = new OpenAIProvider(mockSecretsStore, {
        clientFactory: () => mockClient as any,
      });

      try {
        await provider.chat({
          model: undefined,
          messages: [{ role: "user", content: "Test" }],
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
      }
    });

    it("should handle DNS resolution failures", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockRejectedValue({
              code: "ENOTFOUND",
              message: "DNS lookup failed",
            }),
          },
        },
      };

      const provider = new OpenAIProvider(mockSecretsStore, {
        clientFactory: () => mockClient as any,
      });

      try {
        await provider.chat({
          model: undefined,
          messages: [{ role: "user", content: "Test" }],
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
      }
    });
  });

  describe("Authentication failures", () => {
    it("should handle invalid API key errors", async () => {
      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue({
            status: 401,
            message: "Invalid API key",
          }),
        },
      };

      const provider = new AnthropicProvider(mockSecretsStore, {
        clientFactory: () => mockClient as any,
      });

      try {
        await provider.chat({
          model: undefined,
          messages: [{ role: "user", content: "Test" }],
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        if (error instanceof ProviderError) {
          expect(error.status).toBe(401);
          expect(error.retryable).toBe(false);
        }
      }
    });

    it("should not retry on authentication errors", async () => {
      const mockClient = {
        messages: {
          create: vi.fn().mockRejectedValue({
            status: 401,
            message: "Invalid API key",
          }),
        },
      };

      const provider = new AnthropicProvider(mockSecretsStore, {
        retryAttempts: 3,
        clientFactory: () => mockClient as any,
      });

      try {
        await provider.chat({
          model: undefined,
          messages: [{ role: "user", content: "Test" }],
        });
        expect.fail("Should have thrown");
      } catch (error) {
        // Should only be called once (no retries for auth errors)
        expect(mockClient.messages.create).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe("Server errors (5xx)", () => {
    it("should retry on 500 errors", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi
              .fn()
              .mockRejectedValueOnce({
                status: 500,
                message: "Internal server error",
              })
              .mockResolvedValueOnce({
                choices: [{ message: { content: "Success after retry" } }],
                usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
              }),
          },
        },
      };

      const provider = new OpenAIProvider(mockSecretsStore, {
        retryAttempts: 2,
        clientFactory: () => mockClient as any,
      });

      const response = await provider.chat({
        model: undefined,
        messages: [{ role: "user", content: "Test" }],
      });

      expect(response.output).toBe("Success after retry");
      expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(2);
    });

    it("should retry on 503 Service Unavailable", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi
              .fn()
              .mockRejectedValueOnce({
                status: 503,
                message: "Service unavailable",
              })
              .mockResolvedValueOnce({
                choices: [{ message: { content: "Success" } }],
                usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
              }),
          },
        },
      };

      const provider = new OpenAIProvider(mockSecretsStore, {
        clientFactory: () => mockClient as any,
      });

      const response = await provider.chat({
        model: undefined,
        messages: [{ role: "user", content: "Test" }],
      });

      expect(response.output).toBeDefined();
      expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(2);
    });
  });

  describe("Empty response handling", () => {
    it("should handle empty content gracefully", async () => {
      const mockClient = {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [],
            usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 },
          }),
        },
      };

      const provider = new AnthropicProvider(mockSecretsStore, {
        clientFactory: () => mockClient as any,
      });

      try {
        await provider.chat({
          model: undefined,
          messages: [{ role: "user", content: "Test" }],
        });
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        if (error instanceof ProviderError) {
          expect(error.message).toContain("empty response");
          expect(error.status).toBe(502);
        }
      }
    });
  });

  describe("Concurrent requests", () => {
    it("should handle multiple concurrent requests", async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn().mockImplementation(async ({ messages }) => ({
              choices: [{ message: { content: `Response to: ${messages[0].content}` } }],
              usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
            })),
          },
        },
      };

      const provider = new OpenAIProvider(mockSecretsStore, {
        clientFactory: () => mockClient as any,
      });

      const requests = Array.from({ length: 10 }, (_, i) =>
        provider.chat({
          model: undefined,
          messages: [{ role: "user", content: `Message ${i}` }],
        })
      );

      const responses = await Promise.all(requests);

      expect(responses).toHaveLength(10);
      responses.forEach((response, i) => {
        expect(response.output).toContain(`Message ${i}`);
      });
    });
  });
});
