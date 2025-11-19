import { Logger } from "pino";
import { EventEmitter } from "events";
import { SandboxType, SandboxCapabilities } from "../sandbox";

/**
 * Tool capability flags
 * Used for security checks and approval workflows
 */
export enum ToolCapability {
  /** Read files from filesystem */
  READ_FILES = "read_files",

  /** Write files to filesystem */
  WRITE_FILES = "write_files",

  /** Execute shell commands */
  EXECUTE_COMMANDS = "execute_commands",

  /** Make network requests */
  NETWORK_ACCESS = "network_access",

  /** Access databases */
  DATABASE_ACCESS = "database_access",

  /** Access browser automation */
  BROWSER_AUTOMATION = "browser_automation",

  /** Git operations */
  GIT_OPERATIONS = "git_operations",

  /** Modify system state */
  SYSTEM_MODIFICATION = "system_modification",

  /** Access credentials/secrets */
  CREDENTIAL_ACCESS = "credential_access",

  /** Long-running operations */
  LONG_RUNNING = "long_running",

  /** Screenshot capability */
  SCREENSHOT = "screenshot",

  /** Isolated execution environment */
  ISOLATED_EXECUTION = "isolated_execution",
}

/**
 * Tool execution context
 * Provides contextual information and services to tools
 */
export interface ToolContext {
  /** Unique request ID for tracing */
  requestId: string;

  /** Tenant ID for multi-tenancy */
  tenantId?: string;

  /** User ID executing the tool */
  userId?: string;

  /** Logger instance */
  logger: Logger;

  /** Working directory */
  workdir: string;

  /** Environment variables */
  env?: Record<string, string>;

  /** Timeout for tool execution (ms) */
  timeout?: number;

  /** Callback for requesting approval */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // justified: Approval details are tool-specific and vary by context
  requestApproval?: (reason: string, details: any) => Promise<boolean>;
}

/**
 * Tool execution result
 */
export interface ToolResult<T = any> {
  /** Whether the tool succeeded */
  success: boolean;

  /** Result data */
  data?: T;

  /** Error message if failed */
  error?: string;

  /** Execution duration in milliseconds */
  duration: number;

  /** Output logs from tool execution */
  logs?: string[];

  /** Metadata about execution */
  metadata?: Record<string, any>;
}

/**
 * Tool input validation schema
 */
export interface ToolSchema {
  /** Schema type (typically 'object') */
  type: string;

  /** Object properties */
  properties?: Record<string, any>;

  /** Required properties */
  required?: string[];

  /** Additional properties allowed */
  additionalProperties?: boolean;
}

/**
 * Tool metadata
 */
export interface ToolMetadata {
  /** Unique tool identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Tool description */
  description: string;

  /** Tool version */
  version: string;

  /** Tool author/maintainer */
  author?: string;

  /** Capabilities required by this tool */
  capabilities: ToolCapability[];

  /** Input schema (JSON Schema) */
  inputSchema: ToolSchema;

  /** Output schema (JSON Schema) */
  outputSchema?: ToolSchema;

  /** Whether tool requires approval before execution */
  requiresApproval: boolean;

  /** Sandbox type required */
  sandboxType: SandboxType;

  /** Sandbox capabilities needed */
  sandboxCapabilities: SandboxCapabilities;

  /** Tags for categorization */
  tags?: string[];
}

/**
 * Base class for MCP tools
 * All tools must extend this class
 */
export abstract class McpTool<
  TInput = any,
  TOutput = any,
> extends EventEmitter {
  protected logger: Logger;
  protected metadata: ToolMetadata;

  constructor(metadata: ToolMetadata, logger: Logger) {
    super();
    this.metadata = metadata;
    this.logger = logger.child({ tool: metadata.id });
  }

  /**
   * Get tool metadata
   */
  getMetadata(): ToolMetadata {
    return this.metadata;
  }

  /**
   * Validate input against schema
   */
  protected async validateInput(input: TInput): Promise<void> {
    // Basic validation - in production, use a proper JSON Schema validator
    const schema = this.metadata.inputSchema;

    if (schema.required) {
      for (const field of schema.required) {
        if (!(input as any)[field]) {
          throw new Error(`Missing required field: ${field}`);
        }
      }
    }

    // Emit validation event
    this.emit("validated", { input });
  }

  /**
   * Check if tool has a specific capability
   */
  hasCapability(capability: ToolCapability): boolean {
    return this.metadata.capabilities.includes(capability);
  }

  /**
   * Execute the tool with the given input
   */
  async execute(
    input: TInput,
    context: ToolContext,
  ): Promise<ToolResult<TOutput>> {
    const startTime = Date.now();

    this.logger.info(
      { requestId: context.requestId, tenantId: context.tenantId, input },
      "Executing tool",
    );

    this.emit("started", { input, context });

    try {
      // Validate input
      await this.validateInput(input);

      // Check if approval is required
      if (this.metadata.requiresApproval && context.requestApproval) {
        const approved = await context.requestApproval(
          `Tool ${this.metadata.name} requires approval`,
          { input, capabilities: this.metadata.capabilities },
        );

        if (!approved) {
          throw new Error("Tool execution denied by user");
        }
      }

      // Execute the tool implementation
      const data = await this.executeImpl(input, context);

      const duration = Date.now() - startTime;

      const result: ToolResult<TOutput> = {
        success: true,
        data,
        duration,
      };

      this.logger.info(
        { requestId: context.requestId, duration },
        "Tool executed successfully",
      );

      this.emit("completed", { result, context });

      return result;
    } catch (error: any) {
      // eslint-disable-line @typescript-eslint/no-explicit-any
      const duration = Date.now() - startTime;

      this.logger.error(
        { error, requestId: context.requestId, duration },
        "Tool execution failed",
      );

      const result: ToolResult<TOutput> = {
        success: false,
        error: error.message,
        duration,
      };

      this.emit("failed", { error, context });

      return result;
    }
  }

  /**
   * Tool-specific implementation
   * Must be implemented by subclasses
   */
  protected abstract executeImpl(
    input: TInput,
    context: ToolContext,
  ): Promise<TOutput>;

  /**
   * Cleanup resources
   * Override if tool needs cleanup
   */
  async cleanup(): Promise<void> {
    // Default: no cleanup needed
  }
}

/**
 * Utility to create a simple tool metadata object
 */
export function createToolMetadata(options: {
  id: string;
  name: string;
  description: string;
  version?: string;
  capabilities: ToolCapability[];
  inputSchema: ToolSchema;
  outputSchema?: ToolSchema;
  requiresApproval?: boolean;
  sandboxType?: SandboxType;
  tags?: string[];
}): ToolMetadata {
  return {
    id: options.id,
    name: options.name,
    description: options.description,
    version: options.version || "1.0.0",
    capabilities: options.capabilities,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    requiresApproval: options.requiresApproval || false,
    sandboxType: options.sandboxType || SandboxType.WASM,
    sandboxCapabilities: {
      maxMemory: 512 * 1024 * 1024, // 512MB default
      maxExecutionTime: 60000, // 1 minute default
    },
    tags: options.tags,
  };
}
