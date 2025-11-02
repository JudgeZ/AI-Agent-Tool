import type { SecretsStore } from "../auth/SecretsStore.js";
import type { ChatRequest, ChatResponse, ModelProvider } from "./interfaces.js";
import { callWithRetry, ProviderError, requireSecret } from "./utils.js";

interface OpenAIChatResponse {
  choices: Array<{ message?: { content?: string } | null } | null>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OpenAIClient {
  chat: {
    completions: {
      create: (payload: {
        model: string;
        messages: ChatRequest["messages"];
        temperature?: number;
      }) => Promise<OpenAIChatResponse>;
    };
  };
}

export type OpenAIProviderOptions = {
  defaultModel?: string;
  retryAttempts?: number;
  clientFactory?: (config: { apiKey: string }) => Promise<OpenAIClient> | OpenAIClient;
};

async function defaultClientFactory({ apiKey }: { apiKey: string }): Promise<OpenAIClient> {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey }) as unknown as OpenAIClient;
}

export class OpenAIProvider implements ModelProvider {
  name = "openai";
  private clientPromise?: Promise<OpenAIClient>;

  constructor(private readonly secrets: SecretsStore, private readonly options: OpenAIProviderOptions = {}) {}

  private async getClient(): Promise<OpenAIClient> {
    if (!this.clientPromise) {
      const apiKey = await requireSecret(this.secrets, this.name, {
        key: "provider:openai:apiKey",
        env: "OPENAI_API_KEY",
        description: "API key"
      });
      const factory = this.options.clientFactory ?? defaultClientFactory;
      this.clientPromise = Promise.resolve(factory({ apiKey }));
    }
    return this.clientPromise;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const client = await this.getClient();
    const model = req.model ?? this.options.defaultModel ?? "gpt-4o-mini";

    const result = await callWithRetry(
      async () => {
        try {
          const response = await client.chat.completions.create({
            model,
            messages: req.messages,
            temperature: 0.2
          });
          return response;
        } catch (error) {
          throw this.normalizeError(error);
        }
      },
      { attempts: this.options.retryAttempts ?? 2 }
    );

    const output = result.choices[0]?.message?.content?.trim();
    if (!output) {
      throw new ProviderError("OpenAI returned an empty response", {
        status: 502,
        provider: this.name,
        retryable: false
      });
    }

    return {
      output,
      provider: this.name,
      usage: result.usage
        ? {
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
            totalTokens: result.usage.total_tokens
          }
        : undefined
    };
  }

  private normalizeError(error: unknown): ProviderError {
    if (error instanceof ProviderError) {
      return error;
    }
    type OpenAIErrorLike = {
      status?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const details: OpenAIErrorLike | undefined =
      typeof error === "object" && error !== null ? (error as OpenAIErrorLike) : undefined;
    const status = typeof details?.status === "number" ? details.status : undefined;
    const code = typeof details?.code === "string" ? details.code : undefined;
    const message = typeof details?.message === "string" ? details.message : "OpenAI request failed";
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
