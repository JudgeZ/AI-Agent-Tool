import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { requestCommitMessage } from "./chat";
import { printLine } from "../output";

const execFileAsync = promisify(execFile);

async function requireCleanIndex(): Promise<void> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: process.cwd(),
  });
  if (!stdout.trim()) {
    throw new Error("No changes to commit. Stage files before running /commit.");
  }
}

export async function runCommit(goal?: string): Promise<void> {
  await requireCleanIndex();
  const { stdout: diff } = await execFileAsync("git", ["diff", "--cached"], {
    cwd: process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
  });
  if (!diff.trim()) {
    throw new Error("No staged changes found. Stage files before running /commit.");
  }

  const message = await requestCommitMessage(diff, goal);
  const sanitizedMessage = message.trim();
  if (!sanitizedMessage) {
    throw new Error("Gateway did not return a usable commit message.");
  }

  await execFileAsync("git", ["commit", "-m", sanitizedMessage], {
    cwd: process.cwd(),
  });
  printLine("Committed with message:", sanitizedMessage);
}
