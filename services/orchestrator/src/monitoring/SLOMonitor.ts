/**
 * SLOMonitor - Service Level Objective monitoring and enforcement
 * Phase 5 implementation for production readiness
 */

import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { EventEmitter } from "events";
import { appLogger } from "../observability/logger";

const logger = appLogger.child({ subsystem: "slo-monitor" });

export interface SLO {
  name: string;
  metricName: string; // The actual Prometheus metric name
  target: number; // Target value
  window: number; // Time window in seconds
  percentile?: number; // For latency SLOs (e.g., 95 for p95)
  errorBudget: number; // Allowed failure rate (0-1)
  direction?: "higher" | "lower"; // Whether higher or lower is better (default: lower)
  query?: string; // Custom PromQL query override
}

export interface SLOStatus {
  name: string;
  target: number;
  actual: number;
  passing: boolean;
  errorBudget: number;
  errorBudgetRemaining: number;
  severity: "ok" | "warning" | "critical";
  lastChecked: Date;
}

export interface SLOViolation {
  slo: string;
  target: number;
  actual: number;
  severity: "warning" | "critical";
  message: string;
  timestamp: Date;
  errorBudget: number;
}

export interface RegressionAlert {
  metric: string;
  baseline: number;
  current: number;
  change: number;
  severity: "warning" | "critical";
  message: string;
  timestamp: Date;
}

/**
 * SLOMonitor - Tracks and enforces service level objectives
 */
export class SLOMonitor extends EventEmitter {
  private slos: Map<string, SLO> = new Map();
  private violations: SLOViolation[] = [];
  private maxViolationHistory = 1000;

  // Metrics
  private sloStatusGauge?: Gauge;
  private sloViolationCounter?: Counter;
  private errorBudgetGauge?: Gauge;
  private regressionCounter?: Counter;

  // Baselines for regression detection
  private baselines: Map<string, number[]> = new Map();
  private readonly baselineWindow = 100; // Keep last 100 measurements

  constructor(registry?: Registry) {
    super();

    // Define default SLOs
    this.defineDefaultSLOs();

    if (registry) {
      this.initializeMetrics(registry);
    }

    // Start periodic SLO checking
    this.startPeriodicChecks();
  }
  private defineDefaultSLOs(): void {
    // TTFT (Time to First Token) SLO
    this.slos.set("ttft_p95", {
      name: "TTFT p95",
      metricName: "llm_ttft_seconds",
      target: 0.3, // 300ms (Prometheus uses seconds)
      window: 300, // 5 minutes
      percentile: 95,
      errorBudget: 0.01, // 1% allowed failure
    });

    // RPC latency SLO
    this.slos.set("rpc_p95", {
      name: "RPC p95",
      metricName: "grpc_server_handling_seconds",
      target: 0.05, // 50ms
      window: 300,
      percentile: 95,
      errorBudget: 0.02, // 2% allowed failure
    });

    // Search latency SLO
    this.slos.set("search_p95", {
      name: "Search p95",
      metricName: "search_latency_seconds",
      target: 0.2, // 200ms
      window: 300,
      percentile: 95,
      errorBudget: 0.02,
    });

    // Cache hit rate SLO
    this.slos.set("cache_hit_rate", {
      name: "Cache Hit Rate",
      metricName: "cache_hits_total",
      target: 0.7, // 70%
      window: 600, // 10 minutes
      errorBudget: 0.1, // 10% allowed deviation
      direction: "higher",
      // Custom query for hit rate: rate(hits) / (rate(hits) + rate(misses))
      query: `sum(rate(cache_hits_total[5m])) / (sum(rate(cache_hits_total[5m])) + sum(rate(cache_misses_total[5m])))`,
    });

    // Error rate SLO
    this.slos.set("error_rate", {
      name: "Error Rate",
      metricName: "http_requests_total",
      target: 0.01, // 1%
      window: 300,
      errorBudget: 0.05, // 5% allowed deviation
      direction: "lower",
      // Custom query for error rate: rate(errors) / rate(total)
      query: `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))`,
    });

    // Availability SLO
    this.slos.set("availability", {
      name: "Availability",
      metricName: "up",
      target: 0.999, // 99.9%
      window: 3600, // 1 hour
      errorBudget: 0.001, // 0.1% allowed downtime
      direction: "higher",
      query: `avg_over_time(up[1h])`,
    });
  }

