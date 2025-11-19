import { Logger } from 'pino';
import { EventEmitter } from 'events';
import { McpTool, ToolMetadata, ToolCapability } from './McpTool';

/**
 * Tool registration options
 */
export interface ToolRegistrationOptions {
  /** Whether to allow overwriting existing tools */
  allowOverwrite?: boolean;

  /** Whether to enable the tool immediately */
  enabled?: boolean;
}

/**
 * Tool registry entry
 */
interface ToolEntry {
  /** Tool instance */
  tool: McpTool;

  /** Whether tool is enabled */
  enabled: boolean;

  /** Registration timestamp */
  registeredAt: Date;

  /** Usage statistics */
  stats: {
    executions: number;
    failures: number;
    totalDuration: number;
    lastExecuted?: Date;
  };
}

/**
 * Tool registry for managing MCP tools
 *
 * Features:
 * - Tool registration and discovery
 * - Capability-based filtering
 * - Hot-reloading support
 * - Usage statistics
 * - Enable/disable tools
 * - Versioning
 */
export class ToolRegistry extends EventEmitter {
  private tools: Map<string, ToolEntry>;
  private logger: Logger;

  constructor(logger: Logger) {
    super();
    this.tools = new Map();
    this.logger = logger.child({ component: 'ToolRegistry' });
  }

  /**
   * Register a tool
   */
  register(tool: McpTool, options?: ToolRegistrationOptions): void {
    const metadata = tool.getMetadata();
    const opts = { allowOverwrite: false, enabled: true, ...options };

    if (this.tools.has(metadata.id) && !opts.allowOverwrite) {
      throw new Error(`Tool with id '${metadata.id}' already registered`);
    }

    const entry: ToolEntry = {
      tool,
      enabled: opts.enabled,
      registeredAt: new Date(),
      stats: {
        executions: 0,
        failures: 0,
        totalDuration: 0,
      },
    };

    this.tools.set(metadata.id, entry);

    this.logger.info(
      { toolId: metadata.id, toolName: metadata.name, enabled: opts.enabled },
      'Tool registered'
    );

    this.emit('registered', { tool: metadata });

    // Subscribe to tool events for statistics
    tool.on('completed', ({ result }) => {
      this.recordExecution(metadata.id, result.duration, true);
    });

    tool.on('failed', ({ error }) => {
      this.recordExecution(metadata.id, 0, false);
    });
  }

  /**
   * Unregister a tool
   */
  unregister(toolId: string): boolean {
    const entry = this.tools.get(toolId);

    if (!entry) {
      return false;
    }

    // Cleanup the tool
    entry.tool.cleanup().catch((error) => {
      this.logger.error({ error, toolId }, 'Error during tool cleanup');
    });

    this.tools.delete(toolId);

    this.logger.info({ toolId }, 'Tool unregistered');
    this.emit('unregistered', { toolId });

    return true;
  }

  /**
   * Get a tool by ID
   */
  get(toolId: string): McpTool | undefined {
    const entry = this.tools.get(toolId);
    return entry?.enabled ? entry.tool : undefined;
  }

  /**
   * Get tool metadata by ID
   */
  getMetadata(toolId: string): ToolMetadata | undefined {
    const tool = this.get(toolId);
    return tool?.getMetadata();
  }

  /**
   * List all registered tools
   */
  list(options?: { enabledOnly?: boolean }): ToolMetadata[] {
    const enabledOnly = options?.enabledOnly ?? true;
    const tools: ToolMetadata[] = [];

    for (const entry of this.tools.values()) {
      if (!enabledOnly || entry.enabled) {
        tools.push(entry.tool.getMetadata());
      }
    }

    return tools;
  }

  /**
   * Find tools by capability
   */
  findByCapability(capability: ToolCapability): ToolMetadata[] {
    const results: ToolMetadata[] = [];

    for (const entry of this.tools.values()) {
      if (entry.enabled) {
        const metadata = entry.tool.getMetadata();
        if (metadata.capabilities.includes(capability)) {
          results.push(metadata);
        }
      }
    }

    return results;
  }

  /**
   * Find tools by tag
   */
  findByTag(tag: string): ToolMetadata[] {
    const results: ToolMetadata[] = [];

    for (const entry of this.tools.values()) {
      if (entry.enabled) {
        const metadata = entry.tool.getMetadata();
        if (metadata.tags?.includes(tag)) {
          results.push(metadata);
        }
      }
    }

    return results;
  }

  /**
   * Search tools by name or description
   */
  search(query: string): ToolMetadata[] {
    const lowerQuery = query.toLowerCase();
    const results: ToolMetadata[] = [];

    for (const entry of this.tools.values()) {
      if (entry.enabled) {
        const metadata = entry.tool.getMetadata();
        const matchesName = metadata.name.toLowerCase().includes(lowerQuery);
        const matchesDescription = metadata.description.toLowerCase().includes(lowerQuery);

        if (matchesName || matchesDescription) {
          results.push(metadata);
        }
      }
    }

    return results;
  }

