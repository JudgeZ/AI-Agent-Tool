import type { SecretsStore } from "../auth/SecretsStore.js";
import type { ChatMessage, ChatRequest, ChatResponse, ModelProvider } from "./interfaces.js";
import {
  callWithRetry,
  decodeBedrockBody,
  ProviderError,
  requireSecret,
  disposeClient,
  ensureProviderEgress
} from "./utils.js";

interface BedrockInvokeResult {
  body?: unknown;
}

interface BedrockClient {
  invokeModel: (input: {
    modelId: string;
    body: Uint8Array | Buffer | string;
    contentType: string;
    accept: string;
  }) => Promise<BedrockInvokeResult>;
  destroy?: () => void | Promise<void>;
}

export type BedrockProviderOptions = {
  defaultModel?: string;
  region?: string;
  maxTokens?: number;
  retryAttempts?: number;
  clientFactory?: (config: {
    region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}) => Promise<BedrockClient> | BedrockClient;
};

async function defaultClientFactory({
  region,
  credentials
}: {
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}): Promise<BedrockClient> {
  const { BedrockRuntimeClient, InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region, credentials });
  return {
    invokeModel: async input => client.send(new InvokeModelCommand(input)),
    destroy: () => client.destroy()
  };
}

function toBedrockMessages(messages: ChatMessage[]) {
  return messages
    .filter(msg => msg.role !== "system")
    .map(msg => ({
      role: msg.role,
      content: [{ type: "text", text: msg.content }]
    }));
}

