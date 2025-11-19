#!/usr/bin/env tsx
/**
 * Provider Load Testing Script
 *
 * This script performs comprehensive load testing on provider endpoints to:
 * 1. Validate performance under load
 * 2. Test circuit breaker behavior
 * 3. Measure metrics overhead
 * 4. Verify rate limiting and retry logic
 *
 * Usage:
 *   npm run load-test -- --provider openai --duration 60 --rps 10
 *   npm run load-test -- --all-providers --duration 300 --rps 5
 */

import { Command } from 'commander';
import axios, { AxiosInstance } from 'axios';
import pLimit from 'p-limit';
import { performance } from 'perf_hooks';
import { setTimeout as delay } from 'timers/promises';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import * as fs from 'fs/promises';
import * as path from 'path';

interface LoadTestConfig {
  provider?: string;
  allProviders: boolean;
  duration: number; // seconds
  rps: number; // requests per second
  concurrency: number;
  warmup: boolean;
  outputFile?: string;
  baseUrl: string;
  apiKey?: string;
  verbose: boolean;
  testScenario: 'normal' | 'spike' | 'stress' | 'circuit-breaker';
}

interface TestResult {
  provider: string;
  timestamp: number;
  latency: number;
  success: boolean;
  statusCode?: number;
  error?: string;
  tokenCount?: number;
  cost?: number;
  cacheHit?: boolean;
  retryCount?: number;
}

interface ProviderStats {
  provider: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatency: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  minLatency: number;
  maxLatency: number;
  errorRate: number;
  throughput: number;
  totalTokens: number;
  totalCost: number;
  cacheHitRate: number;
  retryRate: number;
  circuitBreakerTrips: number;
}

class ProviderLoadTester {
  private client: AxiosInstance;
  private results: TestResult[] = [];
  private startTime: number = 0;
  private metricsBaseline: Map<string, number> = new Map();

