/**
 * Cost tracking types and interfaces for Phase 5
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface CostMetrics {
  operation: string;
  tenant?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  duration: number;
  timestamp: Date;
}

export interface ProviderPricing {
  input: number; // Cost per 1M input tokens
  output: number; // Cost per 1M output tokens
}

export interface PricingConfig {
  [provider: string]: {
    [model: string]: ProviderPricing;
  };
}

export interface CostSummary {
  totalCost: number;
  totalTokens: number;
  operationCount: number;
  avgCostPerOperation: number;
  byProvider: Record<string, number>;
  byOperation: Record<string, number>;
  byTenant?: Record<string, number>;
  trends?: {
    hourly: number[];
    daily: number[];
  };
}

export interface CostAnomaly {
  type: 'spike' | 'unusual_pattern' | 'budget_exceeded';
  timestamp: Date;
  value: number;
  baseline?: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
}

export interface TokenBudget {
  tenant: string;
  hourlyLimit: number;
  dailyLimit: number;
  monthlyLimit: number;
  currentHourlyUsage: number;
  currentDailyUsage: number;
  currentMonthlyUsage: number;
  resetHourly: Date;
  resetDaily: Date;
  resetMonthly: Date;
}
