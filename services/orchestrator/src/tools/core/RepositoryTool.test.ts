import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  RepositoryTool,
  GitCloneInput,
  GitCommitInput,
  GitPushInput,
} from "./RepositoryTool";
import { ToolContext } from "../McpTool";
import { ContainerSandbox } from "../../sandbox/ContainerSandbox";
import pino from "pino";

vi.mock("../../sandbox/ContainerSandbox");

describe("RepositoryTool", () => {
  let tool: RepositoryTool;
  let mockSandbox: any;
  let mockContext: ToolContext;
  let mockLogger: pino.Logger;

  beforeEach(() => {
    mockLogger = pino({ level: "silent" });

    mockContext = {
      requestApproval: vi.fn().mockResolvedValue(true),
      tenantId: "test-tenant",
      userId: "test-user",
      sessionId: "test-session",
    } as any;

    tool = new RepositoryTool(mockLogger, {
      workspaceRoot: "/tmp/test-repos",
      allowedHosts: ["github.com", "gitlab.com"],
      defaultTimeout: 30000,
    });

    mockSandbox = (tool as any).sandbox;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Git Clone Tests
  // ==========================================================================

  describe("clone", () => {
    it("should clone a repository successfully", async () => {
      mockSandbox.execute
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "Cloning into...",
          duration: 1000,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "abc123def456\n",
          stderr: "",
          duration: 100,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "main\n",
          stderr: "",
          duration: 100,
        });

      const input = {
        operation: "clone",
        params: {
          url: "https://github.com/owner/repo.git",
          branch: "main",
          depth: 1,
        },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.commitHash).toBe("abc123def456");
      expect(result.data.branch).toBe("main");
      expect(mockSandbox.execute).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["clone"]),
      );
    });

    it("should reject clone from non-allowed host", async () => {
      const input = {
        operation: "clone",
        params: {
          url: "https://malicious.com/repo.git",
        },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not in allowed list");
    });

    it("should handle credentials in clone", async () => {
      mockSandbox.execute
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          duration: 1000,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "abc123\n",
          stderr: "",
          duration: 100,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "main\n",
          stderr: "",
          duration: 100,
        });

      const input = {
        operation: "clone",
        params: {
          url: "https://github.com/owner/repo.git",
          credentials: {
            username: "user",
            token: "ghp_token123",
          },
        },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(true);
      // Verify that credentials were embedded in URL (check call args)
      const cloneCall = mockSandbox.execute.mock.calls[0];
      const cloneArgs = cloneCall[1];
      // Check if any of the arguments contain the username
      const hasCredentials = cloneArgs.some((arg: string) =>
        arg.includes("user"),
      );
      expect(hasCredentials).toBe(true);
    });

    it("should emit clone events", async () => {
      mockSandbox.execute
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          duration: 1000,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "abc\n",
          stderr: "",
          duration: 100,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "main\n",
          stderr: "",
          duration: 100,
        });

      const startedSpy = vi.fn();
      const completedSpy = vi.fn();
      tool.on("clone:started", startedSpy);
      tool.on("clone:completed", completedSpy);

      const input = {
        operation: "clone",
        params: { url: "https://github.com/owner/repo.git" },
      };

      await tool.execute(input, mockContext);

      expect(startedSpy).toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.any(String) }),
      );
      expect(completedSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          commitHash: "abc",
          branch: "main",
        }),
      );
    });

    it("should handle clone failure", async () => {
      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 128,
        stdout: "",
        stderr: "fatal: repository not found",
        duration: 500,
      });

      const input = {
        operation: "clone",
        params: { url: "https://github.com/owner/nonexistent.git" },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Git clone failed");
    });
  });

  // ==========================================================================
  // Git Commit Tests
  // ==========================================================================

  describe("commit", () => {
    it("should commit changes successfully", async () => {
      mockSandbox.execute
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          duration: 100,
        }) // config user.name
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          duration: 100,
        }) // config user.email
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          duration: 200,
        }) // git add
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "[main abc123] Test commit",
          stderr: "",
          duration: 300,
        }) // git commit
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "abc123def\n",
          stderr: "",
          duration: 100,
        }) // rev-parse
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: " 3 files changed, 45 insertions(+), 12 deletions(-)",
          stderr: "",
          duration: 100,
        }); // show --stat

      const input = {
        operation: "commit",
        params: {
          repoPath: "/tmp/repo",
          message: "Test commit",
          author: {
            name: "Test User",
            email: "test@example.com",
          },
        },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.commitHash).toBe("abc123def");
      expect(result.data.filesChanged).toBe(3);
      expect(result.data.insertions).toBe(45);
      expect(result.data.deletions).toBe(12);
    });

    it("should commit specific files", async () => {
      mockSandbox.execute
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          duration: 100,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "[main abc] Commit",
          stderr: "",
          duration: 200,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "abc\n",
          stderr: "",
          duration: 100,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: " 1 file changed, 10 insertions(+)",
          stderr: "",
          duration: 100,
        });

      const input = {
        operation: "commit",
        params: {
          repoPath: "/tmp/repo",
          message: "Update file",
          files: ["src/index.ts"],
        },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(true);
      const addCall = mockSandbox.execute.mock.calls.find((call: any) =>
        call[1].includes("add"),
      );
      expect(addCall![1]).toContain("src/index.ts");
    });

    it("should handle commit with no changes", async () => {
      mockSandbox.execute
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          duration: 100,
        })
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: "",
          stderr: "nothing to commit",
          duration: 100,
        });

      const input = {
        operation: "commit",
        params: {
          repoPath: "/tmp/repo",
          message: "Empty commit",
        },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Git commit failed");
    });
  });

  // ==========================================================================
  // Git Push Tests
  // ==========================================================================

  describe("push", () => {
    it("should push changes successfully", async () => {
      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr:
          "To https://github.com/owner/repo.git\n   abc123..def456  main -> main (3 commits)",
        duration: 2000,
      });

      const input = {
        operation: "push",
        params: {
          repoPath: "/tmp/repo",
          remote: "origin",
          branch: "main",
        },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.pushed).toBe(true);
      expect(result.data.commits).toBe(3);
    });

    it("should handle force push", async () => {
      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        duration: 2000,
      });

      const input = {
        operation: "push",
        params: {
          repoPath: "/tmp/repo",
          force: true,
        },
      };

      await tool.execute(input, mockContext);

      const pushCall = mockSandbox.execute.mock.calls[0];
      expect(pushCall[1]).toContain("--force");
    });

    it("should handle push rejection", async () => {
      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "error: failed to push some refs",
        duration: 1000,
      });

      const input = {
        operation: "push",
        params: {
          repoPath: "/tmp/repo",
        },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Git push failed");
    });
  });

  // ==========================================================================
  // File Operations Tests
  // ==========================================================================

  describe("file operations", () => {
    it("should read file successfully", async () => {
      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'console.log("hello");',
        stderr: "",
        duration: 100,
      });

      const input = {
        operation: "file",
        params: {
          repoPath: "/tmp/repo",
          operation: "read",
          filePath: "src/index.js",
        },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.content).toBe('console.log("hello");');
    });

    it("should write file successfully", async () => {
      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        duration: 100,
      });

      const input = {
        operation: "file",
        params: {
          repoPath: "/tmp/repo",
          operation: "write",
          filePath: "README.md",
          content: "# Test Project",
        },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(true);
    });

    it("should delete file successfully", async () => {
      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        duration: 100,
      });

      const input = {
        operation: "file",
        params: {
          repoPath: "/tmp/repo",
          operation: "delete",
          filePath: "old-file.txt",
        },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(true);
    });

    it("should list files successfully", async () => {
      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "file1.ts\nfile2.ts\nfile3.ts",
        stderr: "",
        duration: 100,
      });

      const input = {
        operation: "file",
        params: {
          repoPath: "/tmp/repo",
          operation: "list",
          filePath: "src/",
        },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.files).toEqual(["file1.ts", "file2.ts", "file3.ts"]);
    });
  });

  // ==========================================================================
  // Git Status Tests
  // ==========================================================================

  describe("status", () => {
    it("should parse git status correctly", async () => {
      const statusOutput = `# branch.oid abc123
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
1 .M N... 100644 100644 100644 xyz123 xyz456 src/index.ts
? untracked.txt`;

      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 0,
        stdout: statusOutput,
        stderr: "",
        duration: 100,
      });

      const input = {
        operation: "status",
        params: { repoPath: "/tmp/repo" },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.branch).toBe("main");
      expect(result.data.ahead).toBe(2);
      expect(result.data.behind).toBe(1);
      expect(result.data.modified).toContain("src/index.ts");
      expect(result.data.untracked).toContain("untracked.txt");
    });
  });

  // ==========================================================================
  // Git Diff Tests
  // ==========================================================================

  describe("diff", () => {
    it("should parse git diff stats", async () => {
      const diffOutput = `10\t5\tsrc/index.ts
3\t2\tREADME.md
0\t8\ttest.js`;

      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 0,
        stdout: diffOutput,
        stderr: "",
        duration: 200,
      });

      const input = {
        operation: "diff",
        params: { repoPath: "/tmp/repo" },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.changes).toHaveLength(3);
      expect(result.data.totalInsertions).toBe(13);
      expect(result.data.totalDeletions).toBe(15);
    });
  });

  // ==========================================================================
  // Git Log Tests
  // ==========================================================================

  describe("log", () => {
    it("should parse git log correctly", async () => {
      const logOutput = `abc123def456|abc123|John Doe|john@example.com|2024-01-15 10:30:00 +0000|Initial commit
10\t0\tsrc/index.ts
5\t0\tREADME.md

def789ghi012|def789|Jane Smith|jane@example.com|2024-01-16 14:20:00 +0000|Add tests
15\t2\ttest/index.test.ts`;

      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 0,
        stdout: logOutput,
        stderr: "",
        duration: 300,
      });

      const input = {
        operation: "log",
        params: {
          repoPath: "/tmp/repo",
          maxCount: 10,
        },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.commits).toHaveLength(2);
      expect(result.data.commits[0].hash).toBe("abc123def456");
      expect(result.data.commits[0].author).toBe("John Doe");
      expect(result.data.commits[0].filesChanged).toBe(2);
    });

    it("should filter log by author", async () => {
      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        duration: 200,
      });

      const input = {
        operation: "log",
        params: {
          repoPath: "/tmp/repo",
          author: "John Doe",
        },
      };

      await tool.execute(input, mockContext);

      const logCall = mockSandbox.execute.mock.calls[0];
      expect(logCall[1]).toContain("--author=John Doe");
    });
  });

  // ==========================================================================
  // Approval Workflow Tests
  // ==========================================================================

  describe("approval workflow", () => {
    it("should request approval before execution", async () => {
      mockSandbox.execute
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          duration: 100,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "abc\n",
          stderr: "",
          duration: 100,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "main\n",
          stderr: "",
          duration: 100,
        });

      const input = {
        operation: "clone",
        params: { url: "https://github.com/owner/repo.git" },
      };

      await tool.execute(input, mockContext);

      expect(mockContext.requestApproval).toHaveBeenCalled();
    });

    it("should abort if approval denied", async () => {
      mockContext.requestApproval = vi.fn().mockResolvedValue(false);

      const input = {
        operation: "push",
        params: { repoPath: "/tmp/repo" },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain("denied");
    });
  });

  // ==========================================================================
  // Error Handling Tests
  // ==========================================================================

  describe("error handling", () => {
    it("should validate input schema", async () => {
      const invalidInput = {
        operation: "clone",
        params: {
          url: "not-a-url",
        },
      };

      const result = await tool.execute(invalidInput, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it("should handle sandbox execution errors", async () => {
      mockSandbox.execute.mockRejectedValueOnce(
        new Error("Container failed to start"),
      );

      const input = {
        operation: "status",
        params: { repoPath: "/tmp/repo" },
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Container failed");
    });

    it("should handle unknown operations", async () => {
      const input = {
        operation: "unknown",
        params: {},
      };

      const result = await tool.execute(input, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown operation");
    });
  });

  // ==========================================================================
  // Integration Tests
  // ==========================================================================

  describe("integration scenarios", () => {
    it("should support full workflow: clone -> modify -> commit -> push", async () => {
      // Clone
      mockSandbox.execute
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          duration: 1000,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "abc123\n",
          stderr: "",
          duration: 100,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "main\n",
          stderr: "",
          duration: 100,
        });

      const cloneResult = await tool.execute(
        {
          operation: "clone",
          params: { url: "https://github.com/owner/repo.git" },
        },
        mockContext,
      );

      expect(cloneResult.success).toBe(true);

      // Write file
      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        duration: 100,
      });

      const writeResult = await tool.execute(
        {
          operation: "file",
          params: {
            repoPath: "/tmp/repo",
            operation: "write",
            filePath: "new-file.txt",
            content: "Hello",
          },
        },
        mockContext,
      );

      expect(writeResult.success).toBe(true);

      // Commit
      mockSandbox.execute
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          duration: 100,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
          duration: 200,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "def456\n",
          stderr: "",
          duration: 100,
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: " 1 file changed, 1 insertion(+)",
          stderr: "",
          duration: 100,
        });

      const commitResult = await tool.execute(
        {
          operation: "commit",
          params: {
            repoPath: "/tmp/repo",
            message: "Add new file",
          },
        },
        mockContext,
      );

      expect(commitResult.success).toBe(true);

      // Push
      mockSandbox.execute.mockResolvedValueOnce({
        exitCode: 0,
        stdout: "",
        stderr: "",
        duration: 2000,
      });

      const pushResult = await tool.execute(
        {
          operation: "push",
          params: { repoPath: "/tmp/repo" },
        },
        mockContext,
      );

      expect(pushResult.success).toBe(true);
    });
  });
});
