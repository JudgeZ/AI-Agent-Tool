/**
 * Provider pricing configuration
 * Prices are per 1M tokens in USD
 * Updated as of January 2025
 */

import { PricingConfig } from './types';

export const PROVIDER_PRICING: PricingConfig = {
  anthropic: {
    'claude-3.5-sonnet': {
      input: 3.00,
      output: 15.00
    },
    'claude-3-opus': {
      input: 15.00,
      output: 75.00
    },
    'claude-3-sonnet': {
      input: 3.00,
      output: 15.00
    },
    'claude-3-haiku': {
      input: 0.25,
      output: 1.25
    }
  },
  openai: {
    'gpt-4': {
      input: 30.00,
      output: 60.00
    },
    'gpt-4-turbo': {
      input: 10.00,
      output: 30.00
    },
    'gpt-4o': {
      input: 5.00,
      output: 15.00
    },
    'gpt-4o-mini': {
      input: 0.15,
      output: 0.60
    },
    'gpt-3.5-turbo': {
      input: 0.50,
      output: 1.50
    }
  },
  google: {
    'gemini-pro': {
      input: 0.50,
      output: 1.50
    },
    'gemini-pro-vision': {
      input: 0.50,
      output: 1.50
    },
    'gemini-ultra': {
      input: 7.00,
      output: 21.00
    }
  },
  mistral: {
    'mistral-large': {
      input: 4.00,
      output: 12.00
    },
    'mistral-medium': {
      input: 2.70,
      output: 8.10
    },
    'mistral-small': {
      input: 0.20,
      output: 0.60
    }
  },
  aws: {
    // Bedrock Claude models
    'anthropic.claude-3-sonnet': {
      input: 3.00,
      output: 15.00
    },
    'anthropic.claude-3-haiku': {
      input: 0.25,
      output: 1.25
    },
    // Bedrock Titan models
    'amazon.titan-text-express': {
      input: 0.20,
      output: 0.60
    },
    'amazon.titan-text-lite': {
      input: 0.15,
      output: 0.20
    }
  },
  azure: {
    // Azure OpenAI models (same pricing as OpenAI)
    'gpt-4': {
      input: 30.00,
      output: 60.00
    },
    'gpt-4-turbo': {
      input: 10.00,
      output: 30.00
    },
    'gpt-35-turbo': {
      input: 0.50,
      output: 1.50
    }
  },
  local: {
    // Local/Ollama models have no token cost
    'llama2': {
      input: 0,
      output: 0
    },
    'mistral': {
      input: 0,
      output: 0
    },
    'codellama': {
      input: 0,
      output: 0
    }
  }
};

/**
 * Get pricing for a specific provider and model
 */
export function getPricing(provider: string, model: string): { input: number; output: number } | null {
  const providerPricing = PROVIDER_PRICING[provider.toLowerCase()];
  if (!providerPricing) {
    return null;
  }

  // Try exact match first
  if (providerPricing[model]) {
    return providerPricing[model];
  }

  // Try to find a matching model by partial match
  const modelLower = model.toLowerCase();
  for (const [key, pricing] of Object.entries(providerPricing)) {
    if (modelLower.includes(key) || key.includes(modelLower)) {
      return pricing;
    }
  }

  return null;
}

/**
 * Calculate cost for token usage
 */
export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = getPricing(provider, model);
  if (!pricing) {
    // If we don't have pricing, return 0 (for local models or unknown)
    return 0;
  }

  // Calculate cost (pricing is per 1M tokens)
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return inputCost + outputCost;
}
