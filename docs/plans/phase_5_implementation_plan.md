# Phase 5 Implementation Plan: Performance, Cost & Ecosystem

_Date: 2025-01-17_  
_Status: Ready for Implementation_  
_Prerequisites: Phase 3 (~90% complete), Phase 4 (~60% complete)_  
_Estimated Duration: 8 weeks with 2 engineers_  
_Priority: P0 (Production Readiness)_

---

## Executive Summary

Phase 5 focuses on **production-grade performance**, **cost optimization**, and **developer ecosystem expansion**. Based on comprehensive codebase analysis, we have strong foundations to build upon:

**✅ Existing Infrastructure:**
- Two-tier PolicyCache (Memory + Redis) at services/orchestrator/src/policy/PolicyCache.ts
- Embedding cache (LRU, in-memory) at services/indexer/src/embeddings.rs
- Pipeline monitoring with bottleneck detection at services/orchestrator/src/agents/PipelineMonitoring.ts
- Prometheus + Grafana setup with queue dashboards
- Tool registry framework at services/orchestrator/src/tools/ToolRegistry.ts
- gRPC indexer with 20+ RPC methods
- Multi-agent orchestration with DAG execution

**❌ Critical Gaps:**
- No cost tracking infrastructure (0% complete)
- No hierarchical caching (L1/L2/L3)
- No semantic similarity cache
- No request coalescing
- No language SDKs
- No tool marketplace API
- Using hash-based embeddings (not real semantic)

**Phase 5 Strategy:** Extend proven patterns (PolicyCache, PipelineMonitoring) rather than rebuild. Add missing cost infrastructure from scratch. Build TypeScript SDK first (most code is TS).

---

## Current State Assessment

### Phase 3: Enterprise Mode & Kafka (~90% Complete)

#### ✅ Completed Infrastructure

**Kafka Integration:**
- Location: services/orchestrator/src/queue/KafkaAdapter.test.ts
- Compacted topics for plan state
- Job state management
- Dead letter queue handling
- Integration tests passing

**CMEK (Customer-Managed Encryption Keys):**
- Location: services/orchestrator/src/security/AuditedCMEKRotation.ts
- Automatic rotation with audit logging
- Tenant key versioning
- Unbounded retain count for compliance (tenantKeys.test.ts:115)

**Vault Integration:**
- Location: services/orchestrator/src/security/VaultTokenRenewal.ts
- In-process renewal (60s interval, 80% threshold)
- Optional sidecar mode for containerized deployments
- Graceful failure handling

**Compliance:**
- DPIA (Data Protection Impact Assessment) complete
- System card documented
- Multi-tenant isolation with ACL/DLP controls

#### 🔄 Remaining Work (~10%)

- HPA Grafana dashboards (basic queue dashboard exists)
- Full OIDC SSO integration (skeleton in auth/OidcClient.ts)
- Final certification artifacts

### Phase 4: Indexing, Tools & Multi-Agent (~60% Complete)

#### ✅ Completed Components

**Indexer Core (services/indexer/src/):**
- Tree-sitter AST parsing (ast.rs) for TypeScript/JavaScript/Rust/JSON
- Semantic store infrastructure (semantic.rs) with placeholder hash embeddings
- LSP server (lsp.rs) with hover/goto-definition/references
- gRPC service (grpc_service.rs, proto/indexer.proto) with 20+ RPCs
- Embedding provider abstraction (embeddings.rs - 550 LOC)
  - OrchestratorProvider ✅
  - MockProvider ✅
  - LocalProvider ❌ (line 327: "Local provider not yet implemented")
- LRU embedding cache with TTL validation (lines 283-359)

**MCP Tools (services/orchestrator/src/tools/):**
- Tool framework (McpTool.ts, ToolRegistry.ts)
- 10 capability flags (READ_FILES, WRITE_FILES, EXECUTE_COMMANDS, etc.)
- Tool registration with versioning and hot-reload
- Usage statistics tracking
- Core tools: RepositoryTool, TestRunnerTool, BrowserTool, DatabaseTool

**Multi-Agent Orchestration (services/orchestrator/src/agents/):**
- Execution graph (ExecutionGraph.ts) with DAG-based execution
- Agent communication (AgentCommunication.ts) with message bus
- Standard pipelines (StandardPipelines.ts) including security/performance checks
- Pipeline monitoring (PipelineMonitoring.ts - 586 LOC)
  - Performance metrics calculation (lines 277-340)
  - Bottleneck detection with severity levels (lines 400-480)
  - p50/p95/p99 aggregation (lines 534-578)

#### ❌ Missing/Incomplete

- Real semantic embeddings (using hash64 placeholders)
- Storage layer full implementation (storage.rs schema exists but incomplete)
- Temporal git integration
- Container/WASM sandboxing deployment
- Approval workflow integration
- OpenTelemetry export configuration

---

## Phase 5 Goals & Success Criteria

### Primary Goals

1. **Performance Excellence** - Achieve and maintain production SLOs
2. **Cost Optimization** - Reduce operational costs by 40%+ through intelligent caching and batching
3. **Developer Ecosystem** - Enable third-party integrations and community contributions

### Success Metrics

**Performance SLOs:**
- TTFT (Time to First Token) p95 ≤ 300ms
- RPC latency p95 < 50ms
- Semantic search p95 < 200ms
- Cache hit rate > 70%
- Zero performance regressions

**Cost Efficiency:**
- Token usage reduction > 40% through caching/batching
- API call reduction > 50% via request coalescing
- Cost per workflow < $0.10
- Resource utilization > 80% during peak

**Ecosystem Adoption:**
- TypeScript SDK published to npm
- Tool marketplace with 5+ community tools
- Integration examples and documentation
- Developer satisfaction > 90%

---

## Epic 5.1: Performance Optimization

**Duration:** 3 weeks  
**Priority:** P0 (Critical)  
**Build On:** PolicyCache pattern, PipelineMonitoring, Prometheus setup

### Task 5.1.1: Hierarchical Cache Layer (5 days)

**Extend:** services/orchestrator/src/policy/PolicyCache.ts pattern

**Implementation Strategy:**
1. Extract PolicyCache's two-tier (Memory + Redis) pattern into reusable HierarchicalCache base class
2. Add L3 disk cache for large datasets (embeddings, completions)
3. Apply to prompts, embeddings, and completions

**Files to Create:**
```
services/orchestrator/src/cache/
├── HierarchicalCache.ts          # Base L1/L2/L3 implementation
├── SemanticCache.ts               # Similarity-based cache
├── PromptCache.ts                 # Extends HierarchicalCache
├── EmbeddingCache.ts              # Extends HierarchicalCache
└── CompletionCache.ts             # Extends HierarchicalCache
```

**Technical Design:**

```typescript
// services/orchestrator/src/cache/HierarchicalCache.ts
import { InMemoryCache } from './InMemoryCache';
import { RedisCache } from './RedisCache';
import { DiskCache } from './DiskCache';

export interface CacheConfig {
  l1: { maxSize: string; ttl: string };
  l2: { maxSize: string; ttl: string };
  l3: { maxSize: string; ttl: string };
}

export abstract class HierarchicalCache<T> {
  protected l1: InMemoryCache<T>;
  protected l2: RedisCache<T>;
  protected l3: DiskCache<T>;
  
  constructor(
    protected config: CacheConfig,
    protected metrics: MetricsCollector
  ) {
    this.l1 = new InMemoryCache(config.l1);
    this.l2 = new RedisCache(config.l2);
    this.l3 = new DiskCache(config.l3);
  }
  
  async get(key: string): Promise<T | null> {
    // L1: Memory cache (< 1ms)
    const l1Hit = await this.l1.get(key);
    if (l1Hit) {
      this.metrics.recordHit('cache.l1');
      return l1Hit;
    }
    
    // L2: Redis cache (< 10ms)
    const l2Hit = await this.l2.get(key);
    if (l2Hit) {
      await this.l1.set(key, l2Hit); // Promote to L1
      this.metrics.recordHit('cache.l2');
      return l2Hit;
    }
    
    // L3: Disk cache (< 100ms)
    const l3Hit = await this.l3.get(key);
    if (l3Hit) {
      await this.promoteToL2AndL1(key, l3Hit);
      this.metrics.recordHit('cache.l3');
      return l3Hit;
    }
    
    this.metrics.recordMiss('cache.all');
    return null;
  }
  
  async set(key: string, value: T): Promise<void> {
    const compressed = await this.compress(value);
    
    // Write-through to all levels
    await Promise.all([
      this.l1.set(key, value, this.config.l1.ttl),
      this.l2.set(key, compressed, this.config.l2.ttl),
      this.l3.set(key, compressed, this.config.l3.ttl)
    ]);
    
    this.metrics.recordWrite('cache.all');
  }
  
  protected abstract compress(value: T): Promise<Buffer>;
  protected abstract decompress(buffer: Buffer): Promise<T>;
}
```

**Semantic Similarity Cache:**

```typescript
// services/orchestrator/src/cache/SemanticCache.ts
import { EmbeddingProvider } from '../grpc/IndexerClient';

export class SemanticCache extends HierarchicalCache<CompletionResponse> {
  constructor(
    config: CacheConfig,
    private embeddings: EmbeddingProvider,
    private similarityThreshold: number = 0.95
  ) {
    super(config, metrics);
  }
  
  async getBySemanticSimilarity(
    prompt: string
  ): Promise<{ response: CompletionResponse; similarity: number } | null> {
    // Get embedding for prompt
    const embedding = await this.embeddings.embed(prompt);
    
    // Search L2 vector store for similar prompts
    const similar = await this.l2.vectorSearch(embedding, {
      topK: 5,
      threshold: this.similarityThreshold
    });
    
    if (similar.length === 0) return null;
    
    // Verify semantic equivalence (optional LLM verification)
    const verified = await this.verifyEquivalence(prompt, similar[0].prompt);
    
    if (verified) {
      this.metrics.recordHit('cache.semantic');
      return {
        response: similar[0].response,
        similarity: similar[0].score
      };
    }
    
    return null;
  }
  
  private async verifyEquivalence(
    prompt1: string,
    prompt2: string
  ): Promise<boolean> {
    // Use fast LLM to verify semantic equivalence
    // Only needed for high-stakes completions
    return true; // Simplified
  }
}
```

**Cache Configuration:**

