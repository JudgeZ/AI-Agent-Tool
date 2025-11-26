import { z } from "zod";
import { NodeType } from "../agents/ExecutionGraph.js";

/**
 * Schema for workflow types supported by the dynamic planner.
 * Each workflow type corresponds to a specific use case:
 * - alerts: Security alert ingestion, enrichment, and remediation
 * - analytics: Data analytics with SQL/database connectivity
 * - automation: SOAR-style automation playbooks
 * - coding: IDE-like coding workflows with indexer integration
 * - chat: Conversational AI workflows
 */
export const WorkflowTypeSchema = z.enum([
  "alerts",
  "analytics",
  "automation",
  "coding",
  "chat",
]);

export type WorkflowType = z.infer<typeof WorkflowTypeSchema>;

/**
 * Schema for step transitions (what happens after a step completes).
 */
export const StepTransitionSchema = z.object({
  /** The ID of the next step to execute */
  nextStepId: z.string().optional(),
  /** Condition that must be true to follow this transition (expression string) */
  condition: z.string().optional(),
  /** If true, this is the default transition when no conditions match */
  isDefault: z.boolean().optional(),
});

export type StepTransition = z.infer<typeof StepTransitionSchema>;

/**
 * Schema for retry policies on individual steps.
 */
export const RetryPolicySchema = z.object({
  /** Maximum number of retry attempts */
  maxRetries: z.number().min(0).max(10).default(3),
  /** Base backoff delay in milliseconds */
  backoffMs: z.number().min(100).max(60000).default(1000),
  /** Whether to use exponential backoff */
  exponential: z.boolean().default(true),
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/**
 * Schema for a single step in a plan definition.
 */
export const PlanStepDefinitionSchema = z.object({
  /** Unique identifier for this step within the plan */
  id: z.string().min(1),
  /** Human-readable action name */
  action: z.string().min(1),
  /** The tool or agent to execute this step */
  tool: z.string().min(1),
  /** Capability required for this step (e.g., "repo.read", "network.egress") */
  capability: z.string().min(1),
  /** Human-readable description of the capability */
  capabilityLabel: z.string().optional(),
  /** Optional labels for categorization */
  labels: z.array(z.string()).default([]),
  /** Timeout in seconds for this step */
  timeoutSeconds: z.number().min(1).max(86400).default(300),
  /** Whether human approval is required before execution */
  approvalRequired: z.boolean().default(false),
  /** Input parameters for this step (can reference variables with ${varName}) */
  input: z.record(z.string(), z.unknown()).default({}),
  /** Optional metadata for the step */
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** IDs of steps that must complete before this step */
  dependencies: z.array(z.string()).default([]),
  /** Transitions to other steps after completion */
  transitions: z.array(StepTransitionSchema).default([]),
  /** Node type for execution graph (defaults to TASK) */
  nodeType: z.nativeEnum(NodeType).default(NodeType.TASK),
  /** Retry policy for this step */
  retryPolicy: RetryPolicySchema.optional(),
  /** If true, failure of this step won't block dependent steps */
  continueOnError: z.boolean().default(false),
  /** Optional description for documentation */
  description: z.string().optional(),
});

export type PlanStepDefinition = z.infer<typeof PlanStepDefinitionSchema>;

/**
 * Schema for input conditions that determine when a plan should be selected.
 */
export const InputConditionSchema = z.object({
  /** Type of condition: pattern match, keyword presence, or custom expression */
  type: z.enum(["pattern", "keywords", "expression"]),
  /** Pattern string (regex for pattern type, keywords for keywords type, expression for expression type) */
  value: z.string(),
  /** Priority when multiple conditions match (higher = more specific) */
  priority: z.number().default(0),
});

export type InputCondition = z.infer<typeof InputConditionSchema>;

/**
 * Schema for a complete plan definition.
 * Plans can be loaded from YAML files and define workflows for the dynamic planner.
 */
export const PlanDefinitionSchema = z.object({
  /** Unique identifier for this plan definition */
  id: z.string().min(1),
  /** Human-readable name */
  name: z.string().min(1),
  /** Optional description */
  description: z.string().optional(),
  /** Version string for tracking changes */
  version: z.string().default("1.0.0"),
  /** Workflow type this plan belongs to */
  workflowType: WorkflowTypeSchema,
  /** Conditions that determine when this plan should be selected */
  inputConditions: z.array(InputConditionSchema).default([]),
  /** Steps in this plan */
  steps: z.array(PlanStepDefinitionSchema).min(1),
  /** IDs of entry steps (steps with no dependencies). Auto-computed if not specified. */
  entrySteps: z.array(z.string()).optional(),
  /** Initial variables available to all steps */
  variables: z.record(z.string(), z.unknown()).default({}),
  /** Success criteria for the plan */
  successCriteria: z.array(z.string()).default([]),
  /** Tags for filtering and organization */
  tags: z.array(z.string()).default([]),
  /** Whether this plan is enabled */
  enabled: z.boolean().default(true),
  /** Optional metadata */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type PlanDefinition = z.infer<typeof PlanDefinitionSchema>;

/**
 * Schema for a collection of plan definitions (e.g., from a YAML file with multiple plans).
 */
export const PlanDefinitionCollectionSchema = z.object({
  /** Schema version for the collection */
  schemaVersion: z.string().default("1.0.0"),
  /** List of plan definitions */
  plans: z.array(PlanDefinitionSchema),
});

export type PlanDefinitionCollection = z.infer<typeof PlanDefinitionCollectionSchema>;

/**
 * Default capability labels for common capabilities.
 */
export const DEFAULT_CAPABILITY_LABELS: Record<string, string> = {
  "repo.read": "Read repository",
  "repo.write": "Apply repository changes",
  "test.run": "Execute tests",
  "github.write": "Open pull request",
  "network.egress": "Call external service",
  "database.read": "Query database",
  "database.write": "Modify database",
  "alert.read": "Read alerts",
  "alert.write": "Update alert status",
  "chat.respond": "Generate response",
  "file.read": "Read files",
  "file.write": "Write files",
};

/**
 * Validates a plan definition and returns a strongly-typed result.
 * @param input - The raw plan definition input
 * @returns Validated PlanDefinition
 * @throws ZodError if validation fails
 */
export function validatePlanDefinition(input: unknown): PlanDefinition {
  const plan = PlanDefinitionSchema.parse(input);

  // Auto-compute entry steps if not specified
  if (!plan.entrySteps || plan.entrySteps.length === 0) {
    plan.entrySteps = plan.steps
      .filter((s) => s.dependencies.length === 0)
      .map((s) => s.id);

    // Validate that entry steps exist
    if (plan.entrySteps.length === 0) {
      throw new Error(
        `Plan "${plan.id}" has no entry steps (all steps have dependencies)`
      );
    }
  }

  // Validate step references
  const stepIds = new Set(plan.steps.map((s) => s.id));
  for (const step of plan.steps) {
    // Validate dependencies reference existing steps
    for (const depId of step.dependencies) {
      if (!stepIds.has(depId)) {
        throw new Error(
          `Step "${step.id}" depends on non-existent step "${depId}"`
        );
      }
    }

    // Validate transitions reference existing steps
    for (const transition of step.transitions) {
      if (transition.nextStepId && !stepIds.has(transition.nextStepId)) {
        throw new Error(
          `Step "${step.id}" has transition to non-existent step "${transition.nextStepId}"`
        );
      }
    }

    // Apply default capability label if not specified
    if (!step.capabilityLabel && DEFAULT_CAPABILITY_LABELS[step.capability]) {
      step.capabilityLabel = DEFAULT_CAPABILITY_LABELS[step.capability];
    }
  }

  // Validate entry steps exist
  if (plan.entrySteps) {
    for (const entryId of plan.entrySteps) {
      if (!stepIds.has(entryId)) {
        throw new Error(
          `Entry step "${entryId}" does not exist in plan "${plan.id}"`
        );
      }
    }
  }

  // Detect cyclic dependencies
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const hasCycle = (stepId: string): boolean => {
    if (recursionStack.has(stepId)) {
      return true; // Cycle detected
    }
    if (visited.has(stepId)) {
      return false; // Already processed, no cycle from this node
    }

    visited.add(stepId);
    recursionStack.add(stepId);

    const step = plan.steps.find((s) => s.id === stepId);
    if (step) {
      for (const depId of step.dependencies) {
        if (hasCycle(depId)) {
          return true;
        }
      }
    }

    recursionStack.delete(stepId);
    return false;
  };

  for (const step of plan.steps) {
    if (hasCycle(step.id)) {
      throw new Error(
        `Plan "${plan.id}" contains cyclic dependencies involving step "${step.id}"`
      );
    }
  }

  return plan;
}

/**
 * Validates a collection of plan definitions.
 * @param input - The raw collection input
 * @returns Validated PlanDefinitionCollection
 * @throws ZodError or Error if validation fails
 */
export function validatePlanDefinitionCollection(
  input: unknown
): PlanDefinitionCollection {
  const collection = PlanDefinitionCollectionSchema.parse(input);

  // Validate each plan and check for duplicate IDs
  const seenIds = new Set<string>();
  for (const plan of collection.plans) {
    validatePlanDefinition(plan);

    if (seenIds.has(plan.id)) {
      throw new Error(`Duplicate plan ID: ${plan.id}`);
    }
    seenIds.add(plan.id);
  }

  return collection;
}