  private initializeMetrics(registry: Registry): void {
    this.sloStatusGauge = new Gauge({
      name: "slo_status",
      help: "SLO status (1=passing, 0=failing)",
      labelNames: ["slo_name"],
      registers: [registry],
    });

    this.sloViolationCounter = new Counter({
      name: "slo_violations_total",
      help: "Total number of SLO violations",
      labelNames: ["slo_name", "severity"],
      registers: [registry],
    });

    this.errorBudgetGauge = new Gauge({
      name: "slo_error_budget_remaining",
      help: "Remaining error budget (0-1)",
      labelNames: ["slo_name"],
      registers: [registry],
    });

    this.regressionCounter = new Counter({
      name: "performance_regressions_total",
      help: "Total number of performance regressions detected",
      labelNames: ["metric", "severity"],
      registers: [registry],
    });
  }

  /**
   * Define or update an SLO
   */
  defineSLO(id: string, slo: SLO): void {
    this.slos.set(id, slo);
    logger.info({ id, slo }, "SLO defined");
  }

  /**
   * Check all SLOs
   */
  async checkSLOs(): Promise<Map<string, SLOStatus>> {
    const results = new Map<string, SLOStatus>();

    for (const [id, slo] of this.slos.entries()) {
      try {
        const status = await this.checkSLO(id, slo);
        results.set(id, status);

        // Update metrics
        this.sloStatusGauge?.set(
          { slo_name: slo.name },
          status.passing ? 1 : 0,
        );
        this.errorBudgetGauge?.set(
          { slo_name: slo.name },
          status.errorBudgetRemaining,
        );

        // Emit violation events
        if (!status.passing) {
          this.handleViolation(slo, status);
        }
      } catch (error) {
        logger.error({ error, id, slo }, "Failed to check SLO");
      }
    }

    return results;
  }

  /**
   * Check a single SLO
   */
  private async checkSLO(id: string, slo: SLO): Promise<SLOStatus> {
    // This is a simplified implementation
    // In production, these would query actual Prometheus metrics

    // Simulate getting metrics
    const metrics = await this.getMetrics(id, slo);

    // Calculate percentile if needed
    const actual = slo.percentile
      ? this.calculatePercentile(metrics, slo.percentile)
      : this.calculateMean(metrics);

    // Calculate error budget
    let errorBudgetUsed = 0;
    const direction = slo.direction || "lower";

    if (direction === "lower") {
      // Lower is better (latency, error rate)
      if (actual > slo.target) {
        errorBudgetUsed = (actual - slo.target) / slo.target;
      }
    } else {
      // Higher is better (availability, cache hit rate)
      if (actual < slo.target) {
        errorBudgetUsed = (slo.target - actual) / slo.target;
      }
    }

    const errorBudgetRemaining = Math.max(0, slo.errorBudget - errorBudgetUsed);
    const passing = errorBudgetUsed === 0 || errorBudgetRemaining > 0;

    const status: SLOStatus = {
      name: slo.name,
      target: slo.target,
      actual,
      passing,
      errorBudget: slo.errorBudget,
      errorBudgetRemaining,
      severity: this.calculateSeverity(errorBudgetRemaining, slo.errorBudget),
      lastChecked: new Date(),
    };

    return status;
  }

