/* eslint-disable @typescript-eslint/no-explicit-any */
// justified: Repository tool handles various git operations with dynamic input/output
// Git command results and repository metadata vary by operation and can't be statically typed

import {
  McpTool,
  ToolMetadata,
  ToolCapability,
  ToolContext,
  ToolResult,
} from "../McpTool";
import {
  ContainerSandbox,
  ExecutionResult,
} from "../../sandbox/ContainerSandbox";
import { SandboxType, SandboxCapabilities } from "../../sandbox";
import path from "path";
import fs from "fs/promises";
import { z } from "zod";
import { Logger } from "pino";

// ============================================================================
// Input/Output Schemas
// ============================================================================

const GitCloneInputSchema = z.object({
  url: z.string().url(),
  branch: z.string().optional(),
  depth: z.number().min(1).optional(),
  targetDir: z.string().optional(),
  credentials: z
    .object({
      username: z.string().optional(),
      token: z.string().optional(),
      sshKey: z.string().optional(),
    })
    .optional(),
});

const GitCommitInputSchema = z.object({
  repoPath: z.string(),
  message: z.string().min(1),
  files: z.array(z.string()).optional(), // Specific files or all changes
  author: z
    .object({
      name: z.string(),
      email: z.string().email(),
    })
    .optional(),
});

const GitPushInputSchema = z.object({
  repoPath: z.string(),
  remote: z.string().default("origin"),
  branch: z.string().optional(),
  force: z.boolean().default(false),
  credentials: z
    .object({
      username: z.string().optional(),
      token: z.string().optional(),
      sshKey: z.string().optional(),
    })
    .optional(),
});

const CreatePullRequestInputSchema = z.object({
  repoPath: z.string(),
  title: z.string().min(1),
  body: z.string(),
  sourceBranch: z.string(),
  targetBranch: z.string().default("main"),
  provider: z.enum(["github", "gitlab", "bitbucket"]),
  credentials: z.object({
    token: z.string(),
  }),
});

const FileOperationInputSchema = z.object({
  repoPath: z.string(),
  operation: z.enum(["read", "write", "delete", "list"]),
  filePath: z.string(),
  content: z.string().optional(), // For write operations
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});

const GitStatusInputSchema = z.object({
  repoPath: z.string(),
});

const GitDiffInputSchema = z.object({
  repoPath: z.string(),
  ref1: z.string().optional(), // HEAD if not specified
  ref2: z.string().optional(), // Working directory if not specified
  filePath: z.string().optional(), // Specific file or all files
});

const GitLogInputSchema = z.object({
  repoPath: z.string(),
  maxCount: z.number().min(1).max(1000).default(50),
  since: z.string().optional(), // Date string or commit hash
  until: z.string().optional(),
  author: z.string().optional(),
  filePath: z.string().optional(),
});

export type GitCloneInput = z.infer<typeof GitCloneInputSchema>;
export type GitCommitInput = z.infer<typeof GitCommitInputSchema>;
export type GitPushInput = z.infer<typeof GitPushInputSchema>;
export type CreatePullRequestInput = z.infer<
  typeof CreatePullRequestInputSchema
>;
export type FileOperationInput = z.infer<typeof FileOperationInputSchema>;
export type GitStatusInput = z.infer<typeof GitStatusInputSchema>;
export type GitDiffInput = z.infer<typeof GitDiffInputSchema>;
export type GitLogInput = z.infer<typeof GitLogInputSchema>;

export interface GitCloneOutput {
  clonedPath: string;
  commitHash: string;
  branch: string;
}

