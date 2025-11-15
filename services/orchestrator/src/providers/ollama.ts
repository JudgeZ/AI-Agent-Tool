import type { SecretsStore } from "../auth/SecretsStore.js";
import type { ChatRequest, ChatResponse, ModelProvider } from "./interfaces.js";
import { callWithRetry, ProviderError, ensureProviderEgress } from "./utils.js";

type FetcherInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

type FetcherResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
};

type Fetcher = (input: string, init?: FetcherInit) => Promise<FetcherResponse>;

export type OllamaProviderOptions = {
  defaultModel?: string;
  retryAttempts?: number;
  fetch?: Fetcher;
  timeoutMs?: number;
};

function sanitizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

type OllamaPayload = unknown;

function extractOllamaText(payload: OllamaPayload): string {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload === "object" && payload !== null) {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.response === "string") return obj.response;
    if (obj.message && typeof obj.message === "object" && obj.message !== null) {
      const message = obj.message as Record<string, unknown>;
      if (typeof message.content === "string") return message.content;
    }
    if (Array.isArray(obj.messages)) {
      const last = obj.messages[obj.messages.length - 1];
      if (last && typeof last === "object" && last !== null) {
        const lastMsg = last as Record<string, unknown>;
        if (typeof lastMsg.content === "string") {
          return lastMsg.content;
        }
      }
    }
    if (Array.isArray(obj.choices)) {
      const choice = obj.choices[0];
      if (choice && typeof choice === "object" && choice !== null) {
        const choiceObj = choice as Record<string, unknown>;
        if (choiceObj.message && typeof choiceObj.message === "object" && choiceObj.message !== null) {
          const message = choiceObj.message as Record<string, unknown>;
          if (message.content) {
            return String(message.content);
          }
        }
      }
    }
  }
  return "";
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { name?: unknown };
  return candidate.name === "AbortError";
}

function extractUsage(payload: OllamaPayload) {
  if (!payload || typeof payload !== "object" || payload === null) return undefined;
  const obj = payload as Record<string, unknown>;
  const usage = obj.usage;
  if (!usage || typeof usage !== "object" || usage === null) return undefined;
  const usageObj = usage as Record<string, unknown>;
  const promptRaw = usageObj.prompt_tokens ?? usageObj.promptTokens;
  const completionRaw = usageObj.completion_tokens ?? usageObj.completionTokens;
  const promptTokens = typeof promptRaw === "number" ? promptRaw : undefined;
  const completionTokens = typeof completionRaw === "number" ? completionRaw : undefined;
  const totalFromUsage = usageObj.total_tokens ?? usageObj.totalTokens;
  const totalTokens = typeof totalFromUsage === "number"
    ? totalFromUsage
    : typeof promptTokens === "number" && typeof completionTokens === "number"
      ? promptTokens + completionTokens
      : undefined;
  if (promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined) {
    return { promptTokens, completionTokens, totalTokens };
  }
  return undefined;
}

export class OllamaProvider implements ModelProvider {
  name = "local_ollama";
  private readonly fetcher: Fetcher;
  private readonly timeoutMs: number;

  constructor(private readonly secrets: SecretsStore, private readonly options: OllamaProviderOptions = {}) {
    if (options.fetch) {
      this.fetcher = options.fetch;
    } else if (typeof globalThis.fetch === "function") {
      this.fetcher = globalThis.fetch.bind(globalThis);
    } else {
      throw new ProviderError("No fetch implementation available for Ollama provider", {
        status: 500,
        provider: "local_ollama",
        retryable: false
      });
    }
    if (options.timeoutMs === undefined) {
      this.timeoutMs = 10_000;
    } else {
      if (
        typeof options.timeoutMs !== "number" ||
        !Number.isFinite(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        !Number.isInteger(options.timeoutMs)
      ) {
        throw new ProviderError("OllamaProvider: timeoutMs must be a positive integer in milliseconds", {
          status: 400,
          provider: this.name,
          retryable: false,
        });
      }
      this.timeoutMs = options.timeoutMs;
    }
  }

  private async fetchWithTimeout(input: string, init: FetcherInit): Promise<FetcherResponse> {
    if (this.timeoutMs <= 0) {
      return this.fetcher(input, init);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetcher(input, { ...init, signal: controller.signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw new ProviderError(`Ollama request timed out after ${this.timeoutMs}ms`, {
          status: 504,
          provider: this.name,
          retryable: true,
          cause: error
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveBaseUrl(): Promise<string> {
    const fromSecret = await this.secrets.get("provider:ollama:baseUrl");
    const fromEnv = process.env.OLLAMA_BASE_URL;
    return sanitizeBaseUrl(fromSecret ?? fromEnv ?? "http://127.0.0.1:11434");
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model ?? this.options.defaultModel ?? "llama3.1";
    const baseUrl = await this.resolveBaseUrl();
    const payload = {
      model,
      messages: req.messages,
      stream: false
    };

    const targetUrl = `${baseUrl}/api/chat`;

    const body = await callWithRetry(
      async () => {
        let response: FetcherResponse;
        ensureProviderEgress(this.name, targetUrl, {
          action: "provider.request",
          metadata: { operation: "chat", model }
        });
        try {
          response = await this.fetchWithTimeout(targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
        } catch (error) {
          if (error instanceof ProviderError) {
            throw error;
          }
          throw new ProviderError("Failed to reach Ollama", {
            status: 503,
            provider: this.name,
            retryable: true,
            cause: error
          });
        }
        if (!response.ok) {
          throw new ProviderError(`Ollama responded with ${response.status}`, {
            status: response.status,
            provider: this.name,
            retryable: response.status >= 500
          });
        }
        try {
          return await response.json();
        } catch (error) {
          throw new ProviderError("Failed to parse Ollama response", {
            status: 502,
            provider: this.name,
            retryable: false,
            cause: error
          });
        }
      },
      { attempts: this.options.retryAttempts ?? 2 }
    );

    const output = extractOllamaText(body).trim();
    if (!output) {
      throw new ProviderError("Ollama returned an empty response", {
        status: 502,
        provider: this.name,
        retryable: false
      });
    }

    return {
      output,
      provider: this.name,
      usage: extractUsage(body)
    };
  }
}
