/* eslint-disable @typescript-eslint/no-explicit-any */
// justified: Test runner results and coverage data are dynamic and vary by test framework
// Jest, Vitest, Mocha, RSpec all return different JSON structures that can't be statically typed

import {
  McpTool,
  ToolMetadata,
  ToolCapability,
  ToolContext,
  ToolResult,
} from "../McpTool";
import { ContainerSandbox } from "../../sandbox/ContainerSandbox";
import { SandboxType, SandboxCapabilities } from "../../sandbox";
import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import { Logger } from "pino";

// ============================================================================
// Input/Output Schemas
// ============================================================================

const RunTestsInputSchema = z.object({
  projectPath: z.string(),
  framework: z
    .enum([
      "jest",
      "vitest",
      "mocha",
      "pytest",
      "go-test",
      "cargo-test",
      "junit",
      "rspec",
      "auto", // Auto-detect
    ])
    .default("auto"),
  testPattern: z.string().optional(), // Pattern to match test files
  testFiles: z.array(z.string()).optional(), // Specific test files
  coverage: z.boolean().default(false),
  parallel: z.boolean().default(true),
  maxWorkers: z.number().min(1).max(16).optional(),
  timeout: z.number().min(1000).max(300000).optional(), // Per-test timeout in ms
  retries: z.number().min(0).max(3).default(0),
  env: z.record(z.string()).optional(), // Environment variables
  watch: z.boolean().default(false),
  bail: z.boolean().default(false), // Stop on first failure
});

export type RunTestsInput = Omit<
  z.infer<typeof RunTestsInputSchema>,
  "framework" | "coverage" | "parallel" | "retries" | "watch" | "bail"
> & {
  framework?:
    | "jest"
    | "vitest"
    | "mocha"
    | "pytest"
    | "go-test"
    | "cargo-test"
    | "junit"
    | "rspec"
    | "auto";
  coverage?: boolean;
  parallel?: boolean;
  retries?: number;
  watch?: boolean;
  bail?: boolean;
};

export interface TestResult {
  name: string;
  file: string;
  status: "passed" | "failed" | "skipped" | "pending";
  duration: number; // milliseconds
  error?: {
    message: string;
    stack?: string;
    expected?: any;
    actual?: any;
  };
}

export interface TestSuiteResult {
  framework: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  duration: number; // milliseconds
  coverage?: {
    lines: { total: number; covered: number; percentage: number };
    statements: { total: number; covered: number; percentage: number };
    functions: { total: number; covered: number; percentage: number };
    branches: { total: number; covered: number; percentage: number };
  };
  tests: TestResult[];
  errors: string[];
}

// ============================================================================
// Framework Detection
// ============================================================================

interface TestFramework {
  name: string;
  language: string;
  configFiles: string[];
  packageJsonScripts?: string[];
  runCommand: string[];
  coverageCommand?: string[];
  parseOutput: (stdout: string, stderr: string) => TestSuiteResult;
}

const FRAMEWORKS: TestFramework[] = [
  {
    name: "jest",
    language: "javascript",
    configFiles: ["jest.config.js", "jest.config.ts", "jest.config.json"],
    packageJsonScripts: ["test", "test:unit"],
    runCommand: ["npx", "jest", "--json", "--testLocationInResults"],
    coverageCommand: ["npx", "jest", "--coverage", "--json"],
    parseOutput: parseJestOutput,
  },
  {
    name: "vitest",
    language: "javascript",
    configFiles: ["vitest.config.ts", "vitest.config.js"],
    packageJsonScripts: ["test", "test:unit"],
    runCommand: ["npx", "vitest", "run", "--reporter=json"],
    coverageCommand: ["npx", "vitest", "run", "--coverage", "--reporter=json"],
    parseOutput: parseVitestOutput,
  },
  {
    name: "mocha",
    language: "javascript",
    configFiles: [".mocharc.json", ".mocharc.js", "mocha.opts"],
    packageJsonScripts: ["test"],
    runCommand: ["npx", "mocha", "--reporter", "json"],
    parseOutput: parseMochaOutput,
  },
  {
    name: "pytest",
    language: "python",
    configFiles: ["pytest.ini", "setup.cfg", "pyproject.toml"],
    runCommand: [
      "pytest",
      "--json-report",
      "--json-report-file=/tmp/pytest-report.json",
    ],
    coverageCommand: ["pytest", "--cov", "--json-report"],
    parseOutput: parsePytestOutput,
  },
  {
    name: "go-test",
    language: "go",
    configFiles: [],
    runCommand: ["go", "test", "-json", "./..."],
    coverageCommand: ["go", "test", "-cover", "-json", "./..."],
    parseOutput: parseGoTestOutput,
  },
  {
    name: "cargo-test",
    language: "rust",
    configFiles: ["Cargo.toml"],
    runCommand: ["cargo", "test", "--", "--format", "json"],
    parseOutput: parseCargoTestOutput,
  },
  {
    name: "rspec",
    language: "ruby",
    configFiles: [".rspec", "spec/spec_helper.rb"],
    runCommand: ["bundle", "exec", "rspec", "--format", "json"],
    parseOutput: parseRspecOutput,
  },
];

