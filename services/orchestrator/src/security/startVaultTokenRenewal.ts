/**
 * Integration module for starting Vault token renewal service
 *
 * This module integrates the VaultTokenRenewalService with the orchestrator
 * application lifecycle, automatically starting token renewal when Vault is enabled.
 */

import {
  VaultTokenRenewalService,
  createVaultStoreTokenProvider,
} from "./VaultTokenRenewal.js";
import { getSecretsStore } from "../providers/ProviderRegistry.js";
import { appLogger } from "../observability/logger.js";

let renewalService: VaultTokenRenewalService | null = null;

/**
 * Start the Vault token renewal service if Vault is enabled
 *
 * This should be called during application startup, after the SecretsStore
 * has been initialized but before any secrets operations.
 *
 * @returns The renewal service instance, or null if not started
 */
export async function startVaultTokenRenewal(): Promise<VaultTokenRenewalService | null> {
  try {
    const secretsStore = getSecretsStore();

    // Check if we're using VaultStore
    if (!isVaultStore(secretsStore)) {
      appLogger.info(
        { event: "vault.renewal.not_vault_store" },
        "SecretsStore is not VaultStore, token renewal not needed",
      );
      return null;
    }

    // Create token provider adapter
    const tokenProvider = createVaultStoreTokenProvider(secretsStore);

    // Check if token is managed
    if (!tokenProvider.isManagedToken()) {
      appLogger.info(
        { event: "vault.renewal.static_token" },
        "Vault token is static (not auto-authenticated), renewal not needed",
      );
      return null;
    }

    // Get configuration from environment
    const config = {
      enabled: parseBoolean(process.env.VAULT_TOKEN_RENEWAL_ENABLED) ?? true,
      checkIntervalMs:
        parseNumber(process.env.VAULT_TOKEN_RENEWAL_INTERVAL_MS) ?? 60000,
      renewalThreshold: parseFloat(
        process.env.VAULT_TOKEN_RENEWAL_THRESHOLD ?? "0.8",
      ),
      maxRetries: parseNumber(process.env.VAULT_TOKEN_RENEWAL_MAX_RETRIES) ?? 3,
      retryBackoffMs:
        parseNumber(process.env.VAULT_TOKEN_RENEWAL_BACKOFF_MS) ?? 5000,
    };

    appLogger.info(
      {
        event: "vault.renewal.config",
        config,
      },
      "Initializing Vault token renewal service",
    );

    // Create and start renewal service
    renewalService = new VaultTokenRenewalService(tokenProvider, config);
    await renewalService.start();

    if (renewalService.isRunning()) {
      appLogger.info(
        { event: "vault.renewal.started" },
        "Vault token renewal service started successfully",
      );
    }

    return renewalService;
  } catch (error) {
    appLogger.error(
      {
        event: "vault.renewal.start_error",
        error: (error as Error).message,
      },
      `Failed to start Vault token renewal service: ${(error as Error).message}`,
    );
    // Don't throw - let app continue without renewal
    return null;
  }
}

/**
 * Stop the Vault token renewal service
 *
 * This should be called during application shutdown.
 */
export async function stopVaultTokenRenewal(): Promise<void> {
  if (!renewalService) {
    return;
  }

  appLogger.info(
    { event: "vault.renewal.stopping" },
    "Stopping Vault token renewal service",
  );

  try {
    await renewalService.stop();
    renewalService = null;

    appLogger.info(
      { event: "vault.renewal.stopped" },
      "Vault token renewal service stopped",
    );
  } catch (error) {
    appLogger.error(
      {
        event: "vault.renewal.stop_error",
        error: (error as Error).message,
      },
      `Error stopping Vault token renewal service: ${(error as Error).message}`,
    );
  }
}

/**
 * Get the current renewal service instance
 */
export function getVaultTokenRenewalService(): VaultTokenRenewalService | null {
  return renewalService;
}

/**
 * Type guard to check if SecretsStore is a VaultStore
 */
function isVaultStore(store: any): boolean {
  // VaultStore has specific methods/properties
  return (
    store &&
    typeof store === "object" &&
    "managedToken" in store &&
    "tokenExpiresAt" in store &&
    "ensureToken" in store
  );
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

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