```typescript
// services/orchestrator/src/cache/config.ts
export const CACHE_CONFIGS = {
  prompts: {
    l1: { maxSize: '100MB', ttl: '5m' },
    l2: { maxSize: '1GB', ttl: '1h' },
    l3: { maxSize: '10GB', ttl: '24h' }
  },
  embeddings: {
    l1: { maxSize: '500MB', ttl: '1h' },
    l2: { maxSize: '5GB', ttl: '7d' },
    l3: { maxSize: '50GB', ttl: '30d' }
  },
  completions: {
    l1: { maxSize: '200MB', ttl: '10m' },
    l2: { maxSize: '2GB', ttl: '2h' },
    l3: { maxSize: '20GB', ttl: '7d' }
  }
};
```

**Integration Points:**
- Wrap all LLM provider calls in services/orchestrator/src/providers/
- Add cache metrics to Grafana dashboard at charts/oss-ai-agent-tool/templates/grafana-dashboard.yaml

**Acceptance Criteria:**
- [ ] Cache hit rate > 70% after 1-hour warmup
- [ ] L1 response time < 1ms p95
- [ ] L2 response time < 10ms p95
- [ ] L3 response time < 100ms p95
- [ ] Graceful degradation on cache failures
- [ ] Memory usage within configured limits
- [ ] Integration tests pass

---

### Task 5.1.2: Request Coalescing (3 days)

**New Implementation** (no existing pattern)

**Purpose:** Deduplicate in-flight requests to expensive operations (LLM calls, embeddings)

**Files to Create:**
```
services/orchestrator/src/optimization/
├── RequestCoalescer.ts
└── RequestCoalescer.test.ts
```

**Technical Design:**

```typescript
// services/orchestrator/src/optimization/RequestCoalescer.ts
import { Deferred } from '../utils/Deferred';

export class RequestCoalescer<TResult> {
  private inflight = new Map<string, Promise<TResult>>();
  private waiters = new Map<string, Set<Deferred<TResult>>>();
  
  async execute(
    key: string,
    fn: () => Promise<TResult>,
    options?: { timeout?: number }
  ): Promise<TResult> {
    // Check if request already in flight
    const existing = this.inflight.get(key);
    if (existing) {
      this.metrics.recordCoalesced(key);
      
      // Add to waiters
      const deferred = new Deferred<TResult>();
      if (!this.waiters.has(key)) {
        this.waiters.set(key, new Set());
      }
      this.waiters.get(key)!.add(deferred);
      
      return options?.timeout
        ? Promise.race([deferred.promise, this.timeout(options.timeout)])
        : deferred.promise;
    }
    
    // Execute and track
    const promise = this.executeWithTracking(key, fn);
    this.inflight.set(key, promise);
    
    try {
      const result = await promise;
      
      // Notify all waiters
      const waitList = this.waiters.get(key);
      if (waitList) {
        waitList.forEach(w => w.resolve(result));
        this.waiters.delete(key);
      }
      
      return result;
    } catch (error) {
      // Notify waiters of failure
      const waitList = this.waiters.get(key);
      if (waitList) {
        waitList.forEach(w => w.reject(error));
        this.waiters.delete(key);
      }
      throw error;
    } finally {
      this.inflight.delete(key);
    }
  }
  
  private async executeWithTracking(
    key: string,
    fn: () => Promise<TResult>
  ): Promise<TResult> {
    const start = Date.now();
    try {
      const result = await fn();
      this.metrics.recordSuccess(key, Date.now() - start);
      return result;
    } catch (error) {
      this.metrics.recordFailure(key, Date.now() - start);
      throw error;
    }
  }
  
  private async timeout(ms: number): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timeout')), ms)
    );
  }
  
  // Get stats for monitoring
  getStats(): CoalescingStats {
    return {
      inflightCount: this.inflight.size,
      waiterCount: Array.from(this.waiters.values())
        .reduce((sum, set) => sum + set.size, 0),
      totalCoalesced: this.metrics.getTotalCoalesced()
    };
  }
}
```

**Integration:**

```typescript
// services/orchestrator/src/providers/AnthropicProvider.ts
import { RequestCoalescer } from '../optimization/RequestCoalescer';

export class AnthropicProvider {
  private coalescer = new RequestCoalescer<CompletionResponse>();
  
  async complete(prompt: string): Promise<CompletionResponse> {
    // Generate deterministic key from prompt
    const key = this.generateCacheKey(prompt);
    
    // Coalesce identical requests
    return this.coalescer.execute(key, async () => {
      return this.anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        messages: [{ role: 'user', content: prompt }]
      });
    });
  }
  
  private generateCacheKey(prompt: string): string {
    return crypto.createHash('sha256').update(prompt).digest('hex');
  }
}
```

**Acceptance Criteria:**
- [ ] Duplicate requests reduced by > 60%
- [ ] No request starvation under load
- [ ] All waiters receive results correctly
- [ ] Memory bounded under high coalescing
- [ ] Unit tests covering edge cases

---

### Task 5.1.3: Retrieval Pipeline Optimization (4 days)

**Enhance:** services/indexer/src/ and services/orchestrator/src/grpc/IndexerClient.ts

**Strategy:**
1. Add batch processing to IndexerClient
2. Implement query optimization
3. Add parallel retrieval with early termination
4. Optimize embedding batch operations

**Files to Modify:**
- services/orchestrator/src/grpc/IndexerClient.ts (add batching)
- services/indexer/src/grpc_service.rs (optimize batch handling)

**Files to Create:**
```
services/orchestrator/src/retrieval/
├── RetrievalOptimizer.ts
├── BatchRetriever.ts
└── QueryRewriter.ts
```

**Technical Design:**

```typescript
// services/orchestrator/src/retrieval/RetrievalOptimizer.ts
export class RetrievalOptimizer {
  constructor(
    private indexer: IndexerClient,
    private cache: HierarchicalCache
  ) {}
  
  async retrieve(query: Query): Promise<Results> {
    // Step 1: Optimize query
    const optimized = await this.optimizeQuery(query);
    
    // Step 2: Check cache first
    const cached = await this.cache.get(optimized.cacheKey);
    if (cached && cached.complete) {
      return cached.results;
    }
    
    // Step 3: Parallel retrieval with racing
    const sources = [
      this.retrieveFromCache(optimized),
      this.retrieveFromIndex(optimized),
      this.retrieveFromEmbeddings(optimized)
    ];
    
    // Race with early termination
    const results = await this.collectWithEarlyTermination(
      sources,
      optimized.minResults,
      optimized.timeout
    );
    
    // Step 4: Post-process
    return this.postProcess(results, optimized);
  }
  
  private async optimizeQuery(query: Query): Promise<OptimizedQuery> {
    return {
      ...query,
      cacheKey: this.generateCacheKey(query),
      minResults: query.minResults || 10,
      maxResults: query.maxResults || 100,
      timeout: query.timeout || 5000,
      filters: this.optimizeFilters(query.filters),
      hints: this.generateHints(query)
    };
  }
  
  private async collectWithEarlyTermination(
    sources: Promise<Results>[],
    minResults: number,
    timeout: number
  ): Promise<Results> {
    const collected: Results = [];
    const timeoutPromise = this.timeout(timeout);
    
    for await (const result of Promise.race([
      this.mergeStreams(sources),
      timeoutPromise
    ])) {
      collected.push(...result);
      
      // Early termination if we have enough
      if (collected.length >= minResults) {
        break;
      }
    }
    
    return collected;
  }
  
  private postProcess(results: Results, query: OptimizedQuery): Results {
    return results
      .filter(r => this.meetsQuality(r, query))
      .sort((a, b) => b.score - a.score)
      .slice(0, query.maxResults);
  }
}
```

**Batch Retrieval:**

```typescript
// services/orchestrator/src/retrieval/BatchRetriever.ts
export class BatchRetriever {
  private queue: Map<string, QueryRequest> = new Map();
  private batchSize = 10;
  private batchTimeout = 50; // ms
  private timer: NodeJS.Timeout | null = null;
  
  async retrieve(query: Query): Promise<Results> {
    return new Promise((resolve, reject) => {
      const id = generateId();
      this.queue.set(id, { query, resolve, reject, timestamp: Date.now() });
      
      // Process immediately if batch full
      if (this.queue.size >= this.batchSize) {
        this.processBatch();
      } else if (!this.timer) {
        // Start timer if not running
        this.timer = setTimeout(() => this.processBatch(), this.batchTimeout);
      }
    });
  }
  
  private async processBatch(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    
    const batch = Array.from(this.queue.values()).slice(0, this.batchSize);
    batch.forEach(req => this.queue.delete(req.id));
    
    if (batch.length === 0) return;
    
    try {
      // Batch embed all queries
      const embeddings = await this.indexer.batchEmbed(
        batch.map(r => r.query.text)
      );
      
      // Batch search
      const results = await this.indexer.batchSearch(embeddings);
      
      // Distribute results
      batch.forEach((req, idx) => {
        req.resolve(results[idx]);
      });
    } catch (error) {
      batch.forEach(req => req.reject(error));
    }
  }
}
```

**Acceptance Criteria:**
- [ ] Retrieval latency p95 < 200ms
- [ ] Batch processing reduces API calls > 50%
- [ ] Early termination works correctly
- [ ] Query optimization improves relevance
- [ ] Integration tests pass

---

### Task 5.1.4: Performance SLO Monitoring (3 days)

**Extend:** services/orchestrator/src/agents/PipelineMonitoring.ts

**Strategy:** Add SLO enforcement to existing performance metrics

**Files to Modify:**
- services/orchestrator/src/agents/PipelineMonitoring.ts (add SLO checks)
- charts/oss-ai-agent-tool/templates/grafana-dashboard.yaml (add panels)
- charts/oss-ai-agent-tool/templates/prometheus-alerts.yaml (add rules)

**Technical Design:**

