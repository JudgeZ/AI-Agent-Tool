import { loadConfig, type AppConfig, type ProviderRuntimeConfig } from "../config.js";
import { LocalFileStore, VaultStore, type SecretsStore } from "../auth/SecretsStore.js";
import { VersionedSecretsManager } from "../auth/VersionedSecretsManager.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import { withSpan } from "../observability/tracing.js";
import {
  createRateLimitStore,
  type RateLimitBackendConfig,
  type RateLimitStore,
} from "../rateLimit/store.js";
import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ProviderContext,
  RoutingMode,
} from "./interfaces.js";
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
import { getProviderCapabilities } from "./capabilities.js";

let secretsStore: SecretsStore | undefined;
let versionedSecretsManager: VersionedSecretsManager | undefined;
let cachedRegistry: Record<string, ModelProvider> | undefined;
const overrides = new Map<string, ModelProvider>();
let rateLimiter: RateLimiter | undefined;
let rateLimiterOptions: RateLimiterOptions | undefined;
let rateLimitStore: RateLimitStore | undefined;
let rateLimitBackendOptions: RateLimitBackendConfig | undefined;
let circuitBreaker: CircuitBreaker | undefined;
let circuitBreakerOptions: CircuitBreakerOptions | undefined;

const MIN_REQUEST_TEMPERATURE = 0;
const MAX_REQUEST_TEMPERATURE = 2;

function cloneRateLimiterOptions(options: RateLimiterOptions): RateLimiterOptions {
  return {
    windowMs: options.windowMs,
    maxRequests: options.maxRequests,
  };
}

function cloneRateLimitBackendConfig(options: RateLimitBackendConfig): RateLimitBackendConfig {
  return {
    provider: options.provider,
    redisUrl: options.redisUrl,
  };
}

function cloneCircuitBreakerOptions(options: CircuitBreakerOptions): CircuitBreakerOptions {
  return {
    failureThreshold: options.failureThreshold,
    resetTimeoutMs: options.resetTimeoutMs
  };
}

function getRateLimiter(options: RateLimiterOptions, backend: RateLimitBackendConfig): RateLimiter {
  const normalized = cloneRateLimiterOptions(options);
  const store = getRateLimitStore(backend);
  if (!rateLimiter || !rateLimiterOptions || hasRateLimiterChanged(rateLimiterOptions, normalized)) {
    rateLimiter = new RateLimiter(normalized, store);
    rateLimiterOptions = normalized;
  }
  return rateLimiter;
}

function getRateLimitStore(backend: RateLimitBackendConfig): RateLimitStore {
  const normalizedBackend = cloneRateLimitBackendConfig(backend);
  if (!rateLimitStore || !rateLimitBackendOptions || hasRateLimitBackendChanged(rateLimitBackendOptions, normalizedBackend)) {
    if (rateLimitStore && typeof rateLimitStore.disconnect === "function") {
      void rateLimitStore.disconnect().catch(() => {
        /* best effort */
      });
    }
    rateLimitStore = createRateLimitStore(normalizedBackend, {
      prefix: "orchestrator:provider-ratelimit",
      logger: appLogger.child({ component: "provider-rate-limiter" }),
    });
    rateLimitBackendOptions = normalizedBackend;
  }
  return rateLimitStore;
}

function hasRateLimiterChanged(prev: RateLimiterOptions, next: RateLimiterOptions): boolean {
  return prev.windowMs !== next.windowMs || prev.maxRequests !== next.maxRequests;
}

