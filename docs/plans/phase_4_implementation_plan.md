# Phase 4 Implementation Plan: Indexing, Tools, and Multi-Agent
_Date: 2025-11-17_  
_Status: Planning_  
_Estimated Duration: 8-10 weeks_

## Executive Summary

Phase 4 delivers the hybrid context engine (symbolic + semantic + temporal), MCP tool integration with sandboxing, and multi-agent orchestration capabilities. This phase transforms the OSS AI Agent Tool from a single-agent system into a sophisticated multi-agent platform with precise code understanding and secure tool execution.

---

## Goals & Success Criteria

### Primary Goals
1. **Hybrid Context Engine**: Deliver precise, context-aware code understanding through symbolic AST analysis, semantic embeddings, and temporal git history
2. **MCP Tools with Sandboxing**: Implement secure, capability-controlled tool execution with approval workflows
3. **Multi-Agent Orchestration**: Enable complex workflows with planner → code-writer → tester → auditor pipelines

### Success Metrics
- Context queries ("Where is auth?") return accurate, recent locations in < 500ms p95
- Tool execution violations are caught 100% by sandbox with zero escapes
- Multi-agent workflows complete end-to-end with proper fan-out/fan-in orchestration
- All security controls per CLAUDE.md are enforced and audited
- Test coverage ≥ 80% for core components

---

## Epic 4.1: Indexer Enhancement (Rust)
**Duration**: 3 weeks  
**Team**: Backend Engineers  
**Dependencies**: Existing indexer skeleton at `services/indexer/`

### Current State Analysis
Based on comprehensive review, the indexer has:
- ✅ Tree-sitter integration for TypeScript/JavaScript/Rust/JSON
- ✅ Basic semantic store with placeholder hash embeddings
- ✅ LSP server with hover/goto-definition/references
- ✅ Comprehensive security (ACL/DLP) and audit logging
- ❌ Real semantic embeddings (using hash placeholders)
- ❌ Persistence layer (in-memory only)
- ❌ gRPC API for orchestrator communication
- ❌ Git integration for temporal context
- ❌ OpenTelemetry export configured

### Task 4.1.1: Implement Real Semantic Embeddings
**Priority**: P0 (Blocking)  
**Duration**: 1 week  
**Owner**: Backend Team

#### Requirements
- Replace hash-based placeholders with real embeddings
- Support multiple embedding providers via orchestrator
- Implement vector similarity search with FAISS or similar
- Add embedding cache to reduce API calls

#### Technical Approach
```rust
// services/indexer/src/embeddings.rs
pub trait EmbeddingProvider: Send + Sync {
    async fn embed(&self, text: &str) -> Result<Vec<f32>, EmbeddingError>;
    fn dimensions(&self) -> usize;
}

pub struct OrchestratorEmbeddingProvider {
    client: reqwest::Client,
    endpoint: String,
    cache: Arc<RwLock<LruCache<String, Vec<f32>>>>,
}

pub struct LocalEmbeddingProvider {
    model: ort::Session, // ONNX Runtime
    tokenizer: Tokenizer,
}
```