// ============================================================================
// Test Runner Tool Configuration
// ============================================================================

export interface TestRunnerToolConfig {
  defaultTimeout: number;
  maxTestDuration: number;
  enableCoverage: boolean;
  coverageThreshold?: {
    lines?: number;
    statements?: number;
    functions?: number;
    branches?: number;
  };
  isolationLevel: "container" | "process" | "none";
  retainArtifacts: boolean;
  artifactsPath?: string;
}

const DEFAULT_CONFIG: TestRunnerToolConfig = {
  defaultTimeout: 5 * 60 * 1000, // 5 minutes
  maxTestDuration: 15 * 60 * 1000, // 15 minutes
  enableCoverage: true,
  isolationLevel: "container",
  retainArtifacts: true,
  artifactsPath: "/tmp/test-artifacts",
};

// ============================================================================
// Test Runner Tool Implementation
// ============================================================================

export class TestRunnerTool extends McpTool<RunTestsInput, TestSuiteResult> {
  private sandbox: ContainerSandbox;
  private config: TestRunnerToolConfig;

  constructor(logger: Logger, config: Partial<TestRunnerToolConfig> = {}) {
    const metadata: ToolMetadata = {
      id: "test-runner",
      name: "Test Runner Tool",
      description:
        "Executes tests with framework auto-detection and isolated execution",
      version: "1.0.0",
      capabilities: [
        ToolCapability.READ_FILES,
        ToolCapability.EXECUTE_COMMANDS,
        ToolCapability.ISOLATED_EXECUTION,
      ],
      requiresApproval: false, // Tests are read-only operations
      sandboxType: SandboxType.CONTAINER,
      sandboxCapabilities: {
        network: false,
        filesystem: true,
        heavyCompute: true,
        externalBinaries: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          projectPath: { type: "string" },
          framework: {
            type: "string",
            enum: [
              "jest",
              "vitest",
              "mocha",
              "pytest",
              "go-test",
              "cargo-test",
              "auto",
            ],
          },
          coverage: { type: "boolean" },
          parallel: { type: "boolean" },
        },
        required: ["projectPath"],
      },
      outputSchema: {
        type: "object",
        properties: {
          framework: { type: "string" },
          totalTests: { type: "number" },
          passed: { type: "number" },
          failed: { type: "number" },
          duration: { type: "number" },
        },
      },
    };

