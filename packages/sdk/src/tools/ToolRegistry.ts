/**
 * ToolRegistry - Tool registration and execution
 */

import type { OrchestratorClient } from '../client/OrchestratorClient';
import type {
  ToolDefinition,
  ToolCapability,
  ToolExecutionContext,
  ToolExecutionResult
} from '../types';
import { ToolDefinitionSchema, ValidationError } from '../types';

export type ToolHandler<TInput = any, TOutput = any> = (
  input: TInput,
  context: ToolExecutionContext
) => Promise<TOutput>;

export class ToolRegistry {
  constructor(private client: OrchestratorClient) {}

  /**
   * Register a tool with the orchestrator
   */
  async register<TInput = any, TOutput = any>(
    definition: ToolDefinition,
    handler: ToolHandler<TInput, TOutput>
  ): Promise<{ id: string; registered: boolean }> {
    // Validate definition
    const validated = ToolDefinitionSchema.parse(definition);

    // Register with orchestrator
    const response = await this.client.request<{ id: string }>('POST', '/api/tools', {
      body: validated
    });

    // Store handler locally (for local execution mode)
    // In production, handlers would be deployed separately

    return {
      id: response.id,
      registered: true
    };
  }

  /**
   * List available tools
   */
  async list(options?: {
    capabilities?: ToolCapability[];
    search?: string;
  }): Promise<ToolDefinition[]> {
    return this.client.request<ToolDefinition[]>('GET', '/api/tools', {
      query: options as any
    });
  }

  /**
   * Get a tool by ID
   */
  async get(toolId: string): Promise<ToolDefinition> {
    return this.client.request<ToolDefinition>('GET', `/api/tools/${toolId}`);
  }

  /**
   * Execute a tool
   */
  async execute<TInput = any, TOutput = any>(
    toolId: string,
    input: TInput,
    context?: Partial<ToolExecutionContext>
  ): Promise<ToolExecutionResult<TOutput>> {
    return this.client.request<ToolExecutionResult<TOutput>>('POST', `/api/tools/${toolId}/execute`, {
      body: {
        input,
        context
      }
    });
  }

  /**
   * Unregister a tool
   */
  async unregister(toolId: string): Promise<void> {
    await this.client.request('DELETE', `/api/tools/${toolId}`);
  }

  /**
   * Update tool definition
   */
  async update(toolId: string, definition: Partial<ToolDefinition>): Promise<ToolDefinition> {
    return this.client.request<ToolDefinition>('PATCH', `/api/tools/${toolId}`, {
      body: definition
    });
  }
}

/**
 * Helper function to define a tool
 */
export function defineTool<TInput = any, TOutput = any>(
  definition: Omit<ToolDefinition, 'id'> & { id?: string },
  handler: ToolHandler<TInput, TOutput>
): {
  definition: ToolDefinition;
  handler: ToolHandler<TInput, TOutput>;
} {
  const fullDefinition: ToolDefinition = {
    id: definition.id || `tool-${Date.now()}`,
    ...definition
  };

  return {
    definition: fullDefinition,
    handler
  };
}
