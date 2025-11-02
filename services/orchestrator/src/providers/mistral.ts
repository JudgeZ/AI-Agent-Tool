import type { SecretsStore } from "../auth/SecretsStore.js";
import type { ChatRequest, ChatResponse, ModelProvider } from "./interfaces.js";
import { callWithRetry, ProviderError, requireSecret } from "./utils.js";

interface MistralChatResponse {
  choices: Array<{ message?: { content?: string } } | null>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface MistralApiClient {
  chat: (payload: {
    model: string;
    messages: ChatRequest["messages"];
    temperature?: number;
  }) => Promise<MistralChatResponse>;
}

export type MistralProviderOptions = {
  defaultModel?: string;
  retryAttempts?: number;
  clientFactory?: (config: { apiKey: string }) => Promise<MistralApiClient> | MistralApiClient;
};

async function defaultClientFactory({ apiKey }: { apiKey: string }): Promise<MistralApiClient> {
  const mistralModule = await import("@mistralai/mistralai");
  const moduleExports = mistralModule as Record<string, unknown>;
  const ctorCandidate = moduleExports.MistralClient ?? moduleExports.default;
  if (typeof ctorCandidate !== "function") {
    throw new Error("Mistral client is not available");
  }
  type MistralConstructor = new (config: { apiKey: string }) => unknown;
  const MistralConstructor = ctorCandidate as MistralConstructor;
  return new MistralConstructor({ apiKey }) as unknown as MistralApiClient;
}

export class MistralProvider implements ModelProvider {
  name = "mistral";
  private clientPromise?: Promise<MistralApiClient>;

  constructor(private readonly secrets: SecretsStore, private readonly options: MistralProviderOptions = {}) {}

  private async getClient(): Promise<MistralApiClient> {
    if (!this.clientPromise) {
      const apiKey = await requireSecret(this.secrets, this.name, {
        key: "provider:mistral:apiKey",
        env: "MISTRAL_API_KEY",
        description: "API key"
      });
      const factory = this.options.clientFactory ?? defaultClientFactory;
      this.clientPromise = Promise.resolve(factory({ apiKey }));
    }
    return this.clientPromise;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const client = await this.getClient();
    const model = req.model ?? this.options.defaultModel ?? "mistral-large-latest";

    const response = await callWithRetry(
      async () => {
        try {
          return await client.chat({
            model,
            messages: req.messages,
            temperature: 0.2
          });
        } catch (error) {
          throw this.normalizeError(error);
        }
      },
      { attempts: this.options.retryAttempts ?? 2 }
    );

    const output = response.choices[0]?.message?.content?.trim();
    if (!output) {
      throw new ProviderError("Mistral returned an empty response", {
        status: 502,
        provider: this.name,
        retryable: false
      });
    }

    return {
      output,
      provider: this.name,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens
          }
        : undefined
    };
  }

  private normalizeError(error: unknown): ProviderError {
    if (error instanceof ProviderError) {
      return error;
    }
    type MistralErrorLike = {
      status?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const details: MistralErrorLike | undefined =
      typeof error === "object" && error !== null ? (error as MistralErrorLike) : undefined;
    const status = typeof details?.status === "number" ? details.status : undefined;
    const code = typeof details?.code === "string" ? details.code : undefined;
    const message = typeof details?.message === "string" ? details.message : "Mistral request failed";
    const retryable = status === 429 || status === 408 || (typeof status === "number" ? status >= 500 : true);
    return new ProviderError(message, {
      status: status ?? 502,
      code,
      provider: this.name,
      retryable,
      cause: error
    });
  }
}
