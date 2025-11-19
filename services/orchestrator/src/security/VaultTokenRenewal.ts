/**
 * Vault Token Renewal Service
 *
 * Proactively renews Vault tokens before expiration to prevent service disruption.
 * Runs as a background service in the orchestrator to ensure continuous Vault access.
 *
 * Features:
 * - Automatic token renewal before expiration
 * - Configurable renewal threshold (default: 80% of lease duration)
 * - Retry logic with exponential backoff
 * - Metrics and logging for monitoring
 * - Graceful shutdown handling
 */

import { setTimeout as sleep } from "node:timers/promises";
import { appLogger } from "../observability/logger.js";
import { Counter, Gauge } from "prom-client";

const DEFAULT_CHECK_INTERVAL_MS = 60000; // 1 minute
const DEFAULT_RENEWAL_THRESHOLD = 0.8; // Renew at 80% of lease duration
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_MS = 5000;

// Metrics
const tokenRenewalCounter = new Counter({
  name: "vault_token_renewals_total",
  help: "Total number of Vault token renewal attempts",
  labelNames: ["status"], // success, failure
});

const tokenExpiryGauge = new Gauge({
  name: "vault_token_expiry_seconds",
  help: "Time until Vault token expiration in seconds",
});

const tokenRenewalErrorCounter = new Counter({
  name: "vault_token_renewal_errors_total",
  help: "Total number of Vault token renewal errors",
  labelNames: ["error_type"],
});

export interface VaultTokenRenewalConfig {
  checkIntervalMs?: number;
  renewalThreshold?: number; // 0.0 to 1.0
  maxRetries?: number;
  retryBackoffMs?: number;
  enabled?: boolean;
}

export interface VaultTokenProvider {
  /**
   * Get current token expiration timestamp (Unix milliseconds)
   * Returns undefined if token doesn't expire or expiry is unknown
   */
  getTokenExpiry(): number | undefined;

  /**
   * Force token renewal
   * @param force - Force renewal even if not expired
   */
  renewToken(force?: boolean): Promise<void>;

  /**
   * Check if token management is enabled
   */
  isManagedToken(): boolean;
}

export class VaultTokenRenewalService {
  private running = false;
  private stopSignal = false;
  private checkIntervalMs: number;
  private renewalThreshold: number;
  private maxRetries: number;
  private retryBackoffMs: number;
  private enabled: boolean;
  private renewalPromise: Promise<void> | null = null;
  private initialExpiryTime: number | undefined = undefined;
  private serviceStartTime: number | undefined = undefined;

  constructor(
    private tokenProvider: VaultTokenProvider,
    config: VaultTokenRenewalConfig = {},
  ) {
    this.checkIntervalMs = config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.renewalThreshold =
      config.renewalThreshold ?? DEFAULT_RENEWAL_THRESHOLD;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBackoffMs = config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.enabled =
      config.enabled ??
      parseBoolean(process.env.VAULT_TOKEN_RENEWAL_ENABLED) ??
      true;

    if (this.renewalThreshold <= 0 || this.renewalThreshold >= 1) {
      throw new Error("renewalThreshold must be between 0 and 1");
    }
  }

  /**
   * Start the token renewal background service
   */
  async start(): Promise<void> {
    if (this.running) {
      appLogger.warn(
        { event: "vault.renewal.already_running" },
        "Vault token renewal service is already running",
      );
      return;
    }

    if (!this.enabled) {
      appLogger.info(
        { event: "vault.renewal.disabled" },
        "Vault token renewal service is disabled",
      );
      return;
    }

    if (!this.tokenProvider.isManagedToken()) {
      appLogger.info(
        { event: "vault.renewal.not_managed" },
        "Vault token is not managed (static token), renewal service not needed",
      );
      return;
    }

    this.running = true;
    this.stopSignal = false;
    this.serviceStartTime = Date.now();
    this.initialExpiryTime = this.tokenProvider.getTokenExpiry();

    appLogger.info(
      {
        event: "vault.renewal.start",
        checkIntervalMs: this.checkIntervalMs,
        renewalThreshold: this.renewalThreshold,
      },
      "Starting Vault token renewal service",
    );

    // Run renewal loop in background
    this.renewalLoop().catch((error) => {
      appLogger.error(
        {
          event: "vault.renewal.loop_error",
          error: (error as Error).message,
        },
        "Vault token renewal loop encountered fatal error",
      );
      this.running = false;
    });
  }

  /**
   * Stop the token renewal service
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    appLogger.info(
      { event: "vault.renewal.stop" },
      "Stopping Vault token renewal service",
    );

    this.stopSignal = true;

    // Wait for any in-flight renewal to complete
    if (this.renewalPromise) {
      await this.renewalPromise.catch(() => {
        // Ignore errors during shutdown
      });
    }

    this.running = false;

    appLogger.info(
      { event: "vault.renewal.stopped" },
      "Vault token renewal service stopped",
    );
  }

  /**
   * Check if the service is running
   */
  isRunning(): boolean {
    return this.running;
  }

  private async renewalLoop(): Promise<void> {
    while (!this.stopSignal) {
      try {
        await this.checkAndRenew();
      } catch (error) {
        appLogger.error(
          {
            event: "vault.renewal.check_error",
            error: (error as Error).message,
          },
          "Error during token renewal check",
        );
        tokenRenewalErrorCounter.labels("check_error").inc();
      }

      // Wait for next check interval
      await this.sleepWithCancellation(this.checkIntervalMs);
    }
  }

