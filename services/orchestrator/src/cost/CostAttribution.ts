/**
 * CostAttribution - Detailed cost analysis and attribution
 * Phase 5 implementation for multi-tenant cost tracking
 */

import { CostMetrics, CostAnomaly } from './types';

export interface AttributionReport {
  period: {
    start: Date;
    end: Date;
  };
  byTenant: TenantAttribution[];
  byOperation: OperationAttribution[];
  byProvider: ProviderAttribution[];
  byHour: HourlyAttribution[];
  byDay: DailyAttribution[];
  topSpenders: TopSpender[];
  anomalies: CostAnomaly[];
  recommendations: CostRecommendation[];
}

export interface TenantAttribution {
  tenant: string;
  totalCost: number;
  totalTokens: number;
  operationCount: number;
  avgCostPerOperation: number;
  percentOfTotal: number;
  trend: 'increasing' | 'stable' | 'decreasing';
  providers: Record<string, number>;
}

export interface OperationAttribution {
  operation: string;
  totalCost: number;
  totalTokens: number;
  executionCount: number;
  avgCost: number;
  avgTokens: number;
  percentOfTotal: number;
  topTenants: Array<{ tenant: string; cost: number }>;
}

export interface ProviderAttribution {
  provider: string;
  model: string;
  totalCost: number;
  totalTokens: number;
  requestCount: number;
  avgCostPerRequest: number;
  percentOfTotal: number;
}

export interface HourlyAttribution {
  hour: number;
  cost: number;
  tokenCount: number;
  operationCount: number;
  peakTenant?: string;
}

export interface DailyAttribution {
  date: Date;
  cost: number;
  tokenCount: number;
  operationCount: number;
  topOperation: string;
  topTenant?: string;
}

export interface TopSpender {
  tenant: string;
  totalCost: number;
  percentOfTotal: number;
  growthRate: number; // % change from previous period
  operations: string[];
  providers: string[];
  recommendation?: string;
}

export interface CostRecommendation {
  type: 'cache' | 'batch' | 'model_downgrade' | 'rate_limit' | 'budget_alert';
  severity: 'low' | 'medium' | 'high';
  estimatedSavings: number;
  description: string;
  affectedTenants?: string[];
  affectedOperations?: string[];
}

export class CostAttribution {
  private metrics: CostMetrics[] = [];
  private anomalyThreshold = 2; // 2x baseline for anomaly detection

  /**
   * Add metrics for attribution
   */
  addMetrics(metrics: CostMetrics[]): void {
    this.metrics.push(...metrics);
  }

  /**
   * Generate comprehensive attribution report
   */
  async attributeCosts(
    startTime: Date,
    endTime: Date,
    options?: {
      includeTenants?: boolean;
      includeRecommendations?: boolean;
      topSpenderLimit?: number;
    }
  ): Promise<AttributionReport> {
    const period = { start: startTime, end: endTime };
    const filteredMetrics = this.filterMetricsByTime(startTime, endTime);

    return {
      period,
      byTenant: options?.includeTenants !== false ? this.attributeByTenant(filteredMetrics) : [],
      byOperation: this.attributeByOperation(filteredMetrics),
      byProvider: this.attributeByProvider(filteredMetrics),
      byHour: this.attributeByHour(filteredMetrics),
      byDay: this.attributeByDay(filteredMetrics),
      topSpenders: this.identifyTopSpenders(filteredMetrics, options?.topSpenderLimit || 10),
      anomalies: await this.detectAnomalies(filteredMetrics),
      recommendations: options?.includeRecommendations !== false
        ? this.generateRecommendations(filteredMetrics)
        : []
    };
  }

  /**
   * Filter metrics by time range
   */
  private filterMetricsByTime(start: Date, end: Date): CostMetrics[] {
    return this.metrics.filter(m =>
      m.timestamp >= start && m.timestamp <= end
    );
  }

