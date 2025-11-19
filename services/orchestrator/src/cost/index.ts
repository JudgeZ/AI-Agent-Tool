/**
 * Cost tracking module exports
 */

export { TokenCounter } from "./TokenCounter.js";
export { CostTracker, type CostTrackerOptions } from "./CostTracker.js";
export {
  CostAttribution,
  type AttributionReport,
  type TenantAttribution,
  type OperationAttribution,
  type ProviderAttribution,
  type CostRecommendation as CostRecommendationType,
} from "./CostAttribution.js";
export {
  type TokenUsage,
  type CostMetrics,
  type ProviderPricing,
  type CostSummary,
  type CostAnomaly,
  type TokenBudget,
} from "./types.js";
export { PROVIDER_PRICING } from "./pricing.js";

/**
 * Initialize cost tracking with default configuration
 */
import { appLogger } from "../observability/logger.js";
import { TokenCounter } from "./TokenCounter.js";
import { CostTracker } from "./CostTracker.js";
import { CostAttribution } from "./CostAttribution.js";

let tokenCounter: TokenCounter | null = null;
let costTracker: CostTracker | null = null;
let costAttribution: CostAttribution | null = null;

/**
 * Initialize cost tracking system
 */
export function initializeCostTracking(): {
  tokenCounter: TokenCounter;
  costTracker: CostTracker;
  costAttribution: CostAttribution;
} {
  if (tokenCounter && costTracker && costAttribution) {
    return { tokenCounter, costTracker, costAttribution };
  }

  appLogger.info("initializing cost tracking");

  // Create token counter
  tokenCounter = new TokenCounter();

  // Create cost tracker
  costTracker = new CostTracker({
    enableAnomalyDetection: true,
    anomalyThreshold: 2.0, // 2x baseline
  });

  // Create cost attribution
  costAttribution = new CostAttribution();

  appLogger.info("cost tracking initialized");

  return { tokenCounter, costTracker, costAttribution };
}

/**
 * Get token counter instance
 */
export function getTokenCounter(): TokenCounter {
  if (!tokenCounter) {
    const { tokenCounter: tc } = initializeCostTracking();
    return tc;
  }
  return tokenCounter;
}

/**
 * Get cost tracker instance
 */
export function getCostTracker(): CostTracker {
  if (!costTracker) {
    const { costTracker: ct } = initializeCostTracking();
    return ct;
  }
  return costTracker;
}

/**
 * Get cost attribution instance
 */
export function getCostAttribution(): CostAttribution {
  if (!costAttribution) {
    const { costAttribution: ca } = initializeCostTracking();
    return ca;
  }
  return costAttribution;
}

/**
 * Shutdown cost tracking (for graceful shutdown)
 */
export async function shutdownCostTracking(): Promise<void> {
  appLogger.info("shutting down cost tracking");

  tokenCounter = null;
  costTracker = null;
  costAttribution = null;

  appLogger.info("cost tracking shut down");
}
