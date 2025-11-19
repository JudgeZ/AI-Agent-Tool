# Provider Integration Guide

This guide explains how to add a new AI model provider to the OSS AI Agent Tool orchestrator.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Step-by-Step Integration](#step-by-step-integration)
4. [Testing Your Provider](#testing-your-provider)
5. [Best Practices](#best-practices)
6. [Troubleshooting](#troubleshooting)

---

## Overview

A **provider** in the orchestrator is a module that interfaces with an AI model API (e.g., OpenAI, Anthropic, Google). Each provider:

- Implements the `ModelProvider` interface
- Handles authentication and credential management
- Normalizes API responses to a common format
- Tracks metrics and health status
- Implements retry logic and error handling

**Existing Providers:**
- OpenAI (GPT-4, GPT-3.5)
- Anthropic (Claude 3 family)
- Google (Gemini)
- Azure OpenAI
- AWS Bedrock
- Mistral
- OpenRouter
- Local/Ollama

---

## Prerequisites

Before adding a new provider, ensure you have:

1. **API Access:** Valid credentials for the provider
2. **SDK (optional):** Official Node.js SDK (recommended but not required)
3. **API Documentation:** Endpoint URLs, request/response formats
4. **Development Environment:** Local orchestrator setup with tests passing

---

## Step-by-Step Integration

### Step 1: Create the Provider File

Create a new file: `services/orchestrator/src/providers/yourprovider.ts`

```typescript
import type { SecretsStore } from "../auth/SecretsStore.js";
import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ProviderContext,
} from "./interfaces.js";
import {
  callWithRetry,
  ProviderError,
  requireSecret,
  disposeClient,
  ensureProviderEgress,
} from "./utils.js";
import { ProviderRequestTimer, recordClientRotation } from "./metrics.js";

const YOUR_API_URL = "https://api.yourprovider.com/v1/chat";

/**
 * Configuration options for YourProvider
 */
export type YourProviderOptions = {
  /**
   * Default model to use when not specified
   * @default "default-model"
   */
  defaultModel?: string;
  
  /**
   * Request timeout in milliseconds
   * @default 30000
   */
  timeoutMs?: number;
  
  /**
   * Number of retry attempts for failed requests
   * @default 2
   */
  retryAttempts?: number;
};

/**
 * YourProvider implementation
 * 
 * @remarks
 * - API Key retrieved from SecretsStore or YOUR_API_KEY environment variable
 * - Supports models: model-1, model-2, model-3
 * - Tracks token usage and request metrics
 * 
 * @example
 * ```typescript
 * const provider = new YourProvider(secretsStore, {
 *   defaultModel: "your-model-v1",
 *   timeoutMs: 15000
 * });
 * ```
 */
export class YourProvider implements ModelProvider {
  name = "yourprovider";
  private clientPromise?: Promise<YourClient>;
  private clientCredentials?: { apiKey: string };

  /**
   * Create a new YourProvider instance
   * 
   * @param secrets - Secret store for retrieving API credentials
   * @param options - Provider configuration options
   */
  constructor(
    private readonly secrets: SecretsStore,
    private readonly options: YourProviderOptions = {}
  ) {}

  /**
   * Get or create the API client with credential rotation support
   */
  private async getClient(): Promise<YourClient> {
    const currentPromise = this.clientPromise;
    let credentials!: { apiKey: string };
    
    try {
      credentials = await this.resolveCredentials();
    } catch (error) {
      // If credentials fail but we have a cached client, return it
      if (currentPromise && this.clientCredentials) {
        return currentPromise;
      }
      throw error;
    }

    // Return cached client if credentials haven't changed
    if (
      currentPromise &&
      this.areCredentialsEqual(this.clientCredentials, credentials)
    ) {
      return currentPromise;
    }

    // Record client rotation metric when credentials change
    if (currentPromise) {
      recordClientRotation(this.name, "credential_change");
    }

    // Create new client
    const factory = this.options.clientFactory ?? defaultClientFactory;
    const nextPromise = Promise.resolve(factory(credentials));
    const wrappedPromise = nextPromise.then(
      (client) => client,
      (error) => {
        // Clear promise on error
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
    return wrappedPromise;
  }

  /**
   * Resolve API credentials from secrets store
   */
  private async resolveCredentials(): Promise<{ apiKey: string }> {
    const apiKey = await requireSecret(this.secrets, this.name, {
      key: "provider:yourprovider:apiKey",
      env: "YOUR_API_KEY",
      description: "API key",
    });
    return { apiKey };
  }

  /**
   * Check if credentials have changed
   */
  private areCredentialsEqual(
    previous?: { apiKey: string },
    next?: { apiKey: string }
  ): previous is { apiKey: string } {
    return Boolean(previous && next && previous.apiKey === next.apiKey);
  }

  /**
   * Dispose of the previous client instance
   */
  private async disposeExistingClient(
    promise?: Promise<YourClient>
  ): Promise<void> {
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

  /**
   * Send a chat completion request
   * 
   * @param req - Chat request with model and messages
   * @param context - Optional provider context (tenant ID, etc.)
   * @returns Chat response with output text and usage stats
   */
  async chat(
    req: ChatRequest,
    context?: ProviderContext
  ): Promise<ChatResponse> {
    const client = await this.getClient();
    const model = req.model ?? this.options.defaultModel ?? "default-model";

    // Start metrics timer
    const timer = new ProviderRequestTimer({
      provider: this.name,
      model,
      operation: "chat",
      tenantId: context?.tenantId,
    });

    try {
      const response = await callWithRetry(
        async () => {
          // Enforce egress policy before making request
          ensureProviderEgress(this.name, YOUR_API_URL, {
            action: "provider.request",
            metadata: { operation: "chat", model },
          });

          try {
            // Call your API
            return await client.chat({
              model,
              messages: req.messages,
            });
          } catch (error) {
            throw this.normalizeError(error);
          }
        },
        { attempts: this.options.retryAttempts ?? 2 }
      );

      // Extract output from response
      const output = response.choices[0]?.message?.content?.trim();
      if (!output) {
        const error = new ProviderError("Provider returned an empty response", {
          status: 502,
          provider: this.name,
          retryable: false,
        });
        timer.error(error);
        throw error;
      }

      // Extract usage information
      const usage = response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined;

      // Record success metrics
      timer.success({
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        totalTokens: usage?.totalTokens,
      });

      return {
        output,
        provider: this.name,
        usage,
      };
    } catch (error) {
      // Record error metrics
      if (error instanceof ProviderError) {
        timer.error(error);
      } else {
        timer.error({ status: 500, retryable: false });
      }
      throw error;
    }
  }

  /**
   * Normalize provider-specific errors to ProviderError
   */
  private normalizeError(error: unknown): ProviderError {
    if (error instanceof ProviderError) {
      return error;
    }

    // Extract error details from provider-specific error object
    const details = typeof error === "object" && error !== null ? error : undefined;
    const status = (details as any)?.status ?? (details as any)?.statusCode ?? 500;
    const code = (details as any)?.code;
    const message =
      (details as any)?.message ?? "Provider request failed";

    // Determine if error is retryable
    const retryable = 
      status === 429 || // Rate limit
      status === 408 || // Timeout
      status >= 500;    // Server error

    return new ProviderError(message, {
      status,
      code,
      provider: this.name,
      retryable,
      cause: error,
    });
  }
}
```

### Step 2: Register in ProviderRegistry

Edit `services/orchestrator/src/providers/ProviderRegistry.ts`:

```typescript
// Add import
import { YourProvider } from "./yourprovider.js";

// In buildRegistry() function, add your provider
function buildRegistry(): Record<string, ModelProvider> {
  if (!cachedRegistry) {
    const secrets = getSecretsStore();
    const cfg = loadConfig();
    
    // Get settings for your provider
    const yourSettings = getProviderSettings(cfg, "yourprovider");
    
    cachedRegistry = {
      // ... existing providers
      yourprovider: new YourProvider(secrets, {
        defaultModel: yourSettings?.defaultModel,
        timeoutMs: yourSettings?.timeoutMs,
      }),
    };
  }
  return cachedRegistry;
}
```

### Step 3: Add to Health Checks

Edit `services/orchestrator/src/providers/health.ts`:

```typescript
// Add your provider to the list
const providerNames = [
  "openai",
  "anthropic",
  "google",
  "azureopenai",
  "bedrock",
  "mistral",
  "openrouter",
  "local_ollama",
  "yourprovider",  // Add here
];
```

### Step 4: Update Configuration Schema

If your provider needs custom configuration, update `services/orchestrator/src/config.ts`:

```typescript
export type ProviderRuntimeConfig = {
  // ... existing config
  yourprovider?: {
    defaultModel?: string;
    timeoutMs?: number;
  };
};
```

---

## Testing Your Provider

### Unit Tests

Create `services/orchestrator/src/providers/__tests__/yourprovider.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { YourProvider } from "../yourprovider.js";
import type { SecretsStore } from "../../auth/SecretsStore.js";

describe("YourProvider", () => {
  let mockSecretsStore: SecretsStore;
  let provider: YourProvider;

  beforeEach(() => {
    mockSecretsStore = {
      get: vi.fn().mockResolvedValue("test-api-key"),
      set: vi.fn(),
      delete: vi.fn(),
    };
    
    provider = new YourProvider(mockSecretsStore, {
      defaultModel: "test-model",
    });
  });

  it("should initialize with correct name", () => {
    expect(provider.name).toBe("yourprovider");
  });

  it("should make successful chat request", async () => {
    // Mock your API client
    const mockClient = {
      chat: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "Hello!" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    };

    const response = await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(response.output).toBe("Hello!");
    expect(response.usage?.totalTokens).toBe(15);
  });

  it("should handle errors gracefully", async () => {
    // Mock error
    const mockClient = {
      chat: vi.fn().mockRejectedValue(new Error("API Error")),
    };

    await expect(
      provider.chat({
        model: "test-model",
        messages: [{ role: "user", content: "Hi" }],
      })
    ).rejects.toThrow("API Error");
  });

  it("should rotate client on credential change", async () => {
    // Test credential rotation logic
    await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "Hi" }],
    });

    // Change credentials
    mockSecretsStore.get = vi.fn().mockResolvedValue("new-api-key");

    // Should create new client
    await provider.chat({
      model: "test-model",
      messages: [{ role: "user", content: "Hi again" }],
    });

    // Verify client rotation metric was recorded
    // (Check your metrics implementation)
  });
});
```

### Integration Tests

Test your provider against the real API (in a separate test suite):

```typescript
import { describe, it, expect } from "vitest";
import { YourProvider } from "../yourprovider.js";
import { LocalFileStore } from "../../auth/SecretsStore.js";

describe("YourProvider Integration", () => {
  it("should make real API call", async () => {
    const secrets = new LocalFileStore();
    const provider = new YourProvider(secrets);

    const response = await provider.chat({
      model: undefined, // Use default
      messages: [{ role: "user", content: "Say hello" }],
    });

    expect(response.output).toBeTruthy();
    expect(response.provider).toBe("yourprovider");
  });
}, { skip: !process.env.YOUR_API_KEY }); // Skip if no API key
```

### Manual Testing

```bash
# Set API key
export YOUR_API_KEY="your-key-here"

# Run tests
npm test -- yourprovider

# Test via orchestrator
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "yourprovider",
    "model": "your-model",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Check health
curl http://localhost:3000/health/providers

# Check metrics
curl http://localhost:3000/metrics | grep yourprovider
```

---

## Best Practices

### 1. **Error Handling**

Always normalize provider-specific errors:

```typescript
private normalizeError(error: unknown): ProviderError {
  // Check for specific error codes
  if (isRateLimitError(error)) {
    return new ProviderError("Rate limit exceeded", {
      status: 429,
      retryable: true,
      provider: this.name,
    });
  }
  
  // Check for auth errors
  if (isAuthError(error)) {
    return new ProviderError("Invalid credentials", {
      status: 401,
      retryable: false,
      provider: this.name,
    });
  }
  
  // Default handling
  return new ProviderError("Unknown error", {
    status: 500,
    retryable: true,
    provider: this.name,
    cause: error,
  });
}
```

### 2. **Metrics Tracking**

Always use `ProviderRequestTimer` for consistent metrics:

```typescript
const timer = new ProviderRequestTimer({
  provider: this.name,
  model,
  operation: "chat",
  tenantId: context?.tenantId,
});

try {
  // ... make request
  timer.success({ promptTokens, completionTokens, totalTokens });
} catch (error) {
  timer.error(error);
  throw error;
}
```

### 3. **Egress Policy**

Always enforce egress policy before making requests:

```typescript
ensureProviderEgress(this.name, API_URL, {
  action: "provider.request",
  metadata: { operation: "chat", model },
});
```

### 4. **Credential Rotation**

Support hot-swapping credentials without restart:

```typescript
if (currentPromise && !this.areCredentialsEqual(oldCreds, newCreds)) {
  recordClientRotation(this.name, "credential_change");
  // Create new client
}
```

### 5. **Timeout Handling**

Use `withProviderTimeout` for requests with timeouts:

```typescript
import { withProviderTimeout } from "./utils.js";

const response = await withProviderTimeout(
  ({ signal }) => client.chat({ model, messages }, { signal }),
  {
    provider: this.name,
    timeoutMs: this.options.timeoutMs,
    action: "chat",
  }
);
```

---

## Troubleshooting

### Provider Not Found

**Error:** `Provider 'yourprovider' not found in registry`

**Solution:**
1. Check `ProviderRegistry.ts` - ensure provider is added to `buildRegistry()`
2. Verify provider name matches exactly (case-sensitive)
3. Restart orchestrator to reload registry

### Credentials Not Loading

**Error:** `API key is not configured`

**Solution:**
1. Check environment variable name matches `requireSecret()` call
2. Verify secret exists in SecretsStore:
   ```bash
   # For local file store
   cat ~/.oss-ai-agent-tool/secrets.json | jq '.["provider:yourprovider:apiKey"]'
   ```
3. Check CLAUDE.md compliance - no hardcoded secrets

### Metrics Not Appearing

**Problem:** Provider metrics not visible in `/metrics` endpoint

**Solution:**
1. Verify `ProviderRequestTimer` is used in `chat()` method
2. Check metrics import: `import { ProviderRequestTimer } from "./metrics.js"`
3. Ensure `timer.success()` or `timer.error()` is called
4. Check Prometheus scrape config includes orchestrator

### Health Check Failing

**Problem:** Provider shows as `unhealthy` in `/health/providers`

**Solution:**
1. Add provider name to `providerNames` array in `health.ts`
2. Verify credentials are configured
3. Check provider can be instantiated: `getProvider("yourprovider")`
4. Test with `?test=true` to perform actual API call

---

## Checklist

Before considering your provider integration complete:

- [ ] Provider implements `ModelProvider` interface
- [ ] Metrics tracking with `ProviderRequestTimer`
- [ ] Client rotation with `recordClientRotation()`
- [ ] Egress policy enforcement with `ensureProviderEgress()`
- [ ] Error normalization to `ProviderError`
- [ ] Retry logic with `callWithRetry()`
- [ ] Unit tests with >80% coverage
- [ ] Integration tests (optional, behind feature flag)
- [ ] Registered in `ProviderRegistry.ts`
- [ ] Added to health check provider list
- [ ] JSDoc comments on public APIs
- [ ] Configuration schema updated (if needed)
- [ ] Documentation updated (README, this guide)
- [ ] Manual testing completed
- [ ] Security review passed (no credentials in logs)

---

## Further Reading

- [Provider Interfaces](./interfaces.ts) - TypeScript interfaces
- [Provider Utils](./utils.ts) - Shared utilities
- [Metrics Module](./metrics.ts) - Prometheus metrics
- [Health Checks](./health.ts) - Health check system
- [CLAUDE.md](../CLAUDE.md) - Security and coding standards
- [Phase 1 Remediation Report](../PHASE_1_REMEDIATION_REPORT.md) - Quality standards

---

**Need Help?**

- Check existing providers for reference implementations
- Review test files for usage examples
- Open an issue on GitHub for guidance

**Happy Integrating! 🚀**