  /**
   * Enable a tool
   */
  enable(toolId: string): boolean {
    const entry = this.tools.get(toolId);

    if (!entry) {
      return false;
    }

    entry.enabled = true;
    this.logger.info({ toolId }, 'Tool enabled');
    this.emit('enabled', { toolId });

    return true;
  }

  /**
   * Disable a tool
   */
  disable(toolId: string): boolean {
    const entry = this.tools.get(toolId);

    if (!entry) {
      return false;
    }

    entry.enabled = false;
    this.logger.info({ toolId }, 'Tool disabled');
    this.emit('disabled', { toolId });

    return true;
  }

  /**
   * Check if a tool is enabled
   */
  isEnabled(toolId: string): boolean {
    const entry = this.tools.get(toolId);
    return entry?.enabled ?? false;
  }

  /**
   * Get tool statistics
   */
  getStats(toolId: string): ToolEntry['stats'] | undefined {
    const entry = this.tools.get(toolId);
    return entry?.stats;
  }

  /**
   * Get all tool statistics
   */
  getAllStats(): Map<string, ToolEntry['stats']> {
    const allStats = new Map<string, ToolEntry['stats']>();

    for (const [id, entry] of this.tools.entries()) {
      allStats.set(id, entry.stats);
    }

    return allStats;
  }

  /**
   * Record tool execution for statistics
   */
  private recordExecution(toolId: string, duration: number, success: boolean): void {
    const entry = this.tools.get(toolId);

    if (!entry) {
      return;
    }

    entry.stats.executions++;
    entry.stats.totalDuration += duration;
    entry.stats.lastExecuted = new Date();

    if (!success) {
      entry.stats.failures++;
    }
  }

  /**
   * Get registry statistics
   */
  getRegistryStats(): {
    totalTools: number;
    enabledTools: number;
    disabledTools: number;
    totalExecutions: number;
    totalFailures: number;
  } {
    let enabledTools = 0;
    let totalExecutions = 0;
    let totalFailures = 0;

    for (const entry of this.tools.values()) {
      if (entry.enabled) {
        enabledTools++;
      }
      totalExecutions += entry.stats.executions;
      totalFailures += entry.stats.failures;
    }

    return {
      totalTools: this.tools.size,
      enabledTools,
      disabledTools: this.tools.size - enabledTools,
      totalExecutions,
      totalFailures,
    };
  }

  /**
   * Clear all tools
   */
  async clear(): Promise<void> {
    const toolIds = Array.from(this.tools.keys());

    for (const toolId of toolIds) {
      this.unregister(toolId);
    }

    this.logger.info('All tools cleared');
    this.emit('cleared');
  }

  /**
   * Hot reload a tool
   */
  async reload(toolId: string, newTool: McpTool): Promise<boolean> {
    const oldEntry = this.tools.get(toolId);

    if (!oldEntry) {
      this.logger.warn({ toolId }, 'Tool not found for reload');
      return false;
    }

    // Cleanup old tool
    await oldEntry.tool.cleanup().catch((error) => {
      this.logger.error({ error, toolId }, 'Error during tool cleanup on reload');
    });

    // Preserve stats
    const stats = oldEntry.stats;

    // Register new tool
    const newEntry: ToolEntry = {
      tool: newTool,
      enabled: oldEntry.enabled,
      registeredAt: new Date(),
      stats,
    };

    this.tools.set(toolId, newEntry);

    this.logger.info({ toolId }, 'Tool reloaded');
    this.emit('reloaded', { toolId });

    // Re-subscribe to events
    newTool.on('completed', ({ result }) => {
      this.recordExecution(toolId, result.duration, true);
    });

    newTool.on('failed', () => {
      this.recordExecution(toolId, 0, false);
    });

    return true;
  }

  /**
   * Validate all tools
   */
  async validate(): Promise<Map<string, string[]>> {
    const errors = new Map<string, string[]>();

    for (const [id, entry] of this.tools.entries()) {
      const metadata = entry.tool.getMetadata();
      const toolErrors: string[] = [];

      // Validate metadata
      if (!metadata.id) {
        toolErrors.push('Missing tool ID');
      }
      if (!metadata.name) {
        toolErrors.push('Missing tool name');
      }
      if (!metadata.inputSchema) {
        toolErrors.push('Missing input schema');
      }
      if (!metadata.capabilities || metadata.capabilities.length === 0) {
        toolErrors.push('No capabilities defined');
      }

      if (toolErrors.length > 0) {
        errors.set(id, toolErrors);
      }
    }

    if (errors.size > 0) {
      this.logger.warn({ errors: Array.from(errors.entries()) }, 'Tool validation found errors');
    }

    return errors;
  }
}
