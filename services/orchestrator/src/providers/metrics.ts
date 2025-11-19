import { Counter, Histogram, Gauge, register } from "prom-client";
import { getDefaultTenantLabel, resolveTenantLabel } from "../observability/metrics.js";

// Metric names following Prometheus naming conventions
const PROVIDER_REQUEST_DURATION_NAME = "provider_request_duration_seconds";
const PROVIDER_REQUESTS_TOTAL_NAME = "provider_requests_total";
const PROVIDER_ERRORS_TOTAL_NAME = "provider_errors_total";
const PROVIDER_TOKEN_USAGE_NAME = "provider_token_usage_total";
const PROVIDER_CACHE_HITS_NAME = "provider_cache_hits_total";
const PROVIDER_CACHE_MISSES_NAME = "provider_cache_misses_total";
const PROVIDER_RATE_LIMIT_NAME = "provider_rate_limit_hits_total";
const PROVIDER_CIRCUIT_BREAKER_NAME = "provider_circuit_breaker_state";
const PROVIDER_ACTIVE_REQUESTS_NAME = "provider_active_requests";
const PROVIDER_CLIENT_ROTATIONS_NAME = "provider_client_rotations_total";

/**
 * Provider metrics context for tracking request details
 */
export interface ProviderMetricsContext {
  provider: string;
  model?: string;
  operation?: string;
  tenantId?: string;
  cacheEnabled?: boolean;
}

/**
 * Token usage information from provider responses
 */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

// Lazy-initialized metrics instances
let requestDurationHistogram: Histogram<string> | undefined;
let requestsCounter: Counter<string> | undefined;
let errorsCounter: Counter<string> | undefined;
let tokenUsageCounter: Counter<string> | undefined;
let cacheHitsCounter: Counter<string> | undefined;
let cacheMissesCounter: Counter<string> | undefined;
let rateLimitCounter: Counter<string> | undefined;
let circuitBreakerGauge: Gauge<string> | undefined;
let activeRequestsGauge: Gauge<string> | undefined;
let clientRotationsCounter: Counter<string> | undefined;

/**
 * Get or create the request duration histogram
 */
function getRequestDurationHistogram(): Histogram<string> {
  if (!requestDurationHistogram) {
    const existing = register.getSingleMetric(PROVIDER_REQUEST_DURATION_NAME) as Histogram<string> | undefined;
    if (existing) {
      requestDurationHistogram = existing;
    } else {
      requestDurationHistogram = new Histogram({
        name: PROVIDER_REQUEST_DURATION_NAME,
        help: "Duration of provider API requests in seconds",
        labelNames: ["provider", "model", "operation", "status", "tenant"],
        buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60]
      });
    }
  }
  return requestDurationHistogram;
}

/**
 * Get or create the requests counter
 */
function getRequestsCounter(): Counter<string> {
  if (!requestsCounter) {
    const existing = register.getSingleMetric(PROVIDER_REQUESTS_TOTAL_NAME) as Counter<string> | undefined;
    if (existing) {
      requestsCounter = existing;
    } else {
      requestsCounter = new Counter({
        name: PROVIDER_REQUESTS_TOTAL_NAME,
        help: "Total number of requests to providers",
        labelNames: ["provider", "model", "operation", "tenant"]
      });
    }
  }
  return requestsCounter;
}

/**
 * Get or create the errors counter
 */
function getErrorsCounter(): Counter<string> {
  if (!errorsCounter) {
    const existing = register.getSingleMetric(PROVIDER_ERRORS_TOTAL_NAME) as Counter<string> | undefined;
    if (existing) {
      errorsCounter = existing;
    } else {
      errorsCounter = new Counter({
        name: PROVIDER_ERRORS_TOTAL_NAME,
        help: "Total number of provider errors",
        labelNames: ["provider", "model", "operation", "error_type", "status_code", "tenant"]
      });
    }
  }
  return errorsCounter;
}

/**
 * Get or create the token usage counter
 */
function getTokenUsageCounter(): Counter<string> {
  if (!tokenUsageCounter) {
    const existing = register.getSingleMetric(PROVIDER_TOKEN_USAGE_NAME) as Counter<string> | undefined;
    if (existing) {
      tokenUsageCounter = existing;
    } else {
      tokenUsageCounter = new Counter({
        name: PROVIDER_TOKEN_USAGE_NAME,
        help: "Total token usage by provider",
        labelNames: ["provider", "model", "type", "tenant"]
      });
    }
  }
  return tokenUsageCounter;
}

/**
 * Get or create the cache hits counter
 */
function getCacheHitsCounter(): Counter<string> {
  if (!cacheHitsCounter) {
    const existing = register.getSingleMetric(PROVIDER_CACHE_HITS_NAME) as Counter<string> | undefined;
    if (existing) {
      cacheHitsCounter = existing;
    } else {
      cacheHitsCounter = new Counter({
        name: PROVIDER_CACHE_HITS_NAME,
        help: "Total number of provider cache hits",
        labelNames: ["provider", "model", "tenant"]
      });
    }
  }
  return cacheHitsCounter;
}

