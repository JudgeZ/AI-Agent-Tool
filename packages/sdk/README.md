# @oss-ai-agent-tool/sdk

Official TypeScript SDK for the OSS AI Agent Tool orchestrator.

## Installation

```bash
npm install @oss-ai-agent-tool/sdk
```

## Quick Start

```typescript
import { createClient, defineTool, ToolCapability } from '@oss-ai-agent-tool/sdk';

// Create a client
const client = createClient({
  endpoint: 'http://localhost:3000',
  apiKey: process.env.API_KEY
});

// Check health
const health = await client.healthCheck();
console.log('Orchestrator status:', health.status);
```

## Usage

### Creating and Executing Plans

```typescript
// Create a plan
const plan = await client.plans.create({
  goal: 'Refactor the authentication module',
  constraints: {
    maxSteps: 10,
    budget: {
      maxCost: 1.0,
      maxTokens: 50000
    }
  },
  approvalMode: 'manual'
});

console.log('Plan created:', plan.id);

// Execute with real-time event streaming
for await (const event of client.plans.execute(plan.id)) {
  console.log(`[${event.type}]`, event.data);
  
  if (event.type === 'approval.required') {
    // Approve step manually
    await client.plans.approveStep(plan.id, event.data.stepId);
  }
}
```

### Registering Custom Tools

```typescript
import { defineTool, ToolCapability } from '@oss-ai-agent-tool/sdk';

// Define a custom tool
const readFileTool = defineTool({
  name: 'Read File',
  description: 'Reads content from a file',
  capabilities: [ToolCapability.READ_FILES],
  inputSchema: {
    path: { type: 'string', description: 'File path to read' }
  },
  outputSchema: {
    content: { type: 'string', description: 'File content' }
  }
}, async (input, context) => {
  const fs = await import('fs/promises');
  const content = await fs.readFile(input.path, 'utf-8');
  
  return { content };
});

// Register with orchestrator
const { id } = await client.tools.register(
  readFileTool.definition,
  readFileTool.handler
);

console.log('Tool registered:', id);
```

### Semantic Search

```typescript
// Search for relevant code
const results = await client.search.semantic(
  'authentication implementation',
  {
    limit: 5,
    filters: {
      language: 'typescript',
      repository: 'my-app'
    }
  }
);

for (const result of results.results) {
  console.log(`[${result.score}] ${result.metadata.file}:${result.metadata.line}`);
  console.log(result.content);
}
```

### Code Search

```typescript
// Search for specific code patterns
const results = await client.search.code(
  'function.*authenticate',
  {
    language: 'typescript',
    limit: 10
  }
);

for (const result of results.results) {
  console.log(`${result.metadata.file}:${result.metadata.line}`);
}
```

## API Reference

### Client

#### `createClient(config: ClientConfig): OrchestratorClient`

Creates a new orchestrator client.

**Parameters:**
- `endpoint` (string): Orchestrator API endpoint
- `apiKey` (optional string): API key for authentication
- `timeout` (optional number): Request timeout in milliseconds (default: 30000)
- `retries` (optional number): Number of retry attempts (default: 3)
- `headers` (optional object): Additional HTTP headers

### Plans

#### `client.plans.create(request: PlanRequest): Promise<Plan>`

Creates a new execution plan.

#### `client.plans.execute(planId: string): AsyncGenerator<Event>`

Executes a plan and streams real-time events.

#### `client.plans.approve(planId: string, comment?: string): Promise<Plan>`

Approves a plan for execution.

#### `client.plans.reject(planId: string, reason: string): Promise<Plan>`

Rejects a plan.

#### `client.plans.list(options?): Promise<{ plans: Plan[]; total: number }>`

Lists plans with optional filtering.

### Tools

#### `client.tools.register(definition: ToolDefinition, handler: ToolHandler): Promise<{ id: string }>`

Registers a new tool with the orchestrator.

#### `client.tools.list(options?): Promise<ToolDefinition[]>`

Lists available tools.

#### `client.tools.execute(toolId: string, input: any, context?: any): Promise<ToolExecutionResult>`

Executes a tool.

### Search

#### `client.search.semantic(query: string, options?): Promise<SearchResponse>`

Performs semantic search.

#### `client.search.code(query: string, options?): Promise<SearchResponse>`

Performs code search with regex patterns.

#### `client.search.fullText(query: string, options?): Promise<SearchResponse>`

Performs full-text search.

## Types

### ToolCapability

```typescript
enum ToolCapability {
  READ_FILES = 'read_files',
  WRITE_FILES = 'write_files',
  EXECUTE_COMMANDS = 'execute_commands',
  NETWORK_ACCESS = 'network_access',
  DATABASE_ACCESS = 'database_access',
  BROWSER_ACCESS = 'browser_access',
  API_CALLS = 'api_calls',
  SEARCH = 'search',
  READ = 'read',
  WRITE = 'write'
}
```

### PlanStatus

```typescript
enum PlanStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXECUTING = 'executing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}
```

### EventType

```typescript
enum EventType {
  PLAN_CREATED = 'plan.created',
  PLAN_APPROVED = 'plan.approved',
  PLAN_EXECUTING = 'plan.executing',
  PLAN_COMPLETED = 'plan.completed',
  PLAN_FAILED = 'plan.failed',
  STEP_STARTED = 'step.started',
  STEP_COMPLETED = 'step.completed',
  TOOL_INVOKED = 'tool.invoked',
  APPROVAL_REQUIRED = 'approval.required'
}
```

## Examples

See the [examples](./examples) directory for complete working examples:

- [custom-tool.ts](./examples/custom-tool.ts) - Creating and registering a custom tool
- [workflow.ts](./examples/workflow.ts) - End-to-end workflow execution
- [search.ts](./examples/search.ts) - Semantic and code search
- [streaming.ts](./examples/streaming.ts) - Real-time event streaming

## Error Handling

The SDK provides typed error classes:

```typescript
import { SDKError, AuthenticationError, ValidationError } from '@oss-ai-agent-tool/sdk';

try {
  await client.plans.create({ goal: 'Invalid plan' });
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('Authentication failed:', error.message);
  } else if (error instanceof ValidationError) {
    console.error('Validation error:', error.details);
  } else if (error instanceof SDKError) {
    console.error('SDK error:', error.code, error.message);
  }
}
```

## TypeScript Support

The SDK is written in TypeScript and provides full type definitions. All types are exported from the main entry point:

```typescript
import type {
  ClientConfig,
  Plan,
  PlanRequest,
  ToolDefinition,
  Event
} from '@oss-ai-agent-tool/sdk';
```

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines.

## License

MIT - See [LICENSE](../../LICENSE) for details.

## Support

- **Documentation:** https://docs.oss-ai-agent-tool.dev
- **Issues:** https://github.com/your-org/oss-ai-agent-tool/issues
- **Discord:** https://discord.gg/oss-ai-agent-tool

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release history.