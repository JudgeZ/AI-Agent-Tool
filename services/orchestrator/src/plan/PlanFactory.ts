import crypto from "node:crypto";
import {
  ExecutionGraph,
  type GraphDefinition,
  type NodeDefinition,
  type NodeHandler,
  type ExecutionContext,
  NodeType,
} from "../agents/ExecutionGraph.js";
import { appLogger } from "../observability/logger.js";
import { startSpan } from "../observability/tracing.js";
import { publishPlanStepEvent } from "./events.js";
import {
  type PlanDefinition,
  type PlanStepDefinition,
  type WorkflowType,
  DEFAULT_CAPABILITY_LABELS,
} from "./PlanDefinition.js";
import { type IPlanDefinitionRepository } from "./PlanDefinitionRepository.js";

/**
 * Options for plan creation.
 */
export interface CreatePlanOptions {
  /** The user's goal or objective */
  goal: string;
  /** Optional workflow type to constrain plan selection */
  workflowType?: WorkflowType;
  /** Optional specific plan ID to use (bypasses automatic selection) */
  planId?: string;
  /** Additional variables to pass to the plan */
  variables?: Record<string, unknown>;
  /** Subject information (tenant, user, etc.) */
  subject?: {
    tenantId?: string;
    userId?: string;
    sessionId?: string;
  };
  /** Concurrency limit for parallel execution */
  concurrencyLimit?: number;
}

/**
 * Result of plan creation.
 */
export interface CreatedPlan {
  /** Unique execution ID for this plan instance */
  executionId: string;
  /** The plan definition that was selected/used */
  definition: PlanDefinition;
  /** The execution graph ready to run */
  graph: ExecutionGraph;
  /** The goal that was provided */
  goal: string;
  /** Merged variables (plan defaults + provided variables) */
  variables: Record<string, unknown>;
}

/**
 * Factory for creating executable plans from plan definitions.
 * Bridges the dynamic plan definitions with the ExecutionGraph runtime.
 */
export class PlanFactory {
  private readonly repository: IPlanDefinitionRepository;
  private readonly nodeHandlers: Map<NodeType, NodeHandler>;

  constructor(
    repository: IPlanDefinitionRepository,
    nodeHandlers?: Map<NodeType, NodeHandler>
  ) {
    this.repository = repository;
    this.nodeHandlers = nodeHandlers ?? new Map();

    // Register default handlers if none provided
    if (!nodeHandlers || nodeHandlers.size === 0) {
      this.registerDefaultHandlers();
    }
  }

  /**
   * Register a handler for a specific node type.
   */
  registerHandler(type: NodeType, handler: NodeHandler): void {
    this.nodeHandlers.set(type, handler);
  }