#### Implementation Steps
1. Create embedding provider abstraction
2. Implement orchestrator-backed provider (calls orchestrator's embedding endpoint)
3. Add optional local ONNX provider for offline/performance
4. Integrate FAISS for vector similarity search
5. Update SemanticStore to use real embeddings
6. Add embedding dimension configuration (384/768/1536)
7. Implement batched embedding for efficiency

#### Acceptance Criteria
- [ ] Semantic search returns relevant results with cosine similarity > 0.7
- [ ] Embedding cache hit rate > 60% in typical workflows
- [ ] Support for OpenAI, Anthropic, and local embeddings
- [ ] Performance: < 50ms for cached, < 500ms for uncached embeddings

### Task 4.1.2: Add gRPC Symbol Graph API
**Priority**: P0 (Blocking)  
**Duration**: 4 days  
**Owner**: Backend Team

#### Requirements
- Define protobuf contracts for indexer↔orchestrator communication
- Implement symbol graph queries (definitions, references, call hierarchy)
- Support incremental indexing updates
- Include capability annotations for security

#### Proto Definition
```protobuf
// services/indexer/proto/indexer.proto
syntax = "proto3";
package indexer;

service IndexerService {
  // Symbol operations
  rpc GetSymbolDefinition(SymbolRequest) returns (SymbolResponse);
  rpc FindReferences(ReferenceRequest) returns (stream ReferenceResponse);
  rpc GetCallHierarchy(CallHierarchyRequest) returns (CallHierarchyResponse);
  
  // Semantic search
  rpc SemanticSearch(SearchRequest) returns (SearchResponse);
  
  // Indexing operations
  rpc IndexFile(IndexFileRequest) returns (IndexFileResponse);
  rpc IndexRepository(IndexRepoRequest) returns (stream IndexProgress);
  
  // Temporal queries
  rpc GetFileHistory(HistoryRequest) returns (HistoryResponse);
  rpc GetChangedSymbols(DiffRequest) returns (DiffResponse);
}

message SymbolRequest {
  string file_path = 1;
  uint32 line = 2;
  uint32 column = 3;
  string commit_id = 4; // optional
}

message SearchRequest {
  string query = 1;
  uint32 top_k = 2;
  repeated string path_filters = 3;
  string commit_id = 4;
  bool include_temporal = 5;
}
```

#### Implementation Steps
1. Create proto definitions in `services/indexer/proto/`
2. Configure tonic-build in build.rs
3. Implement gRPC service handlers
4. Add authentication/authorization interceptors
5. Implement streaming for large result sets
6. Add request/response validation
7. Update orchestrator to call indexer via gRPC

#### Acceptance Criteria
- [ ] All gRPC endpoints functional with < 50ms p95 latency
- [ ] Streaming works for large repositories (> 10k files)
- [ ] Authentication enforced on all endpoints
- [ ] OpenTelemetry traces propagated correctly

### Task 4.1.3: Implement Temporal Layer with Git Integration
**Priority**: P1  
**Duration**: 5 days  
**Owner**: Backend Team

#### Requirements
- Track file changes across git commits
- Index CI/CD failures and correlate with code changes
- Support time-travel queries ("What was this function 3 commits ago?")
- Maintain symbol evolution history

#### Technical Approach
```rust
// services/indexer/src/temporal.rs
pub struct TemporalIndex {
    git_repo: git2::Repository,
    symbol_history: BTreeMap<String, Vec<SymbolVersion>>,
    ci_events: Vec<CiEvent>,
}

pub struct SymbolVersion {
    commit_id: String,
    timestamp: DateTime<Utc>,
    symbol_info: SymbolInfo,
    change_type: ChangeType, // Added, Modified, Deleted, Renamed
}

impl TemporalIndex {
    pub async fn index_commit_range(&mut self, from: &str, to: &str) -> Result<()>;
    pub async fn correlate_ci_failure(&mut self, build_id: &str) -> Result<Vec<SuspectChange>>;
    pub async fn get_symbol_at_commit(&self, symbol: &str, commit: &str) -> Result<SymbolInfo>;
}
```

#### Implementation Steps
1. Integrate git2-rs for repository access
2. Implement commit walking and diff analysis
3. Build symbol history tracking
4. Add CI event correlation (via webhook or API)
5. Implement blame analysis for error attribution
6. Create time-travel query API
7. Add incremental index updates on push events

#### Acceptance Criteria
- [ ] Can query any symbol's state at any commit
- [ ] CI failures correctly attributed to code changes
- [ ] Incremental updates complete in < 2s for typical commits
- [ ] Symbol rename tracking works across refactors

### Task 4.1.4: Add Persistence Layer
**Priority**: P0 (Blocking)  
**Duration**: 3 days  
**Owner**: Backend Team

#### Requirements
- Persist index to disk for restart resilience
- Support both SQLite (consumer) and PostgreSQL (enterprise)
- Implement WAL for crash recovery
- Add index compaction/vacuum operations

#### Implementation
```rust
// services/indexer/src/storage.rs
pub trait IndexStorage: Send + Sync {
    async fn store_symbols(&mut self, symbols: Vec<Symbol>) -> Result<()>;
    async fn store_embeddings(&mut self, embeddings: Vec<Document>) -> Result<()>;
    async fn query_symbols(&self, query: &SymbolQuery) -> Result<Vec<Symbol>>;
    async fn search_semantic(&self, embedding: &[f32], k: usize) -> Result<Vec<Document>>;
    async fn checkpoint(&mut self) -> Result<()>;
}

pub struct SqliteStorage { /* ... */ }
pub struct PostgresStorage { /* ... */ }
```

#### Acceptance Criteria
- [ ] Index survives service restarts
- [ ] < 100ms write latency for typical operations
- [ ] Automatic compaction keeps size < 2x raw data
- [ ] Backup/restore operations documented

---

## Epic 4.2: MCP Tools & Sandboxing
**Duration**: 3 weeks  
**Team**: Platform/Security Team  
**Dependencies**: Orchestrator provider framework

### Task 4.2.1: Design MCP Tool Framework
**Priority**: P0  
**Duration**: 3 days  
**Owner**: Platform Team

#### Requirements
- Define MCP tool interface and capability model
- Support sync and async tool execution
- Implement tool discovery and registration
- Add capability annotations for security

#### Tool Interface
```typescript
// services/orchestrator/src/tools/mcp.ts
export interface McpTool {
  id: string;
  name: string;
  description: string;
  capabilities: ToolCapability[];
  inputSchema: z.ZodSchema;
  outputSchema: z.ZodSchema;
  
  validate(input: unknown): Promise<ValidationResult>;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

export enum ToolCapability {
  READ = 'read',
  WRITE = 'write',
  EXECUTE = 'execute',
  NETWORK = 'network',
  PRIVILEGED = 'privileged'
}

export interface ToolContext {
  sessionId: string;
  userId: string;
  approvals: Map<ToolCapability, boolean>;
  sandbox: SandboxEnvironment;
  timeout: number;
}
```

#### Implementation Steps
1. Define core MCP interfaces and types
2. Create tool registry with dynamic loading
3. Implement capability checking middleware
4. Add tool versioning and compatibility checks
5. Create tool validation framework
6. Implement audit logging for tool execution
7. Add metrics collection (execution time, success rate)

#### Acceptance Criteria
- [ ] Tool registry supports hot-reload of tool definitions
- [ ] Capability violations blocked before execution
- [ ] All tool executions logged with full context
- [ ] Tool validation catches malformed inputs

### Task 4.2.2: Implement Core MCP Tools
**Priority**: P1  
**Duration**: 1 week  
**Owner**: Platform Team

#### Tool Implementations

##### 1. Repository Operations Tool
```typescript
export class RepoTool implements McpTool {
  capabilities = [ToolCapability.READ, ToolCapability.WRITE];
  
  async execute(input: RepoOperation, context: ToolContext) {
    // Git operations: clone, commit, push, pr
    // File operations: read, write, delete
    // Code search: grep, find, symbols
  }
}
```

##### 2. Test Runner Tool
```typescript
export class TestRunnerTool implements McpTool {
  capabilities = [ToolCapability.EXECUTE, ToolCapability.READ];
  
  async execute(input: TestConfig, context: ToolContext) {
    // Language detection
    // Test framework selection
    // Isolated execution
    // Result parsing and reporting
  }
}
```

##### 3. Browser Automation Tool
```typescript
export class BrowserTool implements McpTool {
  capabilities = [ToolCapability.NETWORK, ToolCapability.EXECUTE];
  
  async execute(input: BrowserAction, context: ToolContext) {
    // Puppeteer/Playwright integration
    // Screenshot capture
    // DOM inspection
    // Network monitoring
  }
}
```

##### 4. Database Query Tool
```typescript
export class DatabaseTool implements McpTool {
  capabilities = [ToolCapability.READ, ToolCapability.WRITE];
  
  async execute(input: DbQuery, context: ToolContext) {
    // Connection pooling
    // Query validation
    // Result limiting
    // Transaction support
  }
}
```

#### Acceptance Criteria
- [ ] Each tool has comprehensive input validation
- [ ] Tools respect capability restrictions
- [ ] Error handling doesn't leak sensitive info
- [ ] Tools work in both consumer and enterprise modes

### Task 4.2.3: Implement Sandbox Environments
**Priority**: P0 (Critical Security)  
**Duration**: 1 week  
**Owner**: Security Team

#### Requirements
- Container-based isolation for tool execution
- WASM sandbox for lightweight tools
- Network isolation with allowlist
- Filesystem restrictions and quotas
- Resource limits (CPU, memory, disk)

#### Sandbox Architecture
```typescript
// services/orchestrator/src/sandbox/container.ts
export class ContainerSandbox implements SandboxEnvironment {
  private docker: Docker;
  private networkPolicy: NetworkPolicy;
  
  async prepare(config: SandboxConfig): Promise<void> {
    // Create isolated network namespace
    // Mount read-only filesystem
    // Apply seccomp profiles
    // Set resource limits
    // Configure audit logging
  }
  
  async execute(command: string[], timeout: number): Promise<ExecutionResult> {
    // Run in container
    // Stream output
    // Enforce timeout
    // Collect metrics
  }
  
  async cleanup(): Promise<void> {
    // Remove container
    // Clean temporary files
    // Flush audit logs
  }
}

// services/orchestrator/src/sandbox/wasm.ts
export class WasmSandbox implements SandboxEnvironment {
  private runtime: WasmRuntime;
  
  async execute(wasm: Uint8Array, input: unknown): Promise<unknown> {
    // Load WASM module
    // Apply capability restrictions
    // Execute with timeout
    // Validate output
  }
}
```

#### Security Controls
```yaml
# Seccomp profile
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    {"names": ["read", "write", "open", "close"], "action": "SCMP_ACT_ALLOW"},
    {"names": ["socket", "connect"], "action": "SCMP_ACT_ERRNO"}
  ]
}

# AppArmor profile
profile mcp-sandbox {
  # File access
  /app/** r,
  /tmp/** rw,
  deny /etc/** w,
  deny /proc/sys/** w,
  
  # Network
  network inet stream,
  deny network raw,
  
  # Capabilities
  deny capability sys_admin,
  deny capability sys_ptrace,
}
```

#### Implementation Steps
1. Create Docker/Podman integration for containers
2. Implement Wasmtime/Wasmer for WASM execution
3. Add network policies with iptables/nftables
4. Implement filesystem quotas and monitoring
5. Create security profiles (seccomp, AppArmor)
6. Add resource monitoring and enforcement
7. Implement audit trail for all operations

#### Acceptance Criteria
- [ ] No sandbox escapes in security testing
- [ ] Resource limits enforced (OOM killer works)
- [ ] Network isolation verified with packet capture
- [ ] Filesystem access limited to approved paths
- [ ] Audit logs capture all security-relevant events

### Task 4.2.4: Add Approval Workflows
**Priority**: P1  
**Duration**: 4 days  
**Owner**: Platform Team

#### Requirements
- GUI approval modal for dangerous operations
- Batch approvals for efficiency
- Approval persistence and audit trail
- Timeout and auto-deny options

#### Implementation
```typescript
// services/orchestrator/src/approvals/manager.ts
export class ApprovalManager {
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    // Create approval record
    // Send SSE to GUI
    // Wait for response with timeout
    // Log decision with justification
  }
  
  async batchApprove(pattern: ApprovalPattern): Promise<void> {
    // Store pattern for future matching
    // Apply to pending requests
  }
}

// apps/gui/src/lib/components/ApprovalModal.svelte
<script lang="ts">
  export let request: ApprovalRequest;
  export let onApprove: (justification?: string) => void;
  export let onDeny: (reason: string) => void;
  
  let showDetails = false;
  let justification = '';
  
  function handleApprove() {
    onApprove(justification);
    auditLog('approval_granted', { request, justification });
  }
</script>
```

#### Acceptance Criteria
- [ ] Approvals required for WRITE/EXECUTE/NETWORK/PRIVILEGED
- [ ] Batch approvals reduce modal fatigue
- [ ] Audit trail includes who/what/when/why
- [ ] Timeout auto-denies with logged reason

---

## Epic 4.3: Multi-Agent Orchestration
**Duration**: 2 weeks  
**Team**: Core Platform Team  
**Dependencies**: Indexer gRPC API, MCP Tools

### Task 4.3.1: Design Agent Execution Graph
**Priority**: P0  
**Duration**: 3 days  
**Owner**: Architecture Team

#### Requirements
- DAG-based execution model
- Support sequential, parallel, and conditional flows
- Agent communication via shared context
- Rollback and compensation support

#### Graph Model
```typescript
// services/orchestrator/src/agents/graph.ts
export interface AgentGraph {
  nodes: Map<string, AgentNode>;
  edges: AgentEdge[];
  context: SharedContext;
}

export interface AgentNode {
  id: string;
  agent: Agent;
  dependencies: string[];
  condition?: (context: SharedContext) => boolean;
  maxRetries: number;
  timeout: number;
}

export interface AgentEdge {
  from: string;
  to: string;
  type: 'sequential' | 'parallel' | 'conditional';
  condition?: (result: AgentResult) => boolean;
}

export class GraphExecutor {
  async execute(graph: AgentGraph): Promise<GraphResult> {
    // Topological sort
    // Execute in waves (parallelism)
    // Handle failures and retries
    // Collect results
  }
}
```

#### Standard Pipelines
```typescript
// Refactoring Pipeline
const refactorPipeline = {
  nodes: [
    { id: 'plan', agent: plannerAgent },
    { id: 'analyze', agent: codeAnalyzer, dependencies: ['plan'] },
    { id: 'write', agent: codeWriter, dependencies: ['analyze'] },
    { id: 'test', agent: testRunner, dependencies: ['write'] },
    { id: 'audit', agent: securityAuditor, dependencies: ['write'] },
    { id: 'review', agent: codeReviewer, dependencies: ['test', 'audit'] }
  ]
};

// Bug Fix Pipeline
const bugFixPipeline = {
  nodes: [
    { id: 'reproduce', agent: bugReproducer },
    { id: 'diagnose', agent: debugger, dependencies: ['reproduce'] },
    { id: 'fix', agent: codeWriter, dependencies: ['diagnose'] },
    { id: 'verify', agent: testRunner, dependencies: ['fix'] }
  ]
};
```

#### Acceptance Criteria
- [ ] Graph execution handles cycles correctly (fails fast)
- [ ] Parallel execution improves throughput > 2x
- [ ] Failed nodes can be retried without full restart
- [ ] Context sharing works across agent boundaries

### Task 4.3.2: Implement Agent Communication
**Priority**: P1  
**Duration**: 4 days  
**Owner**: Platform Team

#### Requirements
- Shared context with versioning
- Message passing between agents
- Event streaming for monitoring
- Result aggregation and conflict resolution

#### Implementation
```typescript
// services/orchestrator/src/agents/context.ts
export class SharedContext {
  private state: Map<string, ContextValue>;
  private history: ContextVersion[];
  private locks: Map<string, string>; // key -> agentId
  
  async read(key: string): Promise<unknown> {
    // Return latest value
    // Track access for lineage
  }
  
  async write(key: string, value: unknown, agentId: string): Promise<void> {
    // Acquire lock
    // Validate schema
    // Update with version
    // Emit change event
  }
  
  async transaction(fn: (ctx: TransactionContext) => Promise<void>): Promise<void> {
    // ACID guarantees
    // Rollback on failure
  }
}

// services/orchestrator/src/agents/messaging.ts
export class AgentMessageBus {
  async send(from: string, to: string, message: AgentMessage): Promise<void>;
  async broadcast(from: string, message: AgentMessage): Promise<void>;
  subscribe(agentId: string, handler: MessageHandler): Subscription;
}
```

#### Acceptance Criteria
- [ ] Context updates are atomic and consistent
- [ ] Message delivery is guaranteed (at-least-once)
- [ ] Race conditions prevented by locking
- [ ] Full audit trail of context mutations

### Task 4.3.3: Implement Standard Agent Pipelines
**Priority**: P1  
**Duration**: 5 days  
**Owner**: AI Team

#### Requirements
- Planner → Writer → Tester → Auditor pipeline
- Support for different strategies per language
- Incremental execution with checkpoints
- Result quality validation

#### Pipeline Implementations

##### 1. Full Development Pipeline
```typescript
export class DevelopmentPipeline {
  async execute(request: DevelopmentRequest): Promise<DevelopmentResult> {
    // Step 1: Planning
    const plan = await plannerAgent.createPlan(request);
    
    // Step 2: Parallel analysis
    const [codeAnalysis, testAnalysis] = await Promise.all([
      codeAnalyzer.analyze(plan),
      testAnalyzer.analyzeRequirements(plan)
    ]);
    
    // Step 3: Implementation
    const implementation = await codeWriter.implement(plan, codeAnalysis);
    
    // Step 4: Parallel validation
    const [tests, audit, review] = await Promise.all([
      testRunner.run(implementation),
      securityAuditor.audit(implementation),
      codeReviewer.review(implementation)
    ]);
    
    // Step 5: Integration
    if (tests.passed && audit.passed) {
      return integrator.integrate(implementation, tests, audit);
    } else {
      return fixer.fix(implementation, tests, audit);
    }
  }
}
```

##### 2. Quick Fix Pipeline
```typescript
export class QuickFixPipeline {
  async execute(issue: Issue): Promise<Fix> {
    const diagnosis = await debugger.diagnose(issue);
    const fix = await codeWriter.writeFix(diagnosis);
    const validation = await testRunner.validate(fix);
    return validation.passed ? fix : await this.retry(issue, validation);
  }
}
```

##### 3. Refactoring Pipeline
```typescript
export class RefactoringPipeline {
  async execute(request: RefactorRequest): Promise<RefactorResult> {
    // Analyze impact
    const impact = await impactAnalyzer.analyze(request);
    
    // Create refactoring plan
    const plan = await refactorPlanner.plan(request, impact);
    
    // Execute in phases
    for (const phase of plan.phases) {
      const result = await codeWriter.refactor(phase);
      const tests = await testRunner.regression(result);
      
      if (!tests.passed) {
        await this.rollback(phase);
        throw new RefactorError('Tests failed', tests);
      }
    }
    
    return consolidator.consolidate(plan);
  }
}
```

#### Acceptance Criteria
- [ ] Pipelines complete end-to-end for common scenarios
- [ ] Checkpoint/resume works for long operations
- [ ] Quality gates prevent bad code from proceeding
- [ ] Metrics show success rate > 80%

### Task 4.3.4: Add Orchestration Monitoring
**Priority**: P2  
**Duration**: 3 days  
**Owner**: Platform Team

#### Requirements
- Real-time pipeline visualization
- Agent performance metrics
- Bottleneck identification
- Cost tracking per pipeline

#### Implementation
```typescript
// services/orchestrator/src/monitoring/pipeline.ts
export class PipelineMonitor {
  async trackExecution(pipelineId: string, metrics: PipelineMetrics): Promise<void> {
    // Record start/end times
    // Track token usage per agent
    // Monitor queue depths
    // Calculate critical path
  }
  
  async generateReport(pipelineId: string): Promise<PipelineReport> {
    return {
      duration: this.calculateDuration(pipelineId),
      tokenCost: this.calculateCost(pipelineId),
      bottlenecks: this.identifyBottlenecks(pipelineId),
      suggestions: this.generateOptimizations(pipelineId)
    };
  }
}
```

#### Acceptance Criteria
- [ ] GUI shows live pipeline progress
- [ ] Metrics identify slow agents
- [ ] Cost tracking accurate within 5%
- [ ] Alerts fire on pipeline failures

---

## Testing Strategy

### Unit Testing
- Minimum 80% coverage for new code
- Mock external dependencies
- Test error paths explicitly
- Property-based testing for parsers

### Integration Testing
```typescript
// Test indexer integration
describe('Indexer Integration', () => {
  test('end-to-end indexing', async () => {
    // Index repository
    // Query symbols
    // Search semantically
    // Verify results
  });
});

// Test tool sandboxing
describe('Sandbox Security', () => {
  test('prevents filesystem escape', async () => {
    // Attempt to read /etc/passwd
    // Verify blocked
  });
  
  test('enforces network policy', async () => {
    // Attempt unauthorized connection
    // Verify blocked
  });
});

// Test multi-agent pipeline
describe('Multi-Agent Pipeline', () => {
  test('refactoring pipeline', async () => {
    // Submit refactor request
    // Verify all agents execute
    // Check final result
  });
});
```

### Security Testing
- Penetration testing of sandbox
- Fuzzing tool inputs
- Capability bypass attempts
- Resource exhaustion tests

### Performance Testing
```yaml
# k6 load test
import http from 'k6/http';
import { check } from 'k6';

export let options = {
  stages: [
    { duration: '2m', target: 100 }, // Ramp up
    { duration: '5m', target: 100 }, // Stay at 100
    { duration: '2m', target: 0 },   // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% under 500ms
    http_req_failed: ['rate<0.01'],   // Error rate < 1%
  },
};

export default function() {
  let response = http.post('/api/search', {
    query: 'function authenticate',
    top_k: 10
  });
  
  check(response, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });
}
```

---

## Rollout Plan

### Week 1-3: Foundation
- [ ] Real embeddings in indexer
- [ ] gRPC API implementation
- [ ] Persistence layer
- [ ] Basic MCP tool framework

### Week 4-6: Security & Tools
- [ ] Container sandboxing
- [ ] Core MCP tools (repo, test, browser)
- [ ] Approval workflows
- [ ] Temporal indexing

### Week 7-8: Multi-Agent
- [ ] Graph executor
- [ ] Agent communication
- [ ] Standard pipelines
- [ ] Monitoring dashboard

### Week 9-10: Hardening
- [ ] Security testing
- [ ] Performance optimization
- [ ] Documentation
- [ ] Bug fixes

---

## Risk Mitigation

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Sandbox escape vulnerability | Medium | Critical | Multiple isolation layers, security audits, bug bounty |
| Embedding API latency | High | Medium | Local cache, batch operations, fallback to keyword search |
| Graph execution deadlock | Low | High | Timeout enforcement, cycle detection, manual override |
| Context conflicts between agents | Medium | Medium | Versioning, locking, conflict resolution protocols |
| Memory exhaustion from large repos | Medium | High | Streaming processing, pagination, resource quotas |

### Operational Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Docker daemon unavailable | Low | High | Fallback to WASM, health checks, auto-restart |
| Git operations timeout | Medium | Low | Aggressive timeouts, shallow clones, caching |
| Network partition during pipeline | Low | Medium | Checkpoint/resume, idempotent operations |

---

## Dependencies

### External Dependencies
- Docker/Podman for container sandboxing
- Git for repository operations
- ONNX Runtime or Candle for embeddings
- FAISS for vector search
- PostgreSQL for enterprise persistence

### Internal Dependencies
- Orchestrator provider framework (Phase 1)
- Queue infrastructure (Phase 2)
- Authentication/authorization (Phase 3)

---

## Success Metrics

### Functional Metrics
- [ ] 100% of security tests pass
- [ ] All sandbox escape attempts blocked
- [ ] Multi-agent pipelines complete successfully
- [ ] Context queries return accurate results

### Performance Metrics
- [ ] Semantic search < 500ms p95
- [ ] Symbol lookup < 50ms p95
- [ ] Pipeline execution < 10 minutes for typical tasks
- [ ] Embedding cache hit rate > 60%

### Quality Metrics
- [ ] Test coverage > 80%
- [ ] Zero critical security vulnerabilities
- [ ] Documentation complete for all APIs
- [ ] All audit events properly logged

---

## Documentation Requirements

### API Documentation
- OpenAPI spec for HTTP endpoints
- gRPC proto documentation
- MCP tool development guide
- Agent development guide

### Operational Documentation
- Sandbox security guide
- Pipeline monitoring guide
- Troubleshooting runbook
- Performance tuning guide

### User Documentation
- Multi-agent workflow examples
- Tool approval best practices
- Context query examples
- Integration tutorials

---

## Appendix A: Technical Specifications

### Embedding Dimensions
```yaml
models:
  text-embedding-3-small: 384
  text-embedding-3-large: 1536
  text-embedding-ada-002: 1536
  e5-large-v2: 1024
  all-MiniLM-L6-v2: 384
```

### Sandbox Resource Limits
```yaml
container:
  cpu: 2.0
  memory: 2Gi
  disk: 10Gi
  network_bandwidth: 10Mbps
  max_processes: 100
  max_open_files: 1000

wasm:
  memory: 256Mi
  stack_size: 1Mi
  fuel: 1000000000  # ~1 second of compute
```

### Pipeline Timeout Defaults
```yaml
agents:
  planner: 60s
  code_writer: 300s
  test_runner: 600s
  security_auditor: 120s
  code_reviewer: 180s

pipeline:
  total: 1800s  # 30 minutes
  checkpoint_interval: 300s
```

---

## Appendix B: Security Checklist

### Pre-deployment
- [ ] All sandbox tests pass
- [ ] Security scan clean (Trivy, Semgrep)
- [ ] Penetration test conducted
- [ ] Threat model updated
- [ ] Security review completed

### Runtime
- [ ] Audit logging enabled
- [ ] Resource monitoring active
- [ ] Network policies enforced
- [ ] File integrity monitoring
- [ ] Intrusion detection active

### Post-incident
- [ ] Incident response plan tested
- [ ] Rollback procedure verified
- [ ] Forensics data available
- [ ] Lessons learned documented

---

_End of Phase 4 Implementation Plan_