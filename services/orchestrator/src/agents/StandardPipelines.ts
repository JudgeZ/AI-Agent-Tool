import {
  ExecutionGraph,
  ExecutionContext,
  GraphDefinition,
  NodeType,
  NodeDefinition,
  NodeHandler,
} from "./ExecutionGraph";
import { MessageBus, SharedContextManager } from "./AgentCommunication";
import { McpTool, ToolContext } from "../tools/McpTool";
import { ToolRegistry } from "../tools/ToolRegistry";
import { appLogger } from "../observability/logger";
import { z } from "zod";

// ============================================================================
// Pipeline Types and Validation
// ============================================================================

/**
 * Zod schema for pipeline parameters
 * Validates parameter values at runtime to ensure type safety for dynamic data
 */
export const PipelineParametersSchema = z.record(
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

export type PipelineParameters = z.infer<typeof PipelineParametersSchema>;

export enum PipelineType {
  DEVELOPMENT = "development",
  QUICK_FIX = "quick_fix",
  REFACTORING = "refactoring",
  CODE_REVIEW = "code_review",
  TESTING = "testing",
  DEPLOYMENT = "deployment",
}

export const PipelineConfigSchema = z.object({
  type: z.nativeEnum(PipelineType),
  name: z.string().min(1),
  description: z.string(),
  parameters: PipelineParametersSchema,
  timeout: z.number().positive().optional(),
  retryPolicy: z
    .object({
      maxRetries: z.number().int().nonnegative(),
      backoffMs: z.number().positive(),
      exponential: z.boolean(),
    })
    .optional(),
  concurrency: z.number().int().positive().optional(),
});

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

export interface PipelineContext {
  pipelineId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  messageBus: MessageBus;
  contextManager: SharedContextManager;
  toolRegistry: ToolRegistry;
  parameters: PipelineParameters;
}

// ============================================================================
// Development Pipeline
// ============================================================================

export class DevelopmentPipeline {
  /**
   * Full development workflow:
   * 1. Analyze requirements
   * 2. Search codebase for context
   * 3. Design solution
   * 4. Implement changes
   * 5. Run tests
   * 6. Review code
   * 7. Create PR
   */
  public static create(
    config: PipelineConfig,
    context: PipelineContext,
  ): GraphDefinition {
    const nodes: NodeDefinition[] = [
      // Phase 1: Analysis
      {
        id: "analyze-requirements",
        type: NodeType.TASK,
        name: "Analyze Requirements",
        description: "Parse and understand the requirements",
        dependencies: [],
        config: {
          operation: "analyze",
          input: config.parameters.requirements,
        },
        timeout: 60000,
      },

      // Phase 2: Context Gathering
      {
        id: "search-codebase",
        type: NodeType.TASK,
        name: "Search Codebase",
        description: "Find relevant code sections using semantic search",
        dependencies: ["analyze-requirements"],
        config: {
          operation: "semantic-search",
          query: "${analyze-requirements.keywords}",
          topK: 20,
        },
        timeout: 30000,
      },

      {
        id: "get-git-context",
        type: NodeType.TASK,
        name: "Get Git Context",
        description: "Retrieve recent changes and related commits",
        dependencies: ["analyze-requirements"],
        config: {
          operation: "git-log",
          maxCount: 50,
          since: "7 days ago",
        },
        timeout: 30000,
      },

      // Phase 3: Design
      {
        id: "design-solution",
        type: NodeType.TASK,
        name: "Design Solution",
        description: "Create implementation plan based on context",
        dependencies: ["search-codebase", "get-git-context"],
        config: {
          operation: "design",
          context: {
            requirements: "${analyze-requirements.output}",
            relevantCode: "${search-codebase.results}",
            recentChanges: "${get-git-context.commits}",
          },
        },
        timeout: 120000,
      },

      // Phase 4: Implementation (parallel tasks)
      {
        id: "implement-changes",
        type: NodeType.PARALLEL,
        name: "Implement Changes",
        description: "Apply code changes across multiple files",
        dependencies: ["design-solution"],
        config: {
          operation: "implement",
          files: "${design-solution.filesToModify}",
        },
        timeout: 300000,
      },

      // Phase 5: Testing
      {
        id: "run-unit-tests",
        type: NodeType.TASK,
        name: "Run Unit Tests",
        description: "Execute unit test suite",
        dependencies: ["implement-changes"],
        config: {
          operation: "test",
          framework: "auto",
          coverage: true,
          testPattern: config.parameters.testPattern || "**/*.test.*",
        },
        timeout: 300000,
        retryPolicy: {
          maxRetries: 1,
          backoffMs: 5000,
          exponential: false,
        },
      },

      {
        id: "run-integration-tests",
        type: NodeType.TASK,
        name: "Run Integration Tests",
        description: "Execute integration test suite",
        dependencies: ["implement-changes"],
        config: {
          operation: "test",
          framework: "auto",
          testPattern:
            config.parameters.integrationTestPattern || "**/*.integration.*",
        },
        timeout: 600000,
        continueOnError: true, // Don't block if integration tests fail
      },

      // Phase 6: Quality Checks
      {
        id: "check-test-results",
        type: NodeType.CONDITION,
        name: "Check Test Results",
        description: "Verify all tests passed",
        dependencies: ["run-unit-tests"],
        config: {
          condition: "${run-unit-tests.passed} === ${run-unit-tests.total}",
        },
      },

      {
        id: "code-review",
        type: NodeType.TASK,
        name: "Automated Code Review",
        description: "Review code changes for issues",
        dependencies: ["check-test-results"],
        config: {
          operation: "review",
          files: "${implement-changes.modifiedFiles}",
          checks: [
            "security",
            "performance",
            "best-practices",
            "documentation",
          ],
        },
        timeout: 120000,
      },

      // Phase 7: PR Creation
      {
        id: "create-pull-request",
        type: NodeType.TASK,
        name: "Create Pull Request",
        description: "Create PR with changes",
        dependencies: ["code-review"],
        config: {
          operation: "create-pr",
          title: config.parameters.prTitle || "Automated changes",
          body: "${design-solution.description}\n\n${code-review.summary}",
          sourceBranch:
            config.parameters.branchName || "feature/automated-changes",
          targetBranch: "main",
        },
        timeout: 60000,
      },
    ];

    return {
      id: `dev-pipeline-${Date.now()}`,
      name: config.name,
      description: config.description,
      nodes,
      entryNodes: ["analyze-requirements"],
      variables: context.parameters,
    };
  }
}

// ============================================================================
// Quick Fix Pipeline
// ============================================================================

export class QuickFixPipeline {
  /**
   * Fast bug fix workflow:
   * 1. Analyze error/issue
   * 2. Find relevant code
   * 3. Apply fix
   * 4. Verify with tests
   * 5. Commit changes
   */
  public static create(
    config: PipelineConfig,
    context: PipelineContext,
  ): GraphDefinition {
    const nodes: NodeDefinition[] = [
      // Phase 1: Analysis
      {
        id: "analyze-issue",
        type: NodeType.TASK,
        name: "Analyze Issue",
        description: "Understand the bug/issue",
        dependencies: [],
        config: {
          operation: "analyze-error",
          error: config.parameters.error,
          stackTrace: config.parameters.stackTrace,
        },
        timeout: 30000,
      },

      // Phase 2: Locate Bug
      {
        id: "locate-bug",
        type: NodeType.TASK,
        name: "Locate Bug",
        description: "Find the source of the issue",
        dependencies: ["analyze-issue"],
        config: {
          operation: "correlate-failure",
          testName: config.parameters.testName,
          failureMessage: "${analyze-issue.summary}",
        },
        timeout: 30000,
      },

      // Phase 3: Apply Fix
      {
        id: "apply-fix",
        type: NodeType.TASK,
        name: "Apply Fix",
        description: "Implement the bug fix",
        dependencies: ["locate-bug"],
        config: {
          operation: "fix",
          file: "${locate-bug.file}",
          issue: "${analyze-issue.root-cause}",
        },
        timeout: 60000,
      },

      // Phase 4: Verify
      {
        id: "run-related-tests",
        type: NodeType.TASK,
        name: "Run Related Tests",
        description: "Test the fix",
        dependencies: ["apply-fix"],
        config: {
          operation: "test",
          testFiles: [
            "${locate-bug.testFile}",
            ...(Array.isArray(config.parameters.additionalTests)
              ? config.parameters.additionalTests
              : []),
          ],
        },
        timeout: 120000,
      },

      // Phase 5: Commit
      {
        id: "commit-fix",
        type: NodeType.TASK,
        name: "Commit Fix",
        description: "Commit the bug fix",
        dependencies: ["run-related-tests"],
        config: {
          operation: "git-commit",
          message: `Fix: ${config.parameters.issueSummary || "Bug fix"}\n\nSee analyze-issue step for details`,
          files: ["See apply-fix step output"],
        },
        timeout: 30000,
      },
    ];

    return {
      id: `quickfix-pipeline-${Date.now()}`,
      name: config.name,
      description: config.description,
      nodes,
      entryNodes: ["analyze-issue"],
      variables: context.parameters,
    };
  }
}

// ============================================================================
// Refactoring Pipeline
// ============================================================================

export class RefactoringPipeline {
  /**
   * Code refactoring workflow:
   * 1. Analyze code quality
   * 2. Identify refactoring opportunities
   * 3. Plan refactoring
   * 4. Apply changes
   * 5. Run full test suite
   * 6. Measure improvements
   */
  public static create(
    config: PipelineConfig,
    context: PipelineContext,
  ): GraphDefinition {
    const nodes: NodeDefinition[] = [
      // Phase 1: Analysis
      {
        id: "analyze-code-quality",
        type: NodeType.TASK,
        name: "Analyze Code Quality",
        description: "Assess current code quality",
        dependencies: [],
        config: {
          operation: "analyze-quality",
          files: config.parameters.files || "**/*.{ts,js}",
          metrics: ["complexity", "duplication", "maintainability"],
        },
        timeout: 120000,
      },

      // Phase 2: Identify Opportunities
      {
        id: "identify-refactorings",
        type: NodeType.TASK,
        name: "Identify Refactoring Opportunities",
        description: "Find code that needs refactoring",
        dependencies: ["analyze-code-quality"],
        config: {
          operation: "identify-refactorings",
          qualityReport: "${analyze-code-quality.report}",
          threshold: config.parameters.qualityThreshold || "medium",
        },
        timeout: 60000,
      },

      // Phase 3: Prioritize
      {
        id: "prioritize-refactorings",
        type: NodeType.TASK,
        name: "Prioritize Refactorings",
        description: "Order refactorings by impact",
        dependencies: ["identify-refactorings"],
        config: {
          operation: "prioritize",
          opportunities: "${identify-refactorings.opportunities}",
          strategy: config.parameters.priorityStrategy || "impact",
        },
        timeout: 30000,
      },

      // Phase 4: Execute Refactorings (in batches)
      {
        id: "refactor-batch-1",
        type: NodeType.TASK,
        name: "Refactor Batch 1 (High Priority)",
        description: "Apply high-priority refactorings",
        dependencies: ["prioritize-refactorings"],
        config: {
          operation: "refactor",
          items: "${prioritize-refactorings.high}",
        },
        timeout: 300000,
      },

      {
        id: "test-batch-1",
        type: NodeType.TASK,
        name: "Test Batch 1",
        description: "Verify batch 1 refactorings",
        dependencies: ["refactor-batch-1"],
        config: {
          operation: "test",
          coverage: true,
        },
        timeout: 300000,
      },

      {
        id: "refactor-batch-2",
        type: NodeType.TASK,
        name: "Refactor Batch 2 (Medium Priority)",
        description: "Apply medium-priority refactorings",
        dependencies: ["test-batch-1"],
        config: {
          operation: "refactor",
          items: "${prioritize-refactorings.medium}",
        },
        timeout: 300000,
        continueOnError: true,
      },

      {
        id: "test-batch-2",
        type: NodeType.TASK,
        name: "Test Batch 2",
        description: "Verify batch 2 refactorings",
        dependencies: ["refactor-batch-2"],
        config: {
          operation: "test",
        },
        timeout: 300000,
        continueOnError: true,
      },

      // Phase 5: Measure Improvements
      {
        id: "measure-improvements",
        type: NodeType.TASK,
        name: "Measure Improvements",
        description: "Compare before and after metrics",
        dependencies: ["test-batch-2"],
        config: {
          operation: "compare-metrics",
          before: "${analyze-code-quality.metrics}",
          files: config.parameters.files,
        },
        timeout: 60000,
      },

      // Phase 6: Create PR
      {
        id: "create-refactoring-pr",
        type: NodeType.TASK,
        name: "Create Refactoring PR",
        description: "Create PR with refactored code",
        dependencies: ["measure-improvements"],
        config: {
          operation: "create-pr",
          title: config.parameters.prTitle || "Refactoring improvements",
          body: "${measure-improvements.report}",
          sourceBranch: config.parameters.branchName || "refactor/improvements",
        },
        timeout: 60000,
      },
    ];

    return {
      id: `refactor-pipeline-${Date.now()}`,
      name: config.name,
      description: config.description,
      nodes,
      entryNodes: ["analyze-code-quality"],
      variables: context.parameters,
    };
  }
}

// ============================================================================
// Code Review Pipeline
// ============================================================================

export class CodeReviewPipeline {
  /**
   * Automated code review workflow:
   * 1. Fetch PR changes
   * 2. Run static analysis
   * 3. Check security
   * 4. Check performance
   * 5. Check documentation
   * 6. Post review comments
   */
  public static create(
    config: PipelineConfig,
    context: PipelineContext,
  ): GraphDefinition {
    const nodes: NodeDefinition[] = [
      {
        id: "fetch-pr-changes",
        type: NodeType.TASK,
        name: "Fetch PR Changes",
        description: "Get the diff from the pull request",
        dependencies: [],
        config: {
          operation: "git-diff",
          pr: config.parameters.prNumber,
        },
        timeout: 30000,
      },

      // Parallel analysis
      {
        id: "static-analysis",
        type: NodeType.TASK,
        name: "Static Analysis",
        description: "Run linters and static analyzers",
        dependencies: ["fetch-pr-changes"],
        config: {
          operation: "lint",
          files: "${fetch-pr-changes.files}",
        },
        timeout: 120000,
      },

      {
        id: "security-check",
        type: NodeType.TASK,
        name: "Security Check",
        description: "Scan for security vulnerabilities",
        dependencies: ["fetch-pr-changes"],
        config: {
          operation: "security-scan",
          files: "${fetch-pr-changes.files}",
        },
        timeout: 180000,
      },

      {
        id: "performance-check",
        type: NodeType.TASK,
        name: "Performance Check",
        description: "Identify performance issues",
        dependencies: ["fetch-pr-changes"],
        config: {
          operation: "performance-analysis",
          files: "${fetch-pr-changes.files}",
        },
        timeout: 120000,
      },

      {
        id: "documentation-check",
        type: NodeType.TASK,
        name: "Documentation Check",
        description: "Verify documentation coverage",
        dependencies: ["fetch-pr-changes"],
        config: {
          operation: "doc-check",
          files: "${fetch-pr-changes.files}",
        },
        timeout: 60000,
      },

      // Merge results
      {
        id: "merge-review-results",
        type: NodeType.MERGE,
        name: "Merge Review Results",
        description: "Combine all review findings",
        dependencies: [
          "static-analysis",
          "security-check",
          "performance-check",
          "documentation-check",
        ],
        config: {
          operation: "merge-results",
        },
      },

      // Post results
      {
        id: "post-review-comments",
        type: NodeType.TASK,
        name: "Post Review Comments",
        description: "Add review comments to PR",
        dependencies: ["merge-review-results"],
        config: {
          operation: "post-comments",
          pr: config.parameters.prNumber,
          findings: "${merge-review-results.findings}",
        },
        timeout: 30000,
      },
    ];

    return {
      id: `review-pipeline-${Date.now()}`,
      name: config.name,
      description: config.description,
      nodes,
      entryNodes: ["fetch-pr-changes"],
      variables: context.parameters,
    };
  }
}

// ============================================================================
// Testing Pipeline
// ============================================================================

export class TestingPipeline {
  /**
   * Comprehensive testing workflow:
   * 1. Run unit tests
   * 2. Run integration tests
   * 3. Run E2E tests
   * 4. Check coverage
   * 5. Generate report
   */
  public static create(
    config: PipelineConfig,
    context: PipelineContext,
  ): GraphDefinition {
    const nodes: NodeDefinition[] = [
      {
        id: "run-unit-tests",
        type: NodeType.TASK,
        name: "Run Unit Tests",
        description: "Execute unit test suite",
        dependencies: [],
        config: {
          operation: "test",
          framework: "auto",
          testPattern: "**/*.test.*",
          coverage: true,
        },
        timeout: 300000,
      },

      {
        id: "run-integration-tests",
        type: NodeType.TASK,
        name: "Run Integration Tests",
        description: "Execute integration test suite",
        dependencies: [],
        config: {
          operation: "test",
          framework: "auto",
          testPattern: "**/*.integration.*",
          coverage: true,
        },
        timeout: 600000,
      },

      {
        id: "run-e2e-tests",
        type: NodeType.TASK,
        name: "Run E2E Tests",
        description: "Execute end-to-end test suite",
        dependencies: [],
        config: {
          operation: "test",
          framework: "auto",
          testPattern: "**/*.e2e.*",
        },
        timeout: 900000,
        continueOnError: true,
      },

      {
        id: "check-coverage",
        type: NodeType.TASK,
        name: "Check Coverage",
        description: "Verify coverage thresholds",
        dependencies: ["run-unit-tests", "run-integration-tests"],
        config: {
          operation: "check-coverage",
          thresholds: config.parameters.coverageThresholds || {
            lines: 80,
            statements: 80,
            functions: 80,
            branches: 70,
          },
        },
        timeout: 30000,
      },

      {
        id: "generate-test-report",
        type: NodeType.TASK,
        name: "Generate Test Report",
        description: "Create comprehensive test report",
        dependencies: ["check-coverage", "run-e2e-tests"],
        config: {
          operation: "generate-report",
          results: {
            unit: "${run-unit-tests.output}",
            integration: "${run-integration-tests.output}",
            e2e: "${run-e2e-tests.output}",
            coverage: "${check-coverage.output}",
          },
        },
        timeout: 60000,
      },
    ];

    return {
      id: `testing-pipeline-${Date.now()}`,
      name: config.name,
      description: config.description,
      nodes,
      entryNodes: ["run-unit-tests", "run-integration-tests", "run-e2e-tests"],
      variables: context.parameters,
    };
  }
}

// ============================================================================
// Pipeline Factory
// ============================================================================

export class PipelineFactory {
  public static create(
    config: PipelineConfig,
    context: PipelineContext,
  ): GraphDefinition {
    switch (config.type) {
      case PipelineType.DEVELOPMENT:
        return DevelopmentPipeline.create(config, context);

      case PipelineType.QUICK_FIX:
        return QuickFixPipeline.create(config, context);

      case PipelineType.REFACTORING:
        return RefactoringPipeline.create(config, context);

      case PipelineType.CODE_REVIEW:
        return CodeReviewPipeline.create(config, context);

      case PipelineType.TESTING:
        return TestingPipeline.create(config, context);

      default:
        throw new Error(`Unsupported pipeline type: ${config.type}`);
    }
  }

  public static getSupportedTypes(): PipelineType[] {
    return [
      PipelineType.DEVELOPMENT,
      PipelineType.QUICK_FIX,
      PipelineType.REFACTORING,
      PipelineType.CODE_REVIEW,
      PipelineType.TESTING,
    ];
  }
}

// ============================================================================
// Pipeline Executor
// ============================================================================

export class PipelineExecutor {
  private context: PipelineContext;

  constructor(context: PipelineContext) {
    this.context = context;
  }

  public async execute(config: PipelineConfig): Promise<any> {
    // Create pipeline graph
    const graphDefinition = PipelineFactory.create(config, this.context);

    // Create execution graph
    const graph = new ExecutionGraph(graphDefinition, config.concurrency || 10);

    // Register node handlers
    this.registerHandlers(graph);

    // Execute
    return await graph.execute();
  }

  private registerHandlers(graph: ExecutionGraph): void {
    // Register handler for TASK nodes - dispatches to tools based on operation
    graph.registerHandler(NodeType.TASK, this.createTaskHandler());

    // Register handler for PARALLEL nodes - executes child operations concurrently
    graph.registerHandler(NodeType.PARALLEL, this.createParallelHandler());

    // Register handler for CONDITION nodes - evaluates conditions for branching
    graph.registerHandler(NodeType.CONDITION, this.createConditionHandler());

    // Register handler for MERGE nodes - combines results from parallel branches
    graph.registerHandler(NodeType.MERGE, this.createMergeHandler());
  }

  private createTaskHandler(): NodeHandler {
    return {
      execute: async (
        node: NodeDefinition,
        _context: ExecutionContext,
      ): Promise<unknown> => {
        const operation = node.config.operation as string;

        // Map operations to tools
        switch (operation) {
          case "test":
            return await this.executeTestTool(node);
          case "git-diff":
          case "git-log":
          case "git-commit":
            return await this.executeRepositoryTool(node);
          case "analyze":
          case "analyze-error":
          case "analyze-quality":
            return await this.executeAnalysisTool(node);
          case "semantic-search":
            return await this.executeSearchTool(node);
          case "lint":
          case "security-scan":
          case "performance-analysis":
          case "doc-check":
            return await this.executeReviewTool(node);
          default:
            // Use generic tool execution
            return await this.executeGenericTool(node);
        }
      },
    };
  }

  private createParallelHandler(): NodeHandler {
    return {
      execute: async (
        node: NodeDefinition,
        context: ExecutionContext,
      ): Promise<unknown> => {
        // Parallel nodes coordinate concurrent execution of their configured tasks
        // The actual parallelism is handled by the ExecutionGraph scheduler
        // This handler processes the node's own config if needed
        const operation = node.config.operation as string | undefined;

        if (operation) {
          // If the parallel node has an operation, execute it
          return await this.executeGenericTool(node);
        }

        // Return aggregated info about what this parallel node represents
        return {
          status: "completed",
          nodeId: node.id,
          description: node.description,
          // Results from parallel branches are available in context.outputs
          parallelBranches: node.dependencies,
        };
      },
    };
  }

  private createConditionHandler(): NodeHandler {
    return {
      execute: async (
        node: NodeDefinition,
        context: ExecutionContext,
      ): Promise<unknown> => {
        const condition = node.config.condition as string;

        if (!condition) {
          throw new Error(`Condition node ${node.id} missing 'condition' config`);
        }

        // Evaluate condition by substituting variable references
        const evaluatedCondition = this.substituteVariables(condition, context);

        // Safely evaluate the condition expression
        const result = this.evaluateCondition(evaluatedCondition);

        appLogger.debug(
          { nodeId: node.id, condition, evaluatedCondition, result },
          "Condition evaluated",
        );

        return {
          status: "completed",
          condition,
          result,
          passed: result === true,
        };
      },
    };
  }

  private createMergeHandler(): NodeHandler {
    return {
      execute: async (
        node: NodeDefinition,
        context: ExecutionContext,
      ): Promise<unknown> => {
        // Merge handler collects outputs from all dependency nodes
        const mergedResults: Record<string, unknown> = {};
        const findings: unknown[] = [];

        for (const depId of node.dependencies) {
          const depOutput = context.outputs.get(depId);
          if (depOutput !== undefined) {
            mergedResults[depId] = depOutput;

            // Collect findings if present (for review pipelines)
            if (
              typeof depOutput === "object" &&
              depOutput !== null &&
              "findings" in depOutput
            ) {
              const depFindings = (depOutput as { findings?: unknown[] }).findings;
              if (Array.isArray(depFindings)) {
                findings.push(...depFindings);
              }
            }
          }
        }

        return {
          status: "completed",
          mergedResults,
          findings,
          mergedCount: Object.keys(mergedResults).length,
        };
      },
    };
  }

  private substituteVariables(template: string, context: ExecutionContext): string {
    // Replace ${nodeId.field} patterns with actual values from context outputs
    return template.replace(/\$\{([^}]+)\}/g, (match, path) => {
      const parts = path.split(".");
      const nodeId = parts[0];
      const fieldPath = parts.slice(1);

      const nodeOutput = context.outputs.get(nodeId);
      if (nodeOutput === undefined) {
        return match; // Keep original if not found
      }

      // Navigate to the nested field
      let value: unknown = nodeOutput;
      for (const field of fieldPath) {
        if (typeof value === "object" && value !== null && field in value) {
          value = (value as Record<string, unknown>)[field];
        } else {
          return match; // Keep original if path not found
        }
      }

      return String(value);
    });
  }

  private evaluateCondition(condition: string): boolean {
    // Safe condition evaluation - only allows simple comparisons
    // Supports: ===, !==, >, <, >=, <=, &&, ||
    try {
      // Sanitize: only allow numbers, booleans, comparison operators, and whitespace
      const sanitized = condition.trim();
      const allowedPattern = /^[\d\s.]+(?:===|!==|>=|<=|>|<|&&|\|\||\(|\)|true|false|[\d\s.])+$/;

      if (!allowedPattern.test(sanitized)) {
        appLogger.warn({ condition }, "Condition contains disallowed characters");
        return false;
      }

      // Use Function constructor for safe evaluation of simple expressions
      // This is safer than eval() as it doesn't have access to local scope
      const evaluator = new Function(`return (${sanitized})`);
      const result = evaluator();

      return Boolean(result);
    } catch (error) {
      appLogger.error(
        { condition, err: error instanceof Error ? error : new Error(String(error)) },
        "Failed to evaluate condition",
      );
      return false;
    }
  }

  private async executeTestTool(node: NodeDefinition): Promise<any> {
    const tool = this.context.toolRegistry.get("test-runner");
    if (!tool) {
      throw new Error("Test runner tool not found");
    }

    const toolContext: ToolContext = {
      requestId: this.context.pipelineId,
      tenantId: this.context.tenantId,
      userId: this.context.userId,
      logger: appLogger,
      workdir: process.cwd(),
    };

    return await tool.execute({
      framework: node.config.framework as string,
      pattern: node.config.testPattern as string,
      coverage: node.config.coverage as boolean,
    }, toolContext);
  }

  private async executeRepositoryTool(node: NodeDefinition): Promise<any> {
    const tool = this.context.toolRegistry.get("repository");
    if (!tool) {
      throw new Error("Repository tool not found");
    }

    const toolContext: ToolContext = {
      requestId: this.context.pipelineId,
      tenantId: this.context.tenantId,
      userId: this.context.userId,
      logger: appLogger,
      workdir: process.cwd(),
    };

    const operation = node.config.operation as string;
    return await tool.execute({
      operation,
      ...node.config,
    }, toolContext);
  }

  private async executeAnalysisTool(node: NodeDefinition): Promise<any> {
    // Use AI provider for analysis tasks
    const tool = this.context.toolRegistry.get("ai-analyzer");
    if (!tool) {
      // Fallback to generic execution
      return await this.executeGenericTool(node);
    }

    const toolContext: ToolContext = {
      requestId: this.context.pipelineId,
      tenantId: this.context.tenantId,
      userId: this.context.userId,
      logger: appLogger,
      workdir: process.cwd(),
    };

    return await tool.execute(node.config, toolContext);
  }

  private async executeSearchTool(node: NodeDefinition): Promise<any> {
    // Use indexer for semantic search
    const tool = this.context.toolRegistry.get("semantic-search");
    if (!tool) {
      throw new Error("Semantic search tool not found");
    }

    const toolContext: ToolContext = {
      requestId: this.context.pipelineId,
      tenantId: this.context.tenantId,
      userId: this.context.userId,
      logger: appLogger,
      workdir: process.cwd(),
    };

    return await tool.execute({
      query: node.config.query as string,
      topK: node.config.topK as number,
    }, toolContext);
  }

  private async executeReviewTool(node: NodeDefinition): Promise<any> {
    const toolMap: Record<string, string> = {
      lint: "linter",
      "security-scan": "security-scanner",
      "performance-analysis": "performance-analyzer",
      "doc-check": "documentation-checker",
    };

    const toolName = toolMap[node.config.operation as string];
    const tool = this.context.toolRegistry.get(toolName);

    if (!tool) {
      // Fallback to generic execution
      return await this.executeGenericTool(node);
    }

    const toolContext: ToolContext = {
      requestId: this.context.pipelineId,
      tenantId: this.context.tenantId,
      userId: this.context.userId,
      logger: appLogger,
      workdir: process.cwd(),
    };

    return await tool.execute({
      files: node.config.files,
      ...node.config,
    }, toolContext);
  }

  private async executeGenericTool(node: NodeDefinition): Promise<any> {
    // Try to find a tool matching the operation name
    const tool = this.context.toolRegistry.get(
      node.config.operation as string,
    );

    if (tool) {
      const toolContext: ToolContext = {
        requestId: this.context.pipelineId,
        tenantId: this.context.tenantId,
        userId: this.context.userId,
        logger: appLogger,
        workdir: process.cwd(),
      };
      return await tool.execute(node.config, toolContext);
    }

    // Log that no tool was found for this operation
    console.warn(`No tool found for operation: ${node.config.operation}`);

    // Return mock result for now
    return {
      status: "completed",
      output: `Simulated execution of ${node.config.operation}`,
    };
  }
}
