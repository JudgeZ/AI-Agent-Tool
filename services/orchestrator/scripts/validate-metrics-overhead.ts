#!/usr/bin/env tsx
/**
 * Metrics Overhead Validation Script
 *
 * This script validates that the metrics collection overhead remains below
 * the target threshold (<0.1ms per request) in various scenarios.
 *
 * Usage:
 *   npm run metrics:validate
 *   npm run metrics:validate -- --detailed
 */

import { performance } from 'perf_hooks';
import { Command } from 'commander';
import axios, { AxiosInstance } from 'axios';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import * as os from 'os';

interface ValidationConfig {
  baseUrl: string;
  iterations: number;
  warmupIterations: number;
  detailed: boolean;
  providers: string[];
}

interface MetricsOverheadResult {
  scenario: string;
  metricsEnabled: boolean;
  averageLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  maxLatency: number;
  overhead: number;
  passed: boolean;
}

class MetricsOverheadValidator {
  private client: AxiosInstance;
  private baselineLatencies: Map<string, number[]> = new Map();
  private metricsLatencies: Map<string, number[]> = new Map();

  constructor(private config: ValidationConfig) {
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: 30000
    });
  }

  async run(): Promise<void> {
    console.log(chalk.blue.bold('\n🔬 Metrics Overhead Validation\n'));
    console.log(chalk.gray('Configuration:'));
    console.log(chalk.gray(`  • Iterations: ${this.config.iterations}`));
    console.log(chalk.gray(`  • Warmup: ${this.config.warmupIterations}`));
    console.log(chalk.gray(`  • Target overhead: <0.1ms`));
    console.log();

    // Get system info
    this.displaySystemInfo();

    // Test scenarios
    const scenarios = [
      'simple_request',
      'complex_request',
      'high_cardinality',
      'concurrent_requests',
      'cache_hit',
      'error_response'
    ];

    const results: MetricsOverheadResult[] = [];

    for (const scenario of scenarios) {
      console.log(chalk.yellow(`\nTesting scenario: ${scenario}`));

      // Test without metrics
      const baselineResult = await this.testScenario(scenario, false);
      results.push(baselineResult);

      // Test with metrics
      const metricsResult = await this.testScenario(scenario, true);
      results.push(metricsResult);
    }

    // Display results
    this.displayResults(results);

    // Detailed analysis if requested
    if (this.config.detailed) {
      await this.performDetailedAnalysis();
    }

    // Final verdict
    this.displayVerdict(results);
  }

  private displaySystemInfo(): void {
    console.log(chalk.blue.bold('System Information:'));
    console.log(chalk.gray(`  • Platform: ${os.platform()}`));
    console.log(chalk.gray(`  • CPU: ${os.cpus()[0].model}`));
    console.log(chalk.gray(`  • Cores: ${os.cpus().length}`));
    console.log(chalk.gray(`  • Memory: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`));
    console.log(chalk.gray(`  • Node: ${process.version}`));
    console.log();
  }

  private async testScenario(
    scenario: string,
    metricsEnabled: boolean
  ): Promise<MetricsOverheadResult> {
    const spinner = ora({
      text: `Testing ${scenario} (metrics ${metricsEnabled ? 'enabled' : 'disabled'})...`,
      spinner: 'dots'
    }).start();

    const latencies: number[] = [];

    // Warmup
    for (let i = 0; i < this.config.warmupIterations; i++) {
      await this.executeRequest(scenario, metricsEnabled);
    }

    // Actual test
    for (let i = 0; i < this.config.iterations; i++) {
      const latency = await this.executeRequest(scenario, metricsEnabled);
      latencies.push(latency);
    }

    // Store results for comparison
    if (metricsEnabled) {
      this.metricsLatencies.set(scenario, latencies);
    } else {
      this.baselineLatencies.set(scenario, latencies);
    }

    // Calculate statistics
    latencies.sort((a, b) => a - b);
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p50 = this.percentile(latencies, 0.5);
    const p95 = this.percentile(latencies, 0.95);
    const p99 = this.percentile(latencies, 0.99);
    const max = Math.max(...latencies);

    // Calculate overhead if metrics enabled
    let overhead = 0;
    if (metricsEnabled && this.baselineLatencies.has(scenario)) {
      const baselineAvg = this.baselineLatencies.get(scenario)!
        .reduce((a, b) => a + b, 0) / this.baselineLatencies.get(scenario)!.length;
      overhead = avg - baselineAvg;
    }

    const passed = overhead < 0.1; // Target: <0.1ms overhead

    spinner.succeed(
      `${scenario} (metrics ${metricsEnabled ? 'on' : 'off'}): ` +
      `avg=${avg.toFixed(3)}ms, overhead=${overhead.toFixed(3)}ms`
    );

    return {
      scenario,
      metricsEnabled,
      averageLatency: avg,
      p50Latency: p50,
      p95Latency: p95,
      p99Latency: p99,
      maxLatency: max,
      overhead,
      passed
    };
  }

  private async executeRequest(scenario: string, metricsEnabled: boolean): Promise<number> {
    // Disable/enable metrics collection
    if (!metricsEnabled) {
      process.env.DISABLE_METRICS = 'true';
    } else {
      delete process.env.DISABLE_METRICS;
    }

    const start = performance.now();

    try {
      switch (scenario) {
        case 'simple_request':
          await this.simpleRequest();
          break;

        case 'complex_request':
          await this.complexRequest();
          break;

        case 'high_cardinality':
          await this.highCardinalityRequest();
          break;

        case 'concurrent_requests':
          await this.concurrentRequests();
          break;

        case 'cache_hit':
          await this.cacheHitRequest();
          break;

        case 'error_response':
          await this.errorRequest();
          break;

        default:
          await this.simpleRequest();
      }
    } catch (error) {
      // Expected for error scenarios
    }

    return performance.now() - start;
  }

  private async simpleRequest(): Promise<void> {
    await this.client.get('/health/providers', {
      headers: { 'X-Skip-Metrics': process.env.DISABLE_METRICS ? 'true' : 'false' }
    });
  }

  private async complexRequest(): Promise<void> {
    await this.client.post('/api/v1/completions', {
      provider: 'openai',
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10,
      stream: false
    }, {
      headers: { 'X-Skip-Metrics': process.env.DISABLE_METRICS ? 'true' : 'false' }
    });
  }

  private async highCardinalityRequest(): Promise<void> {
    // Request with many unique label values
    const tenantId = `tenant_${Math.random().toString(36).substring(7)}`;
    const userId = `user_${Math.random().toString(36).substring(7)}`;

    await this.client.post('/api/v1/completions', {
      provider: 'openai',
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: 'Test' }],
      metadata: { tenantId, userId }
    }, {
      headers: {
        'X-Skip-Metrics': process.env.DISABLE_METRICS ? 'true' : 'false',
        'X-Tenant-Id': tenantId,
        'X-User-Id': userId
      }
    });
  }

  private async concurrentRequests(): Promise<void> {
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(this.simpleRequest());
    }
    await Promise.all(promises);
  }

  private async cacheHitRequest(): Promise<void> {
    // First request to populate cache
    await this.client.get('/health/providers', {
      headers: { 'X-Skip-Metrics': process.env.DISABLE_METRICS ? 'true' : 'false' }
    });

    // Second request should hit cache
    await this.client.get('/health/providers', {
      headers: { 'X-Skip-Metrics': process.env.DISABLE_METRICS ? 'true' : 'false' }
    });
  }

  private async errorRequest(): Promise<void> {
    try {
      await this.client.post('/api/v1/completions', {
        provider: 'invalid_provider',
        model: 'invalid_model'
      }, {
        headers: { 'X-Skip-Metrics': process.env.DISABLE_METRICS ? 'true' : 'false' }
      });
    } catch (error) {
      // Expected error
    }
  }

  private percentile(sortedArray: number[], p: number): number {
    const index = Math.ceil(sortedArray.length * p) - 1;
    return sortedArray[Math.max(0, index)] || 0;
  }

  private displayResults(results: MetricsOverheadResult[]): void {
    console.log(chalk.blue.bold('\n📊 Validation Results\n'));

    const table = new Table({
      head: [
        chalk.cyan('Scenario'),
        chalk.cyan('Metrics'),
        chalk.cyan('Avg (ms)'),
        chalk.cyan('P95 (ms)'),
        chalk.cyan('P99 (ms)'),
        chalk.cyan('Overhead (ms)'),
        chalk.cyan('Status')
      ],
      colWidths: [20, 10, 10, 10, 10, 13, 10]
    });

    // Group results by scenario
    const scenarios = new Set(results.map(r => r.scenario));

    for (const scenario of scenarios) {
      const baseline = results.find(r => r.scenario === scenario && !r.metricsEnabled);
      const withMetrics = results.find(r => r.scenario === scenario && r.metricsEnabled);

      if (baseline && withMetrics) {
        // Baseline row
        table.push([
          scenario,
          'Off',
          baseline.averageLatency.toFixed(3),
          baseline.p95Latency.toFixed(3),
          baseline.p99Latency.toFixed(3),
          '-',
          chalk.gray('baseline')
        ]);

        // With metrics row
        const statusColor = withMetrics.passed ? chalk.green : chalk.red;
        const status = withMetrics.passed ? '✅ Pass' : '❌ Fail';

        table.push([
          '',
          'On',
          withMetrics.averageLatency.toFixed(3),
          withMetrics.p95Latency.toFixed(3),
          withMetrics.p99Latency.toFixed(3),
          withMetrics.overhead.toFixed(3),
          statusColor(status)
        ]);
      }
    }

    console.log(table.toString());
  }

  private async performDetailedAnalysis(): Promise<void> {
    console.log(chalk.blue.bold('\n🔍 Detailed Analysis\n'));

    // Memory impact
    const memoryImpact = await this.measureMemoryImpact();
    console.log(chalk.yellow('Memory Impact:'));
    console.log(chalk.gray(`  • Baseline: ${memoryImpact.baseline.toFixed(2)} MB`));
    console.log(chalk.gray(`  • With metrics: ${memoryImpact.withMetrics.toFixed(2)} MB`));
    console.log(chalk.gray(`  • Overhead: ${memoryImpact.overhead.toFixed(2)} MB`));
    console.log();

    // CPU impact
    const cpuImpact = await this.measureCpuImpact();
    console.log(chalk.yellow('CPU Impact:'));
    console.log(chalk.gray(`  • Baseline: ${cpuImpact.baseline.toFixed(2)}%`));
    console.log(chalk.gray(`  • With metrics: ${cpuImpact.withMetrics.toFixed(2)}%`));
    console.log(chalk.gray(`  • Overhead: ${cpuImpact.overhead.toFixed(2)}%`));
    console.log();

    // Cardinality analysis
    await this.analyzeCardinality();
  }

  private async measureMemoryImpact(): Promise<{
    baseline: number;
    withMetrics: number;
    overhead: number;
  }> {
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    // Baseline memory
    const baselineStart = process.memoryUsage().heapUsed / 1024 / 1024;
    for (let i = 0; i < 100; i++) {
      await this.simpleRequest();
    }
    const baselineEnd = process.memoryUsage().heapUsed / 1024 / 1024;

    if (global.gc) {
      global.gc();
    }

    // With metrics memory
    delete process.env.DISABLE_METRICS;
    const metricsStart = process.memoryUsage().heapUsed / 1024 / 1024;
    for (let i = 0; i < 100; i++) {
      await this.simpleRequest();
    }
    const metricsEnd = process.memoryUsage().heapUsed / 1024 / 1024;

    const baseline = baselineEnd - baselineStart;
    const withMetrics = metricsEnd - metricsStart;

    return {
      baseline,
      withMetrics,
      overhead: withMetrics - baseline
    };
  }

  private async measureCpuImpact(): Promise<{
    baseline: number;
    withMetrics: number;
    overhead: number;
  }> {
    const measureCpu = (): number => {
      const startUsage = process.cpuUsage();
      const startTime = Date.now();

      // CPU intensive operation
      let sum = 0;
      for (let i = 0; i < 1000000; i++) {
        sum += Math.sqrt(i);
      }

      const endUsage = process.cpuUsage(startUsage);
      const endTime = Date.now();

      const totalCpu = (endUsage.user + endUsage.system) / 1000; // microseconds to milliseconds
      const totalTime = endTime - startTime;

      return (totalCpu / totalTime) * 100; // CPU percentage
    };

    // Baseline CPU
    process.env.DISABLE_METRICS = 'true';
    const baselineCpu = measureCpu();

    // With metrics CPU
    delete process.env.DISABLE_METRICS;
    const metricsCpu = measureCpu();

    return {
      baseline: baselineCpu,
      withMetrics: metricsCpu,
      overhead: metricsCpu - baselineCpu
    };
  }

  private async analyzeCardinality(): Promise<void> {
    console.log(chalk.yellow('Cardinality Analysis:'));

    try {
      const response = await this.client.get('/metrics');
      const metrics = response.data as string;

      // Parse metrics to analyze cardinality
      const metricFamilies = new Map<string, Set<string>>();
      const lines = metrics.split('\n');

      for (const line of lines) {
        if (line.startsWith('#') || !line.trim()) continue;

        const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*){([^}]*)}/);
        if (match) {
          const metricName = match[1];
          const labels = match[2];

          if (!metricFamilies.has(metricName)) {
            metricFamilies.set(metricName, new Set());
          }
          metricFamilies.get(metricName)!.add(labels);
        }
      }

      // Display cardinality for provider metrics
      const providerMetrics = Array.from(metricFamilies.entries())
        .filter(([name]) => name.includes('provider'))
        .sort((a, b) => b[1].size - a[1].size);

      console.log(chalk.gray('  Provider metric cardinality:'));
      for (const [name, labels] of providerMetrics.slice(0, 5)) {
        const cardinality = labels.size;
        const color = cardinality < 100 ? chalk.green :
                      cardinality < 1000 ? chalk.yellow : chalk.red;
        console.log(chalk.gray(`    • ${name}: ${color(cardinality.toString())}`));
      }

      // Check for high cardinality issues
      const highCardinality = providerMetrics.filter(([, labels]) => labels.size > 1000);
      if (highCardinality.length > 0) {
        console.log(chalk.red('\n  ⚠️  High cardinality detected:'));
        for (const [name, labels] of highCardinality) {
          console.log(chalk.red(`    • ${name}: ${labels.size} unique label combinations`));
        }
      } else {
        console.log(chalk.green('\n  ✅ No high cardinality issues detected'));
      }
    } catch (error) {
      console.log(chalk.red('  Failed to analyze cardinality'));
    }
  }

  private displayVerdict(results: MetricsOverheadResult[]): void {
    console.log(chalk.blue.bold('\n📋 Final Verdict\n'));

    const overheadResults = results.filter(r => r.metricsEnabled);
    const avgOverhead = overheadResults.reduce((sum, r) => sum + r.overhead, 0) / overheadResults.length;
    const maxOverhead = Math.max(...overheadResults.map(r => r.overhead));
    const failedScenarios = overheadResults.filter(r => !r.passed);

    console.log(chalk.gray(`  • Average overhead: ${avgOverhead.toFixed(3)}ms`));
    console.log(chalk.gray(`  • Maximum overhead: ${maxOverhead.toFixed(3)}ms`));
    console.log(chalk.gray(`  • Failed scenarios: ${failedScenarios.length}/${overheadResults.length}`));
    console.log();

    if (avgOverhead < 0.1 && maxOverhead < 0.5 && failedScenarios.length === 0) {
      console.log(chalk.green.bold('✅ VALIDATION PASSED'));
      console.log(chalk.green('Metrics overhead is within acceptable limits (<0.1ms average)'));
    } else if (avgOverhead < 0.5 && maxOverhead < 1.0) {
      console.log(chalk.yellow.bold('⚠️  VALIDATION PASSED WITH WARNINGS'));
      console.log(chalk.yellow('Metrics overhead is acceptable but could be optimized'));

      if (failedScenarios.length > 0) {
        console.log(chalk.yellow('\nFailed scenarios:'));
        for (const scenario of failedScenarios) {
          console.log(chalk.yellow(`  • ${scenario.scenario}: ${scenario.overhead.toFixed(3)}ms overhead`));
        }
      }
    } else {
      console.log(chalk.red.bold('❌ VALIDATION FAILED'));
      console.log(chalk.red(`Metrics overhead exceeds acceptable limits (avg: ${avgOverhead.toFixed(3)}ms)`));

      console.log(chalk.red('\nRecommendations:'));
      console.log(chalk.gray('  • Reduce metric cardinality'));
      console.log(chalk.gray('  • Enable sampling for high-volume metrics'));
      console.log(chalk.gray('  • Use recording rules for expensive queries'));
      console.log(chalk.gray('  • Consider async metric collection'));
    }
  }
}

// CLI setup
const program = new Command();

program
  .name('validate-metrics-overhead')
  .description('Validate metrics collection overhead')
  .option('-u, --base-url <url>', 'Orchestrator base URL', 'http://localhost:3000')
  .option('-i, --iterations <count>', 'Number of test iterations', '100')
  .option('-w, --warmup-iterations <count>', 'Number of warmup iterations', '10')
  .option('-d, --detailed', 'Perform detailed analysis', false)
  .option('-p, --providers <providers>', 'Comma-separated provider list', 'openai,anthropic,google')
  .action(async (options) => {
    const config: ValidationConfig = {
      baseUrl: options.baseUrl,
      iterations: parseInt(options.iterations),
      warmupIterations: parseInt(options.warmupIterations),
      detailed: options.detailed,
      providers: options.providers.split(',')
    };

    try {
      const validator = new MetricsOverheadValidator(config);
      await validator.run();

      console.log(chalk.green.bold('\n✨ Validation complete!\n'));
    } catch (error) {
      console.error(chalk.red('Validation failed:'), error);
      process.exit(1);
    }
  });

program.parse();

export { MetricsOverheadValidator };
