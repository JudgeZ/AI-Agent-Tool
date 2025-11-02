import { loadConfig } from "../config.js";
import { LocalFileStore, VaultStore, type SecretsStore } from "../auth/SecretsStore.js";
import type { ChatRequest, ChatResponse, ModelProvider } from "./interfaces.js";
import { AzureOpenAIProvider } from "./azureOpenAI.js";
import { AnthropicProvider } from "./anthropic.js";
import { BedrockProvider } from "./bedrock.js";
import { GoogleProvider } from "./google.js";
import { MistralProvider } from "./mistral.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { ProviderError } from "./utils.js";
import { CircuitBreaker, RateLimiter, type CircuitBreakerOptions, type RateLimiterOptions } from "./resilience.js";

let secretsStore: SecretsStore | undefined;
let cachedRegistry: Record<string, ModelProvider> | undefined;
const overrides = new Map<string, ModelProvider>();
let rateLimiter: RateLimiter | undefined;
let rateLimiterOptions: RateLimiterOptions | undefined;
let circuitBreaker: CircuitBreaker | undefined;
let circuitBreakerOptions: CircuitBreakerOptions | undefined;

function cloneRateLimiterOptions(options: RateLimiterOptions): RateLimiterOptions {
  return {
    windowMs: options.windowMs,
    maxRequests: options.maxRequests
  };
}

function cloneCircuitBreakerOptions(options: CircuitBreakerOptions): CircuitBreakerOptions {
  return {
    failureThreshold: options.failureThreshold,
    resetTimeoutMs: options.resetTimeoutMs
  };
}

function getRateLimiter(options: RateLimiterOptions): RateLimiter {
  const normalized = cloneRateLimiterOptions(options);
  if (!rateLimiter || !rateLimiterOptions || hasRateLimiterChanged(rateLimiterOptions, normalized)) {
    rateLimiter = new RateLimiter(normalized);
    rateLimiterOptions = normalized;
  }
  return rateLimiter;
}

function hasRateLimiterChanged(prev: RateLimiterOptions, next: RateLimiterOptions): boolean {
  return prev.windowMs !== next.windowMs || prev.maxRequests !== next.maxRequests;
}

function getCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  const normalized = cloneCircuitBreakerOptions(options);
  if (!circuitBreaker || !circuitBreakerOptions || hasCircuitBreakerChanged(circuitBreakerOptions, normalized)) {
    circuitBreaker = new CircuitBreaker(normalized);
    circuitBreakerOptions = normalized;
  }
  return circuitBreaker;
}

function hasCircuitBreakerChanged(prev: CircuitBreakerOptions, next: CircuitBreakerOptions): boolean {
  return prev.failureThreshold !== next.failureThreshold || prev.resetTimeoutMs !== next.resetTimeoutMs;
}

export function getSecretsStore(): SecretsStore {
  if (!secretsStore) {
    const cfg = loadConfig();
    secretsStore = cfg.secrets.backend === "vault" ? new VaultStore() : new LocalFileStore();
  }
  return secretsStore;
}

function buildRegistry(): Record<string, ModelProvider> {
  if (!cachedRegistry) {
    const secrets = getSecretsStore();
    cachedRegistry = {
      openai: new OpenAIProvider(secrets),
      anthropic: new AnthropicProvider(secrets),
      google: new GoogleProvider(secrets),
      azureopenai: new AzureOpenAIProvider(secrets),
      bedrock: new BedrockProvider(secrets),
      mistral: new MistralProvider(secrets),
      openrouter: new OpenRouterProvider(secrets),
      local_ollama: new OllamaProvider(secrets)
    };
  }
  return cachedRegistry;
}

export function getProvider(name: string): ModelProvider | undefined {
  if (overrides.has(name)) {
    return overrides.get(name);
  }
  return buildRegistry()[name];
}

export function setProviderOverride(name: string, provider: ModelProvider | undefined): void {
  if (provider) {
    overrides.set(name, provider);
  } else {
    overrides.delete(name);
  }
}

export function clearProviderOverrides(): void {
  overrides.clear();
}

export function __resetProviderResilienceForTests(): void {
  rateLimiter?.reset();
  circuitBreaker?.reset();
  rateLimiter = undefined;
  rateLimiterOptions = undefined;
  circuitBreaker = undefined;
  circuitBreakerOptions = undefined;
}

export async function routeChat(req: ChatRequest): Promise<ChatResponse> {
  const cfg = loadConfig();
  const enabled = cfg.providers.enabled.map(p => p.trim()).filter(Boolean);
  if (enabled.length === 0) {
    throw new ProviderError("No providers are enabled for chat", {
      status: 503,
      provider: "router",
      retryable: false
    });
  }

  const warnings: string[] = [];
  const errors: ProviderError[] = [];
  const limiter = getRateLimiter(cfg.providers.rateLimit);
  const breaker = getCircuitBreaker(cfg.providers.circuitBreaker);

  for (const providerName of enabled) {
    const provider = getProvider(providerName);
    if (!provider) {
      warnings.push(`${providerName}: provider not registered`);
      errors.push(
        new ProviderError(`Provider ${providerName} is not registered`, {
          status: 503,
          provider: providerName,
          retryable: false
        })
      );
      continue;
    }

    try {
      const response = await limiter.schedule(provider.name, () => breaker.execute(provider.name, () => provider.chat(req)));
      const mergedWarnings = warnings.length
        ? [...warnings, ...(response.warnings ?? [])]
        : response.warnings;
      return {
        ...response,
        provider: response.provider ?? provider.name,
        warnings: mergedWarnings?.length ? mergedWarnings : undefined
      };
    } catch (error) {
              const providerError =
                error instanceof ProviderError
                  ? error
                  : (() => {
                      type ErrorLike = { status?: unknown };
                      const details: ErrorLike | undefined =
                        typeof error === "object" && error !== null ? (error as ErrorLike) : undefined;
                      const status = typeof details?.status === "number" ? details.status : 502;
                      return new ProviderError(
                        error instanceof Error ? error.message : "Provider request failed",
                        {
                          status,
                          provider: provider.name,
                          retryable: false,
                          cause: error
                        }
                      );
                    })();
      warnings.push(`${provider.name}: ${providerError.message}`);
      errors.push(providerError);
    }
  }

  const message = errors.length
    ? errors.map(err => `[${err.provider ?? "unknown"}] ${err.message}`).join("; ")
    : "All providers failed";
  const status =
    errors.find(err => err.status >= 400 && err.status < 500)?.status ??
    errors[errors.length - 1]?.status ??
    502;
  throw new ProviderError(message, {
    status,
    provider: "router",
    retryable: errors.some(err => err.retryable),
    details: errors.map(err => ({ provider: err.provider ?? "unknown", message: err.message, status: err.status }))
  });
}
