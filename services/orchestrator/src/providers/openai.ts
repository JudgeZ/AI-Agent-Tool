import type { SecretsStore } from "../auth/SecretsStore.js";
import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ProviderContext,
} from "./interfaces.js";
import {
  callWithRetry,
  ProviderError,
  requireSecret,
  disposeClient,
  ensureProviderEgress,
  withProviderTimeout,
} from "./utils.js";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

interface OpenAIChatResponse {
  choices: Array<{ message?: { content?: string } | null } | null>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OpenAIClient {
  chat: {
    completions: {
      create: (
        payload: {
          model: string;
          messages: ChatRequest["messages"];
          temperature?: number;
        },
        options?: { signal?: AbortSignal }
      ) => Promise<OpenAIChatResponse>;
    };
  };
}

export type OpenAIProviderOptions = {
  defaultModel?: string;
  retryAttempts?: number;
  clientFactory?: (config: { apiKey: string }) => Promise<OpenAIClient> | OpenAIClient;
  defaultTemperature?: number;
  timeoutMs?: number;
};

async function defaultClientFactory({ apiKey }: { apiKey: string }): Promise<OpenAIClient> {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey }) as unknown as OpenAIClient;
}

export class OpenAIProvider implements ModelProvider {
  name = "openai";
  private clientPromise?: Promise<OpenAIClient>;
  private clientCredentials?: { apiKey: string };

  constructor(private readonly secrets: SecretsStore, private readonly options: OpenAIProviderOptions = {}) {}

  toJSON() {
    return {
      name: this.name,
      options: {
        defaultModel: this.options.defaultModel,
        retryAttempts: this.options.retryAttempts,
        defaultTemperature: this.options.defaultTemperature,
        timeoutMs: this.options.timeoutMs
      }
    };
  }

  private async getClient(): Promise<OpenAIClient> {
    const currentPromise = this.clientPromise;
    let credentials!: { apiKey: string };
    try {
      credentials = await this.resolveCredentials();
    } catch (error) {
      if (currentPromise && this.clientCredentials) {
        return currentPromise;
      }
      throw error;
    }

    if (currentPromise && this.areCredentialsEqual(this.clientCredentials, credentials)) {
      return currentPromise;
    }

    const factory = this.options.clientFactory ?? defaultClientFactory;
    const nextPromise = Promise.resolve(factory(credentials));
    const wrappedPromise = nextPromise.then(
      client => client,
      error => {
        if (this.clientPromise === wrappedPromise) {
          this.clientPromise = undefined;
          this.clientCredentials = undefined;
        }
        throw error;
      }
    );

    this.clientPromise = wrappedPromise;
    this.clientCredentials = credentials;
    void this.disposeExistingClient(currentPromise);
    return wrappedPromise;
  }

  /** @internal */
  async resetClientForTests(): Promise<void> {
    await this.disposeExistingClient(this.clientPromise);
  }

  private async resolveCredentials(): Promise<{ apiKey: string }> {
    const apiKey = await requireSecret(this.secrets, this.name, {
      key: "provider:openai:apiKey",
      env: "OPENAI_API_KEY",
      description: "API key"
    });
    return { apiKey };
  }

  private areCredentialsEqual(
    previous?: { apiKey: string },
    next?: { apiKey: string }
  ): previous is { apiKey: string } {
    return Boolean(previous && next && previous.apiKey === next.apiKey);
  }

  private async disposeExistingClient(promise?: Promise<OpenAIClient>): Promise<void> {
    if (!promise) return;
    try {
      const client = await promise.catch(() => undefined);
      if (client) {
        await disposeClient(client);
      }
    } catch {
      // ignore disposal errors
    } finally {
      if (this.clientPromise === promise) {
        this.clientPromise = undefined;
        this.clientCredentials = undefined;
      }
    }
  }

  async chat(req: ChatRequest, _context?: ProviderContext): Promise<ChatResponse> {
    const client = await this.getClient();
    const model = req.model ?? this.options.defaultModel ?? "gpt-4o-mini";
    const temperature = req.temperature ?? this.options.defaultTemperature;
    const result = await callWithRetry(
      async () => {
        ensureProviderEgress(this.name, OPENAI_CHAT_COMPLETIONS_URL, {
          action: "provider.request",
          metadata: { operation: "chat.completions.create", model },
        });
        const payload: Parameters<OpenAIClient["chat"]["completions"]["create"]>[0] = {
          model,
          messages: req.messages,
        };
        if (typeof temperature === "number") {
          payload.temperature = temperature;
        }
        try {
          return await withProviderTimeout(
            ({ signal }) =>
              client.chat.completions.create(payload, { signal }),
            { provider: this.name, timeoutMs: this.options.timeoutMs, action: "chat.completions.create" },
          );
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

  private sanitize(text: string): string {
    if (!text || !this.clientCredentials?.apiKey) return text;
    return text.replace(this.clientCredentials.apiKey, "[REDACTED]");
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
    const rawMessage = typeof details?.message === "string" ? details.message : "OpenAI request failed";
    
    const message = this.sanitize(rawMessage);
    
    const retryable = status === 429 || status === 408 || (typeof status === "number" ? status >= 500 : true);
    
    // Sanitize cause if needed
    let cause = error;
    if (error && typeof error === "object") {
        try {
            const json = JSON.stringify(error);
            if (this.clientCredentials?.apiKey && json.includes(this.clientCredentials.apiKey)) {
                cause = new Error(this.sanitize(json));
            }
        } catch {
            // Ignore serialization errors
        }
    }

    return new ProviderError(message, {
      status: status ?? 502,
      code,
      provider: this.name,
      retryable,
      cause
    });
  }
}
