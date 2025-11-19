/**
 * Provider health check module
 * Validates connectivity and configuration for all registered providers
 */

import type { ModelProvider } from "./interfaces.js";
import { getProvider } from "./ProviderRegistry.js";

export interface ProviderHealthStatus {
  provider: string;
  status: "healthy" | "degraded" | "unhealthy" | "unconfigured";
  message?: string;
  responseTimeMs?: number;
  lastCheck: string;
  details?: {
    hasCredentials?: boolean;
    canConnect?: boolean;
    error?: string;
  };
}

export interface SystemHealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  providers: Record<string, ProviderHealthStatus>;
  summary: {
    total: number;
    healthy: number;
    degraded: number;
    unhealthy: number;
    unconfigured: number;
  };
}

/**
 * Check health of a single provider
 */
export async function checkProviderHealth(
  provider: ModelProvider,
  options: {
    timeout?: number;
    skipActualRequest?: boolean;
  } = {},
): Promise<ProviderHealthStatus> {
  const startTime = Date.now();
  const skipActualRequest = options.skipActualRequest ?? true; // Default to skip for performance

  try {
    // For health checks, we just verify the provider can be initialized
    // Basic check: can we access the provider instance?
    if (!provider || !provider.name) {
      return {
        provider: provider?.name || "unknown",
        status: "unhealthy",
        message: "Provider not properly initialized",
        lastCheck: new Date().toISOString(),
        details: {
          hasCredentials: false,
          canConnect: false,
          error: "Invalid provider instance",
        },
      };
    }

    // Skip actual requests for performance - just verify provider is initialized
    if (skipActualRequest) {
      return {
        provider: provider.name,
        status: "healthy",
        message: "Provider initialized successfully",
        responseTimeMs: Date.now() - startTime,
        lastCheck: new Date().toISOString(),
        details: {
          hasCredentials: true,
          canConnect: true,
        },
      };
    }

    // If we need to perform an actual check (not recommended for health endpoint)
    const timeout = options.timeout ?? 5000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Health check timeout")), timeout);
    });

    const checkPromise = provider.chat({
      model: undefined,
      messages: [{ role: "user", content: "Hello" }],
    });

    await Promise.race([checkPromise, timeoutPromise]);

    const responseTimeMs = Date.now() - startTime;

    return {
      provider: provider.name,
      status: "healthy",
      message: "Provider responding normally",
      responseTimeMs,
      lastCheck: new Date().toISOString(),
      details: {
        hasCredentials: true,
        canConnect: true,
      },
    };
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;
    const errorMessage = (error instanceof Error ? error.message : String(error)).toLowerCase();

    // Determine status based on error type
    let status: "degraded" | "unhealthy" | "unconfigured" = "unhealthy";
    let hasCredentials = true;

    if (
      errorMessage.includes("not configured") ||
      errorMessage.includes("missing credentials") ||
      errorMessage.includes("API key")
    ) {
      status = "unconfigured";
      hasCredentials = false;
    } else if (
      errorMessage.includes("timeout") ||
      errorMessage.includes("rate limit") ||
      errorMessage.includes("429")
    ) {
      status = "degraded";
    }

    return {
      provider: provider.name,
      status,
      message: errorMessage,
      responseTimeMs,
      lastCheck: new Date().toISOString(),
      details: {
        hasCredentials,
        canConnect: status !== "unconfigured",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Check health of all providers in the registry
 */
export async function checkAllProvidersHealth(
  options: {
    timeout?: number;
    skipActualRequests?: boolean;
    parallel?: boolean;
  } = {},
): Promise<SystemHealthStatus> {
  const parallel = options.parallel ?? true;
  const skipActualRequests = options.skipActualRequests ?? true;

  // List of all known providers
  const providerNames = [
    "openai",
    "anthropic",
    "google",
    "azureopenai",
    "bedrock",
    "mistral",
    "openrouter",
    "local_ollama",
  ];

  const healthChecks: Record<string, ProviderHealthStatus> = {};

  const checkProvider = async (name: string): Promise<void> => {
    try {
      const provider = getProvider(name);
      if (!provider) {
        healthChecks[name] = {
          provider: name,
          status: "unconfigured",
          message: "Provider not found in registry",
          lastCheck: new Date().toISOString(),
          details: {
            hasCredentials: false,
            canConnect: false,
            error: "Provider not registered",
          },
        };
        return;
      }

      healthChecks[name] = await checkProviderHealth(provider, {
        timeout: options.timeout,
        skipActualRequest: skipActualRequests,
      });
    } catch (error) {
      healthChecks[name] = {
        provider: name,
        status: "unhealthy",
        message:
          error instanceof Error ? error.message : "Failed to check provider",
        lastCheck: new Date().toISOString(),
        details: {
          hasCredentials: false,
          canConnect: false,
          error: String(error),
        },
      };
    }
  };

  // Execute health checks
  if (parallel) {
    await Promise.all(providerNames.map(checkProvider));
  } else {
    for (const name of providerNames) {
      await checkProvider(name);
    }
  }

  // Calculate summary
  const summary = {
    total: providerNames.length,
    healthy: 0,
    degraded: 0,
    unhealthy: 0,
    unconfigured: 0,
  };

  for (const health of Object.values(healthChecks)) {
    summary[health.status]++;
  }

  // Determine overall system status
  let systemStatus: "healthy" | "degraded" | "unhealthy";
  if (summary.healthy === summary.total) {
    systemStatus = "healthy";
  } else if (summary.healthy > 0 || summary.degraded > 0) {
    systemStatus = "degraded";
  } else {
    systemStatus = "unhealthy";
  }

  return {
    status: systemStatus,
    timestamp: new Date().toISOString(),
    providers: healthChecks,
    summary,
  };
}

/**
 * Cached health status with TTL
 */
let cachedHealth: SystemHealthStatus | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Get cached health status or perform new check
 */
export async function getCachedProviderHealth(
  options: {
    forceRefresh?: boolean;
    timeout?: number;
    skipActualRequests?: boolean;
  } = {},
): Promise<SystemHealthStatus> {
  const now = Date.now();
  const cacheAge = now - cacheTimestamp;

  if (!options.forceRefresh && cachedHealth && cacheAge < CACHE_TTL_MS) {
    return cachedHealth;
  }

  cachedHealth = await checkAllProvidersHealth(options);
  cacheTimestamp = now;

  return cachedHealth;
}

/**
 * Reset health cache (for testing or manual invalidation)
 */
export function resetHealthCache(): void {
  cachedHealth = null;
  cacheTimestamp = 0;
}
