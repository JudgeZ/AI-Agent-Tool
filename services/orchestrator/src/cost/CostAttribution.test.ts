/**
 * CostAttribution Tests
 * Comprehensive test suite for detailed cost analysis and attribution
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CostAttribution,
  AttributionReport,
  TenantAttribution,
  OperationAttribution,
  ProviderAttribution,
  HourlyAttribution,
  DailyAttribution,
  TopSpender,
  CostRecommendation,
} from "./CostAttribution";
import { CostMetrics } from "./types";

describe("CostAttribution", () => {
  let attribution: CostAttribution;
  let sampleMetrics: CostMetrics[];

  beforeEach(() => {
    attribution = new CostAttribution();

    // Create sample metrics data
    const now = new Date("2024-01-15T12:00:00Z");
    sampleMetrics = [];

    // Generate varied metrics data
    for (let i = 0; i < 100; i++) {
      const hour = i % 24;
      const tenant = `tenant-${(i % 5) + 1}`;
      const operation = `operation-${(i % 3) + 1}`;
      const provider = i % 2 === 0 ? "openai" : "anthropic";
      const model = i % 2 === 0 ? "gpt-4" : "claude-3-opus";

      sampleMetrics.push({
        timestamp: new Date(now.getTime() + i * 3600000), // Each metric 1 hour apart
        tenant,
        operation,
        provider,
        model,
        inputTokens: 100 + Math.floor(Math.random() * 500),
        outputTokens: 200 + Math.floor(Math.random() * 800),
        totalTokens: 300 + Math.floor(Math.random() * 1300),
        cost: 0.01 + Math.random() * 0.5,
        duration: 1000 + Math.floor(Math.random() * 5000),
      });
    }
  });

  describe("addMetrics", () => {
    it("should add metrics to internal storage", () => {
      attribution.addMetrics(sampleMetrics);

      // Verify by generating a report
      const report = attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      expect(report).toBeDefined();
    });

    it("should handle empty metrics array", async () => {
      attribution.addMetrics([]);

      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-16T00:00:00Z")
      );

      expect(report.byTenant).toEqual([]);
      expect(report.byOperation).toEqual([]);
    });
  });

  describe("attributeCosts", () => {
    beforeEach(() => {
      attribution.addMetrics(sampleMetrics);
    });

    it("should generate comprehensive attribution report", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      expect(report.period.start).toBeInstanceOf(Date);
      expect(report.period.end).toBeInstanceOf(Date);
      expect(report.byTenant).toBeInstanceOf(Array);
      expect(report.byOperation).toBeInstanceOf(Array);
      expect(report.byProvider).toBeInstanceOf(Array);
      expect(report.byHour).toHaveLength(24);
      expect(report.byDay).toBeInstanceOf(Array);
      expect(report.topSpenders).toBeInstanceOf(Array);
      expect(report.anomalies).toBeInstanceOf(Array);
      expect(report.recommendations).toBeInstanceOf(Array);
    });

    it("should respect time range filtering", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-15T12:00:00Z")
      );

      // Should only include metrics within the time range
      expect(report.byOperation.length).toBeGreaterThan(0);

      // All metrics should be within the specified range
      const totalOperations = report.byOperation.reduce(
        (sum, op) => sum + op.executionCount,
        0
      );
      expect(totalOperations).toBeLessThan(100); // Not all 100 metrics
    });

    it("should exclude tenants when specified", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z"),
        { includeTenants: false }
      );

      expect(report.byTenant).toEqual([]);
      expect(report.byOperation.length).toBeGreaterThan(0);
    });

    it("should exclude recommendations when specified", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z"),
        { includeRecommendations: false }
      );

      expect(report.recommendations).toEqual([]);
    });

    it("should limit top spenders", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z"),
        { topSpenderLimit: 3 }
      );

      expect(report.topSpenders).toHaveLength(3);
    });
  });

  describe("attributeByTenant", () => {
    beforeEach(() => {
      attribution.addMetrics(sampleMetrics);
    });

    it("should attribute costs by tenant correctly", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      const tenantAttribution = report.byTenant;

      expect(tenantAttribution.length).toBeGreaterThan(0);

      // Check tenant attribution structure
      tenantAttribution.forEach(attr => {
        expect(attr.tenant).toBeDefined();
        expect(attr.totalCost).toBeGreaterThan(0);
        expect(attr.totalTokens).toBeGreaterThan(0);
        expect(attr.operationCount).toBeGreaterThan(0);
        expect(attr.avgCostPerOperation).toBeGreaterThan(0);
        expect(attr.percentOfTotal).toBeGreaterThanOrEqual(0);
        expect(attr.percentOfTotal).toBeLessThanOrEqual(100);
        expect(["increasing", "stable", "decreasing"]).toContain(attr.trend);
        expect(attr.providers).toBeInstanceOf(Object);
      });

      // Verify sorting (by total cost descending)
      for (let i = 1; i < tenantAttribution.length; i++) {
        expect(tenantAttribution[i - 1].totalCost).toBeGreaterThanOrEqual(
          tenantAttribution[i].totalCost
        );
      }
    });

    it("should calculate tenant percentages correctly", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      const totalPercentage = report.byTenant.reduce(
        (sum, attr) => sum + attr.percentOfTotal,
        0
      );

      // Should sum to approximately 100% (allowing for rounding)
      expect(totalPercentage).toBeGreaterThan(99);
      expect(totalPercentage).toBeLessThanOrEqual(101);
    });

    it("should track provider breakdown per tenant", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      report.byTenant.forEach(attr => {
        const providerTotal = Object.values(attr.providers).reduce(
          (sum, cost) => sum + cost,
          0
        );

        // Provider costs should sum to total cost (with rounding tolerance)
        expect(Math.abs(providerTotal - attr.totalCost)).toBeLessThan(0.01);
      });
    });
  });

  describe("attributeByOperation", () => {
    beforeEach(() => {
      attribution.addMetrics(sampleMetrics);
    });

    it("should attribute costs by operation", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      const operationAttribution = report.byOperation;

      expect(operationAttribution.length).toBeGreaterThan(0);

      operationAttribution.forEach(attr => {
        expect(attr.operation).toBeDefined();
        expect(attr.totalCost).toBeGreaterThan(0);
        expect(attr.totalTokens).toBeGreaterThan(0);
        expect(attr.executionCount).toBeGreaterThan(0);
        expect(attr.avgCost).toBeGreaterThan(0);
        expect(attr.avgTokens).toBeGreaterThan(0);
        expect(attr.percentOfTotal).toBeGreaterThanOrEqual(0);
        expect(attr.topTenants).toBeInstanceOf(Array);
      });
    });

    it("should identify top tenants per operation", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      report.byOperation.forEach(attr => {
        expect(attr.topTenants.length).toBeLessThanOrEqual(5);

        // Verify top tenants are sorted by cost
        for (let i = 1; i < attr.topTenants.length; i++) {
          expect(attr.topTenants[i - 1].cost).toBeGreaterThanOrEqual(
            attr.topTenants[i].cost
          );
        }
      });
    });
  });

  describe("attributeByProvider", () => {
    beforeEach(() => {
      attribution.addMetrics(sampleMetrics);
    });

    it("should attribute costs by provider and model", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      const providerAttribution = report.byProvider;

      expect(providerAttribution.length).toBeGreaterThan(0);

      providerAttribution.forEach(attr => {
        expect(attr.provider).toBeDefined();
        expect(attr.model).toBeDefined();
        expect(attr.totalCost).toBeGreaterThan(0);
        expect(attr.totalTokens).toBeGreaterThan(0);
        expect(attr.requestCount).toBeGreaterThan(0);
        expect(attr.avgCostPerRequest).toBeGreaterThan(0);
        expect(attr.percentOfTotal).toBeGreaterThanOrEqual(0);
      });
    });

    it("should separate different models from same provider", async () => {
      // Add metrics with different models from same provider
      const additionalMetrics: CostMetrics[] = [
        {
          timestamp: new Date("2024-01-15T10:00:00Z"),
          tenant: "tenant-1",
          operation: "test",
          provider: "openai",
          model: "gpt-3.5-turbo",
          inputTokens: 100,
          outputTokens: 200,
          totalTokens: 300,
          cost: 0.01,
          duration: 1000,
        },
        {
          timestamp: new Date("2024-01-15T11:00:00Z"),
          tenant: "tenant-1",
          operation: "test",
          provider: "openai",
          model: "gpt-4-turbo",
          inputTokens: 100,
          outputTokens: 200,
          totalTokens: 300,
          cost: 0.05,
          duration: 1500,
        }
      ];

      attribution.addMetrics(additionalMetrics);

      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-16T00:00:00Z")
      );

      const openaiModels = report.byProvider.filter(
        attr => attr.provider === "openai"
      );

      // Should have separate entries for different models
      const modelNames = openaiModels.map(attr => attr.model);
      expect(new Set(modelNames).size).toBeGreaterThan(1);
    });
  });

  describe("attributeByHour", () => {
    beforeEach(() => {
      attribution.addMetrics(sampleMetrics);
    });

    it("should attribute costs by hour of day", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      expect(report.byHour).toHaveLength(24);

      report.byHour.forEach((attr, index) => {
        expect(attr.hour).toBe(index);
        expect(attr.cost).toBeGreaterThanOrEqual(0);
        expect(attr.tokenCount).toBeGreaterThanOrEqual(0);
        expect(attr.operationCount).toBeGreaterThanOrEqual(0);
      });
    });

    it("should identify peak tenant per hour", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      const hoursWithActivity = report.byHour.filter(h => h.operationCount > 0);

      hoursWithActivity.forEach(attr => {
        if (attr.operationCount > 0) {
          expect(attr.peakTenant).toBeDefined();
        }
      });
    });

    it("should fill in hours with no activity", async () => {
      // Create metrics for only specific hours
      const sparseMetrics: CostMetrics[] = [
        {
          timestamp: new Date("2024-01-15T02:00:00Z"),
          tenant: "tenant-1",
          operation: "op1",
          provider: "openai",
          model: "gpt-4",
          inputTokens: 100,
          outputTokens: 200,
          totalTokens: 300,
          cost: 0.05,
          duration: 1000,
        },
        {
          timestamp: new Date("2024-01-15T10:00:00Z"),
          tenant: "tenant-2",
          operation: "op2",
          provider: "anthropic",
          model: "claude-3",
          inputTokens: 150,
          outputTokens: 250,
          totalTokens: 400,
          cost: 0.06,
          duration: 1200,
        }
      ];

      const newAttribution = new CostAttribution();
      newAttribution.addMetrics(sparseMetrics);

      const report = await newAttribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-16T00:00:00Z")
      );

      // Should have all 24 hours
      expect(report.byHour).toHaveLength(24);

      // Hours 2 and 10 should have data
      expect(report.byHour[2].cost).toBeGreaterThan(0);
      expect(report.byHour[10].cost).toBeGreaterThan(0);

      // Other hours should be zero
      expect(report.byHour[0].cost).toBe(0);
      expect(report.byHour[1].cost).toBe(0);
    });
  });

  describe("attributeByDay", () => {
    beforeEach(() => {
      attribution.addMetrics(sampleMetrics);
    });

    it("should attribute costs by day", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      expect(report.byDay.length).toBeGreaterThan(0);

      report.byDay.forEach(attr => {
        expect(attr.date).toBeInstanceOf(Date);
        expect(attr.cost).toBeGreaterThanOrEqual(0);
        expect(attr.tokenCount).toBeGreaterThanOrEqual(0);
        expect(attr.operationCount).toBeGreaterThanOrEqual(0);
        expect(attr.topOperation).toBeDefined();
      });
    });

    it("should identify top operation and tenant per day", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      report.byDay.forEach(attr => {
        if (attr.operationCount > 0) {
          expect(attr.topOperation).toBeTruthy();
          // Top tenant may or may not be defined depending on data
        }
      });
    });

    it("should sort days chronologically", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      for (let i = 1; i < report.byDay.length; i++) {
        expect(report.byDay[i].date.getTime()).toBeGreaterThanOrEqual(
          report.byDay[i - 1].date.getTime()
        );
      }
    });
  });

  describe("identifyTopSpenders", () => {
    beforeEach(() => {
      attribution.addMetrics(sampleMetrics);
    });

    it("should identify top spending tenants", async () => {
      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z"),
        { topSpenderLimit: 5 }
      );

      expect(report.topSpenders).toHaveLength(5);

      report.topSpenders.forEach(spender => {
        expect(spender.tenant).toBeDefined();
        expect(spender.totalCost).toBeGreaterThan(0);
        expect(spender.percentOfTotal).toBeGreaterThan(0);
        expect(spender.growthRate).toBeDefined();
        expect(spender.operations).toBeInstanceOf(Array);
        expect(spender.providers).toBeInstanceOf(Array);
      });

      // Verify sorting by total cost
      for (let i = 1; i < report.topSpenders.length; i++) {
        expect(report.topSpenders[i - 1].totalCost).toBeGreaterThanOrEqual(
          report.topSpenders[i].totalCost
        );
      }
    });

    it("should add recommendations for high spenders", async () => {
      // Create metrics with one dominant tenant
      const dominantMetrics: CostMetrics[] = [];

      for (let i = 0; i < 100; i++) {
        dominantMetrics.push({
          timestamp: new Date(`2024-01-15T${i % 24}:00:00Z`),
          tenant: i < 80 ? "heavy-spender" : `tenant-${i}`,
          operation: "operation-1",
          provider: "openai",
          model: "gpt-4",
          inputTokens: 1000,
          outputTokens: 2000,
          totalTokens: 3000,
          cost: 1.0,
          duration: 2000,
        });
      }

      const newAttribution = new CostAttribution();
      newAttribution.addMetrics(dominantMetrics);

      const report = await newAttribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-16T00:00:00Z")
      );

      const heavySpender = report.topSpenders.find(s => s.tenant === "heavy-spender");

      expect(heavySpender).toBeDefined();
      expect(heavySpender?.percentOfTotal).toBeGreaterThan(20);
      expect(heavySpender?.recommendation).toBeDefined();
    });
  });

  describe("detectAnomalies", () => {
    it("should detect cost spikes", async () => {
      // Create metrics with a spike
      const spikeMetrics: CostMetrics[] = [];
      const baseTime = new Date("2024-01-15T00:00:00Z");

      // Normal baseline
      for (let i = 0; i < 20; i++) {
        spikeMetrics.push({
          timestamp: new Date(baseTime.getTime() + i * 3600000),
          tenant: "tenant-1",
          operation: "normal-op",
          provider: "openai",
          model: "gpt-3.5-turbo",
          inputTokens: 100,
          outputTokens: 200,
          totalTokens: 300,
          cost: 0.01,
          duration: 1000,
        });
      }

      // Add spike at hour 10
      for (let i = 0; i < 5; i++) {
        spikeMetrics.push({
          timestamp: new Date(baseTime.getTime() + 10 * 3600000),
          tenant: "tenant-1",
          operation: "spike-op",
          provider: "openai",
          model: "gpt-4",
          inputTokens: 1000,
          outputTokens: 2000,
          totalTokens: 3000,
          cost: 5.0, // Much higher cost
          duration: 3000,
        });
      }

      const newAttribution = new CostAttribution();
      newAttribution.addMetrics(spikeMetrics);

      const report = await newAttribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-16T00:00:00Z")
      );

      expect(report.anomalies.length).toBeGreaterThan(0);

      const spikeAnomaly = report.anomalies.find(a => a.type === "spike");
      expect(spikeAnomaly).toBeDefined();
      expect(spikeAnomaly?.severity).toBeDefined();
      expect(spikeAnomaly?.message).toContain("spike");
    });

    it("should detect unusual patterns", async () => {
      // Create metrics where one tenant dominates
      const dominantMetrics: CostMetrics[] = [];

      for (let i = 0; i < 100; i++) {
        dominantMetrics.push({
          timestamp: new Date(`2024-01-15T${i % 24}:00:00Z`),
          tenant: i < 85 ? "dominant-tenant" : "other-tenant",
          operation: "operation-1",
          provider: "openai",
          model: "gpt-4",
          inputTokens: 500,
          outputTokens: 1000,
          totalTokens: 1500,
          cost: 0.5,
          duration: 2000,
        });
      }

      const newAttribution = new CostAttribution();
      newAttribution.addMetrics(dominantMetrics);

      const report = await newAttribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-16T00:00:00Z")
      );

      const patternAnomaly = report.anomalies.find(
        a => a.type === "unusual_pattern"
      );

      expect(patternAnomaly).toBeDefined();
      expect(patternAnomaly?.message).toContain("consuming");
    });
  });

  describe("generateRecommendations", () => {
    it("should recommend caching for frequent operations", async () => {
      // Create many repetitions of same operation
      const repetitiveMetrics: CostMetrics[] = [];

      for (let i = 0; i < 150; i++) {
        const hour = String(i % 24).padStart(2, "0");
        repetitiveMetrics.push({
          timestamp: new Date(`2024-01-15T${hour}:00:00Z`),
          tenant: `tenant-${(i % 3) + 1}`,
          operation: "frequent-operation",
          provider: "openai",
          model: "gpt-3.5-turbo",
          inputTokens: 100,
          outputTokens: 200,
          totalTokens: 300,
          cost: 0.02,
          duration: 1000,
        });
      }

      const newAttribution = new CostAttribution();
      newAttribution.addMetrics(repetitiveMetrics);

      const report = await newAttribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-16T00:00:00Z")
      );

      const cacheRec = report.recommendations.find(r => r.type === "cache");

      expect(cacheRec).toBeDefined();
      expect(cacheRec?.severity).toBe("high");
      expect(cacheRec?.description).toContain("caching");
      expect(cacheRec?.estimatedSavings).toBeGreaterThan(0);
    });

    it("should recommend batching for clustered requests", async () => {
      // Create many requests in same time window
      const clusteredMetrics: CostMetrics[] = [];
      const baseTime = new Date("2024-01-15T10:00:00Z");

      for (let i = 0; i < 10; i++) {
        clusteredMetrics.push({
          timestamp: new Date(baseTime.getTime() + i * 1000), // All within same minute
          tenant: "tenant-1",
          operation: "batch-operation",
          provider: "openai",
          model: "gpt-3.5-turbo",
          inputTokens: 50,
          outputTokens: 100,
          totalTokens: 150,
          cost: 0.01,
          duration: 500,
        });
      }

      const newAttribution = new CostAttribution();
      newAttribution.addMetrics(clusteredMetrics);

      const report = await newAttribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-16T00:00:00Z")
      );

      const batchRec = report.recommendations.find(r => r.type === "batch");

      expect(batchRec).toBeDefined();
      expect(batchRec?.description).toContain("Batch");
      expect(batchRec?.estimatedSavings).toBeGreaterThan(0);
    });

    it("should recommend model downgrade for small prompts", async () => {
      // Create metrics using expensive model for small prompts
      const smallPromptMetrics: CostMetrics[] = [];

      for (let i = 0; i < 50; i++) {
        const hour = String(i % 24).padStart(2, "0");
        smallPromptMetrics.push({
          timestamp: new Date(`2024-01-15T${hour}:00:00Z`),
          tenant: "tenant-1",
          operation: "simple-operation",
          provider: "openai",
          model: "gpt-4-turbo",
          inputTokens: 50, // Small prompt
          outputTokens: 100,
          totalTokens: 150,
          cost: 0.1, // High cost for small prompt
          duration: 1000,
        });
      }

      const newAttribution = new CostAttribution();
      newAttribution.addMetrics(smallPromptMetrics);

      const report = await newAttribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-16T00:00:00Z")
      );

      const downgradeRec = report.recommendations.find(
        r => r.type === "model_downgrade"
      );

      expect(downgradeRec).toBeDefined();
      expect(downgradeRec?.description).toContain("GPT-3.5");
      expect(downgradeRec?.severity).toBe("medium");
    });

    it("should sort recommendations by estimated savings", async () => {
      attribution.addMetrics(sampleMetrics);

      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );

      if (report.recommendations.length > 1) {
        for (let i = 1; i < report.recommendations.length; i++) {
          expect(report.recommendations[i - 1].estimatedSavings).toBeGreaterThanOrEqual(
            report.recommendations[i].estimatedSavings
          );
        }
      }
    });
  });

  describe("edge cases", () => {
    it("should handle metrics without tenant", async () => {
      const metricsWithoutTenant: CostMetrics[] = [
        {
          timestamp: new Date("2024-01-15T10:00:00Z"),
          tenant: undefined as any, // No tenant
          operation: "anonymous-op",
          provider: "openai",
          model: "gpt-3.5-turbo",
          inputTokens: 100,
          outputTokens: 200,
          totalTokens: 300,
          cost: 0.05,
          duration: 1000,
        }
      ];

      attribution.addMetrics(metricsWithoutTenant);

      const report = await attribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-16T00:00:00Z")
      );

      const unknownTenant = report.byTenant.find(t => t.tenant === "unknown");
      expect(unknownTenant).toBeDefined();
    });

    it("should handle empty time range", async () => {
      attribution.addMetrics(sampleMetrics);

      const report = await attribution.attributeCosts(
        new Date("2025-01-15T00:00:00Z"), // Future date
        new Date("2025-01-16T00:00:00Z")
      );

      expect(report.byTenant).toEqual([]);
      expect(report.byOperation).toEqual([]);
      expect(report.byProvider).toEqual([]);
      expect(report.topSpenders).toEqual([]);
    });

    it("should handle single metric", async () => {
      const singleMetric: CostMetrics[] = [
        {
          timestamp: new Date("2024-01-15T10:00:00Z"),
          tenant: "single-tenant",
          operation: "single-op",
          provider: "openai",
          model: "gpt-4",
          inputTokens: 100,
          outputTokens: 200,
          totalTokens: 300,
          cost: 0.05,
          duration: 1000,
        }
      ];

      const newAttribution = new CostAttribution();
      newAttribution.addMetrics(singleMetric);

      const report = await newAttribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-16T00:00:00Z")
      );

      expect(report.byTenant).toHaveLength(1);
      expect(report.byOperation).toHaveLength(1);
      expect(report.byProvider).toHaveLength(1);
    });

    it("should handle very large datasets efficiently", async () => {
      const largeMetrics: CostMetrics[] = [];

      // Generate 10,000 metrics
      for (let i = 0; i < 10000; i++) {
        largeMetrics.push({
          timestamp: new Date(`2024-01-${15 + (i % 5)}T${String(i % 24).padStart(2, "0")}:00:00Z`),
          tenant: `tenant-${(i % 100) + 1}`,
          operation: `operation-${(i % 50) + 1}`,
          provider: i % 2 === 0 ? "openai" : "anthropic",
          model: i % 2 === 0 ? "gpt-4" : "claude-3",
          inputTokens: 100 + (i % 500),
          outputTokens: 200 + (i % 800),
          totalTokens: 300 + (i % 1300),
          cost: 0.01 + (i % 100) * 0.001,
          duration: 1000 + (i % 5000),
        });
      }

      const newAttribution = new CostAttribution();
      newAttribution.addMetrics(largeMetrics);

      const start = Date.now();
      const report = await newAttribution.attributeCosts(
        new Date("2024-01-15T00:00:00Z"),
        new Date("2024-01-20T00:00:00Z")
      );
      const duration = Date.now() - start;

      expect(report).toBeDefined();
      expect(report.byTenant.length).toBeGreaterThan(0);

      // Should process in reasonable time (< 2 seconds)
      expect(duration).toBeLessThan(2000);
    });
  });
});