  constructor(private config: LoadTestConfig) {
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey && { 'Authorization': `Bearer ${config.apiKey}` })
      }
    });
  }

  async run(): Promise<void> {
    console.log(chalk.blue.bold('\n🚀 Provider Load Test Starting\n'));
    console.log(chalk.gray(`Configuration:`));
    console.log(chalk.gray(`  • Duration: ${this.config.duration}s`));
    console.log(chalk.gray(`  • RPS: ${this.config.rps}`));
    console.log(chalk.gray(`  • Scenario: ${this.config.testScenario}`));
    console.log(chalk.gray(`  • Providers: ${this.config.allProviders ? 'All' : this.config.provider}`));
    console.log();

    // Capture metrics baseline
    if (this.config.verbose) {
      await this.captureMetricsBaseline();
    }

    // Warmup phase
    if (this.config.warmup) {
      await this.runWarmup();
    }

    // Main test execution
    const providers = await this.getProviders();

    for (const provider of providers) {
      console.log(chalk.yellow(`\nTesting provider: ${provider}`));
      await this.testProvider(provider);
    }

    // Generate report
    await this.generateReport();

    // Save results if output file specified
    if (this.config.outputFile) {
      await this.saveResults();
    }
  }

  private async getProviders(): Promise<string[]> {
    if (!this.config.allProviders && this.config.provider) {
      return [this.config.provider];
    }

    try {
      const response = await this.client.get('/health/providers');
      return Object.keys(response.data.providers || {});
    } catch (error) {
      console.error(chalk.red('Failed to fetch provider list'));
      return ['openai', 'anthropic', 'google']; // Default providers
    }
  }

  private async captureMetricsBaseline(): Promise<void> {
    const spinner = ora('Capturing metrics baseline...').start();

    try {
      const response = await this.client.get('/metrics');
      const metrics = this.parseMetrics(response.data);

      for (const [key, value] of Object.entries(metrics)) {
        this.metricsBaseline.set(key, value as number);
      }

      spinner.succeed('Metrics baseline captured');
    } catch (error) {
      spinner.fail('Failed to capture metrics baseline');
    }
  }

  private parseMetrics(metricsText: string): Record<string, number> {
    const metrics: Record<string, number> = {};
    const lines = metricsText.split('\n');

    for (const line of lines) {
      if (line.startsWith('#') || !line.trim()) continue;

      const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:{[^}]*})?)\s+(.+)$/);
      if (match) {
        metrics[match[1]] = parseFloat(match[2]);
      }
    }

    return metrics;
  }

  private async runWarmup(): Promise<void> {
    const spinner = ora('Running warmup phase...').start();
    const warmupDuration = Math.min(10, this.config.duration * 0.1);
    const warmupRps = Math.max(1, this.config.rps * 0.5);

    const providers = await this.getProviders();
    const limit = pLimit(this.config.concurrency);

    for (const provider of providers) {
      const promises = [];
      for (let i = 0; i < warmupDuration * warmupRps; i++) {
        promises.push(limit(() => this.sendRequest(provider, true)));
        await delay(1000 / warmupRps);
      }
      await Promise.all(promises);
    }

    spinner.succeed(`Warmup completed (${warmupDuration}s)`);
    this.results = []; // Clear warmup results
  }

  private async testProvider(provider: string): Promise<void> {
    this.startTime = performance.now();
    const endTime = this.startTime + (this.config.duration * 1000);
    const limit = pLimit(this.config.concurrency);

    const progressBar = ora({
      text: `Testing ${provider}...`,
      spinner: 'dots'
    }).start();

    let requestCount = 0;
    const requestPromises = [];

    // Generate load based on scenario
    const rpsSchedule = this.getRpsSchedule();

    for (let second = 0; second < this.config.duration; second++) {
      const currentRps = rpsSchedule[Math.min(second, rpsSchedule.length - 1)];

      for (let i = 0; i < currentRps; i++) {
        requestCount++;
        const requestId = requestCount;

        requestPromises.push(
          limit(async () => {
            const result = await this.sendRequest(provider, false, requestId);

            if (this.config.verbose && requestId % 10 === 0) {
              progressBar.text = `Testing ${provider}... [${requestId} requests, ${result.success ? '✓' : '✗'}]`;
            }
          })
        );

        await delay(1000 / currentRps);
      }

      if (performance.now() >= endTime) break;
    }

    await Promise.all(requestPromises);
    progressBar.succeed(`${provider} test completed (${requestCount} requests)`);
  }

  private getRpsSchedule(): number[] {
    const { duration, rps, testScenario } = this.config;
    const schedule: number[] = [];

    switch (testScenario) {
      case 'normal':
        // Constant rate
        for (let i = 0; i < duration; i++) {
          schedule.push(rps);
        }
        break;

      case 'spike':
        // Normal -> 3x spike -> normal
        const spikeStart = Math.floor(duration * 0.4);
        const spikeEnd = Math.floor(duration * 0.6);

        for (let i = 0; i < duration; i++) {
          if (i >= spikeStart && i < spikeEnd) {
            schedule.push(rps * 3);
          } else {
            schedule.push(rps);
          }
        }
        break;

      case 'stress':
        // Gradually increase load
        for (let i = 0; i < duration; i++) {
          const factor = 1 + (i / duration) * 2; // 1x to 3x
          schedule.push(Math.floor(rps * factor));
        }
        break;

      case 'circuit-breaker':
        // High error rate to trigger circuit breaker
        for (let i = 0; i < duration; i++) {
          if (i < 5) {
            schedule.push(rps * 5); // Overload initially
          } else if (i < 10) {
            schedule.push(0); // Pause
          } else {
            schedule.push(rps); // Normal rate
          }
        }
        break;
    }

    return schedule;
  }

  private async sendRequest(
    provider: string,
    isWarmup: boolean,
    requestId?: number
  ): Promise<TestResult> {
    const startTime = performance.now();
    const result: TestResult = {
      provider,
      timestamp: Date.now(),
      latency: 0,
      success: false
    };

    try {
      const payload = this.generatePayload(provider);
      const response = await this.client.post('/api/v1/completions', {
        ...payload,
        provider,
        options: {
          timeout: 30000,
          retryOnError: true,
          enableCache: !isWarmup
        }
      });

      result.success = true;
      result.statusCode = response.status;
      result.tokenCount = response.data.usage?.total_tokens || 0;
      result.cost = response.data.usage?.cost || 0;
      result.cacheHit = response.headers['x-cache-hit'] === 'true';
      result.retryCount = parseInt(response.headers['x-retry-count'] || '0');

    } catch (error: any) {
      result.success = false;
      result.statusCode = error.response?.status || 0;
      result.error = error.response?.data?.error || error.message;

      // Check for circuit breaker
      if (error.response?.status === 503 &&
          error.response?.data?.error?.includes('circuit breaker')) {
        result.error = 'circuit_breaker_open';
      }
    }

    result.latency = performance.now() - startTime;

    if (!isWarmup) {
      this.results.push(result);
    }

    return result;
  }

  private generatePayload(provider: string): any {
    // Generate appropriate payload based on provider
    const prompts = [
      "What is the capital of France?",
      "Explain quantum computing in simple terms.",
      "Write a haiku about coding.",
      "What are the benefits of exercise?",
      "Describe the water cycle."
    ];

    const prompt = prompts[Math.floor(Math.random() * prompts.length)];

    switch (provider) {
      case 'openai':
      case 'azure-openai':
        return {
          model: 'gpt-3.5-turbo',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 100,
          temperature: 0.7
        };

      case 'anthropic':
        return {
          model: 'claude-3-haiku-20240307',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 100
        };

      case 'google':
        return {
          model: 'gemini-pro',
          prompt,
          maxOutputTokens: 100
        };

      default:
        return {
          prompt,
          max_tokens: 100
        };
    }
  }

  private async generateReport(): Promise<void> {
    console.log(chalk.blue.bold('\n📊 Load Test Report\n'));

    // Group results by provider
    const providerResults = new Map<string, TestResult[]>();
    for (const result of this.results) {
      if (!providerResults.has(result.provider)) {
        providerResults.set(result.provider, []);
      }
      providerResults.get(result.provider)!.push(result);
    }

    // Calculate statistics for each provider
    const stats: ProviderStats[] = [];

    for (const [provider, results] of providerResults) {
      const stat = this.calculateStats(provider, results);
      stats.push(stat);
    }

    // Display summary table
    this.displaySummaryTable(stats);

    // Display latency distribution
    this.displayLatencyDistribution(stats);

    // Display error analysis
    this.displayErrorAnalysis();

    // Display metrics overhead
    if (this.config.verbose) {
      await this.displayMetricsOverhead();
    }

    // Display recommendations
    this.displayRecommendations(stats);
  }

  private calculateStats(provider: string, results: TestResult[]): ProviderStats {
    const successfulRequests = results.filter(r => r.success);
    const failedRequests = results.filter(r => !r.success);
    const latencies = results.map(r => r.latency).sort((a, b) => a - b);

    const totalDuration = (performance.now() - this.startTime) / 1000;

    return {
      provider,
      totalRequests: results.length,
      successfulRequests: successfulRequests.length,
      failedRequests: failedRequests.length,
      averageLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p50Latency: this.percentile(latencies, 0.5),
      p95Latency: this.percentile(latencies, 0.95),
      p99Latency: this.percentile(latencies, 0.99),
      minLatency: Math.min(...latencies),
      maxLatency: Math.max(...latencies),
      errorRate: failedRequests.length / results.length,
      throughput: results.length / totalDuration,
      totalTokens: successfulRequests.reduce((sum, r) => sum + (r.tokenCount || 0), 0),
      totalCost: successfulRequests.reduce((sum, r) => sum + (r.cost || 0), 0),
      cacheHitRate: successfulRequests.filter(r => r.cacheHit).length / successfulRequests.length,
      retryRate: results.filter(r => (r.retryCount || 0) > 0).length / results.length,
      circuitBreakerTrips: results.filter(r => r.error === 'circuit_breaker_open').length
    };
  }

  private percentile(sortedArray: number[], p: number): number {
    const index = Math.ceil(sortedArray.length * p) - 1;
    return sortedArray[Math.max(0, index)] || 0;
  }

  private displaySummaryTable(stats: ProviderStats[]): void {
    const table = new Table({
      head: [
        chalk.cyan('Provider'),
        chalk.cyan('Requests'),
        chalk.cyan('Success Rate'),
        chalk.cyan('Avg Latency'),
        chalk.cyan('P95 Latency'),
        chalk.cyan('P99 Latency'),
        chalk.cyan('Throughput'),
        chalk.cyan('Cache Hit')
      ],
      colWidths: [15, 10, 13, 12, 12, 12, 12, 10]
    });

    for (const stat of stats) {
      const successRate = ((1 - stat.errorRate) * 100).toFixed(2) + '%';
      const successColor = stat.errorRate < 0.01 ? chalk.green :
                           stat.errorRate < 0.05 ? chalk.yellow : chalk.red;

      table.push([
        stat.provider,
        stat.totalRequests.toString(),
        successColor(successRate),
        `${stat.averageLatency.toFixed(0)}ms`,
        `${stat.p95Latency.toFixed(0)}ms`,
        `${stat.p99Latency.toFixed(0)}ms`,
        `${stat.throughput.toFixed(2)} rps`,
        `${(stat.cacheHitRate * 100).toFixed(1)}%`
      ]);
    }

    console.log(table.toString());
  }

  private displayLatencyDistribution(stats: ProviderStats[]): void {
    console.log(chalk.blue.bold('\n📈 Latency Distribution\n'));

    const table = new Table({
      head: [
        chalk.cyan('Provider'),
        chalk.cyan('Min'),
        chalk.cyan('P50'),
        chalk.cyan('P95'),
        chalk.cyan('P99'),
        chalk.cyan('Max')
      ],
      colWidths: [15, 10, 10, 10, 10, 10]
    });

    for (const stat of stats) {
      table.push([
        stat.provider,
        `${stat.minLatency.toFixed(0)}ms`,
        `${stat.p50Latency.toFixed(0)}ms`,
        `${stat.p95Latency.toFixed(0)}ms`,
        `${stat.p99Latency.toFixed(0)}ms`,
        `${stat.maxLatency.toFixed(0)}ms`
      ]);
    }

    console.log(table.toString());
  }

  private displayErrorAnalysis(): void {
    const errors = this.results.filter(r => !r.success);
    if (errors.length === 0) {
      console.log(chalk.green('\n✅ No errors detected during test\n'));
      return;
    }

    console.log(chalk.blue.bold('\n⚠️  Error Analysis\n'));

    // Group errors by type
    const errorTypes = new Map<string, number>();
    for (const error of errors) {
      const type = error.error || `HTTP ${error.statusCode}`;
      errorTypes.set(type, (errorTypes.get(type) || 0) + 1);
    }

    const table = new Table({
      head: [chalk.cyan('Error Type'), chalk.cyan('Count'), chalk.cyan('Percentage')],
      colWidths: [40, 10, 12]
    });

    for (const [type, count] of errorTypes) {
      const percentage = ((count / errors.length) * 100).toFixed(2) + '%';
      table.push([
        type.substring(0, 37) + (type.length > 37 ? '...' : ''),
        count.toString(),
        percentage
      ]);
    }

    console.log(table.toString());
  }

  private async displayMetricsOverhead(): Promise<void> {
    console.log(chalk.blue.bold('\n⚙️  Metrics Overhead Analysis\n'));

    try {
      const response = await this.client.get('/metrics');
      const currentMetrics = this.parseMetrics(response.data);

      // Calculate overhead
      const metricsCalls = (currentMetrics['orchestrator_metrics_calls_total'] || 0) -
                          (this.metricsBaseline.get('orchestrator_metrics_calls_total') || 0);

      const metricsLatency = currentMetrics['orchestrator_metrics_latency_seconds_sum'] || 0;
      const totalRequests = this.results.length;

      const overheadPerRequest = metricsCalls > 0 ?
        (metricsLatency * 1000) / metricsCalls : 0;

      console.log(chalk.gray(`  • Metrics calls: ${metricsCalls}`));
      console.log(chalk.gray(`  • Average overhead: ${overheadPerRequest.toFixed(3)}ms per request`));
      console.log(chalk.gray(`  • Total metrics time: ${(metricsLatency * 1000).toFixed(2)}ms`));

      if (overheadPerRequest < 0.1) {
        console.log(chalk.green(`  ✅ Metrics overhead is negligible (<0.1ms)`));
      } else if (overheadPerRequest < 1) {
        console.log(chalk.yellow(`  ⚠️  Metrics overhead is acceptable (<1ms)`));
      } else {
        console.log(chalk.red(`  ❌ Metrics overhead is high (${overheadPerRequest.toFixed(2)}ms)`));
      }
    } catch (error) {
      console.log(chalk.red('  Failed to analyze metrics overhead'));
    }
  }

  private displayRecommendations(stats: ProviderStats[]): void {
    console.log(chalk.blue.bold('\n💡 Recommendations\n'));

    for (const stat of stats) {
      console.log(chalk.yellow(`\n${stat.provider}:`));

      // Error rate recommendations
      if (stat.errorRate > 0.05) {
        console.log(chalk.red(`  ⚠️  High error rate (${(stat.errorRate * 100).toFixed(2)}%)`));
        console.log(chalk.gray(`     • Check API rate limits`));
        console.log(chalk.gray(`     • Verify authentication credentials`));
        console.log(chalk.gray(`     • Review circuit breaker settings`));
      }

      // Latency recommendations
      if (stat.p95Latency > 5000) {
        console.log(chalk.yellow(`  ⚠️  High P95 latency (${stat.p95Latency.toFixed(0)}ms)`));
        console.log(chalk.gray(`     • Consider increasing timeout values`));
        console.log(chalk.gray(`     • Enable request batching`));
        console.log(chalk.gray(`     • Use lighter model variants`));
      }

      // Cache recommendations
      if (stat.cacheHitRate < 0.3 && stat.totalRequests > 50) {
        console.log(chalk.yellow(`  ⚠️  Low cache hit rate (${(stat.cacheHitRate * 100).toFixed(1)}%)`));
        console.log(chalk.gray(`     • Increase cache TTL`));
        console.log(chalk.gray(`     • Review cache key generation`));
        console.log(chalk.gray(`     • Consider semantic caching`));
      }

      // Circuit breaker recommendations
      if (stat.circuitBreakerTrips > 0) {
        console.log(chalk.red(`  ⚠️  Circuit breaker triggered ${stat.circuitBreakerTrips} times`));
        console.log(chalk.gray(`     • Review error threshold settings`));
        console.log(chalk.gray(`     • Adjust timeout duration`));
        console.log(chalk.gray(`     • Consider fallback providers`));
      }

      // Success message
      if (stat.errorRate < 0.01 && stat.p95Latency < 2000 && stat.cacheHitRate > 0.5) {
        console.log(chalk.green(`  ✅ Excellent performance!`));
      }
    }
  }

  private async saveResults(): Promise<void> {
    const outputPath = path.resolve(this.config.outputFile!);
    const outputDir = path.dirname(outputPath);

    // Ensure directory exists
    await fs.mkdir(outputDir, { recursive: true });

    // Prepare output data
    const output = {
      metadata: {
        timestamp: new Date().toISOString(),
        duration: this.config.duration,
        rps: this.config.rps,
        scenario: this.config.testScenario,
        providers: this.config.allProviders ? 'all' : this.config.provider
      },
      results: this.results,
      summary: this.generateSummary()
    };

    // Save as JSON
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
    console.log(chalk.green(`\n✅ Results saved to: ${outputPath}`));
  }

  private generateSummary(): any {
    const providerResults = new Map<string, TestResult[]>();
    for (const result of this.results) {
      if (!providerResults.has(result.provider)) {
        providerResults.set(result.provider, []);
      }
      providerResults.get(result.provider)!.push(result);
    }

    const summary: any = {};
    for (const [provider, results] of providerResults) {
      summary[provider] = this.calculateStats(provider, results);
    }

    return summary;
  }
}