```typescript
// services/orchestrator/src/monitoring/SLOMonitor.ts
export interface SLO {
  name: string;
  target: number;
  window: string;
  percentile: number;
  errorBudget: number;
}

export class SLOMonitor {
  private slos: SLO[] = [
    { name: 'ttft', target: 300, window: '5m', percentile: 95, errorBudget: 0.01 },
    { name: 'rpc', target: 50, window: '5m', percentile: 95, errorBudget: 0.001 },
    { name: 'search', target: 200, window: '5m', percentile: 95, errorBudget: 0.01 }
  ];
  
  async checkSLOs(): Promise<SLOStatus[]> {
    const results: SLOStatus[] = [];
    
    for (const slo of this.slos) {
      const metrics = await this.queryMetrics(slo.name, slo.window);
      const percentileValue = this.calculatePercentile(metrics, slo.percentile);
      const errorBudgetRemaining = await this.calculateErrorBudget(slo);
      
      const status: SLOStatus = {
        name: slo.name,
        target: slo.target,
        actual: percentileValue,
        passing: percentileValue <= slo.target,
        errorBudgetRemaining,
        severity: this.calculateSeverity(percentileValue, slo.target, errorBudgetRemaining)
      };
      
      // Alert if SLO violated
      if (!status.passing) {
        await this.alert({
          severity: status.severity,
          slo: slo.name,
          message: `SLO violation: ${slo.name} p${slo.percentile} = ${percentileValue}ms (target: ${slo.target}ms)`,
          errorBudget: errorBudgetRemaining
        });
      }
      
      results.push(status);
    }
    
    return results;
  }
  
  async detectRegression(operation: string, latency: number): Promise<boolean> {
    const baseline = await this.getBaseline(operation);
    const threshold = baseline * 1.2; // 20% regression
    
    if (latency > threshold) {
      await this.alert({
        severity: 'MEDIUM',
        operation,
        message: `Performance regression: ${operation} ${latency}ms (baseline: ${baseline}ms, +${((latency / baseline - 1) * 100).toFixed(1)}%)`
      });
      return true;
    }
    
    return false;
  }
  
  private calculateSeverity(
    actual: number,
    target: number,
    errorBudget: number
  ): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    const violation = (actual - target) / target;
    
    if (errorBudget <= 0) return 'CRITICAL';
    if (violation > 0.5) return 'HIGH';
    if (violation > 0.2) return 'MEDIUM';
    return 'LOW';
  }
}
```

**Grafana Dashboard Updates:**

```yaml
# charts/oss-ai-agent-tool/templates/grafana-dashboard.yaml
# Add to existing dashboard
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-performance-dashboard
data:
  performance-slos.json: |
    {
      "dashboard": {
        "title": "Performance SLOs",
        "rows": [
          {
            "title": "SLO Status",
            "panels": [
              {
                "title": "TTFT p95",
                "targets": [{
                  "expr": "histogram_quantile(0.95, rate(ttft_duration_ms_bucket[5m]))"
                }],
                "thresholds": [
                  { "value": 300, "color": "red" },
                  { "value": 250, "color": "yellow" },
                  { "value": 0, "color": "green" }
                ]
              },
              {
                "title": "Cache Hit Rate",
                "targets": [{
                  "expr": "rate(cache_hits_total[5m]) / (rate(cache_hits_total[5m]) + rate(cache_misses_total[5m]))"
                }],
                "thresholds": [
                  { "value": 0.7, "color": "green" },
                  { "value": 0.5, "color": "yellow" },
                  { "value": 0, "color": "red" }
                ]
              }
            ]
          }
        ]
      }
    }
```

**Prometheus Alerts:**

```yaml
# charts/oss-ai-agent-tool/templates/prometheus-alerts.yaml
# Add to existing alerts
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: performance-slo-alerts
spec:
  groups:
    - name: performance-slos
      interval: 30s
      rules:
        - alert: TTFTSLOViolation
          expr: histogram_quantile(0.95, rate(ttft_duration_ms_bucket[5m])) > 300
          for: 5m
          labels:
            severity: high
          annotations:
            summary: "TTFT p95 SLO violation"
            description: "TTFT p95 is {{ $value }}ms (target: 300ms)"
        
        - alert: CacheHitRateLow
          expr: rate(cache_hits_total[5m]) / (rate(cache_hits_total[5m]) + rate(cache_misses_total[5m])) < 0.6
          for: 10m
          labels:
            severity: medium
          annotations:
            summary: "Cache hit rate below target"
            description: "Cache hit rate is {{ $value | humanizePercentage }} (target: 70%)"
        
        - alert: PerformanceRegression
          expr: rate(operation_duration_ms[5m]) > rate(operation_duration_ms[1h] offset 24h) * 1.2
          for: 10m
          labels:
            severity: medium
          annotations:
            summary: "Performance regression detected"
            description: "Operation {{ $labels.operation }} latency increased by >20%"
```

**Acceptance Criteria:**
- [ ] All SLOs tracked in real-time
- [ ] Alerts fire within 2 minutes of violation
- [ ] Regression detection automated
- [ ] Dashboards load < 3 seconds
- [ ] Historical data retained 90 days

---

## Epic 5.2: Cost Optimization

**Duration:** 2 weeks  
**Priority:** P0 (Business Critical)  
**Build From Scratch:** No cost tracking infrastructure exists

### Task 5.2.1: Cost Tracking Infrastructure (4 days)

**New Implementation** - Critical Foundation

**Purpose:** Track token usage, API costs, and resource consumption per operation/tenant

**Files to Create:**
```
services/orchestrator/src/cost/
├── CostTracker.ts
├── TokenCounter.ts
├── CostAttribution.ts
└── CostMetrics.ts
```

**Technical Design:**

```typescript
// services/orchestrator/src/cost/CostTracker.ts
import { Counter, Histogram } from 'prom-client';

export interface CostMetrics {
  operation: string;
  tenant?: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  duration: number;
  timestamp: number;
}

export class CostTracker {
  private tokenCounter = new Counter({
    name: 'llm_tokens_total',
    help: 'Total tokens consumed',
    labelNames: ['operation', 'tenant', 'provider', 'type']
  });
  
  private costCounter = new Counter({
    name: 'llm_cost_total',
    help: 'Total cost in USD',
    labelNames: ['operation', 'tenant', 'provider']
  });
  
  private costHistogram = new Histogram({
    name: 'llm_cost_per_operation',
    help: 'Cost per operation in USD',
    labelNames: ['operation', 'tenant', 'provider'],
    buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1.0]
  });
  
  async trackOperation<T>(
    operation: Operation,
    fn: () => Promise<T>
  ): Promise<{ result: T; metrics: CostMetrics }> {
    const start = Date.now();
    const startTokens = await this.getProviderTokenCount(operation.provider);
    
    try {
      const result = await fn();
      
      const endTokens = await this.getProviderTokenCount(operation.provider);
      const duration = Date.now() - start;
      
      const metrics: CostMetrics = {
        operation: operation.name,
        tenant: operation.tenant,
        provider: operation.provider,
        inputTokens: endTokens.input - startTokens.input,
        outputTokens: endTokens.output - startTokens.output,
        totalTokens: (endTokens.input + endTokens.output) - (startTokens.input + startTokens.output),
        cost: this.calculateCost(operation.provider, endTokens.input - startTokens.input, endTokens.output - startTokens.output),
        duration,
        timestamp: Date.now()
      };
      
      // Record metrics
      this.recordMetrics(metrics);
      
      // Store for attribution
      await this.store.save(metrics);
      
      return { result, metrics };
    } catch (error) {
      await this.recordFailure(operation, error);
      throw error;
    }
  }
  
  private calculateCost(
    provider: string,
    inputTokens: number,
    outputTokens: number
  ): number {
    const pricing = this.getPricing(provider);
    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  }
  
  private getPricing(provider: string): { input: number; output: number } {
    // Prices per million tokens
    const prices: Record<string, { input: number; output: number }> = {
      'anthropic-claude-3.5-sonnet': { input: 3.00, output: 15.00 },
      'openai-gpt-4': { input: 30.00, output: 60.00 },
      'openai-gpt-3.5-turbo': { input: 0.50, output: 1.50 }
    };
    return prices[provider] || { input: 0, output: 0 };
  }
  
  private recordMetrics(metrics: CostMetrics): void {
    // Prometheus counters
    this.tokenCounter.inc({
      operation: metrics.operation,
      tenant: metrics.tenant || 'unknown',
      provider: metrics.provider,
      type: 'input'
    }, metrics.inputTokens);
    
    this.tokenCounter.inc({
      operation: metrics.operation,
      tenant: metrics.tenant || 'unknown',
      provider: metrics.provider,
      type: 'output'
    }, metrics.outputTokens);
    
    this.costCounter.inc({
      operation: metrics.operation,
      tenant: metrics.tenant || 'unknown',
      provider: metrics.provider
    }, metrics.cost);
    
    this.costHistogram.observe({
      operation: metrics.operation,
      tenant: metrics.tenant || 'unknown',
      provider: metrics.provider
    }, metrics.cost);
  }
  
  // Get cost summary for reporting
  async getCostSummary(
    filters: { tenant?: string; operation?: string; timeRange?: [Date, Date] }
  ): Promise<CostSummary> {
    const metrics = await this.store.query(filters);
    
    return {
      totalCost: metrics.reduce((sum, m) => sum + m.cost, 0),
      totalTokens: metrics.reduce((sum, m) => sum + m.totalTokens, 0),
      operationCount: metrics.length,
      avgCostPerOperation: metrics.reduce((sum, m) => sum + m.cost, 0) / metrics.length,
      byProvider: this.groupByProvider(metrics),
      byOperation: this.groupByOperation(metrics),
      trends: this.calculateTrends(metrics)
    };
  }
}
```

**Token Counting:**

```typescript
// services/orchestrator/src/cost/TokenCounter.ts
export class TokenCounter {
  // Accurate token counting using tiktoken
  private encoder: TikTokenEncoder;
  
  constructor() {
    this.encoder = encoding_for_model('cl100k_base'); // Claude/GPT-4 encoding
  }
  
  count(text: string): number {
    return this.encoder.encode(text).length;
  }
  
  countMessages(messages: Message[]): number {
    // Account for message formatting overhead
    let total = 0;
    for (const message of messages) {
      total += 4; // Message formatting tokens
      total += this.count(message.role);
      total += this.count(message.content);
    }
    total += 2; // Conversation formatting
    return total;
  }
  
  estimateCompletion(prompt: string, maxTokens: number): TokenEstimate {
    const promptTokens = this.count(prompt);
    return {
      promptTokens,
      maxCompletionTokens: maxTokens,
      totalTokens: promptTokens + maxTokens
    };
  }
}
```

**Cost Attribution:**

