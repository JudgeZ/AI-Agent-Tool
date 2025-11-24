import type { SecretsStore } from "../auth/SecretsStore.js";
import type {
  ChatRequest,
  ChatResponse,
  ProviderContext,
} from "./interfaces.js";
import { BaseModelProvider } from "./BaseModelProvider.js";
import {
  callWithRetry,
  ProviderError,
  requireSecret,
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

type MistralCredentials = { apiKey: string };

export type MistralProviderOptions = {
  defaultModel?: string;
  retryAttempts?: number;
  clientFactory?: (config: MistralCredentials) => Promise<MistralApiClient> | MistralApiClient;
  defaultTemperature?: number;
  timeoutMs?: number;
};

async function defaultClientFactory({ apiKey }: MistralCredentials): Promise<MistralApiClient> {
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

export class MistralProvider extends BaseModelProvider<MistralApiClient, MistralCredentials> {
  readonly name = "mistral";

  constructor(
    secrets: SecretsStore,
    private readonly options: MistralProviderOptions = {}
  ) {
    super(secrets);
  }

  protected async createClient(credentials: MistralCredentials): Promise<MistralApiClient> {
    const factory = this.options.clientFactory ?? defaultClientFactory;
    return factory(credentials);
  }

  protected async resolveCredentials(): Promise<MistralCredentials> {
    const apiKey = await requireSecret(this.secrets, this.name, {
      key: "provider:mistral:apiKey",
      env: "MISTRAL_API_KEY",
      description: "API key"
    });
    return { apiKey };
  }

  protected areCredentialsEqual(
    previous: MistralCredentials | undefined,
    next: MistralCredentials | undefined
  ): previous is MistralCredentials {
    return Boolean(previous && next && previous.apiKey === next.apiKey);
  }

  async chat(req: ChatRequest, _context?: ProviderContext): Promise<ChatResponse> {
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
}