    super(metadata, logger);
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.sandbox = new ContainerSandbox({
      image: "test-runner:latest", // Custom image with multiple test frameworks
      workdir: "/workspace",
      logger: logger,
      limits: {
        memory: 4 * 1024 * 1024 * 1024, // 4 GB for large test suites
        cpuQuota: 4,
        timeout: this.config.maxTestDuration,
      },
      networkPolicy: {
        blockAll: true, // Tests should not require network by default
      },
    });
  }

  // ============================================================================
  // Tool Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.config.isolationLevel === "container") {
      await this.sandbox.prepare();
    }

    if (this.config.retainArtifacts && this.config.artifactsPath) {
      await fs.mkdir(this.config.artifactsPath, { recursive: true });
    }

    this.emit("initialized", { tool: this.metadata.id });
  }

  async shutdown(): Promise<void> {
    if (this.config.isolationLevel === "container") {
      await this.sandbox.cleanup();
    }
    this.emit("shutdown", { tool: this.metadata.id });
  }

  // ============================================================================
  // Main Execution Entry Point
  // ============================================================================

  protected async executeImpl(
    input: RunTestsInput,
    context: ToolContext,
  ): Promise<TestSuiteResult> {
    const validatedInput = RunTestsInputSchema.parse(input);

    this.emit("tests:started", {
      projectPath: validatedInput.projectPath,
      framework: validatedInput.framework,
    });

    // Detect framework if auto
    let framework: TestFramework;
    if (validatedInput.framework === "auto") {
      framework = await this.detectFramework(validatedInput.projectPath);
      this.emit("framework:detected", {
        name: framework.name,
        language: framework.language,
      });
    } else {
      framework = FRAMEWORKS.find((f) => f.name === validatedInput.framework)!;
      if (!framework) {
        throw new Error(
          `Unsupported test framework: ${validatedInput.framework}`,
        );
      }
    }

    // Build test command
    const command = this.buildTestCommand(framework, validatedInput);

    // Execute tests
    const result = await this.executeTests(
      command,
      validatedInput.projectPath,
      validatedInput.env,
    );

    // Parse results
    const testResult = framework.parseOutput(result.stdout, result.stderr);
    testResult.framework = framework.name;

    // Check coverage thresholds
    if (
      validatedInput.coverage &&
      testResult.coverage &&
      this.config.coverageThreshold
    ) {
      this.checkCoverageThresholds(testResult.coverage);
    }

    // Save artifacts
    if (this.config.retainArtifacts) {
      await this.saveArtifacts(testResult, context);
    }

    this.emit("tests:completed", {
      framework: testResult.framework,
      totalTests: testResult.totalTests,
      passed: testResult.passed,
      failed: testResult.failed,
      duration: testResult.duration,
    });

    return testResult;
  }

  protected async validateInput(input: RunTestsInput): Promise<void> {
    RunTestsInputSchema.parse(input);
  }

  // ============================================================================
  // Framework Detection
  // ============================================================================

  private async detectFramework(projectPath: string): Promise<TestFramework> {
    this.emit("framework:detecting", { projectPath });

    for (const framework of FRAMEWORKS) {
      // Check for config files
      for (const configFile of framework.configFiles) {
        const configPath = path.join(projectPath, configFile);
        try {
          await fs.access(configPath);
          return framework;
        } catch {
          // Config file not found, continue
        }
      }

      // Check package.json for JS frameworks
      if (framework.language === "javascript" && framework.packageJsonScripts) {
        try {
          const packageJsonPath = path.join(projectPath, "package.json");
          const packageJson = JSON.parse(
            await fs.readFile(packageJsonPath, "utf-8"),
          );

          if (packageJson.scripts) {
            for (const script of framework.packageJsonScripts) {
              if (packageJson.scripts[script]?.includes(framework.name)) {
                return framework;
              }
            }
          }

          // Check dependencies
          const allDeps = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies,
          };
          if (allDeps[framework.name]) {
            return framework;
          }
        } catch {
          // package.json not found or malformed
        }
      }
    }

    throw new Error(
      `Could not detect test framework in ${projectPath}. Please specify framework explicitly.`,
    );
  }

  // ============================================================================
  // Command Building
  // ============================================================================

  private buildTestCommand(
    framework: TestFramework,
    input: RunTestsInput,
  ): string[] {
    let command: string[];

    if (input.coverage && framework.coverageCommand) {
      command = [...framework.coverageCommand];
    } else {
      command = [...framework.runCommand];
    }

    // Add test pattern or files
    if (input.testFiles && input.testFiles.length > 0) {
      command.push(...input.testFiles);
    } else if (input.testPattern) {
      command.push(input.testPattern);
    }

    // Add parallel/workers config
    if (input.parallel && input.maxWorkers) {
      if (framework.name === "jest" || framework.name === "vitest") {
        command.push("--maxWorkers", input.maxWorkers.toString());
      } else if (framework.name === "pytest") {
        command.push("-n", input.maxWorkers.toString());
      }
    }

    // Add timeout
    if (input.timeout) {
      if (framework.name === "jest") {
        command.push("--testTimeout", input.timeout.toString());
      } else if (framework.name === "mocha") {
        command.push("--timeout", input.timeout.toString());
      } else if (framework.name === "pytest") {
        command.push("--timeout", (input.timeout / 1000).toString());
      }
    }

    // Add retries
    if (input.retries && input.retries > 0) {
      if (framework.name === "jest") {
        command.push("--maxRetries", input.retries.toString());
      } else if (framework.name === "pytest") {
        command.push("--reruns", input.retries.toString());
      }
    }

    // Add bail flag
    if (input.bail) {
      if (framework.name === "jest" || framework.name === "vitest") {
        command.push("--bail");
      } else if (framework.name === "mocha") {
        command.push("--bail");
      } else if (framework.name === "pytest") {
        command.push("-x");
      }
    }

    return command;
  }

  // ============================================================================
  // Test Execution
  // ============================================================================

  private async executeTests(
    command: string[],
    projectPath: string,
    env?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (this.config.isolationLevel === "container") {
      return await this.sandbox.execute(command[0], command.slice(1));
    }

    // Fallback to direct execution (less isolated)
    const { spawn } = await import("child_process");
    return new Promise((resolve, reject) => {
      const proc = spawn(command[0], command.slice(1), {
        cwd: projectPath,
        env: { ...process.env, ...env },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => (stdout += data.toString()));
      proc.stderr.on("data", (data) => (stderr += data.toString()));

      proc.on("close", (exitCode) => {
        resolve({ stdout, stderr, exitCode: exitCode || 0 });
      });

      proc.on("error", (error) => {
        reject(error);
      });

      // Timeout handling
      setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error("Test execution timeout"));
      }, this.config.maxTestDuration);
    });
  }

  // ============================================================================
  // Coverage Threshold Checking
  // ============================================================================

  private checkCoverageThresholds(coverage: TestSuiteResult["coverage"]): void {
    if (!coverage || !this.config.coverageThreshold) return;

    const thresholds = this.config.coverageThreshold;
    const failures: string[] = [];

    if (thresholds.lines && coverage.lines.percentage < thresholds.lines) {
      failures.push(
        `Lines coverage ${coverage.lines.percentage}% < ${thresholds.lines}%`,
      );
    }

    if (
      thresholds.statements &&
      coverage.statements.percentage < thresholds.statements
    ) {
      failures.push(
        `Statements coverage ${coverage.statements.percentage}% < ${thresholds.statements}%`,
      );
    }

    if (
      thresholds.functions &&
      coverage.functions.percentage < thresholds.functions
    ) {
      failures.push(
        `Functions coverage ${coverage.functions.percentage}% < ${thresholds.functions}%`,
      );
    }

    if (
      thresholds.branches &&
      coverage.branches.percentage < thresholds.branches
    ) {
      failures.push(
        `Branches coverage ${coverage.branches.percentage}% < ${thresholds.branches}%`,
      );
    }

    if (failures.length > 0) {
      this.emit("coverage:threshold-failed", { failures });
      throw new Error(`Coverage thresholds not met:\n${failures.join("\n")}`);
    }

    this.emit("coverage:threshold-passed", { coverage });
  }

  // ============================================================================
  // Artifact Management
  // ============================================================================

  private async saveArtifacts(
    result: TestSuiteResult,
    context: ToolContext,
  ): Promise<void> {
    if (!this.config.artifactsPath) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sessionDir = path.join(
      this.config.artifactsPath,
      context.requestId || "unknown",
      timestamp,
    );

    await fs.mkdir(sessionDir, { recursive: true });

    // Save test results JSON
    await fs.writeFile(
      path.join(sessionDir, "results.json"),
      JSON.stringify(result, null, 2),
    );

    // Save coverage report if available
    if (result.coverage) {
      await fs.writeFile(
        path.join(sessionDir, "coverage.json"),
        JSON.stringify(result.coverage, null, 2),
      );
    }

    // Save failed test details
    if (result.failed > 0) {
      const failedTests = result.tests.filter((t) => t.status === "failed");
      await fs.writeFile(
        path.join(sessionDir, "failures.json"),
        JSON.stringify(failedTests, null, 2),
      );
    }

    this.emit("artifacts:saved", {
      path: sessionDir,
      files: ["results.json", "coverage.json"],
    });
  }
}

