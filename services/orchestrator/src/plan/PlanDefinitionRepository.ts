import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { appLogger, normalizeError } from "../observability/logger.js";
import {
  type PlanDefinition,
  type WorkflowType,
  validatePlanDefinition,
  validatePlanDefinitionCollection,
} from "./PlanDefinition.js";

/**
 * Interface for plan definition repositories.
 * Implementations can load plan definitions from various sources
 * (filesystem, database, remote API, etc.).
 */
export interface IPlanDefinitionRepository {
  /**
   * Get a plan definition by its ID.
   * @param planId - The unique plan ID
   * @returns The plan definition if found, undefined otherwise
   */
  getPlan(planId: string): Promise<PlanDefinition | undefined>;

  /**
   * Get all plan definitions.
   * @returns Array of all loaded plan definitions
   */
  getAllPlans(): Promise<PlanDefinition[]>;

  /**
   * Get plan definitions filtered by workflow type.
   * @param workflowType - The workflow type to filter by
   * @returns Array of matching plan definitions
   */
  getPlansByWorkflowType(workflowType: WorkflowType): Promise<PlanDefinition[]>;

  /**
   * Find plans that match a given goal/input.
   * @param goal - The user's goal or input text
   * @param workflowType - Optional workflow type to narrow search
   * @returns Array of matching plans, sorted by match priority (highest first)
   */
  findMatchingPlans(
    goal: string,
    workflowType?: WorkflowType
  ): Promise<PlanDefinition[]>;

  /**
   * Reload plan definitions from the source.
   * Useful for picking up changes without restarting.
   */
  reload(): Promise<void>;

  /**
   * Get the timestamp of the last successful reload.
   */
  getLastReloadTime(): Date | undefined;
}

/**
 * Options for the YAML-based plan definition repository.
 */
export interface YamlPlanDefinitionRepositoryOptions {
  /** Base directory containing plan definition files */
  plansDirectory: string;
  /**
   * Whether to watch for file changes and auto-reload (default: false).
   * Note: The recursive option for fs.watch only works on macOS and Windows.
   * On Linux, only the top-level directory is watched. For cross-platform
   * support in production, consider using a library like chokidar.
   */
  watchForChanges?: boolean;
  /** Minimum interval between reloads in ms (default: 5000) */
  reloadDebounceMs?: number;
}

/**
 * YAML-based implementation of IPlanDefinitionRepository.
 * Loads plan definitions from YAML files in a specified directory.
 */
export class YamlPlanDefinitionRepository implements IPlanDefinitionRepository {
  private readonly plansDirectory: string;
  private readonly watchForChanges: boolean;
  private readonly reloadDebounceMs: number;

  private plans: Map<string, PlanDefinition> = new Map();
  private plansByWorkflow: Map<WorkflowType, PlanDefinition[]> = new Map();
  private lastReloadTime: Date | undefined;
  private watcher: fs.FSWatcher | undefined;
  private reloadTimer: NodeJS.Timeout | undefined;

  constructor(options: YamlPlanDefinitionRepositoryOptions) {
    this.plansDirectory = path.resolve(options.plansDirectory);
    this.watchForChanges = options.watchForChanges ?? false;
    this.reloadDebounceMs = options.reloadDebounceMs ?? 5000;
  }

  /**
   * Initialize the repository by loading all plan definitions.
   * Should be called before using other methods.
   */
  async initialize(): Promise<void> {
    await this.reload();

    if (this.watchForChanges) {
      this.startWatching();
    }
  }

  /**
   * Clean up resources (stop file watcher, clear timers).
   */
  async close(): Promise<void> {
    this.stopWatching();
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
  }

  async getPlan(planId: string): Promise<PlanDefinition | undefined> {
    return this.plans.get(planId);
  }

  async getAllPlans(): Promise<PlanDefinition[]> {
    return Array.from(this.plans.values());
  }

  async getPlansByWorkflowType(
    workflowType: WorkflowType
  ): Promise<PlanDefinition[]> {
    return this.plansByWorkflow.get(workflowType) ?? [];
  }

