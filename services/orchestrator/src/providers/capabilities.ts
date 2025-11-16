import type { RoutingMode } from "./interfaces.js";

export type ProviderCapabilities = {
  supportsTemperature: boolean;
  defaultTemperature?: number;
  defaultTimeoutMs?: number;
};

const DEFAULT_CAPABILITIES: Record<string, ProviderCapabilities> = {
  openai: { supportsTemperature: true, defaultTemperature: 0.2, defaultTimeoutMs: 60_000 },
  azureopenai: { supportsTemperature: true, defaultTemperature: 0.2, defaultTimeoutMs: 60_000 },
  mistral: { supportsTemperature: true, defaultTemperature: 0.2, defaultTimeoutMs: 60_000 },
  openrouter: { supportsTemperature: true, defaultTemperature: 0.2, defaultTimeoutMs: 60_000 },
  anthropic: { supportsTemperature: false },
  bedrock: { supportsTemperature: false },
  google: { supportsTemperature: false },
  local_ollama: { supportsTemperature: false },
};

export const DEFAULT_ROUTING_PRIORITY: Record<RoutingMode, string[]> = {
  balanced: [],
  high_quality: [
    "openai",
    "anthropic",
    "azureopenai",
    "google",
    "mistral",
    "bedrock",
    "openrouter",
    "local_ollama",
  ],
  low_cost: [
    "local_ollama",
    "mistral",
    "openrouter",
    "google",
    "bedrock",
    "azureopenai",
    "anthropic",
    "openai",
  ],
};

export function getProviderCapabilities(provider: string): ProviderCapabilities {
  const normalized = provider.trim().toLowerCase();
  return DEFAULT_CAPABILITIES[normalized] ?? { supportsTemperature: true };
}

export function getDefaultProviderCapabilities(): Record<string, ProviderCapabilities> {
  const clone: Record<string, ProviderCapabilities> = {};
  for (const [provider, capability] of Object.entries(DEFAULT_CAPABILITIES)) {
    clone[provider] = { ...capability };
  }
  return clone;
}
