import type { SecretsStore } from "../auth/SecretsStore.js";
import type { ChatMessage, ChatRequest, ChatResponse, ModelProvider } from "./interfaces.js";
import { callWithRetry, ProviderError, requireSecret } from "./utils.js";

interface AzureUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

interface AzureChatResponse {
  choices: Array<{ message?: { content?: string } } | null>;
  usage?: AzureUsage;
}

interface AzureOpenAIClient {
  getChatCompletions: (
    deployment: string,
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }> ,
    options?: { temperature?: number }
  ) => Promise<AzureChatResponse>;
}

export type AzureOpenAIProviderOptions = {
  defaultDeployment?: string;
  retryAttempts?: number;
  apiVersion?: string;
  clientFactory?: (config: { apiKey: string; endpoint: string; apiVersion?: string }) => Promise<AzureOpenAIClient> | AzureOpenAIClient;
};

async function defaultClientFactory({
  apiKey,
  endpoint,
  apiVersion
}: {
  apiKey: string;
  endpoint: string;
  apiVersion?: string;
}): Promise<AzureOpenAIClient> {
  const azureModule = await import("@azure/openai");
  const moduleExports = azureModule as Record<string, unknown>;
  const ctorCandidate = moduleExports.AzureOpenAI ?? moduleExports.default;
  if (typeof ctorCandidate !== "function") {
    throw new Error("Azure OpenAI client is not available");
  }
  const resolvedApiVersion =
    typeof apiVersion === "string" && apiVersion.trim().length > 0
      ? apiVersion
      : process.env.AZURE_OPENAI_API_VERSION ?? "2024-02-01";
  type AzureOpenAIConstructor = new (config: { apiKey: string; endpoint: string; apiVersion: string }) => unknown;
  const AzureOpenAIConstructor = ctorCandidate as AzureOpenAIConstructor;
  return new AzureOpenAIConstructor({ apiKey, endpoint, apiVersion: resolvedApiVersion }) as unknown as AzureOpenAIClient;
}

function toAzureMessages(messages: ChatMessage[]) {
  return messages.map(msg => ({ role: msg.role, content: msg.content }));
}

export class AzureOpenAIProvider implements ModelProvider {
  name = "azureopenai";
  private clientPromise?: Promise<AzureOpenAIClient>;

  constructor(private readonly secrets: SecretsStore, private readonly options: AzureOpenAIProviderOptions = {}) {}

  private async getClient(): Promise<AzureOpenAIClient> {
    if (!this.clientPromise) {
      const apiKey = await requireSecret(this.secrets, this.name, {
        key: "provider:azureopenai:apiKey",
        env: "AZURE_OPENAI_API_KEY",
        description: "API key"
      });
      const endpoint = await requireSecret(this.secrets, this.name, {
        key: "provider:azureopenai:endpoint",
        env: "AZURE_OPENAI_ENDPOINT",
        description: "endpoint"
      });
      const factory = this.options.clientFactory ?? defaultClientFactory;
      this.clientPromise = Promise.resolve(
        factory({ apiKey, endpoint, apiVersion: this.options.apiVersion })
      );
    }
    return this.clientPromise;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const client = await this.getClient();
    const deployment =
      req.model ??
      this.options.defaultDeployment ??
      (await this.secrets.get("provider:azureopenai:deployment")) ??
      process.env.AZURE_OPENAI_DEPLOYMENT;

    if (!deployment) {
      throw new ProviderError("Azure OpenAI deployment is not configured", {
        status: 400,
        provider: this.name,
        code: "missing_deployment",
        retryable: false
      });
    }

    const response = await callWithRetry(
      async () => {
        try {
          return await client.getChatCompletions(deployment, toAzureMessages(req.messages), {
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
      throw new ProviderError("Azure OpenAI returned an empty response", {
        status: 502,
        provider: this.name,
        retryable: false
      });
    }

    const usage = response.usage;

    return {
      output,
      provider: this.name,
      usage: usage
        ? {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens
          }
        : undefined
    };
  }

  private normalizeError(error: unknown): ProviderError {
    if (error instanceof ProviderError) {
      return error;
    }
    type AzureErrorLike = {
      statusCode?: unknown;
      status?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const details: AzureErrorLike | undefined =
      typeof error === "object" && error !== null ? (error as AzureErrorLike) : undefined;
    const statusCandidate =
      typeof details?.statusCode === "number"
        ? details.statusCode
        : typeof details?.status === "number"
          ? details.status
          : undefined;
    const code = typeof details?.code === "string" ? details.code : undefined;
    const message =
      typeof details?.message === "string" ? details.message : "Azure OpenAI request failed";
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
