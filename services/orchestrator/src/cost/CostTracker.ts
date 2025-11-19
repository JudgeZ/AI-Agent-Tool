/**
 * CostTracker - Main cost tracking implementation with Prometheus metrics
 * Phase 5 implementation for cost optimization
 */

import { Counter, Histogram, Registry } from "prom-client";
import { TokenCounter } from "./TokenCounter";
import { calculateCost } from "./pricing";
import { CostMetrics, TokenUsage, CostSummary, CostAnomaly } from "./types";
import { toError } from "../utils/errorUtils";

export interface CostTrackerOptions {
  registry?: Registry;
  enableAnomalyDetection?: boolean;
  anomalyThreshold?: number; // Multiplier for baseline (default: 2x)
}

export class CostTracker {
  private tokenCounter: TokenCounter;
  private metricsHistory: CostMetrics[] = [];
  private registry: Registry;

  // Prometheus metrics
  private tokenCounter_metric!: Counter;
  private costCounter!: Counter;
  private costHistogram!: Histogram;
  private operationCounter!: Counter;

  // Anomaly detection
  private enableAnomalyDetection: boolean;
  private anomalyThreshold: number;
  private hourlyBaselines: Map<string, number> = new Map();

  constructor(options: CostTrackerOptions = {}) {
    this.tokenCounter = new TokenCounter();
    this.registry = options.registry || new Registry();
    this.enableAnomalyDetection = options.enableAnomalyDetection ?? true;
    this.anomalyThreshold = options.anomalyThreshold ?? 2;

    this.initializeMetrics();
  }

  private initializeMetrics(): void {
    // Token counter by type
    try {
      this.tokenCounter_metric = new Counter({
        name: "llm_tokens_total",
        help: "Total number of tokens used",
        labelNames: ["operation", "tenant", "provider", "model", "type"],
        registers: [this.registry],
      });
    } catch (error: unknown) {
      const err = toError(error);
      if (err.message.includes("already been registered")) {
        this.tokenCounter_metric = this.registry.getSingleMetric(
          "llm_tokens_total",
        ) as Counter;
      } else {
        throw error;
      }
    }

    // Cost counter in USD
    try {
      this.costCounter = new Counter({
        name: "llm_cost_total",
        help: "Total cost in USD",
        labelNames: ["operation", "tenant", "provider", "model"],
        registers: [this.registry],
      });
    } catch (error: unknown) {
      const err = toError(error);
      if (err.message.includes("already been registered")) {
        this.costCounter = this.registry.getSingleMetric(
          "llm_cost_total",
        ) as Counter;
      } else {
        throw error;
      }
    }

    // Cost histogram for distribution analysis
    try {
      this.costHistogram = new Histogram({
        name: "llm_cost_per_operation",
        help: "Cost distribution per operation in USD",
        labelNames: ["operation", "tenant", "provider"],
        buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100],
        registers: [this.registry],
      });
    } catch (error: unknown) {
      const err = toError(error);
      if (err.message.includes("already been registered")) {
        this.costHistogram = this.registry.getSingleMetric(
          "llm_cost_per_operation",
        ) as Histogram;
      } else {
        throw error;
      }
    }