function extractBedrockText(payload: unknown): string {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) {
    return payload.map(extractBedrockText).join("");
  }
  if (typeof payload === "object") {
    const candidate = (payload as { text?: string }).text;
    if (typeof candidate === "string") {
      return candidate;
    }
    if (Array.isArray((payload as { content?: unknown[] }).content)) {
      return extractBedrockText((payload as { content?: unknown[] }).content);
    }
    if (typeof (payload as { outputText?: string }).outputText === "string") {
      return (payload as { outputText: string }).outputText;
    }
    if (Array.isArray((payload as { generations?: unknown[] }).generations)) {
      return extractBedrockText((payload as { generations?: unknown[] }).generations);
    }
    const values = Object.values(payload as Record<string, unknown>);
    return values.map(extractBedrockText).join("");
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class BedrockProvider implements ModelProvider {
  name = "bedrock";
  private clientPromise?: Promise<BedrockClient>;
  private clientCredentials?: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };

  constructor(private readonly secrets: SecretsStore, private readonly options: BedrockProviderOptions = {}) {}

  private async getClient(): Promise<{
    client: BedrockClient;
    credentials: { region: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  }> {
    const currentPromise = this.clientPromise;
    let credentials!: {
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };
    try {
      credentials = await this.resolveCredentials();
    } catch (error) {
      if (currentPromise && this.clientCredentials) {
        return { client: await currentPromise, credentials: this.clientCredentials };
      }
      throw error;
    }

    if (currentPromise && this.areCredentialsEqual(this.clientCredentials, credentials)) {
      const snapshot = this.clientCredentials;
      if (!snapshot) {
        throw new ProviderError("Bedrock credentials are not available", {
          status: 500,
          provider: this.name,
          retryable: false,
        });
      }
      const client = await currentPromise;
      return { client, credentials: snapshot };
    }

    const factory = this.options.clientFactory ?? defaultClientFactory;
    const { region, accessKeyId, secretAccessKey, sessionToken } = credentials;
    const nextPromise = Promise.resolve(
      factory({ region, credentials: { accessKeyId, secretAccessKey, sessionToken } })
    );
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
    const client = await wrappedPromise;
    return { client, credentials };
  }

  /** @internal */
  async resetClientForTests(): Promise<void> {
    await this.disposeExistingClient(this.clientPromise);
  }

  private async resolveCredentials(): Promise<{
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }> {
    const region =
      this.options.region ??
      (await this.secrets.get("provider:bedrock:region")) ??
      process.env.AWS_REGION ??
      "us-east-1";
    const accessKeyId = await requireSecret(this.secrets, this.name, {
      key: "provider:bedrock:accessKeyId",
      env: "AWS_ACCESS_KEY_ID",
      description: "access key"
    });
    const secretAccessKey = await requireSecret(this.secrets, this.name, {
      key: "provider:bedrock:secretAccessKey",
      env: "AWS_SECRET_ACCESS_KEY",
      description: "secret access key"
    });
    const sessionToken =
      (await this.secrets.get("provider:bedrock:sessionToken")) ?? process.env.AWS_SESSION_TOKEN;
    return { region, accessKeyId, secretAccessKey, sessionToken: sessionToken ?? undefined };
  }

  private areCredentialsEqual(
    previous?: {
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    },
    next?: {
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    }
  ): previous is {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  } {
    return Boolean(
      previous &&
        next &&
        previous.region === next.region &&
        previous.accessKeyId === next.accessKeyId &&
        previous.secretAccessKey === next.secretAccessKey &&
        (previous.sessionToken ?? "") === (next.sessionToken ?? "")
    );
  }

  private async disposeExistingClient(promise?: Promise<BedrockClient>): Promise<void> {
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
    const { client, credentials } = await this.getClient();
    const systemMessage = req.messages.find(msg => msg.role === "system")?.content;
    const modelId = req.model ?? this.options.defaultModel ?? "anthropic.claude-3-sonnet-20240229-v1:0";
    const region = credentials.region;
    if (!region) {
      throw new ProviderError("AWS region not resolved in client credentials", {
        status: 500,
        provider: this.name,
        retryable: false
      });
    }
    const targetUrl =
      `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;
    const payload = {
      anthropic_version: "bedrock-2023-05-31",
      system: systemMessage,
      max_tokens: this.options.maxTokens ?? 1024,
      messages: toBedrockMessages(req.messages)
    };

    const response = await callWithRetry(
      async () => {
        ensureProviderEgress(this.name, targetUrl, {
          action: "provider.request",
          metadata: { operation: "invokeModel", model: modelId, region }
        });
        try {
          return await client.invokeModel({
            modelId,
            contentType: "application/json",
            accept: "application/json",
            body: Buffer.from(JSON.stringify(payload), "utf-8")
          });
        } catch (error) {
          throw this.normalizeError(error);
        }
      },
      { attempts: this.options.retryAttempts ?? 2 }
    );

    const rawBody = await decodeBedrockBody(response.body as Uint8Array | undefined);
    let parsed: unknown = {};
    if (rawBody) {
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = { outputText: rawBody };
      }
    }

    const output = extractBedrockText(parsed).trim();
    if (!output) {
      throw new ProviderError("Bedrock returned an empty response", {
        status: 502,
        provider: this.name,
        retryable: false
      });
    }

    const parsedRecord = isRecord(parsed) ? parsed : {};
    const usageCandidate =
      parsedRecord.usage ?? parsedRecord.generationUsage ?? parsedRecord.metrics;
    const usageRecord = isRecord(usageCandidate) ? usageCandidate : undefined;
    const promptTokensRaw =
      usageRecord?.input_tokens ?? usageRecord?.prompt_tokens ?? usageRecord?.inputTokens;
    const completionTokensRaw =
      usageRecord?.output_tokens ?? usageRecord?.completion_tokens ?? usageRecord?.outputTokens;
    const totalTokensRaw = usageRecord?.total_tokens ?? usageRecord?.totalTokens;
    const promptTokens = typeof promptTokensRaw === "number" ? promptTokensRaw : undefined;
    const completionTokens = typeof completionTokensRaw === "number" ? completionTokensRaw : undefined;
    const totalTokens = typeof totalTokensRaw === "number"
      ? totalTokensRaw
      : typeof promptTokens === "number" && typeof completionTokens === "number"
        ? promptTokens + completionTokens
        : undefined;

    return {
      output,
      provider: this.name,
      usage:
        typeof promptTokens === "number" || typeof completionTokens === "number" || typeof totalTokens === "number"
          ? {
              promptTokens,
              completionTokens,
              totalTokens
            }
          : undefined
    };
  }

  private normalizeError(error: unknown): ProviderError {
    if (error instanceof ProviderError) {
      return error;
    }
    type BedrockMetadata = { httpStatusCode?: unknown };
    type BedrockErrorLike = {
      $metadata?: BedrockMetadata;
      statusCode?: unknown;
      name?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const details: BedrockErrorLike | undefined =
      typeof error === "object" && error !== null ? (error as BedrockErrorLike) : undefined;
    const statusCandidate =
      typeof details?.$metadata?.httpStatusCode === "number"
        ? details.$metadata.httpStatusCode
        : typeof details?.statusCode === "number"
          ? details.statusCode
          : undefined;
    const name = typeof details?.name === "string" ? details.name : undefined;
    const code = typeof details?.code === "string" ? details.code : name;
    const message =
      typeof details?.message === "string" ? details.message : "Bedrock request failed";
    const status = statusCandidate;
    const retryableCodes = new Set(["ThrottlingException", "InternalServerException", "ServiceUnavailableException"]);
    const retryable =
      status === 429 || status === 408 || (typeof status === "number" ? status >= 500 : false) ||
      (typeof code === "string" && retryableCodes.has(code));
    return new ProviderError(message, {
      status: status ?? 502,
      code: typeof code === "string" ? code : undefined,
      provider: this.name,
      retryable,
      cause: error
    });
  }
}