```typescript
// services/orchestrator/src/cost/CostAttribution.ts
export class CostAttribution {
  async attributeCosts(
    timeRange: [Date, Date]
  ): Promise<AttributionReport> {
    const metrics = await this.costTracker.getMetrics(timeRange);
    
    return {
      byTenant: this.groupAndSum(metrics, 'tenant'),
      byOperation: this.groupAndSum(metrics, 'operation'),
      byProvider: this.groupAndSum(metrics, 'provider'),
      byHour: this.groupByTime(metrics, 'hour'),
      byDay: this.groupByTime(metrics, 'day'),
      topSpenders: this.getTopSpenders(metrics, 10),
      anomalies: await this.detectAnomalies(metrics)
    };
  }
  
  private detectAnomalies(metrics: CostMetrics[]): Anomaly[] {
    const anomalies: Anomaly[] = [];
    
    // Detect cost spikes
    const hourlySpend = this.groupByTime(metrics, 'hour');
    const baseline = this.calculateBaseline(hourlySpend);
    
    for (const [hour, cost] of Object.entries(hourlySpend)) {
      if (cost > baseline * 2) {
        anomalies.push({
          type: 'spike',
          timestamp: hour,
          value: cost,
          baseline,
          severity: cost > baseline * 5 ? 'HIGH' : 'MEDIUM'
        });
      }
    }
    
    return anomalies;
  }
}
```

**Integration with Providers:**

```typescript
// services/orchestrator/src/providers/AnthropicProvider.ts
export class AnthropicProvider {
  constructor(
    private client: Anthropic,
    private costTracker: CostTracker
  ) {}
  
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const { result, metrics } = await this.costTracker.trackOperation(
      {
        name: 'completion',
        tenant: request.tenant,
        provider: 'anthropic-claude-3.5-sonnet'
      },
      async () => {
        return this.client.messages.create({
          model: 'claude-3-5-sonnet-20241022',
          messages: request.messages,
          max_tokens: request.max_tokens
        });
      }
    );
    
    return result;
  }
}
```

**Grafana Cost Dashboard:**

```yaml
# charts/oss-ai-agent-tool/templates/cost-dashboard.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: grafana-cost-dashboard
data:
  cost-tracking.json: |
    {
      "dashboard": {
        "title": "Cost Tracking",
        "rows": [
          {
            "title": "Cost Overview",
            "panels": [
              {
                "title": "Hourly Spend",
                "targets": [{
                  "expr": "sum(rate(llm_cost_total[1h])) * 3600"
                }],
                "format": "currency"
              },
              {
                "title": "Cost by Provider",
                "targets": [{
                  "expr": "sum by(provider) (rate(llm_cost_total[1h])) * 3600"
                }],
                "type": "piechart"
              },
              {
                "title": "Token Usage",
                "targets": [{
                  "expr": "sum(rate(llm_tokens_total[5m])) * 60"
                }],
                "format": "tokens/min"
              },
              {
                "title": "Cost Per Workflow",
                "targets": [{
                  "expr": "histogram_quantile(0.95, llm_cost_per_operation_bucket{operation='workflow'})"
                }],
                "threshold": 0.10
              }
            ]
          },
          {
            "title": "Cost Attribution",
            "panels": [
              {
                "title": "Top Tenants by Cost",
                "targets": [{
                  "expr": "topk(10, sum by(tenant) (rate(llm_cost_total[24h])) * 86400)"
                }],
                "type": "table"
              },
              {
                "title": "Cost by Operation",
                "targets": [{
                  "expr": "sum by(operation) (rate(llm_cost_total[1h])) * 3600"
                }],
                "type": "bargauge"
              }
            ]
          }
        ]
      }
    }
```

**Acceptance Criteria:**
- [ ] All LLM calls tracked with accurate token counts
- [ ] Cost attribution accurate to $0.001
- [ ] Metrics available in Prometheus
- [ ] Grafana dashboard deployed
- [ ] Anomaly detection functional
- [ ] Per-tenant cost tracking works
- [ ] Historical data retained 90 days

---

### Task 5.2.2: Prompt Optimization (3 days)

**New Implementation**

**Purpose:** Reduce token usage through intelligent prompt compression and optimization

**Files to Create:**
```
services/orchestrator/src/optimization/
├── PromptOptimizer.ts
├── PromptCompressor.ts
├── TokenBudgetManager.ts
└── FewShotSelector.ts
```

**Technical Design:**

```typescript
// services/orchestrator/src/optimization/PromptOptimizer.ts
export class PromptOptimizer {
  constructor(
    private tokenCounter: TokenCounter,
    private compressor: PromptCompressor,
    private fewShotSelector: FewShotSelector
  ) {}
  
  async optimize(
    prompt: Prompt,
    options?: OptimizationOptions
  ): Promise<OptimizedPrompt> {
    const original = {
      text: prompt.text,
      tokens: this.tokenCounter.count(prompt.text)
    };
    
    // Step 1: Remove redundancy
    let optimized = await this.compressor.compress(prompt.text);
    
    // Step 2: Optimize few-shot examples
    if (prompt.examples) {
      const selected = await this.fewShotSelector.select(
        prompt.examples,
        prompt.task,
        options?.maxExamples || 3
      );
      optimized = this.applyExamples(optimized, selected);
    }
    
    // Step 3: Fit to context window
    if (options?.maxTokens) {
      optimized = await this.fitToContext(optimized, options.maxTokens);
    }
    
    // Step 4: Verify quality
    const quality = await this.verifyQuality(original.text, optimized);
    
    const final = {
      text: optimized,
      tokens: this.tokenCounter.count(optimized),
      savings: {
        tokens: original.tokens - this.tokenCounter.count(optimized),
        percentage: (1 - this.tokenCounter.count(optimized) / original.tokens) * 100
      },
      quality
    };
    
    // Record metrics
    this.metrics.recordOptimization(original.tokens, final.tokens, quality);
    
    return final;
  }
}
```

**Prompt Compression:**

```typescript
// services/orchestrator/src/optimization/PromptCompressor.ts
export class PromptCompressor {
  async compress(text: string): Promise<string> {
    let compressed = text;
    
    // Remove duplicate sentences
    compressed = this.deduplicateSentences(compressed);
    
    // Remove unnecessary whitespace
    compressed = this.normalizeWhitespace(compressed);
    
    // Simplify language (preserve meaning)
    compressed = await this.simplifyLanguage(compressed);
    
    // Apply common abbreviations
    compressed = this.applyAbbreviations(compressed);
    
    return compressed;
  }
  
  private deduplicateSentences(text: string): string {
    const sentences = text.split(/[.!?]+/);
    const unique = new Set<string>();
    const result: string[] = [];
    
    for (const sentence of sentences) {
      const normalized = sentence.trim().toLowerCase();
      if (normalized && !unique.has(normalized)) {
        unique.add(normalized);
        result.push(sentence);
      }
    }
    
    return result.join('. ');
  }
  
  private async simplifyLanguage(text: string): Promise<string> {
    // Use fast LLM to simplify while preserving meaning
    // Only do this for very verbose prompts
    if (text.length < 1000) return text;
    
    const simplified = await this.llm.complete({
      prompt: `Simplify this text while preserving all important information:\n\n${text}`,
      maxTokens: Math.floor(text.length * 0.7)
    });
    
    return simplified;
  }
  
  private applyAbbreviations(text: string): string {
    const abbreviations: Record<string, string> = {
      'for example': 'e.g.',
      'that is': 'i.e.',
      'and so on': 'etc.',
      'versus': 'vs',
      // Add more based on your domain
    };
    
    let result = text;
    for (const [full, abbrev] of Object.entries(abbreviations)) {
      result = result.replace(new RegExp(full, 'gi'), abbrev);
    }
    
    return result;
  }
}
```

**Few-Shot Example Selection:**

```typescript
// services/orchestrator/src/optimization/FewShotSelector.ts
export class FewShotSelector {
  async select(
    examples: Example[],
    task: string,
    maxCount: number
  ): Promise<Example[]> {
    if (examples.length <= maxCount) {
      return examples;
    }
    
    // Score examples by relevance to current task
    const scored = await Promise.all(
      examples.map(async ex => ({
        example: ex,
        score: await this.scoreRelevance(ex, task)
      }))
    );
    
    // Sort by score and select top K with diversity
    scored.sort((a, b) => b.score - a.score);
    
    return this.selectDiverse(scored, maxCount);
  }
  
  private async scoreRelevance(example: Example, task: string): Promise<number> {
    // Use embedding similarity
    const taskEmbedding = await this.embeddings.embed(task);
    const exampleEmbedding = await this.embeddings.embed(example.input);
    
    return this.cosineSimilarity(taskEmbedding, exampleEmbedding);
  }
  
  private selectDiverse(
    scored: Array<{ example: Example; score: number }>,
    maxCount: number
  ): Example[] {
    const selected: Example[] = [];
    
    // Always take top scorer
    selected.push(scored[0].example);
    
    // Select remaining examples for diversity
    for (let i = 1; i < scored.length && selected.length < maxCount; i++) {
      const candidate = scored[i].example;
      
      // Check diversity with already selected
      const isDiverse = selected.every(sel =>
        this.calculateDiversity(sel, candidate) > 0.3
      );
      
      if (isDiverse) {
        selected.push(candidate);
      }
    }
    
    return selected;
  }
}
```

**Token Budget Manager:**

```typescript
// services/orchestrator/src/optimization/TokenBudgetManager.ts
export class TokenBudgetManager {
  private budgets = new Map<string, TokenBudget>();
  
  async allocate(
    request: Request,
    available: number
  ): Promise<Allocation> {
    const tenant = request.tenant || 'default';
    const budget = this.budgets.get(tenant) || this.createBudget(tenant);
    
    // Check if tenant has budget
    if (budget.consumed >= budget.limit) {
      throw new BudgetExceededError(tenant, budget);
    }
    
    // Calculate allocation
    const priority = this.calculatePriority(request);
    const minimum = this.calculateMinimum(request);
    const optimal = this.calculateOptimal(request);
    
    if (available < minimum) {
      throw new InsufficientTokensError(minimum, available);
    }
    
    const allocated = Math.min(
      optimal,
      available,
      budget.limit - budget.consumed
    );
    
    // Reserve budget
    budget.consumed += allocated;
    
    return {
      tokens: allocated,
      strategy: allocated < optimal ? 'fallback' : 'optimal',
      priority
    };
  }
  
  async release(tenant: string, tokens: number): Promise<void> {
    const budget = this.budgets.get(tenant);
    if (budget) {
      budget.consumed -= tokens;
    }
  }
  
  // Reset budgets periodically (e.g., hourly, daily)
  async resetBudgets(scope: 'hourly' | 'daily'): Promise<void> {
    for (const [tenant, budget] of this.budgets) {
      if (budget.scope === scope) {
        budget.consumed = 0;
      }
    }
  }
}
```