    // Operation counter
    try {
      this.operationCounter = new Counter({
        name: "llm_operations_total",
        help: "Total number of LLM operations",
        labelNames: ["operation", "tenant", "provider", "model", "status"],
        registers: [this.registry],
      });
    } catch (error: unknown) {
      const err = toError(error);
      if (err.message.includes("already been registered")) {
        this.operationCounter = this.registry.getSingleMetric(
          "llm_operations_total",
        ) as Counter;
      } else {
        throw error;
      }
    }
  }

  /**
   * Track an LLM operation with cost calculation
   */
  async trackOperation<T>(
    metadata: {
      operation: string;
      tenant?: string;
      provider: string;
      model: string;
    },
    fn: () => Promise<T & { usage?: TokenUsage }>,
  ): Promise<{ result: T; metrics: CostMetrics }> {
    const start = Date.now();
    const startTokens = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };

    try {
      // Execute the operation
      const result = await fn();
      const endTokens = (result as any).usage || startTokens;
      const duration = Date.now() - start;

      // Calculate metrics
      const metrics: CostMetrics = {
        operation: metadata.operation,
        tenant: metadata.tenant,
        provider: metadata.provider,
        model: metadata.model,
        inputTokens: endTokens.promptTokens,
        outputTokens: endTokens.completionTokens,
        totalTokens: endTokens.totalTokens,
        cost: calculateCost(
          metadata.provider,
          metadata.model,
          endTokens.promptTokens,
          endTokens.completionTokens,
        ),
        duration,
        timestamp: new Date(),
      };

      // Record metrics
      this.recordMetrics(metrics, "success");

      // Store for history
      this.metricsHistory.push(metrics);

      // Check for anomalies
      if (this.enableAnomalyDetection) {
        await this.checkForAnomalies(metrics);
      }

      // Extract the actual result if it's wrapped
      const actualResult = "result" in result ? (result as any).result : result;
      return { result: actualResult as T, metrics };
    } catch (error: unknown) {
      // Record failed operation
      this.operationCounter.inc({
        operation: metadata.operation,
        tenant: metadata.tenant || "unknown",
        provider: metadata.provider,
        model: metadata.model,
        status: "error",
      });
      throw error;
    }
  }

  /**
   * Track usage manually (post-execution)
   */
  async trackUsage(
    metadata: {
      operation: string;
      tenant?: string;
      provider: string;
      model: string;
    },
    usage: TokenUsage,
    duration: number = 0,
  ): Promise<CostMetrics> {
    // Calculate metrics
    const metrics: CostMetrics = {
      operation: metadata.operation,
      tenant: metadata.tenant,
      provider: metadata.provider,
      model: metadata.model,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cost: calculateCost(
        metadata.provider,
        metadata.model,
        usage.promptTokens,
        usage.completionTokens,
      ),
      duration,
      timestamp: new Date(),
    };

    // Record metrics
    this.recordMetrics(metrics, "success");

    // Store for history
    this.metricsHistory.push(metrics);

    // Check for anomalies
    if (this.enableAnomalyDetection) {
      await this.checkForAnomalies(metrics);
    }

    return metrics;
  }

  /**
   * Record metrics to Prometheus
   */
  private recordMetrics(
    metrics: CostMetrics,
    status: string = "success",
  ): void {
    const labels = {
      operation: metrics.operation,
      tenant: metrics.tenant || "unknown",
      provider: metrics.provider,
      model: metrics.model,
    };

    // Record tokens
    this.tokenCounter_metric.inc(
      { ...labels, type: "input" },
      metrics.inputTokens,
    );

    this.tokenCounter_metric.inc(
      { ...labels, type: "output" },
      metrics.outputTokens,
    );

    // Record cost
    this.costCounter.inc(labels, metrics.cost);

    // Record cost histogram
    this.costHistogram.observe(
      {
        operation: metrics.operation,
        tenant: metrics.tenant || "unknown",
        provider: metrics.provider,
      },
      metrics.cost,
    );

    // Record operation
    this.operationCounter.inc({ ...labels, status });
  }

  /**
   * Check for cost anomalies
   */
  private async checkForAnomalies(
    metrics: CostMetrics,
  ): Promise<CostAnomaly[]> {
    const anomalies: CostAnomaly[] = [];
    const hour = new Date().getHours();
    const key = `${metrics.provider}-${metrics.operation}-${hour}`;

    // Get baseline for this hour
    const baseline = this.hourlyBaselines.get(key);

    if (baseline) {
      // Check if current cost exceeds threshold
      if (metrics.cost > baseline * this.anomalyThreshold) {
        anomalies.push({
          type: "spike",
          timestamp: metrics.timestamp,
          value: metrics.cost,
          baseline,
          severity: metrics.cost > baseline * 5 ? "critical" : "high",
          message: `Cost spike detected: ${metrics.cost.toFixed(4)} USD (${(metrics.cost / baseline).toFixed(1)}x baseline)`,
        });
      }
    }

    // Update rolling baseline (exponential moving average)
    const newBaseline = baseline
      ? baseline * 0.9 + metrics.cost * 0.1
      : metrics.cost;
    this.hourlyBaselines.set(key, newBaseline);

    return anomalies;
  }

  /**
   * Get cost summary for a time period
   */
  async getCostSummary(
    startTime?: Date,
    endTime?: Date,
    filters?: Partial<CostMetrics>,
  ): Promise<CostSummary> {
    let metrics = this.metricsHistory;

    // Apply time filters
    if (startTime) {
      metrics = metrics.filter((m) => m.timestamp >= startTime);
    }
    if (endTime) {
      metrics = metrics.filter((m) => m.timestamp <= endTime);
    }

    // Apply other filters
    if (filters) {
      if (filters.operation) {
        metrics = metrics.filter((m) => m.operation === filters.operation);
      }
      if (filters.tenant) {
        metrics = metrics.filter((m) => m.tenant === filters.tenant);
      }
      if (filters.provider) {
        metrics = metrics.filter((m) => m.provider === filters.provider);
      }
    }

    // Calculate summary
    const totalCost = metrics.reduce((sum, m) => sum + m.cost, 0);
    const totalTokens = metrics.reduce((sum, m) => sum + m.totalTokens, 0);
    const operationCount = metrics.length;

    // Group by provider
    const byProvider: Record<string, number> = {};
    metrics.forEach((m) => {
      byProvider[m.provider] = (byProvider[m.provider] || 0) + m.cost;
    });

    // Group by operation
    const byOperation: Record<string, number> = {};
    metrics.forEach((m) => {
      byOperation[m.operation] = (byOperation[m.operation] || 0) + m.cost;
    });

    // Group by tenant
    const byTenant: Record<string, number> = {};
    metrics.forEach((m) => {
      if (m.tenant) {
        byTenant[m.tenant] = (byTenant[m.tenant] || 0) + m.cost;
      }
    });

    // Calculate hourly trends
    const hourly: number[] = Array(24).fill(0);
    metrics.forEach((m) => {
      const hour = m.timestamp.getHours();
      hourly[hour] += m.cost;
    });

    // Calculate daily trends (last 7 days)
    const daily: number[] = Array(7).fill(0);
    const now = Date.now();
    metrics.forEach((m) => {
      const daysAgo = Math.floor(
        (now - m.timestamp.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysAgo < 7) {
        daily[6 - daysAgo] += m.cost;
      }
    });

    return {
      totalCost,
      totalTokens,
      operationCount,
      avgCostPerOperation: operationCount > 0 ? totalCost / operationCount : 0,
      byProvider,
      byOperation,
      byTenant: Object.keys(byTenant).length > 0 ? byTenant : undefined,
      trends: {
        hourly,
        daily,
      },
    };
  }

  /**
   * Get Prometheus metrics registry
   */
  getRegistry(): Registry {
    return this.registry;
  }

  /**
   * Count tokens directly (for pre-flight cost estimation)
   */
  countTokens(text: string, model?: string): number {
    return this.tokenCounter.count(text, model);
  }

  /**
   * Estimate completion cost
   */
  estimateCost(
    prompt: string,
    provider: string,
    model: string,
    maxTokens: number = 1000,
  ): { estimatedCost: number; usage: TokenUsage } {
    const usage = this.tokenCounter.estimateCompletion(
      prompt,
      maxTokens,
      model,
    );
    const estimatedCost = calculateCost(
      provider,
      model,
      usage.promptTokens,
      usage.completionTokens,
    );

    return { estimatedCost, usage };
  }

  /**
   * Set budget for a tenant
   */
  setBudget(tenant: string, amount: number): void {
    // Placeholder for budget setting
    // In a real implementation, this would store the budget in a database or cache
    const metric = this.registry.getSingleMetric("llm_budget_limit") as any;
    if (metric && metric.set) {
      metric.set({ tenant }, amount);
    }
  }

  /**
   * Get tenant budget status
   */
  getTenantBudgetStatus(tenant: string): {
    used: number;
    limit: number;
    remaining: number;
  } {
    // Placeholder for budget status
    return {
      used: 0,
      limit: 100,
      remaining: 100,
    };
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.tokenCounter.dispose();
    this.metricsHistory = [];
    this.hourlyBaselines.clear();
  }
}