  /**
   * Attribute costs by tenant
   */
  private attributeByTenant(metrics: CostMetrics[]): TenantAttribution[] {
    const tenantMap = new Map<string, TenantAttribution>();
    const totalCost = metrics.reduce((sum, m) => sum + m.cost, 0);

    metrics.forEach(m => {
      const tenant = m.tenant || 'unknown';
      if (!tenantMap.has(tenant)) {
        tenantMap.set(tenant, {
          tenant,
          totalCost: 0,
          totalTokens: 0,
          operationCount: 0,
          avgCostPerOperation: 0,
          percentOfTotal: 0,
          trend: 'stable',
          providers: {}
        });
      }

      const attr = tenantMap.get(tenant)!;
      attr.totalCost += m.cost;
      attr.totalTokens += m.totalTokens;
      attr.operationCount += 1;
      attr.providers[m.provider] = (attr.providers[m.provider] || 0) + m.cost;
    });

    // Calculate averages and percentages
    const attributions = Array.from(tenantMap.values());
    attributions.forEach(attr => {
      attr.avgCostPerOperation = attr.totalCost / attr.operationCount;
      attr.percentOfTotal = (attr.totalCost / totalCost) * 100;
      attr.trend = this.calculateTrend(attr.tenant, metrics);
    });

    return attributions.sort((a, b) => b.totalCost - a.totalCost);
  }

  /**
   * Attribute costs by operation
   */
  private attributeByOperation(metrics: CostMetrics[]): OperationAttribution[] {
    const operationMap = new Map<string, OperationAttribution>();
    const totalCost = metrics.reduce((sum, m) => sum + m.cost, 0);

    metrics.forEach(m => {
      if (!operationMap.has(m.operation)) {
        operationMap.set(m.operation, {
          operation: m.operation,
          totalCost: 0,
          totalTokens: 0,
          executionCount: 0,
          avgCost: 0,
          avgTokens: 0,
          percentOfTotal: 0,
          topTenants: []
        });
      }

      const attr = operationMap.get(m.operation)!;
      attr.totalCost += m.cost;
      attr.totalTokens += m.totalTokens;
      attr.executionCount += 1;
    });

    // Calculate averages and top tenants
    const attributions = Array.from(operationMap.values());
    attributions.forEach(attr => {
      attr.avgCost = attr.totalCost / attr.executionCount;
      attr.avgTokens = attr.totalTokens / attr.executionCount;
      attr.percentOfTotal = (attr.totalCost / totalCost) * 100;

      // Find top tenants for this operation
      const tenantCosts = new Map<string, number>();
      metrics
        .filter(m => m.operation === attr.operation)
        .forEach(m => {
          const tenant = m.tenant || 'unknown';
          tenantCosts.set(tenant, (tenantCosts.get(tenant) || 0) + m.cost);
        });

      attr.topTenants = Array.from(tenantCosts.entries())
        .map(([tenant, cost]) => ({ tenant, cost }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 5);
    });

    return attributions.sort((a, b) => b.totalCost - a.totalCost);
  }

  /**
   * Attribute costs by provider
   */
  private attributeByProvider(metrics: CostMetrics[]): ProviderAttribution[] {
    const providerMap = new Map<string, ProviderAttribution>();
    const totalCost = metrics.reduce((sum, m) => sum + m.cost, 0);

    metrics.forEach(m => {
      const key = `${m.provider}:${m.model}`;
      if (!providerMap.has(key)) {
        providerMap.set(key, {
          provider: m.provider,
          model: m.model,
          totalCost: 0,
          totalTokens: 0,
          requestCount: 0,
          avgCostPerRequest: 0,
          percentOfTotal: 0
        });
      }

      const attr = providerMap.get(key)!;
      attr.totalCost += m.cost;
      attr.totalTokens += m.totalTokens;
      attr.requestCount += 1;
    });

    // Calculate averages and percentages
    const attributions = Array.from(providerMap.values());
    attributions.forEach(attr => {
      attr.avgCostPerRequest = attr.totalCost / attr.requestCount;
      attr.percentOfTotal = (attr.totalCost / totalCost) * 100;
    });

    return attributions.sort((a, b) => b.totalCost - a.totalCost);
  }

  /**
   * Attribute costs by hour
   */
  private attributeByHour(metrics: CostMetrics[]): HourlyAttribution[] {
    const hourlyMap = new Map<number, HourlyAttribution>();

    metrics.forEach(m => {
      const hour = m.timestamp.getUTCHours();
      if (!hourlyMap.has(hour)) {
        hourlyMap.set(hour, {
          hour,
          cost: 0,
          tokenCount: 0,
          operationCount: 0
        });
      }

      const attr = hourlyMap.get(hour)!;
      attr.cost += m.cost;
      attr.tokenCount += m.totalTokens;
      attr.operationCount += 1;
    });

    // Find peak tenant for each hour
    hourlyMap.forEach((attr, hour) => {
      const hourMetrics = metrics.filter(m => m.timestamp.getUTCHours() === hour);
      const tenantCosts = new Map<string, number>();

      hourMetrics.forEach(m => {
        if (m.tenant) {
          tenantCosts.set(m.tenant, (tenantCosts.get(m.tenant) || 0) + m.cost);
        }
      });

      if (tenantCosts.size > 0) {
        const [peakTenant] = Array.from(tenantCosts.entries())
          .sort((a, b) => b[1] - a[1])[0];
        attr.peakTenant = peakTenant;
      }
    });

    // Fill in missing hours
    const attributions: HourlyAttribution[] = [];
    for (let hour = 0; hour < 24; hour++) {
      attributions.push(hourlyMap.get(hour) || {
        hour,
        cost: 0,
        tokenCount: 0,
        operationCount: 0
      });
    }

    return attributions;
  }

  /**
   * Attribute costs by day
   */
  private attributeByDay(metrics: CostMetrics[]): DailyAttribution[] {
    const dailyMap = new Map<string, DailyAttribution>();

    metrics.forEach(m => {
      const dateKey = m.timestamp.toISOString().split('T')[0];
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, {
          date: new Date(dateKey),
          cost: 0,
          tokenCount: 0,
          operationCount: 0,
          topOperation: '',
          topTenant: undefined
        });
      }

      const attr = dailyMap.get(dateKey)!;
      attr.cost += m.cost;
      attr.tokenCount += m.totalTokens;
      attr.operationCount += 1;
    });