**Acceptance Criteria:**
- [ ] Token usage reduced by > 30%
- [ ] Quality maintained (>95% semantic similarity)
- [ ] Compression latency < 50ms p95
- [ ] Few-shot selection improves accuracy
- [ ] Budget enforcement works correctly
- [ ] Metrics tracked in Prometheus

---

### Task 5.2.3: Smart Batching (3 days)

**Enhance:** Existing batch operations in embeddings.rs and add adaptive sizing

**Files to Create:**
```
services/orchestrator/src/optimization/
├── SmartBatcher.ts
├── AdaptiveBatchSizer.ts
└── PriorityBatchQueue.ts
```

**Technical Design:**

```typescript
// services/orchestrator/src/optimization/SmartBatcher.ts
export class SmartBatcher<TRequest, TResponse> {
  private queues = new Map<string, PriorityQueue<BatchItem<TRequest>>>();
  private config: BatchConfig;
  private sizer: AdaptiveBatchSizer;
  
  constructor(config: BatchConfig) {
    this.config = {
      maxSize: config.maxSize || 10,
      maxWait: config.maxWait || 100, // ms
      minSize: config.minSize || 3,
      ...config
    };
    this.sizer = new AdaptiveBatchSizer(this.config);
  }
  
  async batch(
    type: string,
    request: TRequest,
    priority: Priority = Priority.NORMAL
  ): Promise<TResponse> {
    return new Promise((resolve, reject) => {
      const queue = this.getOrCreateQueue(type);
      const item: BatchItem<TRequest> = {
        id: generateId(),
        request,
        priority,
        timestamp: Date.now(),
        resolve,
        reject
      };
      
      queue.enqueue(item, priority);
      
      // Check if we should process now
      if (this.shouldProcessNow(type, queue)) {
        this.processBatch(type, queue);
      } else {
        // Schedule batch processing
        this.scheduleBatch(type, queue);
      }
    });
  }
  
  private shouldProcessNow(type: string, queue: PriorityQueue): boolean {
    const optimalSize = this.sizer.getOptimalSize(type);
    
    // Process if at optimal size
    if (queue.size >= optimalSize) {
      return true;
    }
    
    // Process immediately for high priority
    if (queue.peek()?.priority === Priority.HIGH && queue.size >= this.config.minSize) {
      return true;
    }
    
    // Process if oldest item approaching timeout
    const oldest = queue.peekOldest();
    if (oldest) {
      const age = Date.now() - oldest.timestamp;
      return age >= this.config.maxWait * 0.8;
    }
    
    return false;
  }
  
  private async processBatch(
    type: string,
    queue: PriorityQueue<BatchItem<TRequest>>
  ): Promise<void> {
    const batchSize = this.sizer.getOptimalSize(type);
    const batch = queue.dequeueMultiple(batchSize);
    
    if (batch.length === 0) return;
    
    const start = Date.now();
    
    try {
      // Group similar requests for better batching
      const groups = this.groupBySimilarity(batch);
      
      // Process each group
      const results = await Promise.all(
        groups.map(group => this.processorGroup(type, group))
      );
      
      // Distribute results
      const flatResults = results.flat();
      batch.forEach((item, idx) => {
        item.resolve(flatResults[idx]);
      });
      
      // Update batch size based on performance
      const duration = Date.now() - start;
      this.sizer.recordBatchMetrics(type, {
        size: batch.length,
        duration,
        throughput: batch.length / (duration / 1000)
      });
      
      this.metrics.recordBatch(type, batch.length, duration);
      
    } catch (error) {
      // Fail all requests in batch
      batch.forEach(item => item.reject(error));
      this.metrics.recordBatchError(type, batch.length);
    }
  }
  
  private groupBySimilarity(
    batch: BatchItem<TRequest>[]
  ): BatchItem<TRequest>[][] {
    // Group similar requests for more efficient batching
    const groups: BatchItem<TRequest>[][] = [];
    
    for (const item of batch) {
      let assigned = false;
      
      for (const group of groups) {
        if (this.areSimilar(item.request, group[0].request)) {
          group.push(item);
          assigned = true;
          break;
        }
      }
      
      if (!assigned) {
        groups.push([item]);
      }
    }
    
    return groups;
  }
}
```

**Adaptive Batch Sizer:**

```typescript
// services/orchestrator/src/optimization/AdaptiveBatchSizer.ts
export class AdaptiveBatchSizer {
  private history = new Map<string, CircularBuffer<BatchMetrics>>();
  private optimalSizes = new Map<string, number>();
  
  constructor(private config: BatchConfig) {}
  
  getOptimalSize(type: string): number {
    return this.optimalSizes.get(type) || this.config.maxSize;
  }
  
  recordBatchMetrics(type: string, metrics: BatchMetrics): void {
    let history = this.history.get(type);
    if (!history) {
      history = new CircularBuffer<BatchMetrics>(100);
      this.history.set(type, history);
    }
    
    history.push(metrics);
    
    // Recalculate optimal size periodically
    if (history.length >= 10) {
      this.recalculateOptimalSize(type);
    }
  }
  
  private recalculateOptimalSize(type: string): void {
    const history = this.history.get(type)!;
    const metrics = history.getAll();
    
    const latencyTarget = 100; // ms
    const throughputTarget = 100; // req/s
    
    // Calculate current performance
    const avgLatency = metrics.reduce((sum, m) => sum + m.duration, 0) / metrics.length;
    const avgThroughput = metrics.reduce((sum, m) => sum + m.throughput, 0) / metrics.length;
    
    let size = this.optimalSizes.get(type) || this.config.maxSize;
    
    // Adjust based on latency
    if (avgLatency > latencyTarget) {
      size = Math.max(this.config.minSize, size - 1);
    } else if (avgLatency < latencyTarget * 0.7) {
      size = Math.min(this.config.maxSize, size + 1);
    }
    
    // Adjust based on throughput
    if (avgThroughput < throughputTarget) {
      size = Math.min(this.config.maxSize, size + 1);
    }
    
    this.optimalSizes.set(type, size);
    
    this.metrics.recordOptimalSize(type, size);
  }
}
```

**Acceptance Criteria:**
- [ ] API calls reduced by > 40%
- [ ] Batch latency < 150ms p95
- [ ] Priority requests honored
- [ ] Adaptive sizing responds to load
- [ ] No request starvation
- [ ] Metrics tracked

---

### Task 5.2.4: Resource Pool Management (2 days)

**New Implementation**

**Purpose:** Manage connection pools and compute resources efficiently

**Files to Create:**
```
services/orchestrator/src/resources/
├── ResourcePool.ts
├── ConnectionPool.ts
└── ResourceMetrics.ts
```

**Technical Design:**

```typescript
// services/orchestrator/src/resources/ResourcePool.ts
export class ResourcePool<T> {
  private available: T[] = [];
  private inUse = new Map<string, T>();
  private waiting: Queue<Deferred<T>> = new Queue();
  private config: PoolConfig;
  
  constructor(
    private factory: () => Promise<T>,
    private validator: (resource: T) => Promise<boolean>,
    config: PoolConfig
  ) {
    this.config = {
      minSize: config.minSize || 5,
      maxSize: config.maxSize || 50,
      acquireTimeout: config.acquireTimeout || 5000,
      idleTimeout: config.idleTimeout || 60000,
      ...config
    };
    
    // Pre-warm pool
    this.warmUp();
  }
  
  private async warmUp(): Promise<void> {
    const promises = [];
    for (let i = 0; i < this.config.minSize; i++) {
      promises.push(this.createResource());
    }
    
    const resources = await Promise.all(promises);
    this.available.push(...resources);
  }
  
  async acquire(id: string, timeout?: number): Promise<T> {
    // Try to get from available pool
    while (this.available.length > 0) {
      const resource = this.available.pop()!;
      
      // Validate before use
      if (await this.validator(resource)) {
        this.inUse.set(id, resource);
        this.metrics.recordAcquisition(id);
        return resource;
      } else {
        // Discard invalid resource
        await this.destroyResource(resource);
      }
    }
    
    // Check if we can create new resource
    if (this.getTotalSize() < this.config.maxSize) {
      const resource = await this.createResource();
      this.inUse.set(id, resource);
      return resource;
    }
    
    // Wait for resource to become available
    const deferred = new Deferred<T>();
    this.waiting.enqueue(deferred);
    
    return Promise.race([
      deferred.promise,
      this.timeout(timeout || this.config.acquireTimeout)
    ]);
  }
  
  async release(id: string): Promise<void> {
    const resource = this.inUse.get(id);
    if (!resource) return;
    
    this.inUse.delete(id);
    this.metrics.recordRelease(id);
    
    // Check if valid
    if (!(await this.validator(resource))) {
      await this.destroyResource(resource);
      return;
    }
    
    // Give to waiting request
    const waiter = this.waiting.dequeue();
    if (waiter) {
      waiter.resolve(resource);
    } else {
      this.available.push(resource);
    }
  }
  
  private getTotalSize(): number {
    return this.available.length + this.inUse.size;
  }
  
  private async createResource(): Promise<T> {
    const start = Date.now();
    try {
      const resource = await this.factory();
      this.metrics.recordCreation(Date.now() - start);
      return resource;
    } catch (error) {
      this.metrics.recordCreationError();
      throw error;
    }
  }
  
  private async destroyResource(resource: T): Promise<void> {
    // Cleanup logic here
    this.metrics.recordDestruction();
  }
  
  // Get pool stats
  getStats(): PoolStats {
    return {
      available: this.available.length,
      inUse: this.inUse.size,
      waiting: this.waiting.size,
      total: this.getTotalSize()
    };
  }
}
```

**Connection Pooling for External Services:**

```typescript
// services/orchestrator/src/resources/ConnectionPool.ts
export class HTTPConnectionPool extends ResourcePool<HTTPConnection> {
  constructor(baseURL: string, config: PoolConfig) {
    super(
      // Factory
      async () => {
        const conn = await http.connect(baseURL);
        return conn;
      },
      // Validator
      async (conn) => {
        return conn.isAlive();
      },
      config
    );
  }
}

// Usage in providers
export class AnthropicProvider {
  private connectionPool: HTTPConnectionPool;
  
  constructor(apiKey: string) {
    this.connectionPool = new HTTPConnectionPool('https://api.anthropic.com', {
      minSize: 5,
      maxSize: 50,
      acquireTimeout: 5000
    });
  }
  
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const connId = generateId();
    const conn = await this.connectionPool.acquire(connId);
    
    try {
      const response = await conn.post('/v1/messages', request);
      return response;
    } finally {
      await this.connectionPool.release(connId);
    }
  }
}
```