  /**
   * Create an executable plan from a goal and optional constraints.
   * @param options - Plan creation options
   * @returns Created plan ready for execution
   * @throws Error if no matching plan is found
   */
  async createPlan(options: CreatePlanOptions): Promise<CreatedPlan> {
    const span = startSpan("PlanFactory.createPlan", {
      goal: options.goal,
      workflowType: options.workflowType,
      planId: options.planId,
    });

    try {
      // Find or get the plan definition
      let definition: PlanDefinition | undefined;

      if (options.planId) {
        // Use specific plan ID
        definition = await this.repository.getPlan(options.planId);
        if (!definition) {
          throw new Error(`Plan not found: ${options.planId}`);
        }
      } else {
        // Find matching plans
        const matches = await this.repository.findMatchingPlans(
          options.goal,
          options.workflowType
        );

        if (matches.length === 0) {
          // Fallback: get any enabled plan for the workflow type
          if (options.workflowType) {
            const workflowPlans = await this.repository.getPlansByWorkflowType(
              options.workflowType
            );
            const enabled = workflowPlans.filter((p) => p.enabled);
            if (enabled.length > 0) {
              definition = enabled[0];
            }
          }

          if (!definition) {
            throw new Error(
              `No matching plan found for goal: ${options.goal.substring(0, 100)}...`
            );
          }
        } else {
          definition = matches[0]; // Best match
        }
      }

      span.setAttribute("plan.id", definition.id);
      span.setAttribute("plan.name", definition.name);
      span.setAttribute("plan.workflowType", definition.workflowType);

      // Generate execution ID
      const executionId = `exec-${crypto.randomUUID()}`;
      span.setAttribute("plan.executionId", executionId);

      // Merge variables
      const variables: Record<string, unknown> = {
        ...definition.variables,
        ...options.variables,
        goal: options.goal,
        planId: definition.id,
        executionId,
        tenantId: options.subject?.tenantId,
        userId: options.subject?.userId,
        sessionId: options.subject?.sessionId,
      };

      // Convert plan definition to graph definition
      const graphDefinition = this.buildGraphDefinition(
        definition,
        executionId,
        variables
      );

      // Create execution graph
      const graph = new ExecutionGraph(
        graphDefinition,
        options.concurrencyLimit ?? 10
      );

      // Register handlers
      for (const [type, handler] of this.nodeHandlers) {
        graph.registerHandler(type, handler);
      }

      // Set up event listeners for plan step events
      this.setupEventListeners(graph, definition, executionId, span.context.traceId);

      appLogger.info(
        {
          planId: definition.id,
          executionId,
          goal: options.goal.substring(0, 100),
          stepCount: definition.steps.length,
          event: "plan_factory.plan_created",
        },
        "Plan created successfully"
      );

      return {
        executionId,
        definition,
        graph,
        goal: options.goal,
        variables,
      };
    } finally {
      span.end();
    }
  }