  async findMatchingPlans(
    goal: string,
    workflowType?: WorkflowType
  ): Promise<PlanDefinition[]> {
    const candidates = workflowType
      ? await this.getPlansByWorkflowType(workflowType)
      : await this.getAllPlans();

    // Filter to only enabled plans
    const enabledPlans = candidates.filter((p) => p.enabled);

    // Score and sort by match quality
    const scored = enabledPlans.map((plan) => ({
      plan,
      score: this.scorePlanMatch(plan, goal),
    }));

    // Filter out non-matches and sort by score (highest first)
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.plan);
  }

  async reload(): Promise<void> {
    const newPlans = new Map<string, PlanDefinition>();
    const newPlansByWorkflow = new Map<WorkflowType, PlanDefinition[]>();

    try {
      // Ensure directory exists
      try {
        await fsPromises.access(this.plansDirectory, fs.constants.R_OK);
      } catch {
        appLogger.warn(
          { directory: this.plansDirectory, event: "plan_repository.directory_missing" },
          "Plans directory does not exist, creating empty repository"
        );
        // Create the directory if it doesn't exist
        await fsPromises.mkdir(this.plansDirectory, { recursive: true });
        this.plans = newPlans;
        this.plansByWorkflow = newPlansByWorkflow;
        this.lastReloadTime = new Date();
        return;
      }

      // Read all YAML files
      const files = await this.findPlanFiles();

      for (const filePath of files) {
        try {
          const content = await fsPromises.readFile(filePath, "utf-8");
          const parsed = parseYaml(content);

          // Handle single plan or collection
          if (parsed && typeof parsed === "object") {
            if ("plans" in parsed && Array.isArray(parsed.plans)) {
              // Collection format
              const collection = validatePlanDefinitionCollection(parsed);
              for (const plan of collection.plans) {
                this.addPlanToMaps(plan, newPlans, newPlansByWorkflow);
              }
            } else if ("id" in parsed && "steps" in parsed) {
              // Single plan format
              const plan = validatePlanDefinition(parsed);
              this.addPlanToMaps(plan, newPlans, newPlansByWorkflow);
            } else {
              appLogger.warn(
                { file: filePath, event: "plan_repository.invalid_format" },
                "File does not contain valid plan definition(s)"
              );
            }
          }
        } catch (error) {
          appLogger.error(
            {
              file: filePath,
              err: normalizeError(error),
              event: "plan_repository.load_error",
            },
            "Failed to load plan definition file"
          );
        }
      }

      this.plans = newPlans;
      this.plansByWorkflow = newPlansByWorkflow;
      this.lastReloadTime = new Date();

      appLogger.info(
        {
          planCount: newPlans.size,
          directory: this.plansDirectory,
          event: "plan_repository.loaded",
        },
        "Plan definitions loaded"
      );
    } catch (error) {
      appLogger.error(
        {
          directory: this.plansDirectory,
          err: normalizeError(error),
          event: "plan_repository.reload_error",
        },
        "Failed to reload plan definitions"
      );
      throw error;
    }
  }

  getLastReloadTime(): Date | undefined {
    return this.lastReloadTime;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private addPlanToMaps(
    plan: PlanDefinition,
    plans: Map<string, PlanDefinition>,
    plansByWorkflow: Map<WorkflowType, PlanDefinition[]>
  ): void {
    if (plans.has(plan.id)) {
      appLogger.warn(
        { planId: plan.id, event: "plan_repository.duplicate_id" },
        "Duplicate plan ID, later definition will be used"
      );
    }

    plans.set(plan.id, plan);

    const workflowPlans = plansByWorkflow.get(plan.workflowType) ?? [];
    workflowPlans.push(plan);
    plansByWorkflow.set(plan.workflowType, workflowPlans);
  }

  private async findPlanFiles(): Promise<string[]> {
    const entries = await fsPromises.readdir(this.plansDirectory, {
      withFileTypes: true,
    });

    const files: string[] = [];

    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === ".yaml" || ext === ".yml") {
          files.push(path.join(this.plansDirectory, entry.name));
        }
      } else if (entry.isDirectory()) {
        // Recursively search subdirectories
        const subDir = path.join(this.plansDirectory, entry.name);
        const subFiles = await this.findPlanFilesInDir(subDir);
        files.push(...subFiles);
      }
    }

    return files;
  }

  /** Maximum directory depth for recursive plan file search to prevent traversal attacks */
  private static readonly MAX_DIRECTORY_DEPTH = 10;

  private async findPlanFilesInDir(
    directory: string,
    depth: number = 0
  ): Promise<string[]> {
    // Prevent directory traversal attacks with depth limit
    if (depth > YamlPlanDefinitionRepository.MAX_DIRECTORY_DEPTH) {
      appLogger.warn(
        {
          directory,
          depth,
          maxDepth: YamlPlanDefinitionRepository.MAX_DIRECTORY_DEPTH,
          event: "plan_repository.max_depth_exceeded",
        },
        "Maximum directory depth exceeded, skipping deeper directories"
      );
      return [];
    }

    const entries = await fsPromises.readdir(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      // Skip symbolic links to prevent symlink-based traversal attacks
      if (entry.isSymbolicLink()) {
        appLogger.debug(
          {
            directory,
            entry: entry.name,
            event: "plan_repository.symlink_skipped",
          },
          "Skipping symbolic link in plan directory"
        );
        continue;
      }

      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === ".yaml" || ext === ".yml") {
          files.push(path.join(directory, entry.name));
        }
      } else if (entry.isDirectory()) {
        const subDir = path.join(directory, entry.name);
        const subFiles = await this.findPlanFilesInDir(subDir, depth + 1);
        files.push(...subFiles);
      }
    }

    return files;
  }

  private scorePlanMatch(plan: PlanDefinition, goal: string): number {
    if (plan.inputConditions.length === 0) {
      // No conditions means the plan matches any goal in its workflow type
      return 1;
    }

    const goalLower = goal.toLowerCase();
    let maxScore = 0;

    for (const condition of plan.inputConditions) {
      let matched = false;

      switch (condition.type) {
        case "pattern": {
          // ReDoS protection: limit pattern length to prevent catastrophic backtracking
          const MAX_PATTERN_LENGTH = 500;
          if (condition.value.length > MAX_PATTERN_LENGTH) {
            appLogger.warn(
              {
                planId: plan.id,
                patternLength: condition.value.length,
                maxLength: MAX_PATTERN_LENGTH,
                event: "plan_repository.pattern_too_long",
              },
              "Regex pattern exceeds maximum length, skipping"
            );
            break;
          }

          try {
            const regex = new RegExp(condition.value, "i");
            matched = regex.test(goal);
          } catch {
            appLogger.warn(
              {
                planId: plan.id,
                pattern: condition.value,
                event: "plan_repository.invalid_pattern",
              },
              "Invalid regex pattern in plan condition"
            );
          }
          break;
        }

        case "keywords": {
          const keywords = condition.value
            .toLowerCase()
            .split(",")
            .map((k) => k.trim());
          matched = keywords.some((kw) => goalLower.includes(kw));
          break;
        }

        case "expression": {
          // For now, expressions are evaluated as simple keyword matches
          // In the future, this could support more complex logic
          matched = goalLower.includes(condition.value.toLowerCase());
          break;
        }
      }

      if (matched) {
        const score = 10 + condition.priority;
        maxScore = Math.max(maxScore, score);
      }
    }

    return maxScore;
  }

  private startWatching(): void {
    if (this.watcher) {
      return;
    }

    try {
      this.watcher = fs.watch(
        this.plansDirectory,
        { recursive: true },
        (eventType, filename) => {
          if (
            filename &&
            (filename.endsWith(".yaml") || filename.endsWith(".yml"))
          ) {
            this.scheduleReload();
          }
        }
      );

      this.watcher.on("error", (error) => {
        appLogger.error(
          {
            directory: this.plansDirectory,
            err: normalizeError(error),
            event: "plan_repository.watch_error",
          },
          "File watcher error"
        );
      });
    } catch (error) {
      appLogger.warn(
        {
          directory: this.plansDirectory,
          err: normalizeError(error),
          event: "plan_repository.watch_failed",
        },
        "Failed to start file watcher"
      );
    }
  }

  private stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }

    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.reload().catch((error) => {
        appLogger.error(
          {
            err: normalizeError(error),
            event: "plan_repository.scheduled_reload_error",
          },
          "Scheduled reload failed"
        );
      });
    }, this.reloadDebounceMs);
  }
}

