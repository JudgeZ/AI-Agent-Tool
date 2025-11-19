/**
 * OSS AI Agent Tool TypeScript SDK
 *
 * @example
 * ```typescript
 * import { createClient, defineTool, ToolCapability } from '@oss-ai-agent-tool/sdk';
 *
 * // Create client
 * const client = createClient({
 *   endpoint: 'http://localhost:3000',
 *   apiKey: process.env.API_KEY
 * });
 *
 * // Register a tool
 * const myTool = defineTool({
 *   name: 'My Tool',
 *   description: 'Does something useful',
 *   capabilities: [ToolCapability.READ],
 *   inputSchema: { query: { type: 'string' } },
 *   outputSchema: { result: { type: 'string' } }
 * }, async (input, context) => {
 *   return { result: `Processed: ${input.query}` };
 * });
 *
 * await client.tools.register(myTool.definition, myTool.handler);
 *
 * // Create and execute a plan
 * const plan = await client.plans.create({
 *   goal: 'Analyze the codebase',
 *   approvalMode: 'auto'
 * });
 *
 * for await (const event of client.plans.execute(plan.id)) {
 *   console.log(event.type, event.data);
 * }
 * ```
 */

// Client
export { OrchestratorClient, createClient } from './client/OrchestratorClient';
export { PlanExecutor } from './client/PlanExecutor';
export { SearchClient } from './client/SearchClient';

// Tools
export { ToolRegistry, defineTool } from './tools/ToolRegistry';

// Types
export type {
  ClientConfig,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolHandler,
  Plan,
  PlanRequest,
  PlanStep,
  Event,
  SearchRequest,
  SearchResponse,
  SearchResult
} from './types';

export {
  ToolCapability,
  PlanStatus,
  EventType,
  SearchType,
  SDKError,
  AuthenticationError,
  ValidationError,
  ToolExecutionError
} from './types';