// ============================================================================
// Output Parsers for Different Frameworks
// ============================================================================

function parseJestOutput(stdout: string, stderr: string): TestSuiteResult {
  try {
    const data = JSON.parse(stdout);

    const tests: TestResult[] = [];
    let totalDuration = 0;

    for (const result of data.testResults || []) {
      totalDuration += result.endTime - result.startTime;

      for (const testResult of result.assertionResults || []) {
        tests.push({
          name: testResult.title,
          file: result.name,
          status:
            testResult.status === "passed"
              ? "passed"
              : testResult.status === "failed"
                ? "failed"
                : "skipped",
          duration: testResult.duration || 0,
          error: testResult.failureMessages?.length
            ? {
                message: testResult.failureMessages[0],
                stack: testResult.failureMessages.join("\n"),
              }
            : undefined,
        });
      }
    }

    const coverage = data.coverageMap
      ? {
          lines: calculateCoverage(data.coverageMap, "lines"),
          statements: calculateCoverage(data.coverageMap, "statements"),
          functions: calculateCoverage(data.coverageMap, "functions"),
          branches: calculateCoverage(data.coverageMap, "branches"),
        }
      : undefined;

    return {
      framework: "jest",
      totalTests: data.numTotalTests || tests.length,
      passed:
        data.numPassedTests ||
        tests.filter((t) => t.status === "passed").length,
      failed:
        data.numFailedTests ||
        tests.filter((t) => t.status === "failed").length,
      skipped:
        data.numPendingTests ||
        tests.filter((t) => t.status === "skipped").length,
      pending: 0,
      duration: totalDuration,
      coverage,
      tests,
      errors: [],
    };
  } catch (error) {
    throw new Error(`Failed to parse Jest output: ${error}`);
  }
}

