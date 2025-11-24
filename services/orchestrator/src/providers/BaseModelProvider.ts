import type { SecretsStore } from "../auth/SecretsStore.js";
import type { ModelProvider, ChatRequest, ChatResponse, ProviderContext } from "./interfaces.js";
import { ProviderError, disposeClient } from "./utils.js";

/**
 * Common error shape that provider SDKs typically return.
 * Used by normalizeError to extract status, code, and message.
 */
export type ProviderErrorLike = {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  name?: unknown;
  message?: unknown;
  $metadata?: { httpStatusCode?: unknown };
};

/**
 * Options for error normalization
 */
export type NormalizeErrorOptions = {
  /** Default message if none can be extracted from the error */
  defaultMessage?: string;
  /** Error codes that indicate a retryable error */
  retryableCodes?: Set<string>;
};

/**
 * Base abstract class for model providers that use simple credential-based client caching.
 *
 * Handles common patterns:
 * - Client caching with credential comparison
 * - Client disposal on credential rotation
 * - Error normalization with secret sanitization
 * - Graceful fallback to cached client when credential resolution fails
 *
 * @template TClient - The SDK client type
 * @template TCredentials - The credentials shape (e.g., { apiKey: string })
 */
export abstract class BaseModelProvider<TClient, TCredentials> implements ModelProvider {
  abstract readonly name: string;

  protected clientPromise?: Promise<TClient>;
  protected clientCredentials?: TCredentials;

  constructor(protected readonly secrets: SecretsStore) {}

  /**
   * Create a new client instance with the given credentials.
   * Called when credentials change or no cached client exists.
   */
  protected abstract createClient(credentials: TCredentials): Promise<TClient> | TClient;

  /**
   * Resolve current credentials from secrets store and/or environment.
   * Should throw ProviderError with code 'missing_credentials' if required secrets are missing.
   */
  protected abstract resolveCredentials(): Promise<TCredentials>;

  /**
   * Compare two credential objects for equality.
   * Override for credentials with multiple fields.
   * Default implementation compares by JSON serialization.
   */
  protected areCredentialsEqual(
    previous: TCredentials | undefined,
    next: TCredentials | undefined
  ): previous is TCredentials {
    if (!previous || !next) return false;
    return JSON.stringify(previous) === JSON.stringify(next);
  }

  /**
   * Chat implementation - must be provided by each provider.
   */
  abstract chat(req: ChatRequest, context?: ProviderContext): Promise<ChatResponse>;