// CLI Command Setup
const program = new Command();

program
  .name('provider-load-test')
  .description('Load test provider endpoints')
  .option('-p, --provider <provider>', 'Specific provider to test')
  .option('-a, --all-providers', 'Test all available providers', false)
  .option('-d, --duration <seconds>', 'Test duration in seconds', '60')
  .option('-r, --rps <rate>', 'Requests per second', '5')
  .option('-c, --concurrency <limit>', 'Concurrent request limit', '10')
  .option('-w, --warmup', 'Run warmup phase before test', true)
  .option('-o, --output-file <path>', 'Save results to file')
  .option('-u, --base-url <url>', 'Orchestrator base URL', 'http://localhost:3000')
  .option('-k, --api-key <key>', 'API key for authentication')
  .option('-v, --verbose', 'Verbose output', false)
  .option(
    '-s, --test-scenario <scenario>',
    'Test scenario: normal, spike, stress, circuit-breaker',
    'normal'
  )
  .action(async (options) => {
    const config: LoadTestConfig = {
      provider: options.provider,
      allProviders: options.allProviders,
      duration: parseInt(options.duration),
      rps: parseInt(options.rps),
      concurrency: parseInt(options.concurrency),
      warmup: options.warmup,
      outputFile: options.outputFile,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey || process.env.API_KEY,
      verbose: options.verbose,
      testScenario: options.testScenario
    };

    // Validation
    if (!config.allProviders && !config.provider) {
      console.error(chalk.red('Error: Must specify --provider or --all-providers'));
      process.exit(1);
    }

    if (config.duration < 10) {
      console.error(chalk.red('Error: Duration must be at least 10 seconds'));
      process.exit(1);
    }

    if (config.rps < 1 || config.rps > 1000) {
      console.error(chalk.red('Error: RPS must be between 1 and 1000'));
      process.exit(1);
    }

    try {
      const tester = new ProviderLoadTester(config);
      await tester.run();

      console.log(chalk.green.bold('\n✨ Load test completed successfully!\n'));
    } catch (error) {
      console.error(chalk.red('Load test failed:'), error);
      process.exit(1);
    }
  });

program.parse();

// Export for programmatic use
export { ProviderLoadTester, LoadTestConfig, TestResult, ProviderStats };