export interface GitCommitOutput {
  commitHash: string;
  message: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface GitPushOutput {
  pushed: boolean;
  remote: string;
  branch: string;
  commits: number;
}

export interface PullRequestOutput {
  id: string;
  number: number;
  url: string;
  status: string;
}

export interface FileOperationOutput {
  success: boolean;
  path: string;
  content?: string;
  files?: string[];
  size?: number;
}

export interface GitStatusOutput {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicted: string[];
}

export interface GitDiffOutput {
  changes: Array<{
    file: string;
    insertions: number;
    deletions: number;
    diff: string;
  }>;
  totalInsertions: number;
  totalDeletions: number;
}

export interface GitLogOutput {
  commits: Array<{
    hash: string;
    shortHash: string;
    author: string;
    email: string;
    date: string;
    message: string;
    filesChanged?: number;
  }>;
  total: number;
}

// ============================================================================
// Repository Tool Configuration
// ============================================================================

export interface RepositoryToolConfig {
  workspaceRoot: string;
  maxRepoSize: number; // In bytes
  allowedHosts: string[]; // Whitelist of Git hosts
  defaultTimeout: number; // In milliseconds
  enableShallowClone: boolean;
  gitImage: string; // Docker image with Git
}

const DEFAULT_CONFIG: RepositoryToolConfig = {
  workspaceRoot: "/tmp/repos",
  maxRepoSize: 5 * 1024 * 1024 * 1024, // 5 GB
  allowedHosts: ["github.com", "gitlab.com", "bitbucket.org"],
  defaultTimeout: 5 * 60 * 1000, // 5 minutes
  enableShallowClone: true,
  gitImage: "alpine/git:latest",
};

// ============================================================================
// Repository Tool Implementation
// ============================================================================

export class RepositoryTool extends McpTool<any, any> {
  private sandbox: ContainerSandbox;
  private config: RepositoryToolConfig;