  /**
   * Get or create a cached client.
   * - Reuses cached client if credentials haven't changed
   * - Falls back to cached client if credential resolution fails but cache exists
   * - Disposes old client when credentials rotate
   */
  protected async getClient(): Promise<TClient> {
    const currentPromise = this.clientPromise;
    let credentials: TCredentials;

    try {
      credentials = await this.resolveCredentials();
    } catch (error) {
      // Fall back to cached client if credential resolution fails
      if (currentPromise && this.clientCredentials) {
        return currentPromise;
      }
      throw error;
    }

    // Return cached client if credentials haven't changed
    if (currentPromise && this.areCredentialsEqual(this.clientCredentials, credentials)) {
      return currentPromise;
    }

    // Create new client
    const nextPromise = Promise.resolve(this.createClient(credentials));
    const wrappedPromise = nextPromise.then(
      client => client,
      error => {
        // Clear cache on factory failure
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
   * Dispose and clear cached client.
   * @internal - exposed for testing
   */
  async resetClientForTests(): Promise<void> {
    await this.disposeExistingClient(this.clientPromise);
  }

  /**
   * Dispose an existing client and clear the cache if it matches.
   */
  protected async disposeExistingClient(promise?: Promise<TClient>): Promise<void> {
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
   * Sanitize a string by redacting any credentials.
   * Override in subclasses to handle provider-specific credential patterns.
   * Default implementation redacts apiKey if credentials have one.
   */
  protected sanitize(text: string): string {
    if (!text || !this.clientCredentials) return text;
    const creds = this.clientCredentials as Record<string, unknown>;
    if (typeof creds.apiKey === "string" && creds.apiKey) {
      return text.replace(creds.apiKey, "[REDACTED]");
    }
    return text;
  }

  /**
   * Normalize an error into a ProviderError with proper status, code, and retryability.
   * Handles common error shapes from provider SDKs.
   * Sanitizes error messages to prevent credential leakage.
   */
  protected normalizeError(error: unknown, options: NormalizeErrorOptions = {}): ProviderError {
    if (error instanceof ProviderError) {
      return error;
    }

    const { defaultMessage = `${this.name} request failed`, retryableCodes } = options;

    const details: ProviderErrorLike | undefined =
      typeof error === "object" && error !== null ? (error as ProviderErrorLike) : undefined;

    // Extract status from various error shapes
    const statusCandidate =
      typeof details?.$metadata?.httpStatusCode === "number"
        ? details.$metadata.httpStatusCode
        : typeof details?.status === "number"
          ? details.status
          : typeof details?.statusCode === "number"
            ? details.statusCode
            : undefined;

    const code = typeof details?.code === "string"
      ? details.code
      : typeof details?.name === "string"
        ? details.name
        : undefined;

    const rawMessage = typeof details?.message === "string" ? details.message : defaultMessage;
    const message = this.sanitize(rawMessage);
    const status = statusCandidate;

    // Determine retryability
    let retryable = status === 429 || status === 408 || (typeof status === "number" ? status >= 500 : true);
    if (retryableCodes && typeof code === "string" && retryableCodes.has(code)) {
      retryable = true;
    }

    // Sanitize cause if needed
    let cause = error;
    if (error && typeof error === "object") {
      try {
        const json = JSON.stringify(error);
        const creds = this.clientCredentials as Record<string, unknown> | undefined;
        if (creds && typeof creds.apiKey === "string" && json.includes(creds.apiKey)) {
          cause = new Error(this.sanitize(json));
        }
      } catch {
        // Ignore serialization errors
      }
    }

    return new ProviderError(message, {
      status: status ?? 502,
      code: typeof code === "string" ? code : undefined,
      provider: this.name,
      retryable,
      cause
    });
  }
}

/**
 * Base class for providers that need to return credentials alongside the client.
 * Used by Azure OpenAI and Bedrock which need credential data for URL construction.
 *
 * @template TClient - The SDK client type
 * @template TCredentials - The credentials shape
 */
export abstract class BaseModelProviderWithCredentials<TClient, TCredentials> implements ModelProvider {
  abstract readonly name: string;

  /**
   * Display name for error messages. Defaults to capitalized name.
   * Override this in subclasses for proper error message formatting.
   */
  protected get displayName(): string {
    return this.name.charAt(0).toUpperCase() + this.name.slice(1);
  }

  protected clientPromise?: Promise<TClient>;
  protected clientCredentials?: TCredentials;

  constructor(protected readonly secrets: SecretsStore) {}

  /**
   * Create a new client instance with the given credentials.
   */
  protected abstract createClient(credentials: TCredentials): Promise<TClient> | TClient;

  /**
   * Resolve current credentials from secrets store and/or environment.
   */
  protected abstract resolveCredentials(): Promise<TCredentials>;

  /**
   * Compare two credential objects for equality.
   */
  protected abstract areCredentialsEqual(
    previous: TCredentials | undefined,
    next: TCredentials | undefined
  ): previous is TCredentials;

  /**
   * Chat implementation - must be provided by each provider.
   */
  abstract chat(req: ChatRequest, context?: ProviderContext): Promise<ChatResponse>;

  /**
   * Get or create a cached client, returning both client and credentials.
   * Used by providers that need credential data for request construction.
   */
  protected async getClient(): Promise<{ client: TClient; credentials: TCredentials }> {
    const currentPromise = this.clientPromise;
    let credentials: TCredentials;

    try {
      credentials = await this.resolveCredentials();
    } catch (error) {
      if (currentPromise) {
        const snapshot = this.clientCredentials;
        if (!snapshot) {
          throw new ProviderError(`${this.displayName} credentials are not available`, {
            status: 500,
            provider: this.name,
            retryable: false,
          });
        }
        const client = await currentPromise;
        return { client, credentials: snapshot };
      }
      throw error;
    }

    if (currentPromise && this.areCredentialsEqual(this.clientCredentials, credentials)) {
      const snapshot = this.clientCredentials;
      if (!snapshot) {
        throw new ProviderError(`${this.displayName} credentials are not available`, {
          status: 500,
          provider: this.name,
          retryable: false,
        });
      }
      const client = await currentPromise;
      return { client, credentials: snapshot };
    }

    const nextPromise = Promise.resolve(this.createClient(credentials));
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

  /**
   * @internal - exposed for testing
   */
  async resetClientForTests(): Promise<void> {
    await this.disposeExistingClient(this.clientPromise);
  }

  protected async disposeExistingClient(promise?: Promise<TClient>): Promise<void> {
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
   * Normalize an error into a ProviderError.
   */
  protected normalizeError(error: unknown, options: NormalizeErrorOptions = {}): ProviderError {
    if (error instanceof ProviderError) {
      return error;
    }

    const { defaultMessage = `${this.name} request failed`, retryableCodes } = options;

    const details: ProviderErrorLike | undefined =
      typeof error === "object" && error !== null ? (error as ProviderErrorLike) : undefined;

    const statusCandidate =
      typeof details?.$metadata?.httpStatusCode === "number"
        ? details.$metadata.httpStatusCode
        : typeof details?.status === "number"
          ? details.status
          : typeof details?.statusCode === "number"
            ? details.statusCode
            : undefined;

    const code = typeof details?.code === "string"
      ? details.code
      : typeof details?.name === "string"
        ? details.name
        : undefined;

    const message = typeof details?.message === "string" ? details.message : defaultMessage;
    const status = statusCandidate;

    let retryable = status === 429 || status === 408 || (typeof status === "number" ? status >= 500 : true);
    if (retryableCodes && typeof code === "string" && retryableCodes.has(code)) {
      retryable = true;
    }

    return new ProviderError(message, {
      status: status ?? 502,
      code: typeof code === "string" ? code : undefined,
      provider: this.name,
      retryable,
      cause: error
    });
  }
}