**Acceptance Criteria:**
- [ ] Connection pool hit rate > 95%
- [ ] No resource starvation
- [ ] Pool stats available in metrics
- [ ] Graceful handling of invalid resources
- [ ] Memory bounded under load

---

## Epic 5.3: Developer Experience & Ecosystem

**Duration:** 2 weeks  
**Priority:** P1  
**Build On:** Tool registry, gRPC patterns, existing GUI

### Task 5.3.1: TypeScript SDK (5 days)

**Build From:** services/orchestrator/src/grpc/IndexerClient.ts pattern

**Purpose:** Provide first-class TypeScript client library for OSS AI Agent Tool

**Files to Create:**
```
packages/sdk-typescript/
├── src/
│   ├── client.ts
│   ├── plans.ts
│   ├── tools.ts
│   ├── search.ts
│   └── types.ts
├── tests/
├── package.json
├── tsconfig.json
└── README.md
```

**Technical Design:**

```typescript
// packages/sdk-typescript/src/client.ts
import { OrchestratorClient } from './grpc/orchestrator_grpc_pb';
import { ToolRegistry } from './tools';
import { PlanExecutor } from './plans';
import { SearchClient } from './search';

export interface ClientConfig {
  endpoint: string;
  apiKey?: string;
  tenant?: string;
  timeout?: number;
  retries?: number;
}

export class OSSAIClient {
  private orchestrator: OrchestratorClient;
  public tools: ToolRegistry;
  public plans: PlanExecutor;
  public search: SearchClient;
  
  constructor(config: ClientConfig) {
    // gRPC client
    this.orchestrator = new OrchestratorClient(
      config.endpoint,
      this.createCredentials(config)
    );
    
    // Sub-clients
    this.tools = new ToolRegistry(this.orchestrator);
    this.plans = new PlanExecutor(this.orchestrator);
    this.search = new SearchClient(this.orchestrator);
  }
  
  private createCredentials(config: ClientConfig): grpc.ChannelCredentials {
    if (config.apiKey) {
      return grpc.credentials.createSsl();
    }
    return grpc.credentials.createInsecure();
  }
  
  async healthCheck(): Promise<HealthStatus> {
    const response = await this.orchestrator.healthCheck({});
    return {
      status: response.status,
      version: response.version,
      uptime: response.uptime
    };
  }
}

// Convenient factory function
export function createClient(config: ClientConfig): OSSAIClient {
  return new OSSAIClient(config);
}

// Re-export types
export * from './types';
export * from './tools';
export * from './plans';
```

**Plan Management:**

```typescript
// packages/sdk-typescript/src/plans.ts
export class PlanExecutor {
  constructor(private client: OrchestratorClient) {}
  
  async create(goal: string, options?: PlanOptions): Promise<Plan> {
    const request = {
      goal,
      constraints: options?.constraints,
      context: options?.context,
      approvalMode: options?.approvalMode || 'auto'
    };
    
    const response = await this.client.createPlan(request);
    
    return {
      id: response.id,
      goal: response.goal,
      steps: response.steps.map(this.convertStep),
      status: response.status,
      createdAt: new Date(response.created_at)
    };
  }
  
  async execute(planId: string): Promise<AsyncIterableIterator<ExecutionEvent>> {
    const stream = this.client.executePlan({ planId });
    
    return this.convertStream(stream);
  }
  
  async *convertStream(
    stream: grpc.ClientReadableStream
  ): AsyncIterableIterator<ExecutionEvent> {
    for await (const event of stream) {
      yield {
        type: event.type,
        step: event.step,
        data: JSON.parse(event.data),
        timestamp: new Date(event.timestamp)
      };
    }
  }
  
  async get(planId: string): Promise<Plan> {
    const response = await this.client.getPlan({ planId });
    return this.convertPlan(response);
  }
  
  async list(filters?: PlanFilters): Promise<Plan[]> {
    const response = await this.client.listPlans(filters || {});
    return response.plans.map(this.convertPlan);
  }
}
```

**Tool Registration:**

```typescript
// packages/sdk-typescript/src/tools.ts
import { z } from 'zod';

export interface ToolDefinition<TInput = any, TOutput = any> {
  id: string;
  name: string;
  description: string;
  capabilities: Capability[];
  inputSchema: z.ZodSchema<TInput>;
  outputSchema: z.ZodSchema<TOutput>;
  handler: (input: TInput) => Promise<TOutput>;
}

export class ToolRegistry {
  private tools = new Map<string, MCPTool>();
  
  constructor(private client: OrchestratorClient) {}
  
  register<TInput, TOutput>(
    definition: ToolDefinition<TInput, TOutput>
  ): MCPTool {
    const tool: MCPTool = {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      capabilities: definition.capabilities,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      
      async execute(input: unknown): Promise<TOutput> {
        // Validate input
        const validated = definition.inputSchema.parse(input);
        
        // Execute handler
        const result = await definition.handler(validated);
        
        // Validate output
        return definition.outputSchema.parse(result);
      }
    };
    
    this.tools.set(tool.id, tool);
    
    // Register with server
    this.client.registerTool({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      capabilities: tool.capabilities,
      schema: JSON.stringify(definition.inputSchema)
    });
    
    return tool;
  }
  
  async list(): Promise<MCPTool[]> {
    const response = await this.client.listTools({});
    return response.tools.map(this.convertTool);
  }
  
  async get(id: string): Promise<MCPTool | undefined> {
    return this.tools.get(id);
  }
}

// Decorator for tool creation
export function mcpTool<TInput, TOutput>(
  definition: Omit<ToolDefinition<TInput, TOutput>, 'handler'>
) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    
    descriptor.value = function (...args: any[]) {
      return originalMethod.apply(this, args);
    };
    
    // Attach metadata
    Reflect.defineMetadata('mcp:tool', definition, target, propertyKey);
    
    return descriptor;
  };
}
```

**Search Client:**

```typescript
// packages/sdk-typescript/src/search.ts
export class SearchClient {
  constructor(private client: OrchestratorClient) {}
  
  async semantic(query: string, options?: SearchOptions): Promise<SearchResults> {
    const response = await this.client.search({
      query,
      type: 'semantic',
      limit: options?.limit || 10,
      filters: options?.filters
    });
    
    return {
      results: response.results.map(r => ({
        id: r.id,
        score: r.score,
        content: r.content,
        metadata: JSON.parse(r.metadata)
      })),
      total: response.total,
      took: response.took_ms
    };
  }
  
  async code(query: string, options?: CodeSearchOptions): Promise<CodeResults> {
    const response = await this.client.search({
      query,
      type: 'code',
      language: options?.language,
      repository: options?.repository
    });
    
    return {
      results: response.results.map(r => ({
        file: r.file,
        line: r.line,
        content: r.content,
        score: r.score
      })),
      total: response.total
    };
  }
}
```

**Example Usage:**

```typescript
// examples/quickstart.ts
import { createClient, mcpTool } from '@ossai/sdk';
import { z } from 'zod';

// Create client
const client = createClient({
  endpoint: 'localhost:8080',
  apiKey: process.env.OSSAI_API_KEY
});

// Register a tool
const readFileTool = client.tools.register({
  id: 'file-reader',
  name: 'Read File',
  description: 'Reads content from a file',
  capabilities: ['READ_FILES'],
  inputSchema: z.object({
    path: z.string()
  }),
  outputSchema: z.object({
    content: z.string()
  }),
  handler: async (input) => {
    const content = await fs.readFile(input.path, 'utf-8');
    return { content };
  }
});

// Create and execute a plan
const plan = await client.plans.create('Analyze the codebase for security issues');

for await (const event of client.plans.execute(plan.id)) {
  console.log(event.type, event.data);
}

// Search code
const results = await client.search.code('function authenticate', {
  language: 'typescript'
});
```

**Package Configuration:**

```json
// packages/sdk-typescript/package.json
{
  "name": "@ossai/sdk",
  "version": "1.0.0",
  "description": "TypeScript SDK for OSS AI Agent Tool",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "prepublishOnly": "npm run build"
  },
  "keywords": ["ai", "agent", "mcp", "sdk"],
  "dependencies": {
    "@grpc/grpc-js": "^1.9.0",
    "@grpc/proto-loader": "^0.7.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.0.0",
    "jest": "^29.0.0"
  }
}
```

**Acceptance Criteria:**
- [ ] SDK published to npm
- [ ] Type definitions complete
- [ ] Examples work end-to-end
- [ ] Documentation generated
- [ ] Unit tests pass (>80% coverage)
- [ ] Integration tests pass

---

### Task 5.3.2: Tool Marketplace API (3 days)

**Extend:** services/orchestrator/src/tools/ToolRegistry.ts

**Purpose:** REST API for tool discovery, publishing, and management

**Files to Create:**
```
services/orchestrator/src/marketplace/
├── MarketplaceAPI.ts
├── ToolPublisher.ts
├── ToolDiscovery.ts
├── SecurityScanner.ts
└── routes.ts
```

**Technical Design:**

```typescript
// services/orchestrator/src/marketplace/MarketplaceAPI.ts
import { Router } from 'express';
import { ToolRegistry } from '../tools/ToolRegistry';
import { SecurityScanner } from './SecurityScanner';

export class MarketplaceAPI {
  private router: Router;
  
  constructor(
    private registry: ToolRegistry,
    private scanner: SecurityScanner
  ) {
    this.router = Router();
    this.setupRoutes();
  }
  
  private setupRoutes(): void {
    // Discovery
    this.router.get('/tools', this.search.bind(this));
    this.router.get('/tools/:id', this.getTool.bind(this));
    
    // Publishing
    this.router.post('/tools', this.publish.bind(this));
    this.router.put('/tools/:id', this.update.bind(this));
    this.router.delete('/tools/:id', this.delete.bind(this));
    
    // Metadata
    this.router.get('/tools/:id/stats', this.getStats.bind(this));
    this.router.get('/tools/:id/versions', this.getVersions.bind(this));
  }
  
  private async search(req: Request, res: Response): Promise<void> {
    const {
      query,
      capabilities,
      tags,
      author,
      limit = 20,
      offset = 0
    } = req.query;
    
    const results = await this.registry.search({
      text: query as string,
      capabilities: capabilities ? (capabilities as string).split(',') : undefined,
      tags: tags ? (tags as string).split(',') : undefined,
      author: author as string,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string)
    });
    
    // Enhance with usage stats
    const enhanced = await Promise.all(
      results.map(async tool => ({
        ...tool,
        stats: await this.registry.getUsageStats(tool.id),
        rating: await this.getRating(tool.id)
      }))
    );
    
    res.json({
      results: enhanced,
      total: await this.registry.count(req.query),
      limit,
      offset
    });
  }
  
  private async publish(req: Request, res: Response): Promise<void> {
    const toolPackage: ToolPackage = req.body;
    
    // Validate package structure
    await this.validatePackage(toolPackage);
    
    // Security scan
    const scanResult = await this.scanner.scan(toolPackage);
    if (!scanResult.passed) {
      res.status(400).json({
        error: 'Security scan failed',
        issues: scanResult.issues
      });
      return;
    }
    
    // Register tool
    const tool = await this.registry.register(toolPackage);
    
    // Update search index
    await this.updateIndex(tool);
    
    res.status(201).json({
      id: tool.id,
      version: tool.version,
      url: `/api/marketplace/tools/${tool.id}`
    });
  }
  
  private async validatePackage(pkg: ToolPackage): Promise<void> {
    const schema = z.object({
      id: z.string(),
      version: z.string().regex(/^\d+\.\d+\.\d+$/),
      name: z.string(),
      description: z.string(),
      author: z.object({
        name: z.string(),
        email: z.string().email()
      }),
      capabilities: z.array(z.string()),
      code: z.object({
        source: z.string(),
        language: z.enum(['typescript', 'javascript', 'python', 'rust']),
        entrypoint: z.string()
      }),
      license: z.string()
    });
    
    schema.parse(pkg);
  }
}
```

