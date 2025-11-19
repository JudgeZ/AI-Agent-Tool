import { EventEmitter } from "events";
import { z } from "zod";

// ============================================================================
// Node Types and Schemas
// ============================================================================

export enum NodeType {
  TASK = "task",
  CONDITION = "condition",
  PARALLEL = "parallel",
  MERGE = "merge",
  LOOP = "loop",
}

export enum NodeStatus {
  PENDING = "pending",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  SKIPPED = "skipped",
  BLOCKED = "blocked",
}

/**
 * Zod schema for node configuration
 * Allows flexible configuration while ensuring valid JSON-serializable values
 */
export const NodeConfigSchema = z.record(
  z.string(),
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.unknown()),
    z.record(z.string(), z.unknown()),
    z.null(),
  ]),
);

export type NodeConfig = z.infer<typeof NodeConfigSchema>;

export interface NodeDefinition {
  id: string;
  type: NodeType;
  name: string;
  description?: string;
  dependencies: string[]; // Node IDs that must complete before this node
  config: NodeConfig;
  retryPolicy?: {
    maxRetries: number;
    backoffMs: number;
    exponential: boolean;
  };
  timeout?: number;
  continueOnError?: boolean; // If true, failure doesn't block dependents
}

export interface NodeExecution {
  nodeId: string;
  status: NodeStatus;
  startTime?: Date;
  endTime?: Date;
  duration?: number;
  output?: unknown; // Node outputs are intentionally dynamic - structure varies by node type
  error?: {
    message: string;
    stack?: string;
    retryCount: number;
  };
  attempts: number;
}

export interface ExecutionContext {
  graphId: string;
  executionId: string;
  variables: Map<string, unknown>; // Shared execution variables - intentionally dynamic
  outputs: Map<string, unknown>; // Node outputs - intentionally dynamic
  metadata: NodeConfig; // Metadata follows same schema as node config
}

// ============================================================================
// Graph Definition and Validation
// ============================================================================

const NodeDefinitionSchema = z.object({
  id: z.string().min(1),
  type: z.nativeEnum(NodeType),
  name: z.string().min(1),
  description: z.string().optional(),
  dependencies: z.array(z.string()),
  config: NodeConfigSchema,
  retryPolicy: z
    .object({
      maxRetries: z.number().min(0).max(10),
      backoffMs: z.number().min(0),
      exponential: z.boolean(),
    })
    .optional(),
  timeout: z.number().min(1000).max(3600000).optional(),
  continueOnError: z.boolean().optional(),
});

export type ValidatedNodeDefinition = z.infer<typeof NodeDefinitionSchema>;

export interface GraphDefinition {
  id: string;
  name: string;
  description?: string;
  nodes: NodeDefinition[];
  entryNodes: string[]; // Nodes with no dependencies (starting points)
  variables?: NodeConfig; // Initial variables follow same schema as node config
}

// ============================================================================
// Execution Graph Implementation
// ============================================================================

export class ExecutionGraph extends EventEmitter {
  private definition: GraphDefinition;
  private context: ExecutionContext;
  private executions: Map<string, NodeExecution> = new Map();
  private nodeHandlers: Map<NodeType, NodeHandler> = new Map();
  private dependencyMap: Map<string, Set<string>> = new Map(); // nodeId -> dependents
  private running: boolean = false;
  private concurrencyLimit: number;
  private activeExecutions: number = 0;

  constructor(definition: GraphDefinition, concurrencyLimit: number = 10) {
    super();
    this.definition = this.validateGraph(definition);
    this.concurrencyLimit = concurrencyLimit;

    this.context = {
      graphId: definition.id,
      executionId: this.generateExecutionId(),
      variables: new Map(Object.entries(definition.variables || {})),
      outputs: new Map(),
      metadata: {},
    };

    this.buildDependencyMap();
    this.initializeExecutions();
  }

  // ============================================================================
  // Graph Validation
  // ============================================================================