  private async sleepWithCancellation(ms: number): Promise<void> {
    const checkFrequency = 1000; // Check stop signal every second
    const iterations = Math.ceil(ms / checkFrequency);

    for (let i = 0; i < iterations && !this.stopSignal; i++) {
      await sleep(Math.min(checkFrequency, ms - i * checkFrequency));
    }
  }

  private async checkAndRenew(): Promise<void> {
    const expiryTimestamp = this.tokenProvider.getTokenExpiry();

    if (expiryTimestamp === undefined) {
      // Token doesn't expire or expiry unknown, nothing to do
      tokenExpiryGauge.set(Infinity);
      return;
    }

    const now = Date.now();
    const timeUntilExpiry = expiryTimestamp - now;
    const timeUntilExpirySeconds = Math.max(0, timeUntilExpiry / 1000);

    // Update metric
    tokenExpiryGauge.set(timeUntilExpirySeconds);

    if (timeUntilExpiry <= 0) {
      appLogger.warn(
        {
          event: "vault.renewal.token_expired",
          expiryTimestamp,
          now,
        },
        "Vault token has already expired, attempting immediate renewal",
      );
      await this.attemptRenewal(true);
      return;
    }

    // Calculate original lease duration from when service started
    // Use tracked values if available (first check), otherwise estimate
    let originalLeaseDuration: number;
    if (
      this.initialExpiryTime !== undefined &&
      this.serviceStartTime !== undefined
    ) {
      originalLeaseDuration = this.initialExpiryTime - this.serviceStartTime;
    } else {
      // Fallback: estimate from current remaining time
      originalLeaseDuration = timeUntilExpiry / (1 - this.renewalThreshold);
    }

    const renewalThresholdTime =
      originalLeaseDuration * (1 - this.renewalThreshold);
    const shouldRenew = timeUntilExpiry < renewalThresholdTime;

    if (shouldRenew) {
      appLogger.info(
        {
          event: "vault.renewal.threshold_reached",
          timeUntilExpirySeconds,
          renewalThresholdSeconds: renewalThresholdTime / 1000,
        },
        `Token renewal threshold reached (${(this.renewalThreshold * 100).toFixed(0)}% of lease duration)`,
      );
      await this.attemptRenewal();
    } else {
      appLogger.debug(
        {
          event: "vault.renewal.check",
          timeUntilExpirySeconds,
          renewalThresholdSeconds: renewalThresholdTime / 1000,
        },
        `Token is valid, renewal not needed yet (${timeUntilExpirySeconds.toFixed(0)}s remaining)`,
      );
    }
  }

  private async attemptRenewal(force = false): Promise<void> {
    this.renewalPromise = this.renewWithRetry(force);
    try {
      await this.renewalPromise;
    } finally {
      this.renewalPromise = null;
    }
  }

  private async renewWithRetry(force = false): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const startTime = Date.now();

        appLogger.info(
          {
            event: "vault.renewal.attempt",
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            force,
          },
          `Attempting Vault token renewal (attempt ${attempt + 1}/${this.maxRetries})`,
        );

        await this.tokenProvider.renewToken(force);

        const duration = Date.now() - startTime;

        appLogger.info(
          {
            event: "vault.renewal.success",
            attempt: attempt + 1,
            durationMs: duration,
          },
          "Vault token renewed successfully",
        );

        tokenRenewalCounter.labels("success").inc();

        // Update tracked values after successful renewal
        this.serviceStartTime = Date.now();
        this.initialExpiryTime = this.tokenProvider.getTokenExpiry();

        return;
      } catch (error) {
        lastError = error as Error;

        appLogger.error(
          {
            event: "vault.renewal.failure",
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            error: lastError.message,
          },
          `Vault token renewal failed (attempt ${attempt + 1}/${this.maxRetries}): ${lastError.message}`,
        );

        tokenRenewalCounter.labels("failure").inc();
        tokenRenewalErrorCounter.labels("renewal_failure").inc();

        // Backoff before retry (except on last attempt)
        if (attempt < this.maxRetries - 1) {
          const backoffMs = this.retryBackoffMs * Math.pow(2, attempt);
          appLogger.info(
            {
              event: "vault.renewal.retry_backoff",
              backoffMs,
            },
            `Waiting ${backoffMs}ms before retry`,
          );
          await this.sleepWithCancellation(backoffMs);
        }
      }
    }

    // All retries failed
    const errorMessage = lastError?.message ?? "Unknown error";
    appLogger.error(
      {
        event: "vault.renewal.exhausted",
        maxRetries: this.maxRetries,
        error: errorMessage,
      },
      `Vault token renewal failed after ${this.maxRetries} attempts`,
    );

    tokenRenewalErrorCounter.labels("exhausted").inc();

    throw new Error(
      `Failed to renew Vault token after ${this.maxRetries} attempts: ${errorMessage}`,
    );
  }
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

/**
 * Create a VaultTokenProvider adapter for VaultStore
 */
export function createVaultStoreTokenProvider(
  vaultStore: any,
): VaultTokenProvider {
  return {
    getTokenExpiry(): number | undefined {
      return vaultStore.tokenExpiresAt;
    },
    async renewToken(force = false): Promise<void> {
      await vaultStore.ensureToken(force);
    },
    isManagedToken(): boolean {
      return vaultStore.managedToken ?? false;
    },
  };
}