**Security Scanner:**

```typescript
// services/orchestrator/src/marketplace/SecurityScanner.ts
export class SecurityScanner {
  async scan(toolPackage: ToolPackage): Promise<ScanResult> {
    const issues: SecurityIssue[] = [];
    
    // Static analysis
    issues.push(...await this.staticAnalysis(toolPackage.code));
    
    // Dependency check
    issues.push(...await this.checkDependencies(toolPackage));
    
    // Permission analysis
    issues.push(...await this.analyzePermissions(toolPackage.capabilities));
    
    // Malware scan
    issues.push(...await this.malwareScan(toolPackage.code));
    
    return {
      passed: issues.filter(i => i.severity === 'HIGH' || i.severity === 'CRITICAL').length === 0,
      issues,
      score: this.calculateScore(issues)
    };
  }
  
  private async staticAnalysis(code: CodePackage): Promise<SecurityIssue[]> {
    const issues: SecurityIssue[] = [];
    
    // Check for dangerous patterns
    const dangerousPatterns = [
      { pattern: /eval\(/, message: 'Use of eval() detected' },
      { pattern: /exec\(/, message: 'Use of exec() detected' },
      { pattern: /child_process/, message: 'Process execution detected' },
      { pattern: /fs\.unlink/, message: 'File deletion detected' }
    ];
    
    for (const { pattern, message } of dangerousPatterns) {
      if (pattern.test(code.source)) {
        issues.push({
          type: 'dangerous-pattern',
          severity: 'HIGH',
          message,
          line: this.findLineNumber(code.source, pattern)
        });
      }
    }
    
    return issues;
  }
  
  private async checkDependencies(pkg: ToolPackage): Promise<SecurityIssue[]> {
    // Check for known vulnerabilities in dependencies
    // Integration with npm audit, snyk, etc.
    return [];
  }
}
```

**Tool Discovery:**

```typescript
// services/orchestrator/src/marketplace/ToolDiscovery.ts
export class ToolDiscovery {
  constructor(
    private registry: ToolRegistry,
    private searchIndex: SearchIndex
  ) {}
  
  async discover(query: DiscoveryQuery): Promise<Tool[]> {
    // Multi-faceted search
    const results = await this.searchIndex.search({
      text: query.text,
      capabilities: query.capabilities,
      tags: query.tags,
      author: query.author,
      minRating: query.minRating || 0,
      verified: query.verifiedOnly || false
    });
    
    // Rank by relevance and popularity
    return this.rankResults(results, query);
  }
  
  private rankResults(results: Tool[], query: DiscoveryQuery): Tool[] {
    return results.sort((a, b) => {
      // Scoring factors:
      // - Text relevance (from search)
      // - Download count
      // - Rating
      // - Recency
      // - Author reputation
      
      const scoreA = this.calculateScore(a, query);
      const scoreB = this.calculateScore(b, query);
      
      return scoreB - scoreA;
    });
  }
  
  private calculateScore(tool: Tool, query: DiscoveryQuery): number {
    let score = 0;
    
    // Text relevance (0-100)
    score += tool.relevanceScore || 0;
    
    // Popularity (0-50)
    score += Math.min(50, Math.log10(tool.stats.downloads + 1) * 10);
    
    // Rating (0-25)
    score += (tool.rating || 0) * 5;
    
    // Recency (0-15)
    const daysSinceUpdate = (Date.now() - tool.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 15 - daysSinceUpdate / 30);
    
    // Verified bonus (10)
    if (tool.verified) score += 10;
    
    return score;
  }
}
```

**Acceptance Criteria:**
- [ ] REST API functional
- [ ] Security scanning works
- [ ] Search returns relevant results
- [ ] Version management works
- [ ] Usage analytics tracked
- [ ] API documentation generated

---

## Performance Benchmarks & Targets

### Latency Targets

```yaml
operations:
  ttft:  # Time to First Token
    p50: 150ms
    p95: 300ms
    p99: 500ms
  
  rpc:  # Internal RPC
    p50: 20ms
    p95: 50ms
    p99: 100ms
  
  search:  # Semantic search
    p50: 100ms
    p95: 200ms
    p99: 400ms
  
  cache_lookup:
    l1:
      p50: 0.5ms
      p95: 1ms
      p99: 5ms
    l2:
      p50: 5ms
      p95: 10ms
      p99: 50ms
    l3:
      p50: 50ms
      p95: 100ms
      p99: 200ms
```

### Throughput Targets

```yaml
capacity:
  concurrent_requests: 1000
  requests_per_second: 5000
  workflows_per_minute: 100
  batch_size_optimal: 10-20
```

### Cost Targets

```yaml
efficiency:
  cache_hit_rate_target: 0.70
  token_reduction_target: 0.40
  api_call_reduction_target: 0.50
  cost_per_workflow_target: 0.10  # USD
  
baselines:
  token_cost_per_1k: 0.015  # Claude 3.5 Sonnet
  avg_workflow_tokens_before: 50000
  avg_workflow_tokens_after: 30000  # 40% reduction
```

---

## Testing Strategy

### Performance Testing

```typescript
// tests/performance/benchmarks.test.ts
import { loadTest, percentile } from './utils';

describe('Performance Benchmarks', () => {
  test('TTFT p95 < 300ms', async () => {
    const results = await loadTest({
      endpoint: '/api/complete',
      concurrent: 100,
      duration: '60s',
      rampUp: '10s'
    });
    
    expect(percentile(results.latencies, 95)).toBeLessThan(300);
  });
  
  test('Cache hit rate > 70%', async () => {
    // Warm cache
    await warmCache();
    
    // Run workload
    const metrics = await runWorkload();
    
    const hitRate = metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses);
    expect(hitRate).toBeGreaterThan(0.7);
  });
  
  test('Request coalescing reduces duplicate calls', async () => {
    const results = await loadTest({
      endpoint: '/api/complete',
      concurrent: 50,
      identicalRequests: true,  // Send same request from all clients
      duration: '30s'
    });
    
    const uniqueCalls = results.backendCallsCount;
    const totalRequests = results.totalRequests;
    
    expect(uniqueCalls / totalRequests).toBeLessThan(0.4);  // >60% coalesced
  });
});
```

### Load Testing