  constructor(logger: Logger, config: Partial<RepositoryToolConfig> = {}) {
    const metadata: ToolMetadata = {
      id: "repository",
      name: "Repository Tool",
      description:
        "Performs Git operations (clone, commit, push, PR creation) in isolated containers",
      version: "1.0.0",
      capabilities: [
        ToolCapability.READ_FILES,
        ToolCapability.WRITE_FILES,
        ToolCapability.EXECUTE_COMMANDS,
        ToolCapability.NETWORK_ACCESS,
        ToolCapability.GIT_OPERATIONS,
      ],
      requiresApproval: true, // Git operations can be destructive
      sandboxType: SandboxType.CONTAINER,
      sandboxCapabilities: {
        network: true,
        filesystem: true,
        heavyCompute: false,
        externalBinaries: true, // Git commands
      },
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: [
              "clone",
              "commit",
              "push",
              "pr",
              "file",
              "status",
              "diff",
              "log",
            ],
          },
          params: { type: "object" },
        },
        required: ["operation", "params"],
      },
      outputSchema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          data: { type: "object" },
        },
      },
    };

    super(metadata, logger);
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize container sandbox with Git capabilities
    this.sandbox = new ContainerSandbox({
      image: this.config.gitImage,
      workdir: "/workspace",
      logger: logger,
      limits: {
        memory: 2 * 1024 * 1024 * 1024, // 2 GB
        cpuQuota: 2,
        timeout: this.config.defaultTimeout,
      },
      networkPolicy: {
        allowAll: false,
        allowlist: this.config.allowedHosts,
      },
    });
  }

  // ============================================================================
  // Tool Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    await this.sandbox.prepare();
    // Ensure workspace root exists
    await fs.mkdir(this.config.workspaceRoot, { recursive: true });
    this.emit("initialized", { tool: this.metadata.id });
  }

  async shutdown(): Promise<void> {
    await this.sandbox.cleanup();
    this.emit("shutdown", { tool: this.metadata.id });
  }

  // ============================================================================
  // Main Execution Entry Point
  // ============================================================================

  protected async executeImpl(input: any, context: ToolContext): Promise<any> {
    const { operation, params } = input;

    switch (operation) {
      case "clone":
        return await this.clone(params, context);
      case "commit":
        return await this.commit(params, context);
      case "push":
        return await this.push(params, context);
      case "pr":
        return await this.createPullRequest(params, context);
      case "file":
        return await this.fileOperation(params, context);
      case "status":
        return await this.status(params, context);
      case "diff":
        return await this.diff(params, context);
      case "log":
        return await this.log(params, context);
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }

  protected async validateInput(input: any): Promise<void> {
    if (!input.operation || !input.params) {
      throw new Error("Invalid input: operation and params are required");
    }
  }

  // ============================================================================
  // Git Clone
  // ============================================================================

  private async clone(
    params: unknown,
    context: ToolContext,
  ): Promise<GitCloneOutput> {
    const input = GitCloneInputSchema.parse(params);

    // Validate allowed host
    const url = new URL(input.url);
    if (!this.config.allowedHosts.includes(url.hostname)) {
      throw new Error(`Git host ${url.hostname} is not in allowed list`);
    }

    const targetDir = input.targetDir || this.generateRepoDir(url);
    const fullPath = path.join(this.config.workspaceRoot, targetDir);

    // Build clone command
    const args: string[] = ["clone"];
    if (this.config.enableShallowClone && input.depth) {
      args.push("--depth", input.depth.toString());
    }
    if (input.branch) {
      args.push("--branch", input.branch);
    }

    // Handle credentials
    let cloneUrl = input.url;
    if (input.credentials?.token) {
      const urlObj = new URL(input.url);
      urlObj.username = input.credentials.username || "git";
      urlObj.password = input.credentials.token;
      cloneUrl = urlObj.toString();
    }

    args.push(cloneUrl, targetDir);

    this.emit("clone:started", { url: input.url, targetDir });

    const result = await this.sandbox.execute("git", args);

    if (result.exitCode !== 0) {
      this.emit("clone:failed", { url: input.url, error: result.stderr });
      throw new Error(`Git clone failed: ${result.stderr}`);
    }

    // Get commit hash and branch
    const hashResult = await this.sandbox.execute("git", [
      "-C",
      targetDir,
      "rev-parse",
      "HEAD",
    ]);
    const branchResult = await this.sandbox.execute("git", [
      "-C",
      targetDir,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);

    const output: GitCloneOutput = {
      clonedPath: fullPath,
      commitHash: hashResult.stdout.trim(),
      branch: branchResult.stdout.trim(),
    };

    this.emit("clone:completed", output);
    return output;
  }

  // ============================================================================
  // Git Commit
  // ============================================================================

  private async commit(
    params: unknown,
    context: ToolContext,
  ): Promise<GitCommitOutput> {
    const input = GitCommitInputSchema.parse(params);

    // Configure author if provided
    if (input.author) {
      await this.sandbox.execute("git", [
        "-C",
        input.repoPath,
        "config",
        "user.name",
        input.author.name,
      ]);
      await this.sandbox.execute("git", [
        "-C",
        input.repoPath,
        "config",
        "user.email",
        input.author.email,
      ]);
    }

    // Stage files
    const addArgs = ["-C", input.repoPath, "add"];
    if (input.files && input.files.length > 0) {
      addArgs.push(...input.files);
    } else {
      addArgs.push(".");
    }

    const addResult = await this.sandbox.execute("git", addArgs);
    if (addResult.exitCode !== 0) {
      throw new Error(`Git add failed: ${addResult.stderr}`);
    }

    this.emit("commit:started", {
      repoPath: input.repoPath,
      message: input.message,
    });

    // Commit
    const commitResult = await this.sandbox.execute("git", [
      "-C",
      input.repoPath,
      "commit",
      "-m",
      input.message,
    ]);

    if (commitResult.exitCode !== 0) {
      this.emit("commit:failed", {
        repoPath: input.repoPath,
        error: commitResult.stderr,
      });
      throw new Error(`Git commit failed: ${commitResult.stderr}`);
    }

    // Get commit hash
    const hashResult = await this.sandbox.execute("git", [
      "-C",
      input.repoPath,
      "rev-parse",
      "HEAD",
    ]);

    // Get stats
    const statsResult = await this.sandbox.execute("git", [
      "-C",
      input.repoPath,
      "show",
      "--stat",
      "--oneline",
      "HEAD",
    ]);

    const stats = this.parseCommitStats(statsResult.stdout);

    const output: GitCommitOutput = {
      commitHash: hashResult.stdout.trim(),
      message: input.message,
      filesChanged: stats.filesChanged,
      insertions: stats.insertions,
      deletions: stats.deletions,
    };

    this.emit("commit:completed", output);
    return output;
  }

  // ============================================================================
  // Git Push
  // ============================================================================

  private async push(
    params: unknown,
    context: ToolContext,
  ): Promise<GitPushOutput> {
    const input = GitPushInputSchema.parse(params);

    // Handle credentials
    if (input.credentials?.token) {
      // Set credential helper
      await this.sandbox.execute("git", [
        "-C",
        input.repoPath,
        "config",
        "credential.helper",
        "store",
      ]);
    }

    const args = ["-C", input.repoPath, "push"];
    if (input.force) {
      args.push("--force");
    }
    args.push(input.remote);
    if (input.branch) {
      args.push(input.branch);
    }

    this.emit("push:started", {
      repoPath: input.repoPath,
      remote: input.remote,
    });

    const result = await this.sandbox.execute("git", args);

    if (result.exitCode !== 0) {
      this.emit("push:failed", {
        repoPath: input.repoPath,
        error: result.stderr,
      });
      throw new Error(`Git push failed: ${result.stderr}`);
    }

    // Parse push output to count commits
    const commits = this.parsePushOutput(result.stderr);

    const output: GitPushOutput = {
      pushed: true,
      remote: input.remote,
      branch: input.branch || "current",
      commits,
    };

    this.emit("push:completed", output);
    return output;
  }

  // ============================================================================
  // Create Pull Request
  // ============================================================================

  private async createPullRequest(
    params: unknown,
    context: ToolContext,
  ): Promise<PullRequestOutput> {
    const input = CreatePullRequestInputSchema.parse(params);

    this.emit("pr:started", { title: input.title, provider: input.provider });

    // Provider-specific PR creation using their APIs
    let prData: PullRequestOutput;

    switch (input.provider) {
      case "github":
        prData = await this.createGitHubPR(input);
        break;
      case "gitlab":
        prData = await this.createGitLabMR(input);
        break;
      case "bitbucket":
        prData = await this.createBitbucketPR(input);
        break;
      default:
        throw new Error(`Unsupported provider: ${input.provider}`);
    }

    this.emit("pr:completed", prData);
    return prData;
  }

  // ============================================================================
  // File Operations
  // ============================================================================

  private async fileOperation(
    params: unknown,
    context: ToolContext,
  ): Promise<FileOperationOutput> {
    const input = FileOperationInputSchema.parse(params);

    const fullPath = path.join(input.repoPath, input.filePath);

    switch (input.operation) {
      case "read": {
        const result = await this.sandbox.execute("cat", [fullPath]);
        if (result.exitCode !== 0) {
          throw new Error(`Failed to read file: ${result.stderr}`);
        }
        return {
          success: true,
          path: fullPath,
          content: result.stdout,
          size: Buffer.byteLength(result.stdout),
        };
      }

      case "write": {
        if (!input.content) {
          throw new Error("Content is required for write operation");
        }
        // Use tee to write content
        const result = await this.sandbox.execute("sh", [
          "-c",
          `echo '${input.content.replace(/'/g, "'\\''")}' > ${fullPath}`,
        ]);
        if (result.exitCode !== 0) {
          throw new Error(`Failed to write file: ${result.stderr}`);
        }
        return { success: true, path: fullPath, size: input.content.length };
      }

      case "delete": {
        const result = await this.sandbox.execute("rm", ["-f", fullPath]);
        if (result.exitCode !== 0) {
          throw new Error(`Failed to delete file: ${result.stderr}`);
        }
        return { success: true, path: fullPath };
      }

      case "list": {
        const result = await this.sandbox.execute("ls", ["-1", fullPath]);
        if (result.exitCode !== 0) {
          throw new Error(`Failed to list files: ${result.stderr}`);
        }
        return {
          success: true,
          path: fullPath,
          files: result.stdout.split("\n").filter((f) => f.trim()),
        };
      }

      default:
        throw new Error(`Unknown file operation: ${input.operation}`);
    }
  }

  // ============================================================================
  // Git Status
  // ============================================================================

  private async status(
    params: unknown,
    context: ToolContext,
  ): Promise<GitStatusOutput> {
    const input = GitStatusInputSchema.parse(params);

    const result = await this.sandbox.execute("git", [
      "-C",
      input.repoPath,
      "status",
      "--porcelain=v2",
      "--branch",
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`Git status failed: ${result.stderr}`);
    }

    return this.parseGitStatus(result.stdout);
  }

  // ============================================================================
  // Git Diff
  // ============================================================================

  private async diff(
    params: unknown,
    context: ToolContext,
  ): Promise<GitDiffOutput> {
    const input = GitDiffInputSchema.parse(params);

    const args = ["-C", input.repoPath, "diff", "--numstat"];
    if (input.ref1) args.push(input.ref1);
    if (input.ref2) args.push(input.ref2);
    if (input.filePath) args.push("--", input.filePath);

    const result = await this.sandbox.execute("git", args);

    if (result.exitCode !== 0) {
      throw new Error(`Git diff failed: ${result.stderr}`);
    }

    return this.parseGitDiff(result.stdout);
  }

  // ============================================================================
  // Git Log
  // ============================================================================

  private async log(
    params: unknown,
    context: ToolContext,
  ): Promise<GitLogOutput> {
    const input = GitLogInputSchema.parse(params);

    const args = [
      "-C",
      input.repoPath,
      "log",
      `--max-count=${input.maxCount}`,
      "--pretty=format:%H|%h|%an|%ae|%ai|%s",
      "--numstat",
    ];

    if (input.since) args.push(`--since=${input.since}`);
    if (input.until) args.push(`--until=${input.until}`);
    if (input.author) args.push(`--author=${input.author}`);
    if (input.filePath) args.push("--", input.filePath);

    const result = await this.sandbox.execute("git", args);

    if (result.exitCode !== 0) {
      throw new Error(`Git log failed: ${result.stderr}`);
    }

    return this.parseGitLog(result.stdout);
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private generateRepoDir(url: URL): string {
    const parts = url.pathname.split("/").filter((p) => p);
    return parts.join("_").replace(/\.git$/, "");
  }

  private parseCommitStats(output: string): {
    filesChanged: number;
    insertions: number;
    deletions: number;
  } {
    // Example: "3 files changed, 45 insertions(+), 12 deletions(-)"
    const match = output.match(
      /(\d+) file[s]? changed(?:, (\d+) insertion[s]?\(\+\))?(?:, (\d+) deletion[s]?\(-\))?/,
    );
    return {
      filesChanged: match ? parseInt(match[1], 10) : 0,
      insertions: match && match[2] ? parseInt(match[2], 10) : 0,
      deletions: match && match[3] ? parseInt(match[3], 10) : 0,
    };
  }

  private parsePushOutput(output: string): number {
    // Parse stderr for commit count (e.g., "main -> main (3 commits)")
    const match = output.match(/\((\d+) commit[s]?\)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  private parseGitStatus(output: string): GitStatusOutput {
    const lines = output.split("\n");
    const status: GitStatusOutput = {
      branch: "",
      ahead: 0,
      behind: 0,
      staged: [],
      modified: [],
      untracked: [],
      conflicted: [],
    };

    for (const line of lines) {
      if (line.startsWith("# branch.head")) {
        status.branch = line.split(" ")[2];
      } else if (line.startsWith("# branch.ab")) {
        const parts = line.split(" ");
        status.ahead = parseInt(parts[2].replace("+", ""), 10);
        status.behind = parseInt(parts[3].replace("-", ""), 10);
      } else if (line.startsWith("1") || line.startsWith("2")) {
        const parts = line.split(" ");
        const xy = parts[1];
        const file = parts[parts.length - 1];

        if (xy[0] !== "." && xy[1] === ".") status.staged.push(file);
        if (xy[1] !== ".") status.modified.push(file);
        if (xy.includes("U")) status.conflicted.push(file);
      } else if (line.startsWith("?")) {
        status.untracked.push(line.split(" ")[1]);
      }
    }

    return status;
  }

  private parseGitDiff(output: string): GitDiffOutput {
    const lines = output.split("\n").filter((l) => l.trim());
    const changes = lines.map((line) => {
      const [insertions, deletions, file] = line.split("\t");
      return {
        file,
        insertions: parseInt(insertions, 10) || 0,
        deletions: parseInt(deletions, 10) || 0,
        diff: "", // Placeholder - full diff would require separate call
      };
    });

    const totalInsertions = changes.reduce((sum, c) => sum + c.insertions, 0);
    const totalDeletions = changes.reduce((sum, c) => sum + c.deletions, 0);

    return { changes, totalInsertions, totalDeletions };
  }

  private parseGitLog(output: string): GitLogOutput {
    const commitBlocks = output.split("\n\n").filter((b) => b.trim());
    const commits = commitBlocks.map((block) => {
      const lines = block.split("\n");
      const [hash, shortHash, author, email, date, message] =
        lines[0].split("|");

      // Count files changed from numstat lines
      const filesChanged = lines
        .slice(1)
        .filter((l) => l.match(/^\d+\t\d+\t/)).length;

      return {
        hash,
        shortHash,
        author,
        email,
        date,
        message,
        filesChanged: filesChanged > 0 ? filesChanged : undefined,
      };
    });

    return { commits, total: commits.length };
  }

  // ============================================================================
  // Provider-Specific PR Creation
  // ============================================================================

  private async createGitHubPR(
    input: CreatePullRequestInput,
  ): Promise<PullRequestOutput> {
    // Extract owner/repo from repo path
    const repoInfo = await this.getRepoInfo(input.repoPath);

    const response = await fetch(
      `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/pulls`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${input.credentials.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.sourceBranch,
          base: input.targetBranch,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub PR creation failed: ${await response.text()}`);
    }

    const data = await response.json();

    return {
      id: data.id.toString(),
      number: data.number,
      url: data.html_url,
      status: data.state,
    };
  }

  private async createGitLabMR(
    input: CreatePullRequestInput,
  ): Promise<PullRequestOutput> {
    const repoInfo = await this.getRepoInfo(input.repoPath);

    const response = await fetch(
      `https://gitlab.com/api/v4/projects/${encodeURIComponent(
        `${repoInfo.owner}/${repoInfo.repo}`,
      )}/merge_requests`,
      {
        method: "POST",
        headers: {
          "PRIVATE-TOKEN": input.credentials.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: input.title,
          description: input.body,
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`GitLab MR creation failed: ${await response.text()}`);
    }

    const data = await response.json();

    return {
      id: data.iid.toString(),
      number: data.iid,
      url: data.web_url,
      status: data.state,
    };
  }

  private async createBitbucketPR(
    input: CreatePullRequestInput,
  ): Promise<PullRequestOutput> {
    const repoInfo = await this.getRepoInfo(input.repoPath);

    const response = await fetch(
      `https://api.bitbucket.org/2.0/repositories/${repoInfo.owner}/${repoInfo.repo}/pullrequests`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.credentials.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: input.title,
          description: input.body,
          source: { branch: { name: input.sourceBranch } },
          destination: { branch: { name: input.targetBranch } },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Bitbucket PR creation failed: ${await response.text()}`);
    }

    const data = await response.json();

    return {
      id: data.id.toString(),
      number: data.id,
      url: data.links.html.href,
      status: data.state,
    };
  }

  private async getRepoInfo(
    repoPath: string,
  ): Promise<{ owner: string; repo: string }> {
    const result = await this.sandbox.execute("git", [
      "-C",
      repoPath,
      "config",
      "--get",
      "remote.origin.url",
    ]);

    if (result.exitCode !== 0) {
      throw new Error("Failed to get remote URL");
    }

    const url = result.stdout.trim();
    // Parse git@github.com:owner/repo.git or https://github.com/owner/repo.git
    const match = url.match(/[:/]([^/]+)\/([^/]+?)(\.git)?$/);
    if (!match) {
      throw new Error(`Cannot parse repository URL: ${url}`);
    }

    return { owner: match[1], repo: match[2] };
  }
}