function parseVitestOutput(stdout: string, stderr: string): TestSuiteResult {
  // Similar to Jest with minor format differences
  return parseJestOutput(stdout, stderr);
}

function parseMochaOutput(stdout: string, stderr: string): TestSuiteResult {
  try {
    const data = JSON.parse(stdout);

    const tests: TestResult[] = (data.tests || []).map((test: any) => ({
      name: test.title,
      file: test.file,
      status:
        test.state === "passed"
          ? "passed"
          : test.state === "failed"
            ? "failed"
            : "skipped",
      duration: test.duration || 0,
      error: test.err
        ? {
            message: test.err.message,
            stack: test.err.stack,
          }
        : undefined,
    }));

    return {
      framework: "mocha",
      totalTests: data.stats.tests,
      passed: data.stats.passes,
      failed: data.stats.failures,
      skipped: data.stats.pending,
      pending: 0,
      duration: data.stats.duration,
      tests,
      errors: [],
    };
  } catch (error) {
    throw new Error(`Failed to parse Mocha output: ${error}`);
  }
}

function parsePytestOutput(stdout: string, stderr: string): TestSuiteResult {
  try {
    // Read from report file
    const reportPath = "/tmp/pytest-report.json";
    const data = JSON.parse(fsSync.readFileSync(reportPath, "utf-8"));

    const tests: TestResult[] = (data.tests || []).map((test: any) => ({
      name: test.nodeid,
      file: test.location[0],
      status:
        test.outcome === "passed"
          ? "passed"
          : test.outcome === "failed"
            ? "failed"
            : "skipped",
      duration: (test.duration || 0) * 1000, // Convert to ms
      error: test.call?.longrepr
        ? {
            message: test.call.longrepr,
          }
        : undefined,
    }));

    return {
      framework: "pytest",
      totalTests: data.summary.total,
      passed: data.summary.passed || 0,
      failed: data.summary.failed || 0,
      skipped: data.summary.skipped || 0,
      pending: 0,
      duration: data.duration * 1000,
      tests,
      errors: [],
    };
  } catch (error) {
    throw new Error(`Failed to parse pytest output: ${error}`);
  }
}