  /**
   * Get metrics for an SLO from Prometheus
   */
  private async getMetrics(id: string, slo: SLO): Promise<number[]> {
    const prometheusUrl = process.env.PROMETHEUS_URL || "http://prometheus:9090";
    const query = this.buildPrometheusQuery(id, slo);

    try {
      const response = await fetch(`${prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
      if (!response.ok) {
        throw new Error(`Prometheus query failed: ${response.statusText}`);
      }

      const data = await response.json();
      if (data.status !== "success") {
        throw new Error(`Prometheus error: ${data.error}`);
      }

      // Parse result
      // Format: { status: "success", data: { resultType: "vector", result: [ { metric: {}, value: [timestamp, "value"] } ] } }
      const result = data.data?.result;
      if (!Array.isArray(result) || result.length === 0) {
        return [];
      }

      // Return the value from the first result series
      const value = parseFloat(result[0].value[1]);
      return isNaN(value) ? [] : [value];
    } catch (error) {
      logger.warn({ error, query }, "Failed to query Prometheus");
      return [];
    }
  }

  /**
   * Build PromQL query for an SLO
   */
  private buildPrometheusQuery(id: string, slo: SLO): string {
    if (slo.query) {
      return slo.query;
    }

    // Use the same logic as the alert generator to ensure consistency
    if (slo.percentile) {
      // Latency SLO: histogram_quantile(0.95, rate(metric_bucket[5m]))
      return `histogram_quantile(${slo.percentile / 100}, sum(rate(${slo.metricName}_bucket[${slo.window}s])) by (le))`;
    } else {
      // Rate-based SLO: rate(metric[5m])
      return `rate(${slo.metricName}[${slo.window}s])`;
    }
  }

  /**
   * Calculate percentile from measurements
   */
  private calculatePercentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  /**
   * Calculate mean from measurements
   */
  private calculateMean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /**
   * Calculate severity based on error budget
   */
  private calculateSeverity(
    remaining: number,
    total: number,
  ): "ok" | "warning" | "critical" {
    const usage = 1 - remaining / total;

    if (usage >= 1.0) return "critical";
    if (usage >= 0.8) return "warning";
    return "ok";
  }

  /**
   * Handle SLO violation
   */
  private handleViolation(slo: SLO, status: SLOStatus): void {
    const violation: SLOViolation = {
      slo: slo.name,
      target: slo.target,
      actual: status.actual,
      severity: status.severity === "critical" ? "critical" : "warning",
      message: `${slo.name} violated: ${status.actual.toFixed(2)} vs target ${slo.target}`,
      timestamp: new Date(),
      errorBudget: status.errorBudgetRemaining,
    };

    // Store violation
    this.violations.push(violation);
    if (this.violations.length > this.maxViolationHistory) {
      this.violations.shift();
    }

    // Update metrics
    this.sloViolationCounter?.inc({
      slo_name: slo.name,
      severity: violation.severity,
    });

    // Emit event
    this.emit("violation", violation);

    logger.warn({ violation }, "SLO violation detected");
  }

  /**
   * Detect performance regression
   */
  async detectRegression(
    metric: string,
    currentValue: number,
    options?: {
      threshold?: number; // Percentage change threshold (default: 0.2 = 20%)
      lookback?: number; // Number of historical values to compare (default: 50)
    },
  ): Promise<RegressionAlert | null> {
    const threshold = options?.threshold || 0.2;
    const lookback = options?.lookback || 50;

    // Get or create baseline
    let baseline = this.baselines.get(metric);
    if (!baseline) {
      baseline = [];
      this.baselines.set(metric, baseline);
    }

    // Add current value to baseline
    baseline.push(currentValue);
    if (baseline.length > this.baselineWindow) {
      baseline.shift();
    }

    // Need enough history to detect regression
    if (baseline.length < lookback) {
      return null;
    }

    // Calculate baseline average (excluding recent values)
    const historicalValues = baseline.slice(0, -10);
    const baselineAvg =
      historicalValues.reduce((sum, v) => sum + v, 0) / historicalValues.length;

    // Calculate recent average
    const recentValues = baseline.slice(-10);
    const recentAvg =
      recentValues.reduce((sum, v) => sum + v, 0) / recentValues.length;

    // Calculate change
    const change = (recentAvg - baselineAvg) / baselineAvg;

    // Check if regression occurred
    if (Math.abs(change) > threshold) {
      const alert: RegressionAlert = {
        metric,
        baseline: baselineAvg,
        current: recentAvg,
        change,
        severity: Math.abs(change) > threshold * 2 ? "critical" : "warning",
        message: `Performance regression detected in ${metric}: ${(change * 100).toFixed(1)}% change`,
        timestamp: new Date(),
      };

      // Update metrics
      this.regressionCounter?.inc({
        metric,
        severity: alert.severity,
      });

      // Emit event
      this.emit("regression", alert);

      logger.warn({ alert }, "Performance regression detected");

      return alert;
    }

    return null;
  }

  /**
   * Get recent violations
   */
  getRecentViolations(limit: number = 10): SLOViolation[] {
    return this.violations.slice(-limit);
  }

  /**
   * Get SLO status summary
   */
  async getSummary(): Promise<{
    total: number;
    passing: number;
    failing: number;
    critical: number;
    statuses: SLOStatus[];
  }> {
    const statuses = await this.checkSLOs();
    const statusArray = Array.from(statuses.values());

    return {
      total: statusArray.length,
      passing: statusArray.filter((s) => s.passing).length,
      failing: statusArray.filter((s) => !s.passing).length,
      critical: statusArray.filter((s) => s.severity === "critical").length,
      statuses: statusArray,
    };
  }

  /**
   * Start periodic SLO checks
   */
  private startPeriodicChecks(): void {
    // Check SLOs every 30 seconds
    setInterval(() => {
      this.checkSLOs().catch((error) => {
        logger.error({ error }, "Failed to check SLOs");
      });
    }, 30000);
  }

  /**
   * Reset baselines (useful after deployment)
   */
  resetBaselines(): void {
    this.baselines.clear();
    logger.info("Performance baselines reset");
  }

  /**
   * Export SLO configuration
   */
  exportConfig(): Record<string, SLO> {
    const config: Record<string, SLO> = {};
    for (const [id, slo] of this.slos.entries()) {
      config[id] = { ...slo };
    }
    return config;
  }
}

/**
 * Prometheus rule generator for SLO alerts
 */
export class SLOAlertGenerator {
  /**
   * Generate Prometheus alerting rules for SLOs
   */
  static generatePrometheusRules(slos: Map<string, SLO>): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // justified: Prometheus rule format is dynamic and varies by metric type
    const rules: any[] = [];

    for (const [id, slo] of slos.entries()) {
      // Generate alert rule based on SLO type
      if (slo.percentile) {
        // Latency SLO
        rules.push({
          alert: `${id.toUpperCase()}Violation`,
          expr: `histogram_quantile(${slo.percentile / 100}, rate(${id}_duration_ms_bucket[${slo.window}s])) > ${slo.target}`,
          for: `${Math.floor(slo.window / 6)}s`,
          labels: {
            severity: "high",
            slo: id,
          },
          annotations: {
            summary: `${slo.name} SLO violation`,
            description: `${slo.name} is {{ $value | humanizeDuration }} (target: ${slo.target}ms)`,
          },
        });
      } else if (id.includes("rate") || id.includes("availability")) {
        // Rate-based SLO
        rules.push({
          alert: `${id.toUpperCase()}Violation`,
          expr: `rate(${id}[${slo.window}s]) ${slo.direction === "higher" ? "<" : ">"} ${slo.target}`,
          for: `${Math.floor(slo.window / 6)}s`,
          labels: {
            severity: "high",
            slo: id,
          },
          annotations: {
            summary: `${slo.name} SLO violation`,
            description: `${slo.name} is {{ $value | humanizePercentage }} (target: ${slo.target * 100}%)`,
          },
        });
      }
    }

    return JSON.stringify(
      {
        groups: [
          {
            name: "slo-alerts",
            interval: "30s",
            rules,
          },
        ],
      },
      null,
      2,
    );
  }
}

/**
 * SLO Dashboard generator for Grafana
 */
export class SLODashboardGenerator {
  /**
   * Generate Grafana dashboard JSON for SLOs
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // justified: Grafana dashboard JSON schema is complex and varies by version
  // Using any for flexibility with Grafana's dynamic panel configuration
  static generateGrafanaDashboard(slos: Map<string, SLO>): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const panels: any[] = [];
    let panelId = 1;
    let yPos = 0;

    for (const [id, slo] of slos.entries()) {
      // Status gauge
      panels.push({
        id: panelId++,
        type: "gauge",
        title: `${slo.name} Status`,
        gridPos: { x: 0, y: yPos, w: 6, h: 4 },
        targets: [
          {
            expr: `slo_status{slo_name="${slo.name}"}`,
            refId: "A",
          },
        ],
        options: {
          showThresholdMarkers: true,
          showThresholdLabels: false,
        },
        fieldConfig: {
          defaults: {
            thresholds: {
              mode: "absolute",
              steps: [
                { color: "red", value: 0 },
                { color: "green", value: 1 },
              ],
            },
          },
        },
      });

      // Error budget gauge
      panels.push({
        id: panelId++,
        type: "gauge",
        title: `${slo.name} Error Budget`,
        gridPos: { x: 6, y: yPos, w: 6, h: 4 },
        targets: [
          {
            expr: `slo_error_budget_remaining{slo_name="${slo.name}"}`,
            refId: "A",
          },
        ],
        options: {
          showThresholdMarkers: true,
          showThresholdLabels: false,
        },
        fieldConfig: {
          defaults: {
            max: slo.errorBudget,
            unit: "percentunit",
            thresholds: {
              mode: "percentage",
              steps: [
                { color: "red", value: 0 },
                { color: "yellow", value: 20 },
                { color: "green", value: 50 },
              ],
            },
          },
        },
      });

      // Actual value timeseries
      panels.push({
        id: panelId++,
        type: "timeseries",
        title: `${slo.name} Actual vs Target`,
        gridPos: { x: 12, y: yPos, w: 12, h: 4 },
        targets: [
          {
            expr: slo.percentile
              ? `histogram_quantile(${slo.percentile / 100}, rate(${id}_duration_ms_bucket[${slo.window}s]))`
              : `rate(${id}[${slo.window}s])`,
            legendFormat: "Actual",
            refId: "A",
          },
          {
            expr: `${slo.target}`,
            legendFormat: "Target",
            refId: "B",
          },
        ],
        fieldConfig: {
          defaults: {
            custom: {
              drawStyle: "line",
              lineInterpolation: "smooth",
              lineWidth: 2,
              fillOpacity: 10,
            },
          },
        },
      });

      yPos += 4;
    }

    return {
      title: "SLO Dashboard",
      panels,
      refresh: "10s",
      time: { from: "now-1h", to: "now" },
      timezone: "browser",
    };
  }
}