    // Find top operation and tenant for each day
    dailyMap.forEach((attr, dateKey) => {
      const dayMetrics = metrics.filter(m =>
        m.timestamp.toISOString().split('T')[0] === dateKey
      );

      // Top operation
      const operationCosts = new Map<string, number>();
      dayMetrics.forEach(m => {
        operationCosts.set(m.operation, (operationCosts.get(m.operation) || 0) + m.cost);
      });

      if (operationCosts.size > 0) {
        const [topOperation] = Array.from(operationCosts.entries())
          .sort((a, b) => b[1] - a[1])[0];
        attr.topOperation = topOperation;
      }

      // Top tenant
      const tenantCosts = new Map<string, number>();
      dayMetrics.forEach(m => {
        if (m.tenant) {
          tenantCosts.set(m.tenant, (tenantCosts.get(m.tenant) || 0) + m.cost);
        }
      });

      if (tenantCosts.size > 0) {
        const [topTenant] = Array.from(tenantCosts.entries())
          .sort((a, b) => b[1] - a[1])[0];
        attr.topTenant = topTenant;
      }
    });

    return Array.from(dailyMap.values()).sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  /**
   * Identify top spending tenants
   */
  private identifyTopSpenders(metrics: CostMetrics[], limit: number): TopSpender[] {
    const tenantData = new Map<string, TopSpender>();
    const totalCost = metrics.reduce((sum, m) => sum + m.cost, 0);

    metrics.forEach(m => {
      const tenant = m.tenant || 'unknown';
      if (!tenantData.has(tenant)) {
        tenantData.set(tenant, {
          tenant,
          totalCost: 0,
          percentOfTotal: 0,
          growthRate: 0,
          operations: [],
          providers: []
        });
      }

      const data = tenantData.get(tenant)!;
      data.totalCost += m.cost;

      if (!data.operations.includes(m.operation)) {
        data.operations.push(m.operation);
      }
      if (!data.providers.includes(m.provider)) {
        data.providers.push(m.provider);
      }
    });

    // Calculate percentages and growth
    const spenders = Array.from(tenantData.values());
    spenders.forEach(spender => {
      spender.percentOfTotal = (spender.totalCost / totalCost) * 100;
      spender.growthRate = this.calculateGrowthRate(spender.tenant, metrics);

      // Add recommendations for high spenders
      if (spender.percentOfTotal > 20) {
        spender.recommendation = `Consider implementing rate limiting or budget alerts for tenant ${spender.tenant}`;
      } else if (spender.growthRate > 50) {
        spender.recommendation = `Monitor ${spender.tenant} closely - 50%+ growth detected`;
      }
    });

    return spenders
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, limit);
  }

  /**
   * Detect cost anomalies
   */
  private async detectAnomalies(metrics: CostMetrics[]): Promise<CostAnomaly[]> {
    const anomalies: CostAnomaly[] = [];

    // Group metrics by hour
    const hourlyGroups = new Map<number, CostMetrics[]>();
    metrics.forEach(m => {
      const hour = m.timestamp.getUTCHours();
      if (!hourlyGroups.has(hour)) {
        hourlyGroups.set(hour, []);
      }
      hourlyGroups.get(hour)!.push(m);
    });

    // Calculate baseline and detect spikes
    hourlyGroups.forEach((hourMetrics, hour) => {
      const hourlySpend = hourMetrics.reduce((sum, m) => sum + m.cost, 0);
      const baseline = this.calculateHourlyBaseline(hour, metrics);

      if (hourlySpend > baseline * this.anomalyThreshold) {
        anomalies.push({
          type: 'spike',
          timestamp: new Date(),
          value: hourlySpend,
          baseline,
          severity: hourlySpend > baseline * 5 ? 'critical' :
            hourlySpend > baseline * 3 ? 'high' : 'medium',
          message: `Hour ${hour}: Cost spike detected - $${hourlySpend.toFixed(2)} (${(hourlySpend / baseline).toFixed(1)}x normal)`
        });
      }
    });

    // Check for unusual patterns
    const tenantSpend = new Map<string, number>();
    metrics.forEach(m => {
      if (m.tenant) {
        tenantSpend.set(m.tenant, (tenantSpend.get(m.tenant) || 0) + m.cost);
      }
    });

    // Detect if a single tenant is consuming too much
    const totalSpend = Array.from(tenantSpend.values()).reduce((a, b) => a + b, 0);
    tenantSpend.forEach((spend, tenant) => {
      const percentage = (spend / totalSpend) * 100;
      if (percentage > 50) {
        anomalies.push({
          type: 'unusual_pattern',
          timestamp: new Date(),
          value: spend,
          severity: percentage > 75 ? 'high' : 'medium',
          message: `Tenant ${tenant} consuming ${percentage.toFixed(1)}% of total spend`
        });
      }
    });

    return anomalies;
  }

  /**
   * Generate cost optimization recommendations
   */
  private generateRecommendations(metrics: CostMetrics[]): CostRecommendation[] {
    const recommendations: CostRecommendation[] = [];

    // Analyze for caching opportunities
    const operationFrequency = new Map<string, number>();
    metrics.forEach(m => {
      operationFrequency.set(m.operation, (operationFrequency.get(m.operation) || 0) + 1);
    });

    operationFrequency.forEach((count, operation) => {
      if (count > 100) {
        const operationCost = metrics
          .filter(m => m.operation === operation)
          .reduce((sum, m) => sum + m.cost, 0);

        recommendations.push({
          type: 'cache',
          severity: 'high',
          estimatedSavings: operationCost * 0.7, // Assume 70% cache hit rate
          description: `Enable caching for "${operation}" - executed ${count} times`,
          affectedOperations: [operation]
        });
      }
    });

    // Analyze for batching opportunities
    const timeWindows = new Map<string, CostMetrics[]>();
    metrics.forEach(m => {
      const window = Math.floor(m.timestamp.getTime() / (1000 * 60)); // 1-minute windows
      const key = `${window}-${m.operation}`;
      if (!timeWindows.has(key)) {
        timeWindows.set(key, []);
      }
      timeWindows.get(key)!.push(m);
    });

    timeWindows.forEach((windowMetrics, key) => {
      if (windowMetrics.length > 5) {
        const totalCost = windowMetrics.reduce((sum, m) => sum + m.cost, 0);
        const [, operation] = key.split('-');

        recommendations.push({
          type: 'batch',
          severity: 'medium',
          estimatedSavings: totalCost * 0.4, // Assume 40% reduction from batching
          description: `Batch similar requests for "${operation}" - ${windowMetrics.length} requests in same minute`,
          affectedOperations: [operation]
        });
      }
    });

    // Check for model downgrade opportunities
    const modelUsage = new Map<string, { provider: string; model: string; count: number; avgTokens: number }>();
    metrics.forEach(m => {
      const key = `${m.provider}:${m.model}`;
      if (!modelUsage.has(key)) {
        modelUsage.set(key, { provider: m.provider, model: m.model, count: 0, avgTokens: 0 });
      }
      const usage = modelUsage.get(key)!;
      usage.count++;
      usage.avgTokens = (usage.avgTokens * (usage.count - 1) + m.totalTokens) / usage.count;
    });

    modelUsage.forEach((usage) => {
      const { model } = usage;

      // If using expensive models for small prompts
      if (model.includes('gpt-4') && usage.avgTokens < 500) {
        recommendations.push({
          type: 'model_downgrade',
          severity: 'medium',
          estimatedSavings: 0.5, // Rough estimate
          description: `Consider using GPT-3.5 instead of ${model} for small prompts (avg ${Math.round(usage.avgTokens)} tokens)`,
          affectedOperations: []
        });
      }
    });

    return recommendations.sort((a, b) => b.estimatedSavings - a.estimatedSavings);
  }

  /**
   * Calculate trend for a tenant
   */
  private calculateTrend(tenant: string, metrics: CostMetrics[]): 'increasing' | 'stable' | 'decreasing' {
    const tenantMetrics = metrics.filter(m => m.tenant === tenant);
    if (tenantMetrics.length < 2) return 'stable';

    // Compare first half vs second half
    const midpoint = Math.floor(tenantMetrics.length / 2);
    const firstHalf = tenantMetrics.slice(0, midpoint).reduce((sum, m) => sum + m.cost, 0);
    const secondHalf = tenantMetrics.slice(midpoint).reduce((sum, m) => sum + m.cost, 0);

    const change = ((secondHalf - firstHalf) / firstHalf) * 100;

    if (change > 10) return 'increasing';
    if (change < -10) return 'decreasing';
    return 'stable';
  }

  /**
   * Calculate growth rate for a tenant
   */
  private calculateGrowthRate(tenant: string, metrics: CostMetrics[]): number {
    const tenantMetrics = metrics.filter(m => m.tenant === tenant);
    if (tenantMetrics.length < 2) return 0;

    const midpoint = Math.floor(tenantMetrics.length / 2);
    const firstHalf = tenantMetrics.slice(0, midpoint).reduce((sum, m) => sum + m.cost, 0);
    const secondHalf = tenantMetrics.slice(midpoint).reduce((sum, m) => sum + m.cost, 0);

    if (firstHalf === 0) return 100;
    return ((secondHalf - firstHalf) / firstHalf) * 100;
  }

  /**
   * Calculate hourly baseline
   */
  private calculateHourlyBaseline(hour: number, metrics: CostMetrics[]): number {
    const hourlyMetrics = metrics.filter(m => m.timestamp.getUTCHours() === hour);
    if (hourlyMetrics.length === 0) return 0;

    const costs = hourlyMetrics.map(m => m.cost);
    costs.sort((a, b) => a - b);

    // Use median as baseline (more robust than mean)
    const median = costs[Math.floor(costs.length / 2)];
    return median || 0.01; // Avoid division by zero
  }
}