function parseGoTestOutput(stdout: string, stderr: string): TestSuiteResult {
  const lines = stdout.split("\n").filter((l) => l.trim());
  const tests: TestResult[] = [];
  let totalDuration = 0;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      if (
        event.Action === "pass" ||
        event.Action === "fail" ||
        event.Action === "skip"
      ) {
        tests.push({
          name: event.Test || event.Package,
          file: event.Package,
          status:
            event.Action === "pass"
              ? "passed"
              : event.Action === "fail"
                ? "failed"
                : "skipped",
          duration: (event.Elapsed || 0) * 1000,
          error:
            event.Output && event.Action === "fail"
              ? { message: event.Output }
              : undefined,
        });

        totalDuration += (event.Elapsed || 0) * 1000;
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  return {
    framework: "go-test",
    totalTests: tests.length,
    passed: tests.filter((t) => t.status === "passed").length,
    failed: tests.filter((t) => t.status === "failed").length,
    skipped: tests.filter((t) => t.status === "skipped").length,
    pending: 0,
    duration: totalDuration,
    tests,
    errors: [],
  };
}

function parseCargoTestOutput(stdout: string, stderr: string): TestSuiteResult {
  // Cargo test JSON output is experimental, parse text output as fallback
  const lines = stderr.split("\n");
  const tests: TestResult[] = [];

  const testRegex = /test (.+?) \.\.\. (\w+)/;
  const summaryRegex = /test result: (\w+)\. (\d+) passed; (\d+) failed/;

  let passed = 0;
  let failed = 0;

  for (const line of lines) {
    const testMatch = line.match(testRegex);
    if (testMatch) {
      tests.push({
        name: testMatch[1],
        file: "unknown",
        status:
          testMatch[2] === "ok"
            ? "passed"
            : testMatch[2] === "FAILED"
              ? "failed"
              : "skipped",
        duration: 0,
      });
    }

    const summaryMatch = line.match(summaryRegex);
    if (summaryMatch) {
      passed = parseInt(summaryMatch[2], 10);
      failed = parseInt(summaryMatch[3], 10);
    }
  }

  return {
    framework: "cargo-test",
    totalTests: tests.length,
    passed,
    failed,
    skipped: tests.filter((t) => t.status === "skipped").length,
    pending: 0,
    duration: 0,
    tests,
    errors: [],
  };
}

function parseRspecOutput(stdout: string, stderr: string): TestSuiteResult {
  try {
    const data = JSON.parse(stdout);

    const tests: TestResult[] = (data.examples || []).map((example: any) => ({
      name: example.description,
      file: example.file_path,
      status:
        example.status === "passed"
          ? "passed"
          : example.status === "failed"
            ? "failed"
            : "skipped",
      duration: example.run_time * 1000,
      error: example.exception
        ? {
            message: example.exception.message,
            stack: example.exception.backtrace?.join("\n"),
          }
        : undefined,
    }));

    return {
      framework: "rspec",
      totalTests: data.summary.example_count,
      passed: tests.filter((t) => t.status === "passed").length,
      failed: data.summary.failure_count,
      skipped: data.summary.pending_count,
      pending: 0,
      duration: data.summary.duration * 1000,
      tests,
      errors: [],
    };
  } catch (error) {
    throw new Error(`Failed to parse RSpec output: ${error}`);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function calculateCoverage(
  coverageMap: any,
  type: "lines" | "statements" | "functions" | "branches",
): { total: number; covered: number; percentage: number } {
  let total = 0;
  let covered = 0;

  for (const file in coverageMap) {
    const fileCoverage = coverageMap[file];
    const data = fileCoverage[type];

    if (data) {
      total += data.total;
      covered += data.covered;
    }
  }

  return {
    total,
    covered,
    percentage: total > 0 ? Math.round((covered / total) * 10000) / 100 : 0,
  };
}