  private validateGraph(definition: GraphDefinition): GraphDefinition {
    if (!definition.nodes || definition.nodes.length === 0) {
      throw new Error("Graph must contain at least one node");
    }

    // Validate each node
    const nodeIds = new Set<string>();
    for (const node of definition.nodes) {
      // Validate schema
      NodeDefinitionSchema.parse(node);

      // Check for duplicate IDs
      if (nodeIds.has(node.id)) {
        throw new Error(`Duplicate node ID: ${node.id}`);
      }
      nodeIds.add(node.id);

      // Validate dependencies exist
      for (const depId of node.dependencies) {
        if (
          !nodeIds.has(depId) &&
          !definition.nodes.some((n) => n.id === depId)
        ) {
          throw new Error(
            `Node ${node.id} depends on non-existent node: ${depId}`,
          );
        }
      }
    }

    // Detect cycles
    this.detectCycles(definition.nodes);

    // Identify entry nodes if not specified
    if (!definition.entryNodes || definition.entryNodes.length === 0) {
      definition.entryNodes = definition.nodes
        .filter((n) => n.dependencies.length === 0)
        .map((n) => n.id);

      if (definition.entryNodes.length === 0) {
        throw new Error(
          "Graph has no entry nodes (all nodes have dependencies - possible cycle)",
        );
      }
    }

    return definition;
  }