/**
 * Get or create the cache misses counter
 */
function getCacheMissesCounter(): Counter<string> {
  if (!cacheMissesCounter) {
    const existing = register.getSingleMetric(PROVIDER_CACHE_MISSES_NAME) as Counter<string> | undefined;
    if (existing) {
      cacheMissesCounter = existing;
    } else {
      cacheMissesCounter = new Counter({
        name: PROVIDER_CACHE_MISSES_NAME,
        help: "Total number of provider cache misses",
        labelNames: ["provider", "model", "tenant"]
      });
    }
  }
  return cacheMissesCounter;
}

/**
 * Get or create the rate limit counter
 */
function getRateLimitCounter(): Counter<string> {
  if (!rateLimitCounter) {
    const existing = register.getSingleMetric(PROVIDER_RATE_LIMIT_NAME) as Counter<string> | undefined;
    if (existing) {
      rateLimitCounter = existing;
    } else {
      rateLimitCounter = new Counter({
        name: PROVIDER_RATE_LIMIT_NAME,
        help: "Total number of rate limit hits by provider",
        labelNames: ["provider", "model", "tenant"]
      });
    }
  }
  return rateLimitCounter;
}

/**
 * Get or create the circuit breaker state gauge
 */
function getCircuitBreakerGauge(): Gauge<string> {
  if (!circuitBreakerGauge) {
    const existing = register.getSingleMetric(PROVIDER_CIRCUIT_BREAKER_NAME) as Gauge<string> | undefined;
    if (existing) {
      circuitBreakerGauge = existing;
    } else {
      circuitBreakerGauge = new Gauge({
        name: PROVIDER_CIRCUIT_BREAKER_NAME,
        help: "Circuit breaker state (0=closed, 1=open, 2=half-open)",
        labelNames: ["provider", "tenant"]
      });
    }
  }
  return circuitBreakerGauge;
}

/**
 * Get or create the active requests gauge
 */
function getActiveRequestsGauge(): Gauge<string> {
  if (!activeRequestsGauge) {
    const existing = register.getSingleMetric(PROVIDER_ACTIVE_REQUESTS_NAME) as Gauge<string> | undefined;
    if (existing) {
      activeRequestsGauge = existing;
    } else {
      activeRequestsGauge = new Gauge({
        name: PROVIDER_ACTIVE_REQUESTS_NAME,
        help: "Number of active requests to providers",
        labelNames: ["provider", "model", "operation", "tenant"]
      });
    }
  }
  if (!activeRequestsGauge) {
    throw new Error("Failed to initialize activeRequestsGauge");
  }
  return activeRequestsGauge;
}

/**
 * Get or create the client rotations counter
 */
function getClientRotationsCounter(): Counter<string> {
  if (!clientRotationsCounter) {
    const existing = register.getSingleMetric(PROVIDER_CLIENT_ROTATIONS_NAME) as Counter<string> | undefined;
    if (existing) {
      clientRotationsCounter = existing;
    } else {
      clientRotationsCounter = new Counter({
        name: PROVIDER_CLIENT_ROTATIONS_NAME,
        help: "Total number of provider client rotations due to credential changes",
        labelNames: ["provider", "reason", "tenant"]
      });
    }
  }
  return clientRotationsCounter;
}

/**
 * Start tracking a provider request
 * @returns A function to end the tracking and record metrics
 */
export function startProviderRequest(context: ProviderMetricsContext): () => void {
  const startTime = Date.now();
  const tenant = resolveTenantLabel(context.tenantId);
  const labels = {
    provider: context.provider,
    model: context.model || "unknown",
    operation: context.operation || "chat",
    tenant
  };

  // Increment request counter
  getRequestsCounter().labels(labels).inc();

  // Increment active requests
  getActiveRequestsGauge().labels(labels).inc();

  let ended = false;

  return () => {
    if (ended) return;
    ended = true;

    // Decrement active requests
    getActiveRequestsGauge().labels(labels).dec();

    // Record duration
    const duration = (Date.now() - startTime) / 1000;
    getRequestDurationHistogram().labels({
      ...labels,
      status: "success"
    }).observe(duration);
  };
}

/**
 * Record a provider error
 */
export function recordProviderError(
  context: ProviderMetricsContext,
  error: { status?: number; code?: string; retryable?: boolean }
): void {
  const tenant = resolveTenantLabel(context.tenantId);
  const errorType = error.code || (error.retryable ? "retryable" : "non_retryable");
  const statusCode = String(error.status || 500);

  getErrorsCounter().labels({
    provider: context.provider,
    model: context.model || "unknown",
    operation: context.operation || "chat",
    error_type: errorType,
    status_code: statusCode,
    tenant
  }).inc();
}

