import type { SecretsStore } from "../auth/SecretsStore.js";
import type { ChatMessage, ChatRequest, ChatResponse, ModelProvider } from "./interfaces.js";
import { callWithRetry, coalesceText, ProviderError, requireSecret } from "./utils.js";

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
    create: (payload: {
      model: string;
      system?: string;
      max_tokens: number;
      messages: Array<{ role: "user" | "assistant"; content: Array<{ type: "text"; text: string }> }>;
    }) => Promise<AnthropicChatResponse>;
  };
}

export type AnthropicProviderOptions = {
  defaultModel?: string;
  maxTokens?: number;
  retryAttempts?: number;
  clientFactory?: (config: { apiKey: string }) => Promise<AnthropicClient> | AnthropicClient;
};

async function defaultClientFactory({ apiKey }: { apiKey: string }): Promise<AnthropicClient> {
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

export class AnthropicProvider implements ModelProvider {
  name = "anthropic";
  private clientPromise?: Promise<AnthropicClient>;

  constructor(private readonly secrets: SecretsStore, private readonly options: AnthropicProviderOptions = {}) {}

  private async getClient(): Promise<AnthropicClient> {
    if (!this.clientPromise) {
      const apiKey = await requireSecret(this.secrets, this.name, {
        key: "provider:anthropic:apiKey",
        env: "ANTHROPIC_API_KEY",
        description: "API key"
      });
      const factory = this.options.clientFactory ?? defaultClientFactory;
      this.clientPromise = Promise.resolve(factory({ apiKey }));
    }
    return this.clientPromise;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const client = await this.getClient();
    const systemMessage = req.messages.find(msg => msg.role === "system")?.content;
    const model = req.model ?? this.options.defaultModel ?? "claude-3-sonnet-20240229";
    const maxTokens = this.options.maxTokens ?? 1024;

    const response = await callWithRetry(
      async () => {
        try {
          return await client.messages.create({
            model,
            system: systemMessage,
            max_tokens: maxTokens,
            messages: toAnthropicMessages(req.messages)
          });
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

  private normalizeError(error: unknown): ProviderError {
    if (error instanceof ProviderError) {
      return error;
    }
    type AnthropicErrorLike = {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const details: AnthropicErrorLike | undefined =
      typeof error === "object" && error !== null ? (error as AnthropicErrorLike) : undefined;
    const statusCandidate =
      typeof details?.status === "number"
        ? details.status
        : typeof details?.statusCode === "number"
          ? details.statusCode
          : undefined;
    const code = typeof details?.code === "string" ? details.code : undefined;
    const message =
      typeof details?.message === "string" ? details.message : "Anthropic request failed";
    const status = statusCandidate;
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
