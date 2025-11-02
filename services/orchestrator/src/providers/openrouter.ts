import type { SecretsStore } from "../auth/SecretsStore.js";
import type { ChatRequest, ChatResponse, ModelProvider } from "./interfaces.js";
import { callWithRetry, ProviderError, requireSecret } from "./utils.js";

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenRouterSuccess {
  choices: Array<{ message?: { content?: string } | null } | null>;
  usage?: OpenRouterUsage;
}

interface OpenRouterResponseSuccess {
  success: true;
  data: OpenRouterSuccess;
}

interface OpenRouterResponseError {
  success: false;
  errorCode: number;
  errorMessage: string;
  metadata?: unknown;
}

interface OpenRouterAbortError {
  success: false;
  error: "AbortSignal" | unknown;
}

type OpenRouterResponse = OpenRouterResponseSuccess | OpenRouterResponseError | OpenRouterAbortError;

interface OpenRouterClient {
  chat: (
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    config?: { model?: string; max_tokens?: number; temperature?: number }
  ) => Promise<OpenRouterResponse>;
}

export type OpenRouterProviderOptions = {
  defaultModel?: string;
  retryAttempts?: number;
  clientFactory?: (config: { apiKey: string; globalConfig?: Record<string, unknown> }) => Promise<OpenRouterClient> | OpenRouterClient;
  globalConfig?: Record<string, unknown>;
};

async function defaultClientFactory({
  apiKey,
  globalConfig
}: {
  apiKey: string;
  globalConfig?: Record<string, unknown>;
}): Promise<OpenRouterClient> {
  const { OpenRouter } = await import("openrouter-client");
  return new OpenRouter(apiKey, globalConfig) as unknown as OpenRouterClient;
}

function toOpenRouterMessages(messages: ChatRequest["messages"]) {
  return messages.map(msg => ({ role: msg.role, content: msg.content }));
}

export class OpenRouterProvider implements ModelProvider {
  name = "openrouter";
  supportsOAuth = true;
  private clients = new Map<string, Promise<OpenRouterClient>>();

  constructor(private readonly secrets: SecretsStore, private readonly options: OpenRouterProviderOptions = {}) {}

  private async resolveApiKey(): Promise<string> {
    const oauthToken = await this.secrets.get("oauth:openrouter:access_token");
    if (oauthToken) {
      return oauthToken;
    }
    return requireSecret(this.secrets, this.name, {
      key: "provider:openrouter:apiKey",
      env: "OPENROUTER_API_KEY",
      description: "API key"
    });
  }

  private async getClient(apiKey: string): Promise<OpenRouterClient> {
    if (!this.clients.has(apiKey)) {
      const factory = this.options.clientFactory ?? defaultClientFactory;
      this.clients.set(apiKey, Promise.resolve(factory({ apiKey, globalConfig: this.options.globalConfig })));
    }
    return this.clients.get(apiKey)!;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model ?? this.options.defaultModel ?? "openrouter/openai/gpt-4o-mini";
    const messages = toOpenRouterMessages(req.messages);

    const result = await callWithRetry(
      async () => {
        const apiKey = await this.resolveApiKey();
        const client = await this.getClient(apiKey);
        let response: OpenRouterResponse;
        try {
          response = await client.chat(messages, { model, temperature: 0.2 });
        } catch (error) {
          throw this.normalizeError(error);
        }
        if (!response.success) {
          throw this.normalizeResponseError(response);
        }
        return response.data;
      },
      { attempts: this.options.retryAttempts ?? 2 }
    );

    const output = result.choices[0]?.message?.content?.trim();
    if (!output) {
      throw new ProviderError("OpenRouter returned an empty response", {
        status: 502,
        provider: this.name,
        retryable: false
      });
    }

    const usage = result.usage;

    return {
      output,
      provider: this.name,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens
          }
        : undefined
    };
  }

  private normalizeResponseError(response: OpenRouterResponseError | OpenRouterAbortError): ProviderError {
    if ((response as OpenRouterResponseError).errorCode !== undefined) {
      const err = response as OpenRouterResponseError;
      const retryable = err.errorCode === 429 || err.errorCode >= 500;
      return new ProviderError(err.errorMessage || "OpenRouter request failed", {
        status: err.errorCode || 502,
        provider: this.name,
        retryable,
        cause: err.metadata
      });
    }
    const abort = response as OpenRouterAbortError;
    return new ProviderError("OpenRouter request aborted", {
      status: 499,
      provider: this.name,
      retryable: false,
      cause: abort.error
    });
  }

  private normalizeError(error: unknown): ProviderError {
    if (error instanceof ProviderError) {
      return error;
    }
    type OpenRouterErrorLike = {
      status?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const details: OpenRouterErrorLike | undefined =
      typeof error === "object" && error !== null ? (error as OpenRouterErrorLike) : undefined;
    const status = typeof details?.status === "number" ? details.status : undefined;
    const code = typeof details?.code === "string" ? details.code : undefined;
    const message =
      typeof details?.message === "string" ? details.message : "OpenRouter request failed";
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