function hasRateLimitBackendChanged(prev: RateLimitBackendConfig, next: RateLimitBackendConfig): boolean {
  return prev.provider !== next.provider || prev.redisUrl !== next.redisUrl;
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

export function getVersionedSecretsManager(): VersionedSecretsManager {
  if (!versionedSecretsManager) {
    versionedSecretsManager = new VersionedSecretsManager(getSecretsStore());
  }
  return versionedSecretsManager;
}

function buildRegistry(): Record<string, ModelProvider> {
  if (!cachedRegistry) {
    const secrets = getSecretsStore();
    const cfg = loadConfig();
    const openaiSettings = getProviderSettings(cfg, "openai");
    const azureSettings = getProviderSettings(cfg, "azureopenai");
    const mistralSettings = getProviderSettings(cfg, "mistral");
    const openRouterSettings = getProviderSettings(cfg, "openrouter");
    const bedrockSettings = getProviderSettings(cfg, "bedrock");
    cachedRegistry = {
      openai: new OpenAIProvider(secrets, {
        defaultTemperature: openaiSettings?.defaultTemperature,
        timeoutMs: openaiSettings?.timeoutMs,
      }),
      anthropic: new AnthropicProvider(secrets),
      google: new GoogleProvider(secrets),
      azureopenai: new AzureOpenAIProvider(secrets, {
        defaultTemperature: azureSettings?.defaultTemperature,
        timeoutMs: azureSettings?.timeoutMs,
      }),
      bedrock: new BedrockProvider(secrets, {
        timeoutMs: bedrockSettings?.timeoutMs,
      }),
      mistral: new MistralProvider(secrets, {
        defaultTemperature: mistralSettings?.defaultTemperature,
        timeoutMs: mistralSettings?.timeoutMs,
      }),
      openrouter: new OpenRouterProvider(secrets, {
        defaultTemperature: openRouterSettings?.defaultTemperature,
        timeoutMs: openRouterSettings?.timeoutMs,
      }),
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
  if (rateLimitStore && typeof rateLimitStore.disconnect === "function") {
    void rateLimitStore.disconnect().catch(() => undefined);
  }
  rateLimiter = undefined;
  rateLimiterOptions = undefined;
  rateLimitStore = undefined;
  rateLimitBackendOptions = undefined;
  circuitBreaker = undefined;
  circuitBreakerOptions = undefined;
}

const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function normalizeProviderId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (!PROVIDER_NAME_PATTERN.test(normalized)) {
    return undefined;
  }
  return normalized;
}

type ProviderOrder = { providers: string[]; routingMode: RoutingMode };

function cloneChatRequest(req: ChatRequest): ChatRequest {
  return { ...req };
}

function assertRequestTemperature(value: number, providerName: string): number {
  if (!Number.isFinite(value) || value < MIN_REQUEST_TEMPERATURE || value > MAX_REQUEST_TEMPERATURE) {
    throw new ProviderError(
      `Temperature override for provider ${providerName} must be a finite number between ${MIN_REQUEST_TEMPERATURE} and ${MAX_REQUEST_TEMPERATURE} (received ${value})`,
      {
        status: 400,
        provider: "router",
        retryable: false,
      },
    );
  }
  return value;
}

function buildProviderRequest(
  req: ChatRequest,
  providerName: string,
  cfg: AppConfig,
): { request: ChatRequest; warnings: string[] } {
  const capability = getProviderCapabilities(providerName);
  const warnings: string[] = [];
  const request = cloneChatRequest(req);
  if (!capability.supportsTemperature) {
    if (typeof req.temperature === "number") {
      warnings.push(`${providerName}: temperature is not supported and was ignored`);
    }
    delete (request as { temperature?: number }).temperature;
    return { request, warnings };
  }
  const existingTemperature = req.temperature;
  if (typeof existingTemperature === "number") {
    request.temperature = assertRequestTemperature(existingTemperature, providerName);
    return { request, warnings };
  }
  const providerSetting = getProviderSettings(cfg, providerName);
  const fallbackTemperature = providerSetting?.defaultTemperature ?? capability.defaultTemperature;
  if (typeof fallbackTemperature === "number") {
    request.temperature = fallbackTemperature;
  } else {
    delete (request as { temperature?: number }).temperature;
  }
  return { request, warnings };
}

function getProviderSettings(cfg: AppConfig, provider: string): ProviderRuntimeConfig | undefined {
  const normalized = provider.trim().toLowerCase();
  return cfg.providers.settings[normalized];
}

function determineProviderOrder(req: ChatRequest, cfg: AppConfig): ProviderOrder {
  const enabled = cfg.providers.enabled.map(provider => {
    const normalized = normalizeProviderId(provider);
    if (!normalized) {
      throw new ProviderError(`Configured provider name "${provider}" is invalid`, {
        status: 500,
        provider: "router",
        retryable: false,
      });
    }
    return normalized;
  });
  if (enabled.length === 0) {
    throw new ProviderError("No providers are enabled for chat", {
      status: 503,
      provider: "router",
      retryable: false
    });
  }

  const requestedProvider = normalizeProviderId(req.provider);
  if (req.provider && !requestedProvider) {
    throw new ProviderError("Requested provider is invalid", {
      status: 400,
      provider: "router",
      retryable: false
    });
  }

  const selectedRoute = req.routing ?? cfg.providers.defaultRoute ?? "balanced";

  if (requestedProvider) {
    if (!enabled.includes(requestedProvider)) {
      throw new ProviderError(`Provider ${req.provider} is not enabled`, {
        status: 404,
        provider: "router",
        retryable: false
      });
    }
    return { providers: [requestedProvider], routingMode: selectedRoute };
  }

  const prioritizedList = cfg.providers.routingPriority[selectedRoute] ?? [];
  if (!prioritizedList || prioritizedList.length === 0) {
    return { providers: enabled, routingMode: selectedRoute };
  }

  const enabledSet = new Set(enabled);
  const prioritized = prioritizedList.filter(provider => enabledSet.has(provider));
  const prioritizedSet = new Set(prioritized);
  const remaining = enabled.filter(provider => !prioritizedSet.has(provider));
  const orderedProviders = [...prioritized, ...remaining];
  if (orderedProviders.length === 0) {
    throw new ProviderError(`No providers are available for the ${selectedRoute} route`, {
      status: 503,
      provider: "router",
      retryable: false
    });
  }
  return { providers: orderedProviders, routingMode: selectedRoute };
}

export async function routeChat(
  req: ChatRequest,
  context?: ProviderContext,
): Promise<ChatResponse> {
  const cfg = loadConfig();
  const routingHint = req.routing ?? cfg.providers.defaultRoute ?? "balanced";
  return withSpan(
    "providers.routeChat",
    async routeSpan => {
      const { providers: orderedProviders, routingMode } = determineProviderOrder(req, cfg);
      routeSpan.setAttribute("providers.routing_mode", routingMode);
      if (req.provider) {
        routeSpan.setAttribute("providers.provider_hint", req.provider);
      }
      if (req.model) {
        routeSpan.setAttribute("providers.model", req.model);
      }
      if (typeof req.temperature === "number") {
        routeSpan.setAttribute("providers.temperature", req.temperature);
      }

      const logger = appLogger.child({ component: "provider-router", routing: routingMode });
      logger.debug(
        {
          event: "provider_routing.start",
          providerHint: req.provider ?? "auto",
          routingHint: req.routing ?? routingMode
        },
        "Routing chat request",
      );

      const warnings: string[] = [];
      const errors: ProviderError[] = [];
      const limiter = getRateLimiter(cfg.providers.rateLimit, cfg.server.rateLimits.backend);
      const breaker = getCircuitBreaker(cfg.providers.circuitBreaker);

      for (const providerName of orderedProviders) {
        const provider = getProvider(providerName);
        if (!provider) {
          const warning = `${providerName}: provider not registered`;
          warnings.push(warning);
          const error = new ProviderError(`Provider ${providerName} is not registered`, {
            status: 503,
            provider: providerName,
            retryable: false
          });
          errors.push(error);
          logger.warn(
            {
              event: "provider_attempt.failure",
              provider: providerName,
              routing: routingMode,
              status: error.status,
              retryable: error.retryable
            },
            warning,
          );
          continue;
        }

        const attemptMeta = { provider: provider.name, routing: routingMode };
        const attemptStart = Date.now();
        const { request: providerRequest, warnings: capabilityWarnings } = buildProviderRequest(req, provider.name, cfg);
        if (capabilityWarnings.length) {
          warnings.push(...capabilityWarnings);
        }
        const invokeProvider = context === undefined
          ? () => provider.chat(providerRequest)
          : () => provider.chat(providerRequest, context);
        try {
          const response = await withSpan(
            "providers.routeChat.attempt",
            async attemptSpan => {
              attemptSpan.setAttribute("providers.provider", provider.name);
              attemptSpan.setAttribute("providers.routing_mode", routingMode);
              const result = await limiter.schedule(provider.name, () =>
                breaker.execute(provider.name, invokeProvider),
              );
              attemptSpan.addEvent("provider_attempt.success", {
                provider: provider.name,
                routing: routingMode
              });
              return result;
            },
            attemptMeta,
          );
          const mergedWarnings = warnings.length
            ? [...warnings, ...(response.warnings ?? [])]
            : response.warnings;
          const durationMs = Date.now() - attemptStart;
          logger.info(
            {
              event: "provider_attempt.success",
              ...attemptMeta,
              durationMs,
              warnings: mergedWarnings?.length ? mergedWarnings.length : 0
            },
            "Provider handled chat request",
          );
          routeSpan.addEvent("provider_routing.success", {
            provider: provider.name,
            routing: routingMode,
            durationMs
          });
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
          const durationMs = Date.now() - attemptStart;
          warnings.push(`${provider.name}: ${providerError.message}`);
          errors.push(providerError);
          logger.warn(
            {
              event: "provider_attempt.failure",
              ...attemptMeta,
              status: providerError.status,
              retryable: providerError.retryable,
              durationMs,
              err: normalizeError(providerError)
            },
            providerError.message,
          );
        }
      }

      const message = errors.length
        ? errors.map(err => `[${err.provider ?? "unknown"}] ${err.message}`).join("; ")
        : "All providers failed";
      const status =
        errors.find(err => err.status >= 400 && err.status < 500)?.status ??
        errors[errors.length - 1]?.status ??
        502;
      const aggregatedError = new ProviderError(message, {
        status,
        provider: "router",
        retryable: errors.some(err => err.retryable),
        details: errors.map(err => ({ provider: err.provider ?? "unknown", message: err.message, status: err.status }))
      });
      logger.error(
        {
          event: "provider_routing.failed",
          providerHint: req.provider ?? "auto",
          routing: routingMode,
          attempts: orderedProviders.length,
          warnings,
          err: normalizeError(aggregatedError)
        },
        aggregatedError.message,
      );
      routeSpan.addEvent("provider_routing.failed", {
        routing: routingMode,
        attempts: orderedProviders.length
      });
      throw aggregatedError;
    },
    {
      routing_hint: routingHint,
      provider_hint: req.provider ?? "auto"
    }
  );
}
