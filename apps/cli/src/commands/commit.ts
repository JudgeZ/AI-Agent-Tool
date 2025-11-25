import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { requestCommitMessage } from "./chat";
import { printLine } from "../output";

const execFileAsync = promisify(execFile);

async function requirePendingChanges(): Promise<void> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: process.cwd(),
  });
  if (!stdout.trim()) {
    throw new Error("Working directory is clean. Make changes before running /commit.");
  }
}

export async function runCommit(goal?: string): Promise<void> {
  await requirePendingChanges();
  const { stdout: diff } = await execFileAsync("git", ["diff", "--cached"], {
    cwd: process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
  });
  if (!diff.trim()) {
    throw new Error("No staged changes found. Stage files before running /commit.");
  }

  const message = await requestCommitMessage(diff, goal);
  const sanitizedMessage = message.split("\n")[0].trim();
  if (!sanitizedMessage) {
    throw new Error("Gateway did not return a usable commit message.");
  }
  if (sanitizedMessage.startsWith("-")) {
    throw new Error("Commit message cannot start with '-'.");
  }
  if (sanitizedMessage.includes("\0")) {
    throw new Error("Commit message contains invalid characters.");
  }

  await execFileAsync("git", ["commit", "-m", sanitizedMessage], {
    cwd: process.cwd(),
  });
  printLine("Committed with message:", sanitizedMessage);
}