  private detectCycles(nodes: NodeDefinition[]): void {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (nodeId: string): boolean => {
      if (!visited.has(nodeId)) {
        visited.add(nodeId);
        recursionStack.add(nodeId);

        const node = nodes.find((n) => n.id === nodeId);
        if (node) {
          for (const depId of node.dependencies) {
            if (!visited.has(depId) && dfs(depId)) {
              return true;
            } else if (recursionStack.has(depId)) {
              throw new Error(
                `Cycle detected involving nodes: ${nodeId} -> ${depId}`,
              );
            }
          }
        }
      }

      recursionStack.delete(nodeId);
      return false;
    };

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        dfs(node.id);
      }
    }
  }

  // ============================================================================
  // Dependency Management
  // ============================================================================

  private buildDependencyMap(): void {
    // Build reverse dependency map (who depends on me?)
    for (const node of this.definition.nodes) {
      for (const depId of node.dependencies) {
        if (!this.dependencyMap.has(depId)) {
          this.dependencyMap.set(depId, new Set());
        }
        this.dependencyMap.get(depId)!.add(node.id);
      }
    }
  }

  private initializeExecutions(): void {
    for (const node of this.definition.nodes) {
      this.executions.set(node.id, {
        nodeId: node.id,
        status: NodeStatus.PENDING,
        attempts: 0,
      });
    }
  }

  // ============================================================================
  // Node Handler Registration
  // ============================================================================

  public registerHandler(type: NodeType, handler: NodeHandler): void {
    this.nodeHandlers.set(type, handler);
    this.emit("handler:registered", { type });
  }

  private getHandler(type: NodeType): NodeHandler {
    const handler = this.nodeHandlers.get(type);
    if (!handler) {
      throw new Error(`No handler registered for node type: ${type}`);
    }
    return handler;
  }

  // ============================================================================
  // Execution Control
  // ============================================================================

  public async execute(): Promise<ExecutionResult> {
    if (this.running) {
      throw new Error("Graph execution already in progress");
    }

    this.running = true;
    const startTime = Date.now();

    this.emit("execution:started", {
      graphId: this.definition.id,
      executionId: this.context.executionId,
      totalNodes: this.definition.nodes.length,
    });

    try {
      // Start with entry nodes
      await this.scheduleNodes(this.definition.entryNodes);

      // Wait for all nodes to complete
      await this.waitForCompletion();

      // Check if any nodes failed (excluding those with continueOnError)
      const failedNodes = Array.from(this.executions.entries())
        .filter(([nodeId, exec]) => {
          if (exec.status !== NodeStatus.FAILED) return false;
          const node = this.definition.nodes.find((n) => n.id === nodeId);
          return !node?.continueOnError; // Only include if continueOnError is false/undefined
        })
        .map(([nodeId, exec]) => ({ nodeId, error: exec.error }));

      if (failedNodes.length > 0) {
        // If only one node failed, use its error message directly
        if (failedNodes.length === 1) {
          const failedNode = failedNodes[0];
          const error = new Error(
            failedNode.error?.message || "Node execution failed",
          );
          (error as any).failedNodes = failedNodes;
          throw error;
        }

        // Multiple nodes failed
        const errorMessage = `Graph execution failed: ${failedNodes.length} node(s) failed`;
        const error = new Error(errorMessage);
        (error as any).failedNodes = failedNodes;
        throw error;
      }

      const duration = Date.now() - startTime;
      const result = this.buildExecutionResult(duration);

      this.emit("execution:completed", result);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const duration = Date.now() - startTime;
      const result = this.buildExecutionResult(duration, err);

      this.emit("execution:failed", result);
      throw err;
    } finally {
      this.running = false;
    }
  }

  public async stop(): Promise<void> {
    this.running = false;
    this.emit("execution:stopped", { executionId: this.context.executionId });
  }

  // ============================================================================
  // Node Scheduling and Execution
  // ============================================================================

  private async scheduleNodes(nodeIds: string[]): Promise<void> {
    for (const nodeId of nodeIds) {
      if (this.canExecute(nodeId)) {
        this.scheduleNode(nodeId);
      }
    }
  }

  private canExecute(nodeId: string): boolean {
    const execution = this.executions.get(nodeId);
    if (!execution || execution.status !== NodeStatus.PENDING) {
      return false;
    }

    const node = this.definition.nodes.find((n) => n.id === nodeId)!;

    // Check if all dependencies are satisfied
    for (const depId of node.dependencies) {
      const depExecution = this.executions.get(depId);
      if (!depExecution) return false;

      // Dependency must be completed or (failed but continueOnError)
      if (depExecution.status === NodeStatus.COMPLETED) {
        continue;
      }

      const depNode = this.definition.nodes.find((n) => n.id === depId);
      if (
        depExecution.status === NodeStatus.FAILED &&
        depNode?.continueOnError
      ) {
        continue;
      }

      return false; // Dependency not satisfied
    }

    return true;
  }

  private async scheduleNode(nodeId: string): Promise<void> {
    // Respect concurrency limit
    while (this.activeExecutions >= this.concurrencyLimit) {
      await this.sleep(100);
    }

    this.activeExecutions++;
    this.executeNode(nodeId).finally(() => {
      this.activeExecutions--;
    });
  }

  private async executeNode(nodeId: string): Promise<void> {
    const node = this.definition.nodes.find((n) => n.id === nodeId)!;
    const execution = this.executions.get(nodeId)!;

    execution.status = NodeStatus.RUNNING;
    execution.startTime = new Date();
    execution.attempts++;

    this.emit("node:started", {
      nodeId,
      executionId: this.context.executionId,
      attempt: execution.attempts,
    });

    try {
      const handler = this.getHandler(node.type);

      // Execute with timeout
      const timeoutMs = node.timeout || 300000; // Default 5 minutes
      const output = await this.executeWithTimeout(
        handler.execute(node, this.context),
        timeoutMs,
        `Node ${nodeId} timed out after ${timeoutMs}ms`,
      );

      execution.status = NodeStatus.COMPLETED;
      execution.endTime = new Date();
      execution.duration =
        execution.endTime.getTime() - execution.startTime.getTime();
      execution.output = output;

      // Store output in context
      this.context.outputs.set(nodeId, output);

      this.emit("node:completed", {
        nodeId,
        executionId: this.context.executionId,
        duration: execution.duration,
        output,
      });

      // Schedule dependent nodes
      const dependents = this.dependencyMap.get(nodeId);
      if (dependents) {
        await this.scheduleNodes(Array.from(dependents));
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      execution.endTime = new Date();
      execution.duration =
        execution.endTime.getTime() - execution.startTime!.getTime();

      // Handle retry logic
      const shouldRetry =
        node.retryPolicy &&
        execution.attempts < node.retryPolicy.maxRetries + 1 &&
        this.running;

      if (shouldRetry) {
        execution.status = NodeStatus.PENDING;

        if (!execution.error) {
          execution.error = {
            message: err.message,
            stack: err.stack,
            retryCount: 0,
          };
        }
        execution.error.retryCount++;

        const backoff = node.retryPolicy!.exponential
          ? node.retryPolicy!.backoffMs *
            Math.pow(2, execution.error.retryCount - 1)
          : node.retryPolicy!.backoffMs;

        this.emit("node:retry", {
          nodeId,
          executionId: this.context.executionId,
          attempt: execution.attempts,
          nextAttemptIn: backoff,
          error: err.message,
        });

        await this.sleep(backoff);
        await this.scheduleNode(nodeId);
      } else {
        execution.status = NodeStatus.FAILED;
        execution.error = {
          message: err.message,
          stack: err.stack,
          retryCount: execution.attempts - 1,
        };

        this.emit("node:failed", {
          nodeId,
          executionId: this.context.executionId,
          error: err.message,
          attempts: execution.attempts,
        });

        // Mark blocked dependents
        if (!node.continueOnError) {
          this.markBlockedDependents(nodeId);
        } else {
          // Schedule dependents even though this node failed
          const dependents = this.dependencyMap.get(nodeId);
          if (dependents) {
            await this.scheduleNodes(Array.from(dependents));
          }
        }
      }
    }
  }

  private markBlockedDependents(nodeId: string): void {
    const visited = new Set<string>();
    const queue = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const dependents = this.dependencyMap.get(current);
      if (dependents) {
        for (const depId of dependents) {
          const execution = this.executions.get(depId);
          if (execution && execution.status === NodeStatus.PENDING) {
            execution.status = NodeStatus.BLOCKED;
            this.emit("node:blocked", {
              nodeId: depId,
              blockedBy: nodeId,
              executionId: this.context.executionId,
            });

            // Recursively mark dependents as blocked
            queue.push(depId);
          }
        }
      }
    }
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  private async executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string,
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(errorMessage)), timeoutMs),
      ),
    ]);
  }

  private async waitForCompletion(): Promise<void> {
    const checkInterval = 100;

    while (this.running) {
      const allDone = Array.from(this.executions.values()).every(
        (exec) =>
          exec.status === NodeStatus.COMPLETED ||
          exec.status === NodeStatus.FAILED ||
          exec.status === NodeStatus.SKIPPED ||
          exec.status === NodeStatus.BLOCKED,
      );

      if (allDone) {
        break;
      }

      await this.sleep(checkInterval);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private generateExecutionId(): string {
    return `exec_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  // ============================================================================
  // Result Building
  // ============================================================================

  private buildExecutionResult(
    duration: number,
    error?: Error,
  ): ExecutionResult {
    const executions = Array.from(this.executions.values());

    return {
      graphId: this.definition.id,
      executionId: this.context.executionId,
      duration,
      totalNodes: this.definition.nodes.length,
      completed: executions.filter((e) => e.status === NodeStatus.COMPLETED)
        .length,
      failed: executions.filter((e) => e.status === NodeStatus.FAILED).length,
      blocked: executions.filter((e) => e.status === NodeStatus.BLOCKED).length,
      skipped: executions.filter((e) => e.status === NodeStatus.SKIPPED).length,
      success:
        !error && executions.every((e) => e.status === NodeStatus.COMPLETED),
      error: error
        ? {
            message: error.message,
            stack: error.stack,
          }
        : undefined,
      nodeExecutions: executions,
      outputs: Object.fromEntries(this.context.outputs),
    };
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  public getExecution(nodeId: string): NodeExecution | undefined {
    return this.executions.get(nodeId);
  }

  public getAllExecutions(): NodeExecution[] {
    return Array.from(this.executions.values());
  }

  public getContext(): ExecutionContext {
    return this.context;
  }

  public getDefinition(): GraphDefinition {
    return this.definition;
  }

  public isRunning(): boolean {
    return this.running;
  }
}

// ============================================================================
// Node Handler Interface
// ============================================================================

export interface NodeHandler {
  execute(node: NodeDefinition, context: ExecutionContext): Promise<unknown>;
}

// ============================================================================
// Execution Result
// ============================================================================

export interface ExecutionResult {
  graphId: string;
  executionId: string;
  duration: number;
  totalNodes: number;
  completed: number;
  failed: number;
  blocked: number;
  skipped: number;
  success: boolean;
  error?: {
    message: string;
    stack?: string;
  };
  nodeExecutions: NodeExecution[];
  outputs: Record<string, unknown>;
}
