import type { SecretsStore } from "../auth/SecretsStore.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderContext,
} from "./interfaces.js";
import { BaseModelProvider } from "./BaseModelProvider.js";
import {
  callWithRetry,
  coalesceText,
  ProviderError,
  requireSecret,
  ensureProviderEgress,
  withProviderTimeout
} from "./utils.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface AnthropicMessagePart {
  type: string;
  text?: string;
}

interface AnthropicChatResponse {
  content: AnthropicMessagePart[];
  usage?: AnthropicUsage;
}

interface AnthropicClient {
  messages: {
    create: (
      payload: {
        model: string;
        system?: string;
        max_tokens: number;
        messages: Array<{ role: "user" | "assistant"; content: Array<{ type: "text"; text: string }> }>;
      },
      options?: { signal?: AbortSignal }
    ) => Promise<AnthropicChatResponse>;
  };
}

/** Credentials required for Anthropic API authentication */
export type AnthropicCredentials = { apiKey: string };

export type AnthropicProviderOptions = {
  defaultModel?: string;
  maxTokens?: number;
  retryAttempts?: number;
  timeoutMs?: number;
  clientFactory?: (config: AnthropicCredentials) => Promise<AnthropicClient> | AnthropicClient;
};

async function defaultClientFactory({ apiKey }: AnthropicCredentials): Promise<AnthropicClient> {
  const { Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic({ apiKey }) as unknown as AnthropicClient;
}

function toAnthropicMessages(messages: ChatMessage[]): Array<{
  role: "user" | "assistant";
  content: Array<{ type: "text"; text: string }>;
}> {
  return messages
    .filter(msg => msg.role !== "system")
    .map(msg => {
      const role: "user" | "assistant" = msg.role === "assistant" ? "assistant" : "user";
      return {
        role,
        content: [{ type: "text", text: msg.content }]
      };
    });
}

export class AnthropicProvider extends BaseModelProvider<AnthropicClient, AnthropicCredentials> {
  readonly name = "anthropic";

  constructor(
    secrets: SecretsStore,
    private readonly options: AnthropicProviderOptions = {}
  ) {
    super(secrets);
  }

  toJSON() {
    return {
      name: this.name,
      options: {
        defaultModel: this.options.defaultModel,
        maxTokens: this.options.maxTokens,
        retryAttempts: this.options.retryAttempts,
        timeoutMs: this.options.timeoutMs
      }
    };
  }

  protected async createClient(credentials: AnthropicCredentials): Promise<AnthropicClient> {
    const factory = this.options.clientFactory ?? defaultClientFactory;
    return factory(credentials);
  }

  protected async resolveCredentials(): Promise<AnthropicCredentials> {
    const apiKey = await requireSecret(this.secrets, this.name, {
      key: "provider:anthropic:apiKey",
      env: "ANTHROPIC_API_KEY",
      description: "API key"
    });
    return { apiKey };
  }

  protected areCredentialsEqual(
    previous: AnthropicCredentials | undefined,
    next: AnthropicCredentials | undefined
  ): previous is AnthropicCredentials {
    return Boolean(previous && next && previous.apiKey === next.apiKey);
  }

  async chat(req: ChatRequest, _context?: ProviderContext): Promise<ChatResponse> {
    const client = await this.getClient();
    const systemMessage = req.messages.find(msg => msg.role === "system")?.content;
    const model = req.model ?? this.options.defaultModel ?? "claude-3-sonnet-20240229";
    const maxTokens = this.options.maxTokens ?? 1024;

    const response = await callWithRetry(
      async () => {
        ensureProviderEgress(this.name, ANTHROPIC_MESSAGES_URL, {
          action: "provider.request",
          metadata: { operation: "messages.create", model }
        });
        try {
          return await withProviderTimeout(
            ({ signal }) =>
              client.messages.create(
                {
                  model,
                  system: systemMessage,
                  max_tokens: maxTokens,
                  messages: toAnthropicMessages(req.messages)
                },
                { signal }
              ),
            { provider: this.name, timeoutMs: this.options.timeoutMs, action: "messages.create" }
          );
        } catch (error) {
          throw this.normalizeError(error);
        }
      },
      { attempts: this.options.retryAttempts ?? 2 }
    );

    const output = coalesceText(
      response.content
        .filter(part => part?.type === "text")
        .map(part => ({ text: part?.text }))
    );

    if (!output) {
      throw new ProviderError("Anthropic returned an empty response", {
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
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            totalTokens: response.usage.total_tokens
          }
        : undefined
    };
  }
}
