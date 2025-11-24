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

type OpenAICredentials = { apiKey: string };

export type OpenAIProviderOptions = {
  defaultModel?: string;
  retryAttempts?: number;
  clientFactory?: (config: OpenAICredentials) => Promise<OpenAIClient> | OpenAIClient;
  defaultTemperature?: number;
  timeoutMs?: number;
};

async function defaultClientFactory({ apiKey }: OpenAICredentials): Promise<OpenAIClient> {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey }) as unknown as OpenAIClient;
}

export class OpenAIProvider extends BaseModelProvider<OpenAIClient, OpenAICredentials> {
  readonly name = "openai";

  constructor(
    secrets: SecretsStore,
    private readonly options: OpenAIProviderOptions = {}
  ) {
    super(secrets);
  }

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

  protected async createClient(credentials: OpenAICredentials): Promise<OpenAIClient> {
    const factory = this.options.clientFactory ?? defaultClientFactory;
    return factory(credentials);
  }

  protected async resolveCredentials(): Promise<OpenAICredentials> {
    const apiKey = await requireSecret(this.secrets, this.name, {
      key: "provider:openai:apiKey",
      env: "OPENAI_API_KEY",
      description: "API key"
    });
    return { apiKey };
  }

  protected areCredentialsEqual(
    previous: OpenAICredentials | undefined,
    next: OpenAICredentials | undefined
  ): previous is OpenAICredentials {
    return Boolean(previous && next && previous.apiKey === next.apiKey);
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
}
