/**
 * SLOMonitor test suite
 * Tests SLO tracking, violation detection, regression detection, and alerting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Registry } from "prom-client";
import {
  SLOMonitor,
  SLOAlertGenerator,
  SLODashboardGenerator,
  SLO,
  SLOStatus,
  SLOViolation,
  RegressionAlert
} from "./SLOMonitor";

describe("SLOMonitor", () => {
  let monitor: SLOMonitor;
  let registry: Registry;

  beforeEach(() => {
    vi.useFakeTimers();
    registry = new Registry();
    monitor = new SLOMonitor(registry);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe("initialization", () => {
    it("should initialize with default SLOs", () => {
      const config = monitor.exportConfig();

      // Check default SLOs are defined
      expect(config).toHaveProperty("ttft_p95");
      expect(config).toHaveProperty("rpc_p95");
      expect(config).toHaveProperty("search_p95");
      expect(config).toHaveProperty("cache_hit_rate");
      expect(config).toHaveProperty("error_rate");
      expect(config).toHaveProperty("availability");
    });

    it("should create Prometheus metrics when registry provided", async () => {
      const metrics = await registry.metrics();

      expect(metrics).toContain("slo_status");
      expect(metrics).toContain("slo_violations_total");
      expect(metrics).toContain("slo_error_budget_remaining");
      expect(metrics).toContain("performance_regressions_total");
    });

    it("should start periodic checks", () => {
      const setIntervalSpy = vi.spyOn(global, "setInterval");

      new SLOMonitor();

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        30000 // Every 30 seconds
      );
    });
  });

  describe("defineSLO", () => {
    it("should define a new SLO", () => {
      const customSLO: SLO = {
        name: "Custom SLO",
        metricName: "custom_metric",
        target: 100,
        window: 60,
        errorBudget: 0.05,
      };

      monitor.defineSLO("custom_slo", customSLO);

      const config = monitor.exportConfig();
      expect(config.custom_slo).toEqual(customSLO);
    });

    it("should update an existing SLO", () => {
      const updatedSLO: SLO = {
        name: "Updated TTFT",
        metricName: "llm_ttft_seconds",
        target: 250, // Lower target
        window: 600, // Longer window
        percentile: 95,
        errorBudget: 0.02,
      };

      monitor.defineSLO("ttft_p95", updatedSLO);

      const config = monitor.exportConfig();
      expect(config.ttft_p95.target).toBe(250);
      expect(config.ttft_p95.window).toBe(600);
    });
  });

  describe("checkSLOs", () => {
    beforeEach(() => {
      // Mock getMetrics to return controlled data
      vi.spyOn(monitor as any, "getMetrics").mockImplementation(
        async (id: any, slo: any) => {
          if (id === "ttft_p95") {
            // Return values that will violate the SLO
            return Array.from({ length: 100 }, () => slo.target * 1.5);
          }
          // Return values that pass the SLO
          return Array.from({ length: 100 }, () => slo.target * 0.8);
        }
      );
    });

    it("should check all SLOs and return statuses", async () => {
      const results = await monitor.checkSLOs();

      expect(results.size).toBeGreaterThan(0);

      // Check TTFT SLO (should be failing based on mock data)
      const ttftStatus = results.get("ttft_p95");
      expect(ttftStatus).toBeDefined();
      expect(ttftStatus?.passing).toBe(false);
      expect(ttftStatus?.actual).toBeGreaterThan(ttftStatus?.target || 0);
    });

    it("should update Prometheus metrics", async () => {
      await monitor.checkSLOs();

      const metrics = await registry.metrics();

      // Check that metrics contain SLO data
      expect(metrics).toContain('slo_status{slo_name="TTFT p95"}');
      expect(metrics).toContain('slo_error_budget_remaining{slo_name="TTFT p95"}');
    });

    it("should emit violation events for failing SLOs", async () => {
      const violationListener = vi.fn();
      monitor.on("violation", violationListener);

      await monitor.checkSLOs();

      // TTFT should violate based on mock data
      expect(violationListener).toHaveBeenCalledWith(
        expect.objectContaining({
          slo: "TTFT p95",
          severity: expect.stringMatching(/warning|critical/),
        })
      );
    });

    it("should store violation history", async () => {
      await monitor.checkSLOs();

      const violations = monitor.getRecentViolations();
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0].slo).toBe("TTFT p95");
    });
  });

  describe("severity calculation", () => {
    it("should calculate severity based on error budget usage", async () => {
      // Mock different error budget scenarios
      const scenarios = [
        { remaining: 0.01, total: 0.01, expected: "ok" },       // 0% used
        { remaining: 0.002, total: 0.01, expected: "warning" }, // 80% used
        { remaining: 0, total: 0.01, expected: "critical" },    // 100% used
      ];

      for (const scenario of scenarios) {
        const severity = (monitor as any).calculateSeverity(
          scenario.remaining,
          scenario.total
        );
        expect(severity).toBe(scenario.expected);
      }
    });
  });

  describe("percentile calculation", () => {
    it("should calculate percentiles correctly", () => {
      const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

      const p50 = (monitor as any).calculatePercentile(values, 50);
      expect(p50).toBe(5);

      const p95 = (monitor as any).calculatePercentile(values, 95);
      expect(p95).toBe(10);

      const p99 = (monitor as any).calculatePercentile(values, 99);
      expect(p99).toBe(10);
    });

    it("should handle empty arrays", () => {
      const result = (monitor as any).calculatePercentile([], 95);
      expect(result).toBe(0);
    });
  });

  describe("mean calculation", () => {
    it("should calculate mean correctly", () => {
      const values = [1, 2, 3, 4, 5];
      const mean = (monitor as any).calculateMean(values);
      expect(mean).toBe(3);
    });

    it("should handle empty arrays", () => {
      const result = (monitor as any).calculateMean([]);
      expect(result).toBe(0);
    });
  });

  describe("detectRegression", () => {
    it("should detect performance regression when threshold exceeded", async () => {
      // Establish baseline with consistent values
      for (let i = 0; i < 50; i++) {
        await monitor.detectRegression("test_metric", 100);
      }

      // Introduce regression (50% increase)
      for (let i = 0; i < 10; i++) {
        await monitor.detectRegression("test_metric", 150);
      }

      // Should detect regression
      const alert = await monitor.detectRegression("test_metric", 150);

      expect(alert).not.toBeNull();
      expect(alert?.metric).toBe("test_metric");
      expect(alert?.change).toBeGreaterThan(0.2);
      expect(alert?.severity).toBe("critical");
    });

    it("should detect critical regression for large changes", async () => {
      // Establish baseline
      for (let i = 0; i < 50; i++) {
        await monitor.detectRegression("critical_metric", 100);
      }

      // Introduce severe regression (100% increase)
      for (let i = 0; i < 10; i++) {
        await monitor.detectRegression("critical_metric", 200);
      }

      const alert = await monitor.detectRegression("critical_metric", 200);

      expect(alert).not.toBeNull();
      expect(alert?.severity).toBe("critical");
    });

    it("should not detect regression within threshold", async () => {
      // Establish baseline
      for (let i = 0; i < 50; i++) {
        await monitor.detectRegression("stable_metric", 100);
      }

      // Small change (10% increase - below default 20% threshold)
      for (let i = 0; i < 10; i++) {
        await monitor.detectRegression("stable_metric", 110);
      }

      const alert = await monitor.detectRegression("stable_metric", 110);

      expect(alert).toBeNull();
    });

    it("should respect custom threshold", async () => {
      // Establish baseline
      for (let i = 0; i < 50; i++) {
        await monitor.detectRegression("sensitive_metric", 100);
      }

      // 10% change
      for (let i = 0; i < 10; i++) {
        await monitor.detectRegression("sensitive_metric", 110);
      }

      // Should detect with 5% threshold
      const alert = await monitor.detectRegression("sensitive_metric", 110, {
        threshold: 0.05, // 5% threshold
      });

      expect(alert).not.toBeNull();
    });

    it("should emit regression event", async () => {
      const regressionListener = vi.fn();
      monitor.on("regression", regressionListener);

      // Establish baseline and trigger regression
      for (let i = 0; i < 50; i++) {
        await monitor.detectRegression("event_metric", 100);
      }
      for (let i = 0; i < 10; i++) {
        await monitor.detectRegression("event_metric", 150);
      }

      await monitor.detectRegression("event_metric", 150);

      expect(regressionListener).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: "event_metric",
          severity: expect.stringMatching(/warning|critical/),
        })
      );
    });

    it("should not detect regression without enough history", async () => {
      // Only add a few values (less than lookback)
      for (let i = 0; i < 10; i++) {
        await monitor.detectRegression("new_metric", 100);
      }

      const alert = await monitor.detectRegression("new_metric", 200);

      expect(alert).toBeNull(); // Not enough history
    });

    it("should maintain baseline window size", async () => {
      // Add more values than window size (100)
      for (let i = 0; i < 150; i++) {
        await monitor.detectRegression("windowed_metric", i);
      }

      // Baseline should only keep last 100 values
      const baselines = (monitor as any).baselines;
      const baseline = baselines.get("windowed_metric");

      expect(baseline.length).toBe(100);
    });
  });

  describe("getRecentViolations", () => {
    it("should return recent violations with limit", async () => {
      // Mock to create multiple violations
      vi.spyOn(monitor as any, "getMetrics").mockImplementation(
        async () => Array.from({ length: 100 }, () => 1000) // High values to violate SLOs
      );

      // Generate violations
      for (let i = 0; i < 5; i++) {
        await monitor.checkSLOs();
      }

      const recent = monitor.getRecentViolations(3);
      expect(recent.length).toBeLessThanOrEqual(3);
    });

    it("should return violations in chronological order", async () => {
      vi.spyOn(monitor as any, "getMetrics").mockImplementation(
        async () => Array.from({ length: 100 }, () => 1000)
      );

      await monitor.checkSLOs();
      vi.advanceTimersByTime(1000);
      await monitor.checkSLOs();

      const violations = monitor.getRecentViolations();

      if (violations.length >= 2) {
        expect(violations[0].timestamp.getTime()).toBeLessThanOrEqual(
          violations[1].timestamp.getTime()
        );
      }
    });
  });

  describe("getSummary", () => {
    it("should return SLO summary statistics", async () => {
      // Mock mixed results
      vi.spyOn(monitor as any, "getMetrics").mockImplementation(
        async (id: any, slo: any) => {
          if (id.includes("ttft") || id.includes("rpc")) {
            // Failing SLOs
            return Array.from({ length: 100 }, () => slo.target * 2);
          }
          // Passing SLOs
          return Array.from({ length: 100 }, () => slo.target * 0.5);
        }
      );

      const summary = await monitor.getSummary();

      expect(summary.total).toBe(6); // 6 default SLOs
      expect(summary.passing).toBeGreaterThan(0);
      expect(summary.failing).toBeGreaterThan(0);
      expect(summary.passing + summary.failing).toBe(summary.total);
      expect(summary.statuses).toHaveLength(6);
    });

    it("should identify critical SLOs", async () => {
      // Mock to create critical violations
      vi.spyOn(monitor as any, "getMetrics").mockImplementation(
        async (id: any, slo: any) => {
          if (id === "availability") {
            // Critical violation - way over error budget
            return Array.from({ length: 100 }, () => 0.5); // 50% availability
          }
          return Array.from({ length: 100 }, () => slo.target);
        }
      );

      const summary = await monitor.getSummary();

      expect(summary.critical).toBeGreaterThanOrEqual(1);
    });
  });

  describe("resetBaselines", () => {
    it("should clear all baselines", async () => {
      // Add some baselines
      for (let i = 0; i < 10; i++) {
        await monitor.detectRegression("metric1", 100);
        await monitor.detectRegression("metric2", 200);
      }

      monitor.resetBaselines();

      const baselines = (monitor as any).baselines;
      expect(baselines.size).toBe(0);
    });
  });

  describe("exportConfig", () => {
    it("should export all SLO configurations", () => {
      const config = monitor.exportConfig();

      expect(config).toHaveProperty("ttft_p95");
      expect(config).toHaveProperty("rpc_p95");
      expect(config).toHaveProperty("cache_hit_rate");

      // Check structure
      expect(config.ttft_p95).toHaveProperty("name");
      expect(config.ttft_p95).toHaveProperty("target");
      expect(config.ttft_p95).toHaveProperty("window");
      expect(config.ttft_p95).toHaveProperty("errorBudget");
    });

    it("should return a copy not a reference", () => {
      const config1 = monitor.exportConfig();
      const config2 = monitor.exportConfig();

      config1.ttft_p95.target = 999;

      expect(config2.ttft_p95.target).not.toBe(999);
    });
  });

  describe("periodic checks", () => {
    it("should run checks periodically", () => {
      const checkSpy = vi.spyOn(monitor, "checkSLOs");

      // Advance time by 30 seconds
      vi.advanceTimersByTime(30000);

      expect(checkSpy).toHaveBeenCalled();

      // Advance another 30 seconds
      vi.advanceTimersByTime(30000);

      expect(checkSpy).toHaveBeenCalledTimes(2);
    });

    it("should handle errors in periodic checks", () => {
      const errorSpy = vi.spyOn(monitor, "checkSLOs").mockRejectedValue(
        new Error("Check failed")
      );

      // Should not throw
      expect(() => {
        vi.advanceTimersByTime(30000);
      }).not.toThrow();

      expect(errorSpy).toHaveBeenCalled();
    });
  });
});

describe("SLOAlertGenerator", () => {
  it("should generate Prometheus alerting rules", () => {
    const slos = new Map<string, SLO>([
      ["ttft_p95", {
        name: "TTFT p95",
        metricName: "llm_ttft_seconds",
        target: 300,
        window: 300,
        percentile: 95,
        errorBudget: 0.01,
      }],
      ["error_rate", {
        name: "Error Rate",
        metricName: "http_requests_total",
        target: 0.01,
        window: 300,
        errorBudget: 0.05,
      }],
    ]);

    const rules = SLOAlertGenerator.generatePrometheusRules(slos);
    const parsed = JSON.parse(rules);

    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0].name).toBe("slo-alerts");
    expect(parsed.groups[0].rules).toHaveLength(2);

    // Check first rule (latency)
    const ttftRule = parsed.groups[0].rules[0];
    expect(ttftRule.alert).toBe("TTFT_P95Violation");
    expect(ttftRule.expr).toContain("histogram_quantile");
    expect(ttftRule.expr).toContain("0.95");
    expect(ttftRule.expr).toContain("300");

    // Check second rule (rate)
    const errorRule = parsed.groups[0].rules[1];
    expect(errorRule.alert).toBe("ERROR_RATEViolation");
    expect(errorRule.expr).toContain("rate");
  });

  it("should handle different SLO types", () => {
    const slos = new Map<string, SLO>([
      ["availability", {
        name: "Availability",
        metricName: "up",
        target: 0.999,
        window: 3600,
        errorBudget: 0.001,
      }],
      ["cache_hit_rate", {
        name: "Cache Hit Rate",
        metricName: "cache_hits_total",
        target: 0.7,
        window: 600,
        errorBudget: 0.1,
      }],
    ]);

    const rules = SLOAlertGenerator.generatePrometheusRules(slos);
    const parsed = JSON.parse(rules);

    const availRule = parsed.groups[0].rules[0];
    expect(availRule.expr).toContain("<");

    const cacheRule = parsed.groups[0].rules[1];
    expect(cacheRule.expr).toContain("<");
  });
});

describe("SLODashboardGenerator", () => {
  it("should generate Grafana dashboard JSON", () => {
    const slos = new Map<string, SLO>([
      ["ttft_p95", {
        name: "TTFT p95",
        metricName: "llm_ttft_seconds",
        target: 300,
        window: 300,
        percentile: 95,
        errorBudget: 0.01,
      }],
      ["error_rate", {
        name: "Error Rate",
        metricName: "http_requests_total",
        target: 0.01,
        window: 300,
        errorBudget: 0.05,
      }],
    ]);

    const dashboard = SLODashboardGenerator.generateGrafanaDashboard(slos);

    expect(dashboard.title).toBe("SLO Dashboard");
    expect(dashboard.refresh).toBe("10s");
    expect(dashboard.panels).toHaveLength(6); // 3 panels per SLO

    // Check panel types
    const panelTypes = dashboard.panels.map((p: any) => p.type);
    expect(panelTypes).toContain("gauge");
    expect(panelTypes).toContain("timeseries");
  });

  it("should create appropriate panel configurations", () => {
    const slos = new Map<string, SLO>([
      ["ttft_p95", {
        name: "TTFT p95",
        metricName: "llm_ttft_seconds",
        target: 300,
        window: 300,
        percentile: 95,
        errorBudget: 0.01,
      }],
    ]);

    const dashboard = SLODashboardGenerator.generateGrafanaDashboard(slos);

    // Status gauge
    const statusGauge = dashboard.panels[0];
    expect(statusGauge.type).toBe("gauge");
    expect(statusGauge.title).toContain("Status");
    expect(statusGauge.targets[0].expr).toContain("slo_status");

    // Error budget gauge
    const budgetGauge = dashboard.panels[1];
    expect(budgetGauge.type).toBe("gauge");
    expect(budgetGauge.title).toContain("Error Budget");
    expect(budgetGauge.targets[0].expr).toContain("slo_error_budget_remaining");
    expect(budgetGauge.fieldConfig.defaults.max).toBe(0.01);

    // Timeseries
    const timeseries = dashboard.panels[2];
    expect(timeseries.type).toBe("timeseries");
    expect(timeseries.title).toContain("Actual vs Target");
    expect(timeseries.targets).toHaveLength(2); // Actual and target
  });

  it("should handle percentile vs non-percentile SLOs", () => {
    const slos = new Map<string, SLO>([
      ["ttft_p95", {
        name: "TTFT p95",
        metricName: "llm_ttft_seconds",
        target: 300,
        window: 300,
        percentile: 95,
        errorBudget: 0.01,
      }],
      ["error_rate", {
        name: "Error Rate",
        metricName: "http_requests_total",
        target: 0.01,
        window: 300,
        errorBudget: 0.05,
      }],
    ]);

    const dashboard = SLODashboardGenerator.generateGrafanaDashboard(slos);

    // TTFT timeseries (with percentile)
    const ttftPanel = dashboard.panels[2];
    expect(ttftPanel.targets[0].expr).toContain("histogram_quantile");
    expect(ttftPanel.targets[0].expr).toContain("0.95");

    // Error rate timeseries (without percentile)
    const errorPanel = dashboard.panels[5];
    expect(errorPanel.targets[0].expr).toContain("rate");
    expect(errorPanel.targets[0].expr).not.toContain("histogram_quantile");
  });
});