/**
 * In-memory implementation for testing purposes.
 */
export class InMemoryPlanDefinitionRepository
  implements IPlanDefinitionRepository
{
  private plans: Map<string, PlanDefinition> = new Map();
  private lastReloadTime: Date | undefined;

  /**
   * @param initialPlans - Initial plans to load. Set skipValidation=true for
   *   pre-validated plans (e.g., from test fixtures) to improve performance.
   * @param skipValidation - If true, skips validation of initialPlans (default: false)
   */
  constructor(initialPlans?: PlanDefinition[], skipValidation = false) {
    if (initialPlans) {
      for (const plan of initialPlans) {
        if (skipValidation) {
          this.plans.set(plan.id, plan);
        } else {
          const validated = validatePlanDefinition(plan);
          this.plans.set(validated.id, validated);
        }
      }
      this.lastReloadTime = new Date();
    }
  }

  addPlan(plan: PlanDefinition): void {
    const validated = validatePlanDefinition(plan);
    this.plans.set(validated.id, validated);
  }

  removePlan(planId: string): boolean {
    return this.plans.delete(planId);
  }

  async getPlan(planId: string): Promise<PlanDefinition | undefined> {
    return this.plans.get(planId);
  }

  async getAllPlans(): Promise<PlanDefinition[]> {
    return Array.from(this.plans.values());
  }

  async getPlansByWorkflowType(
    workflowType: WorkflowType
  ): Promise<PlanDefinition[]> {
    return Array.from(this.plans.values()).filter(
      (p) => p.workflowType === workflowType
    );
  }

  async findMatchingPlans(
    goal: string,
    workflowType?: WorkflowType
  ): Promise<PlanDefinition[]> {
    const candidates = workflowType
      ? await this.getPlansByWorkflowType(workflowType)
      : await this.getAllPlans();

    return candidates.filter((p) => p.enabled);
  }

  async reload(): Promise<void> {
    this.lastReloadTime = new Date();
  }

  getLastReloadTime(): Date | undefined {
    return this.lastReloadTime;
  }
}
