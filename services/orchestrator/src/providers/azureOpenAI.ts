import type { SecretsStore } from "../auth/SecretsStore.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderContext,
} from "./interfaces.js";
import { BaseModelProviderWithCredentials } from "./BaseModelProvider.js";
import {
  callWithRetry,
  ProviderError,
  requireSecret,
  ensureProviderEgress,
  withProviderTimeout,
} from "./utils.js";

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
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options?: { temperature?: number; abortSignal?: AbortSignal }
  ) => Promise<AzureChatResponse>;
}

/** Credentials required for Azure OpenAI API authentication */
export type AzureCredentials = { apiKey: string; endpoint: string };

export type AzureOpenAIProviderOptions = {
  defaultDeployment?: string;
  retryAttempts?: number;
  apiVersion?: string;
  clientFactory?: (config: { apiKey: string; endpoint: string; apiVersion?: string }) => Promise<AzureOpenAIClient> | AzureOpenAIClient;
  defaultTemperature?: number;
  timeoutMs?: number;
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

export class AzureOpenAIProvider extends BaseModelProviderWithCredentials<AzureOpenAIClient, AzureCredentials> {
  readonly name = "azureopenai";

  protected override get displayName(): string {
    return "Azure OpenAI";
  }

  constructor(
    secrets: SecretsStore,
    private readonly options: AzureOpenAIProviderOptions = {}
  ) {
    super(secrets);
  }

  protected async createClient(credentials: AzureCredentials): Promise<AzureOpenAIClient> {
    const factory = this.options.clientFactory ?? defaultClientFactory;
    return factory({ ...credentials, apiVersion: this.options.apiVersion });
  }

  protected async resolveCredentials(): Promise<AzureCredentials> {
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
    return { apiKey, endpoint };
  }

  protected areCredentialsEqual(
    previous: AzureCredentials | undefined,
    next: AzureCredentials | undefined
  ): previous is AzureCredentials {
    return Boolean(
      previous &&
        next &&
        previous.apiKey === next.apiKey &&
        previous.endpoint === next.endpoint
    );
  }

  async chat(req: ChatRequest, _context?: ProviderContext): Promise<ChatResponse> {
    const { client, credentials } = await this.getClientWithCredentials();
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

    const endpoint = credentials.endpoint;
    if (!endpoint) {
      throw new ProviderError("Azure OpenAI endpoint is not resolved", {
        status: 500,
        provider: this.name,
        retryable: false
      });
    }
    const baseUrl = endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint;
    const targetUrl = `${baseUrl}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`;
    const temperature = req.temperature ?? this.options.defaultTemperature;
    const azureMessages = toAzureMessages(req.messages);

    const response = await callWithRetry(
      async () => {
        ensureProviderEgress(this.name, targetUrl, {
          action: "provider.request",
          metadata: { operation: "chat.completions", model: deployment }
        });
        try {
          return await withProviderTimeout(
            ({ signal }) => {
              const options: { temperature?: number; abortSignal: AbortSignal } = { abortSignal: signal };
              if (typeof temperature === "number") {
                options.temperature = temperature;
              }
              return client.getChatCompletions(deployment, azureMessages, options);
            },
            { provider: this.name, timeoutMs: this.options.timeoutMs, action: "chat.completions" },
          );
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
}