```yaml
# k6/load-test.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export let options = {
  scenarios: {
    constant_load: {
      executor: 'constant-arrival-rate',
      rate: 1000,  # 1000 req/s
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
    spike_load: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 500,
      stages: [
        { duration: '2m', target: 1000 },
        { duration: '5m', target: 5000 },  # Spike
        { duration: '2m', target: 1000 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
    errors: ['rate<0.05'],
  },
};

export default function() {
  const payload = JSON.stringify({
    goal: 'Analyze code for security issues',
    context: { repository: 'example/repo' }
  });
  
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${__ENV.API_KEY}`,
    },
  };
  
  const res = http.post('http://localhost:8080/api/plans', payload, params);
  
  check(res, {
    'status is 200': (r) => r.status === 200,
    'ttft < 300ms': (r) => r.timings.waiting < 300,
    'has plan id': (r) => r.json('id') !== undefined,
  }) || errorRate.add(1);
  
  sleep(1);
}
```

### Cost Testing

```typescript
// tests/cost/optimization.test.ts
describe('Cost Optimization', () => {
  test('Token usage reduced by 40%', async () => {
    const baseline = await measureBaseline();
    const optimized = await measureOptimized();
    
    const reduction = (baseline.tokens - optimized.tokens) / baseline.tokens;
    expect(reduction).toBeGreaterThan(0.4);
  });
  
  test('Prompt compression maintains quality', async () => {
    const original = generateTestPrompt();
    const compressed = await promptOptimizer.compress(original);
    
    // Verify semantic similarity
    const similarity = await semanticSimilarity(original, compressed);
    expect(similarity).toBeGreaterThan(0.95);
    
    // Verify token reduction
    const reduction = (original.tokens - compressed.tokens) / original.tokens;
    expect(reduction).toBeGreaterThan(0.2);
  });
  
  test('Batching reduces API calls by 50%', async () => {
    const baseline = await runWithoutBatching();
    const batched = await runWithBatching();
    
    const reduction = (baseline.apiCalls - batched.apiCalls) / baseline.apiCalls;
    expect(reduction).toBeGreaterThan(0.5);
  });
});
```

### Regression Testing

```typescript
// tests/regression/performance-regression.test.ts
describe('Performance Regression Detection', () => {
  test('Detect latency regression', async () => {
    const baseline = await getBaselineMetrics('completion');
    const current = await getCurrentMetrics('completion');
    
    const regression = (current.p95 - baseline.p95) / baseline.p95;
    
    if (regression > 0.2) {
      throw new Error(`Performance regression detected: ${(regression * 100).toFixed(1)}% slower`);
    }
  });
});
```

---

## Rollout Plan

### Week 1-2: Performance Foundation

**Days 1-5:**
- [ ] Implement HierarchicalCache base class
- [ ] Extend to PromptCache, EmbeddingCache, CompletionCache
- [ ] Deploy Redis cluster configuration
- [ ] Add cache metrics to Prometheus

**Days 6-10:**
- [ ] Implement RequestCoalescer
- [ ] Add RetrievalOptimizer with batching
- [ ] Enhance PipelineMonitoring with SLO checks
- [ ] Update Grafana dashboards
- [ ] Deploy to staging

### Week 3-4: Cost Infrastructure

**Days 11-15:**
- [ ] Implement CostTracker with token counting
- [ ] Wrap all provider calls with cost tracking
- [ ] Create cost Grafana dashboard
- [ ] Add Prometheus alerts for cost overruns
- [ ] Deploy to staging

**Days 16-20:**
- [ ] Implement PromptOptimizer with compression
- [ ] Add SmartBatcher with adaptive sizing
- [ ] Implement TokenBudgetManager
- [ ] Add ResourcePool for connections
- [ ] Deploy to staging

### Week 5-6: Developer Ecosystem

**Days 21-25:**
- [ ] Build TypeScript SDK
- [ ] Add unit tests and integration tests
- [ ] Generate documentation
- [ ] Create examples
- [ ] Publish to npm

**Days 26-30:**
- [ ] Implement Marketplace API
- [ ] Add SecurityScanner
- [ ] Create tool discovery UI
- [ ] Write marketplace documentation
- [ ] Deploy to staging

### Week 7-8: Hardening & Production

**Days 31-35:**
- [ ] Run performance benchmarks
- [ ] Run load tests (k6)
- [ ] Run cost optimization validation
- [ ] Fix issues and tune parameters
- [ ] Security audit

**Days 36-40:**
- [ ] Canary deployment to production (10% traffic)
- [ ] Monitor SLOs and cost metrics
- [ ] Gradual rollout (25%, 50%, 100%)
- [ ] Complete documentation
- [ ] Launch announcement

---

## Risk Mitigation

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Cache invalidation bugs | Medium | High | Comprehensive testing, gradual rollout with feature flags |
| Performance regression | Medium | High | Automated regression detection, canary deployments |
| Cost overruns | Medium | High | Budget alerts, automatic throttling, cost tracking dashboard |
| SDK compatibility | Low | Medium | Contract tests, semantic versioning, deprecation policy |
| Redis failures | Low | High | Clustering with automatic failover, graceful degradation |

### Operational Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Marketplace abuse | Medium | Medium | Security scanning, moderation, rate limiting |
| API rate limits hit | Medium | Low | Batching, exponential backoff, connection pooling |
| Documentation gaps | Medium | Medium | Generated docs, examples, community feedback |
| Slow SDK adoption | Medium | Low | Good examples, marketing, community engagement |

### Dependency Risks

| Dependency | Risk | Mitigation |
|-----------|------|------------|
| Real embeddings not implemented | HIGH | Complete embeddings.rs LocalProvider or use OrchestratorProvider |
| Storage layer incomplete | MEDIUM | Complete storage.rs or use in-memory for caching |
| OpenTelemetry exports missing | LOW | Nice-to-have, not blocking |

---

## Success Metrics Dashboard

### Key Metrics

```yaml
dashboard:
  performance:
    - name: ttft_p95
      target: 300
      unit: ms
      alert: ">300 for 5m"
    
    - name: rpc_p95
      target: 50
      unit: ms
      alert: ">50 for 5m"
    
    - name: search_p95
      target: 200
      unit: ms
      alert: ">200 for 5m"
    
    - name: cache_hit_rate
      target: 0.70
      unit: ratio
      alert: "<0.6 for 10m"
  
  cost:
    - name: token_spend_hourly
      unit: $/hour
      budget: 10.00
      alert: ">12.00"
    
    - name: api_calls_saved
      unit: calls/hour
      target: 5000
    
    - name: cost_per_workflow
      unit: $
      target: 0.10
      alert: ">0.15"
    
    - name: efficiency_gain
      unit: "%"
      target: 40
  
  adoption:
    - name: sdk_downloads_weekly
      unit: downloads
      target: 100
    
    - name: marketplace_tools
      unit: count
      target: 5
    
    - name: active_developers
      unit: count
      target: 50
```

### Alerting Rules

```yaml
# charts/oss-ai-agent-tool/templates/prometheus-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: phase5-alerts
spec:
  groups:
    - name: performance-slos
      interval: 30s
      rules:
        - alert: TTFTSLOViolation
          expr: histogram_quantile(0.95, rate(ttft_duration_ms_bucket[5m])) > 300
          for: 5m
          labels:
            severity: high
            phase: "5"
          annotations:
            summary: "TTFT p95 SLO violation"
            description: "TTFT p95 is {{ $value }}ms (target: 300ms)"
        
        - alert: CacheHitRateLow
          expr: rate(cache_hits_total[5m]) / (rate(cache_hits_total[5m]) + rate(cache_misses_total[5m])) < 0.6
          for: 10m
          labels:
            severity: medium
          annotations:
            summary: "Cache hit rate below target"
            description: "Hit rate {{ $value | humanizePercentage }} (target: 70%)"
    
    - name: cost-alerts
      interval: 1m
      rules:
        - alert: CostOverrun
          expr: sum(rate(llm_cost_total[1h])) * 3600 > 12.00
          for: 5m
          labels:
            severity: high
          annotations:
            summary: "Hourly cost exceeds budget"
            description: "Cost ${{ $value }}/hour (budget: $10/hour)"
        
        - alert: TokenUsageAnomaly
          expr: sum(rate(llm_tokens_total[5m])) > avg_over_time(sum(rate(llm_tokens_total[5m]))[1h:5m]) * 2
          for: 10m
          labels:
            severity: medium
          annotations:
            summary: "Token usage spike detected"
            description: "Token rate {{ $value }} is 2x normal"
    
    - name: ecosystem-health
      interval: 5m
      rules:
        - alert: SDKErrorRateHigh
          expr: rate(sdk_errors_total[5m]) / rate(sdk_requests_total[5m]) > 0.01
          for: 5m
          labels:
            severity: medium
          annotations:
            summary: "SDK error rate above 1%"
            description: "Error rate {{ $value | humanizePercentage }}"
```

---

## Documentation Requirements

### Performance Documentation

Create in `docs/performance/`:
- `caching-guide.md` - How to configure and tune the hierarchical cache
- `performance-tuning.md` - Performance optimization best practices
- `slo-runbook.md` - What to do when SLOs are violated
- `monitoring-guide.md` - How to read dashboards and metrics

### Cost Documentation

Create in `docs/cost/`:
- `cost-optimization.md` - Strategies for reducing costs
- `token-management.md` - Token counting and budgeting
- `pricing-model.md` - How costs are calculated
- `budget-alerts.md` - Setting up cost alerts

### Developer Documentation

Create in `docs/sdk/`:
- `typescript-quickstart.md` - Getting started with TypeScript SDK
- `tool-development.md` - How to build MCP tools
- `marketplace-guide.md` - Publishing tools to marketplace
- `api-reference.md` - Generated API documentation

### Runbooks

Create in `docs/runbooks/`:
- `cache-invalidation.md` - What to do when cache gets stale
- `performance-regression.md` - Debugging performance issues
- `cost-spike.md` - Responding to cost anomalies
- `marketplace-security.md` - Handling security issues in tools

---

## Dependencies & Prerequisites

### External Dependencies

**Required:**
- Redis 7+ for distributed caching (L2 layer)
- PostgreSQL 14+ for cost tracking storage
- Grafana 9+ for dashboards
- Prometheus for metrics collection

**Optional:**
- Vector database (Qdrant, Weaviate) for semantic cache
- npm/npmjs.com for SDK publishing
- GitHub for marketplace integration

### Internal Dependencies

**Blockers:**
- [ ] Real semantic embeddings (currently using hashes) - services/indexer/src/embeddings.rs:327
- [ ] Storage layer completion - services/indexer/src/storage.rs

**Important:**
- [ ] OpenTelemetry exports configured
- [ ] OIDC SSO complete (for marketplace auth)
- [ ] Phase 4 tools deployed

**Nice-to-have:**
- [ ] Sandbox implementation deployed
- [ ] Approval workflows integrated

---

## Definition of Done

### Phase 5 Complete When:

#### Performance (Epic 5.1)
- [ ] All performance SLOs met consistently for 7 days
- [ ] TTFT p95 < 300ms sustained
- [ ] Cache hit rate > 70% sustained
- [ ] Request coalescing reduces calls > 60%
- [ ] Performance regression tests passing
- [ ] Grafana dashboards deployed and functional

#### Cost (Epic 5.2)
- [ ] Cost tracking infrastructure operational
- [ ] Token usage reduced by > 40% validated
- [ ] API calls reduced by > 50% via batching
- [ ] Cost per workflow < $0.10 average
- [ ] Cost dashboards and alerts deployed
- [ ] No budget overruns for 7 days

#### Ecosystem (Epic 5.3)
- [ ] TypeScript SDK published to npm
- [ ] SDK has > 80% test coverage
- [ ] Tool marketplace API functional
- [ ] Security scanning operational
- [ ] 5+ community tools published
- [ ] Documentation complete and reviewed

#### Operations
- [ ] All integration tests passing
- [ ] Load tests passing at 2x expected traffic
- [ ] Security audit passed
- [ ] Runbooks created for common issues
- [ ] Canary deployment successful
- [ ] Production rollout complete (100% traffic)

#### Metrics (Sustained for 7 days)
- [ ] TTFT p95 < 300ms ✅
- [ ] RPC p95 < 50ms ✅
- [ ] Search p95 < 200ms ✅
- [ ] Cache hit rate > 70% ✅
- [ ] Cost per workflow < $0.10 ✅
- [ ] Zero critical alerts ✅

---

## Next Steps (Phase 6 Preview)

After Phase 5 completion, consider:

1. **Advanced AI Features:**
   - Multi-modal support (vision, audio)
   - Fine-tuned models for specific tasks
   - Agent learning from feedback

2. **Extended Ecosystem:**
   - VS Code extension (deferred from Phase 5)
   - Python, Go, Rust SDKs
   - IDE plugins (JetBrains, Vim)

3. **Enterprise Features:**
   - Advanced governance and compliance
   - Custom model hosting
   - Air-gapped deployment

4. **Platform Expansion:**
   - Mobile SDKs
   - Browser extension
   - Slack/Teams integration

---

_End of Phase 5 Implementation Plan_

**Document Status:** ✅ Ready for Implementation  
**Last Updated:** 2025-01-17  
**Next Review:** Start of Week 3 (Cost Infrastructure)