/**
 * Record token usage from a provider response
 */
export function recordTokenUsage(
  context: ProviderMetricsContext,
  usage: TokenUsage
): void {
  const tenant = resolveTenantLabel(context.tenantId);
  const counter = getTokenUsageCounter();
  const baseLabels = {
    provider: context.provider,
    model: context.model || "unknown",
    tenant
  };

  if (usage.promptTokens !== undefined && usage.promptTokens > 0) {
    counter.labels({
      ...baseLabels,
      type: "prompt"
    }).inc(usage.promptTokens);
  }

  if (usage.completionTokens !== undefined && usage.completionTokens > 0) {
    counter.labels({
      ...baseLabels,
      type: "completion"
    }).inc(usage.completionTokens);
  }

  if (usage.totalTokens !== undefined && usage.totalTokens > 0) {
    counter.labels({
      ...baseLabels,
      type: "total"
    }).inc(usage.totalTokens);
  }
}

/**
 * Record a cache hit
 */
export function recordCacheHit(context: ProviderMetricsContext): void {
  const tenant = resolveTenantLabel(context.tenantId);
  getCacheHitsCounter().labels({
    provider: context.provider,
    model: context.model || "unknown",
    tenant
  }).inc();
}

/**
 * Record a cache miss
 */
export function recordCacheMiss(context: ProviderMetricsContext): void {
  const tenant = resolveTenantLabel(context.tenantId);
  getCacheMissesCounter().labels({
    provider: context.provider,
    model: context.model || "unknown",
    tenant
  }).inc();
}

/**
 * Record a rate limit hit
 */
export function recordRateLimit(context: ProviderMetricsContext): void {
  const tenant = resolveTenantLabel(context.tenantId);
  getRateLimitCounter().labels({
    provider: context.provider,
    model: context.model || "unknown",
    tenant
  }).inc();
}

/**
 * Update circuit breaker state
 * @param state 0=closed (normal), 1=open (blocking), 2=half-open (testing)
 */
export function updateCircuitBreakerState(
  provider: string,
  state: number,
  tenantId?: string
): void {
  const tenant = resolveTenantLabel(tenantId);
  getCircuitBreakerGauge().labels({
    provider,
    tenant
  }).set(state);
}

/**
 * Record a client rotation event
 */
export function recordClientRotation(
  provider: string,
  reason: "credential_change" | "error" | "manual",
  tenantId?: string
): void {
  const tenant = resolveTenantLabel(tenantId);
  getClientRotationsCounter().labels({
    provider,
    reason,
    tenant
  }).inc();
}

/**
 * Provider request timer helper for measuring request duration
 */
export class ProviderRequestTimer {
  private readonly context: ProviderMetricsContext;
  private readonly startTime: number;
  private readonly endTracking: () => void;
  private ended = false;

  constructor(context: ProviderMetricsContext) {
    this.context = context;
    this.startTime = Date.now();
    this.endTracking = startProviderRequest(context);
  }

  /**
   * End the timer and record success metrics
   */
  success(tokenUsage?: TokenUsage): void {
    if (this.ended) return;
    this.ended = true;
    this.endTracking();

    if (tokenUsage) {
      recordTokenUsage(this.context, tokenUsage);
    }
  }

  /**
   * End the timer and record error metrics
   */
  error(error: { status?: number; code?: string; retryable?: boolean }): void {
    if (this.ended) return;
    this.ended = true;

    // Decrement active requests (endTracking won't be called)
    const tenant = resolveTenantLabel(this.context.tenantId);
    getActiveRequestsGauge().labels({
      provider: this.context.provider,
      model: this.context.model || "unknown",
      tenant
    }).dec();

    // Record duration with error status
    const duration = (Date.now() - this.startTime) / 1000;
    getRequestDurationHistogram().labels({
      provider: this.context.provider,
      model: this.context.model || "unknown",
      operation: this.context.operation || "chat",
      status: "error",
      tenant
    }).observe(duration);

    // Record error
    recordProviderError(this.context, error);
  }

  /**
   * Record a cache hit and end the timer
   */
  cacheHit(): void {
    if (this.ended) return;
    this.ended = true;
    this.endTracking();
    recordCacheHit(this.context);
  }
}

/**
 * Reset all provider metrics (mainly for testing)
 */
export function resetProviderMetrics(): void {
  requestDurationHistogram?.reset();
  requestsCounter?.reset();
  errorsCounter?.reset();
  tokenUsageCounter?.reset();
  cacheHitsCounter?.reset();
  cacheMissesCounter?.reset();
  rateLimitCounter?.reset();
  circuitBreakerGauge?.reset();
  activeRequestsGauge?.reset();
  clientRotationsCounter?.reset();
}