  /**
   * Create a plan from a specific plan ID without goal matching.
   */
  async createPlanById(
    planId: string,
    options?: Omit<CreatePlanOptions, "planId" | "goal">
  ): Promise<CreatedPlan> {
    const definition = await this.repository.getPlan(planId);
    if (!definition) {
      throw new Error(`Plan not found: ${planId}`);
    }

    // Safely extract goal from variables, falling back to plan name
    const goalFromVars = options?.variables?.goal;
    const goal = typeof goalFromVars === "string" ? goalFromVars : definition.name;

    return this.createPlan({
      ...options,
      goal,
      planId,
    });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private buildGraphDefinition(
    plan: PlanDefinition,
    executionId: string,
    variables: Record<string, unknown>
  ): GraphDefinition {
    const nodes: NodeDefinition[] = plan.steps.map((step) =>
      this.stepToNode(step, variables)
    );

    return {
      id: `${plan.id}-${executionId}`,
      name: plan.name,
      description: plan.description,
      nodes,
      entryNodes: plan.entrySteps ?? nodes.filter((n) => n.dependencies.length === 0).map((n) => n.id),
      variables,
    };
  }

  private stepToNode(
    step: PlanStepDefinition,
    variables: Record<string, unknown>
  ): NodeDefinition {
    // Substitute variables in input
    const input = this.substituteVariables(step.input, variables);

    return {
      id: step.id,
      type: step.nodeType,
      name: step.action,
      description: step.description,
      dependencies: step.dependencies,
      config: {
        tool: step.tool,
        capability: step.capability,
        capabilityLabel:
          step.capabilityLabel ?? DEFAULT_CAPABILITY_LABELS[step.capability],
        labels: step.labels,
        approvalRequired: step.approvalRequired,
        input,
        metadata: step.metadata ?? {},
        transitions: step.transitions ?? [],
      },
      retryPolicy: step.retryPolicy
        ? {
            maxRetries: step.retryPolicy.maxRetries,
            backoffMs: step.retryPolicy.backoffMs,
            exponential: step.retryPolicy.exponential,
          }
        : undefined,
      timeout: step.timeoutSeconds * 1000, // Convert to ms
      continueOnError: step.continueOnError,
    };
  }

  private substituteVariables(
    input: Record<string, unknown>,
    variables: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "string") {
        result[key] = this.substituteString(value, variables);
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) => {
          if (typeof item === "string") {
            return this.substituteString(item, variables);
          } else if (item && typeof item === "object") {
            return this.substituteVariables(
              item as Record<string, unknown>,
              variables
            );
          }
          return item;
        });
      } else if (value && typeof value === "object") {
        result[key] = this.substituteVariables(
          value as Record<string, unknown>,
          variables
        );
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  private substituteString(
    template: string,
    variables: Record<string, unknown>
  ): string {
    // Match ${varName} where varName can contain word chars, dots, and hyphens
    // This supports step output references like ${index-repo.output}
    return template.replace(/\$\{([\w.-]+)\}/g, (match, varName) => {
      // Prevent prototype pollution
      if (
        varName === "__proto__" ||
        varName === "constructor" ||
        varName === "prototype"
      ) {
        return match;
      }

      const value = variables[varName];
      if (value === undefined || value === null) {
        return match; // Keep original if variable not found
      }

      return String(value);
    });
  }

  private setupEventListeners(
    graph: ExecutionGraph,
    plan: PlanDefinition,
    executionId: string,
    traceId: string
  ): void {
    // Map step IDs to step definitions for easy lookup
    const stepMap = new Map(plan.steps.map((s) => [s.id, s]));

    graph.on("node:started", ({ nodeId }) => {
      const step = stepMap.get(nodeId);
      if (step) {
        publishPlanStepEvent({
          event: "plan.step",
          traceId,
          planId: plan.id,
          step: {
            id: step.id,
            action: step.action,
            tool: step.tool,
            state: "running",
            capability: step.capability,
            capabilityLabel:
              step.capabilityLabel ?? DEFAULT_CAPABILITY_LABELS[step.capability],
            labels: step.labels,
            timeoutSeconds: step.timeoutSeconds,
            approvalRequired: step.approvalRequired,
            summary: `Executing ${step.action}`,
          },
        });
      }
    });

    graph.on("node:completed", ({ nodeId, output }) => {
      const step = stepMap.get(nodeId);
      if (step) {
        publishPlanStepEvent({
          event: "plan.step",
          traceId,
          planId: plan.id,
          step: {
            id: step.id,
            action: step.action,
            tool: step.tool,
            state: "completed",
            capability: step.capability,
            capabilityLabel:
              step.capabilityLabel ?? DEFAULT_CAPABILITY_LABELS[step.capability],
            labels: step.labels,
            timeoutSeconds: step.timeoutSeconds,
            approvalRequired: step.approvalRequired,
            summary: `Completed ${step.action}`,
            output,
          },
        });
      }
    });

    graph.on("node:failed", ({ nodeId, error }) => {
      const step = stepMap.get(nodeId);
      if (step) {
        publishPlanStepEvent({
          event: "plan.step",
          traceId,
          planId: plan.id,
          step: {
            id: step.id,
            action: step.action,
            tool: step.tool,
            state: "failed",
            capability: step.capability,
            capabilityLabel:
              step.capabilityLabel ?? DEFAULT_CAPABILITY_LABELS[step.capability],
            labels: step.labels,
            timeoutSeconds: step.timeoutSeconds,
            approvalRequired: step.approvalRequired,
            summary: `Failed: ${error}`,
            error,
          },
        });
      }
    });

    graph.on("node:blocked", ({ nodeId, blockedBy }) => {
      const step = stepMap.get(nodeId);
      if (step) {
        publishPlanStepEvent({
          event: "plan.step",
          traceId,
          planId: plan.id,
          step: {
            id: step.id,
            action: step.action,
            tool: step.tool,
            state: "blocked",
            capability: step.capability,
            capabilityLabel:
              step.capabilityLabel ?? DEFAULT_CAPABILITY_LABELS[step.capability],
            labels: step.labels,
            timeoutSeconds: step.timeoutSeconds,
            approvalRequired: step.approvalRequired,
            summary: `Blocked by ${blockedBy}`,
          },
        });
      }
    });

    graph.on("node:retry", ({ nodeId, attempt, nextAttemptIn, error }) => {
      const step = stepMap.get(nodeId);
      if (step) {
        publishPlanStepEvent({
          event: "plan.step",
          traceId,
          planId: plan.id,
          step: {
            id: step.id,
            action: step.action,
            tool: step.tool,
            state: "retrying",
            capability: step.capability,
            capabilityLabel:
              step.capabilityLabel ?? DEFAULT_CAPABILITY_LABELS[step.capability],
            labels: step.labels,
            timeoutSeconds: step.timeoutSeconds,
            approvalRequired: step.approvalRequired,
            summary: `Retrying (attempt ${attempt}, next in ${nextAttemptIn}ms): ${error}`,
          },
        });
      }
    });
  }

  private registerDefaultHandlers(): void {
    // Default TASK handler that logs execution
    const taskHandler: NodeHandler = {
      async execute(node, context): Promise<unknown> {
        appLogger.info(
          {
            nodeId: node.id,
            tool: node.config.tool,
            executionId: context.executionId,
            event: "plan_factory.task_executing",
          },
          `Executing task: ${node.name}`
        );

        // Default implementation just returns the input
        // Real handlers should be registered by the application
        return {
          nodeId: node.id,
          executed: true,
          input: node.config.input,
        };
      },
    };

    // Default CONDITION handler
    const conditionHandler: NodeHandler = {
      async execute(node, context): Promise<unknown> {
        const condition = node.config.condition as string | undefined;
        if (!condition) {
          return { result: true };
        }

        // Simple expression evaluation (extend as needed)
        const variables = Object.fromEntries(context.variables);
        const result = condition === "true" || variables[condition] === true;

        return { result };
      },
    };

    // Default PARALLEL handler (just marks as complete)
    const parallelHandler: NodeHandler = {
      async execute(): Promise<unknown> {
        return { type: "parallel", executed: true };
      },
    };

    // Default MERGE handler (just marks as complete)
    const mergeHandler: NodeHandler = {
      async execute(node, context): Promise<unknown> {
        // Collect outputs from dependencies
        const outputs: Record<string, unknown> = {};
        for (const depId of node.dependencies) {
          const output = context.outputs.get(depId);
          if (output !== undefined) {
            outputs[depId] = output;
          }
        }
        return { type: "merge", merged: outputs };
      },
    };

    // Default LOOP handler
    const loopHandler: NodeHandler = {
      async execute(node, context): Promise<unknown> {
        const iterations = (node.config.iterations as number) ?? 1;
        return { type: "loop", iterations, completed: true };
      },
    };

    this.nodeHandlers.set(NodeType.TASK, taskHandler);
    this.nodeHandlers.set(NodeType.CONDITION, conditionHandler);
    this.nodeHandlers.set(NodeType.PARALLEL, parallelHandler);
    this.nodeHandlers.set(NodeType.MERGE, mergeHandler);
    this.nodeHandlers.set(NodeType.LOOP, loopHandler);
  }
}

/**
 * Configuration mode for the planner.
 */
export type PlannerMode = "static" | "dynamic" | "hybrid";

/**
 * Configuration for the dynamic planner integration.
 */
export interface DynamicPlannerConfig {
  /** Planner mode: static (legacy), dynamic (new), or hybrid (fallback) */
  mode: PlannerMode;
  /** Directory containing plan definition YAML files */
  plansDirectory: string;
  /** Whether to watch for plan file changes */
  watchForChanges?: boolean;
  /** Default concurrency limit for plan execution */
  defaultConcurrencyLimit?: number;
}
