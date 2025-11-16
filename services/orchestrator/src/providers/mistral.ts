import type { SecretsStore } from "../auth/SecretsStore.js";
import type { ChatRequest, ChatResponse, ModelProvider } from "./interfaces.js";
import {
  callWithRetry,
  ProviderError,
  requireSecret,
  disposeClient,
  ensureProviderEgress,
  withProviderTimeout,
} from "./utils.js";

interface MistralChatResponse {
  choices: Array<{ message?: { content?: string } } | null>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface MistralApiClient {
  chat: (payload: {
    model: string;
    messages: ChatRequest["messages"];
    temperature?: number;
    signal?: AbortSignal;
  }) => Promise<MistralChatResponse>;
}

export type MistralProviderOptions = {
  defaultModel?: string;
  retryAttempts?: number;
  clientFactory?: (config: { apiKey: string }) => Promise<MistralApiClient> | MistralApiClient;
  defaultTemperature?: number;
  timeoutMs?: number;
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
  private clientCredentials?: { apiKey: string };

  constructor(private readonly secrets: SecretsStore, private readonly options: MistralProviderOptions = {}) {}

  private async getClient(): Promise<MistralApiClient> {
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
      key: "provider:mistral:apiKey",
      env: "MISTRAL_API_KEY",
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

  private async disposeExistingClient(promise?: Promise<MistralApiClient>): Promise<void> {
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

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const client = await this.getClient();
    const model = req.model ?? this.options.defaultModel ?? "mistral-large-latest";
    const temperature = req.temperature ?? this.options.defaultTemperature;
    const response = await callWithRetry(
      async () => {
        ensureProviderEgress(this.name, "https://api.mistral.ai/v1/chat/completions", {
          action: "provider.request",
          metadata: { operation: "chat", model }
        });
        const payload: Parameters<MistralApiClient["chat"]>[0] = {
          model,
          messages: req.messages,
        };
        if (typeof temperature === "number") {
          payload.temperature = temperature;
        }
        try {
          return await withProviderTimeout(
            ({ signal }) =>
              client.chat({ ...payload, signal }),
            { provider: this.name, timeoutMs: this.options.timeoutMs, action: "chat" },
          );
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
