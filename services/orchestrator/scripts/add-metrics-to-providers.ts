#!/usr/bin/env node
/**
 * Script to add Prometheus metrics to all provider implementations
 * This ensures consistent monitoring across all AI provider integrations
 */

import { promises as fs } from "fs";
import path from "path";

const PROVIDERS_DIR = path.join(__dirname, "../src/providers");

// Providers that need to be updated
const PROVIDERS_TO_UPDATE = [
  "google.ts",
  "azureOpenAI.ts",
  "bedrock.ts",
  "mistral.ts",
  "openrouter.ts",
  "ollama.ts"
];

interface UpdatePattern {
  name: string;
  importPattern: RegExp;
  importReplacement: string;
  clientRotationPattern: RegExp;
  clientRotationReplacement: string;
  chatMethodPattern: RegExp;
  chatMethodTransform: (match: string) => string;
}

// Generic patterns that work for most providers
const GENERIC_PATTERNS: UpdatePattern = {
  name: "generic",

  // Add metrics import
  importPattern: /from "\.\/utils\.js";/,
  importReplacement: `from "./utils.js";
import { ProviderRequestTimer, recordClientRotation } from "./metrics.js";`,

  // Add client rotation tracking in getClient method
  clientRotationPattern: /(if \(currentPromise && this\.areCredentialsEqual[^}]+\}\s+)\n(\s+const factory)/,
  clientRotationReplacement: `$1

    // Record client rotation metric when credentials change
    if (currentPromise) {
      recordClientRotation(this.name, "credential_change");
    }

$2`,

  // Transform chat method to add metrics
  chatMethodPattern: /async chat\(\s*req: ChatRequest,\s*_?context\?: ProviderContext[^{]*\{/,
  chatMethodTransform: (match: string) => {
    return match.replace("_context", "context");
  }
};

async function updateProvider(filePath: string): Promise<void> {
  try {
    console.log(`Updating ${path.basename(filePath)}...`);

    let content = await fs.readFile(filePath, "utf-8");
    const originalContent = content;

    // Skip if already has metrics import
    if (content.includes("./metrics.js")) {
      console.log(`  ✓ Already has metrics import, skipping`);
      return;
    }

    // Add metrics import
    content = content.replace(
      GENERIC_PATTERNS.importPattern,
      GENERIC_PATTERNS.importReplacement
    );

    // Add client rotation tracking
    if (content.includes("getClient")) {
      content = content.replace(
        GENERIC_PATTERNS.clientRotationPattern,
        GENERIC_PATTERNS.clientRotationReplacement
      );
    }

    // Update chat method signature to accept context
    content = content.replace(
      GENERIC_PATTERNS.chatMethodPattern,
      GENERIC_PATTERNS.chatMethodTransform
    );

    // Add metrics timer at the beginning of chat method
    const chatMethodRegex = /async chat\([^)]+\): Promise<ChatResponse> \{([^}]+?)(\n\s+const \w+ = )/;
    content = content.replace(chatMethodRegex, (match, beforeCode, constLine) => {
      // Extract model variable name
      const modelMatch = constLine.match(/const (\w+) = req\.model/);
      const modelVar = modelMatch ? modelMatch[1] : "model";

      return match.replace(constLine, `${beforeCode}

    // Start metrics timer
    const timer = new ProviderRequestTimer({
      provider: this.name,
      model: ${modelVar},
      operation: "chat",
      tenantId: context?.tenantId,
    });

    try {${constLine}`);
    });

    // Wrap the return statement with metrics recording
    const returnPattern = /return \{[\s\S]*?output[,\s]+provider:[^,]+,[\s\S]*?\};/g;
    content = content.replace(returnPattern, (match) => {
      // Extract usage calculation if present
      const usageMatch = match.match(/usage:[\s\S]*?undefined[,\s]*\}/);

      if (usageMatch) {
        // Add metrics recording before return
        return `const usage = ${usageMatch[0]};

      // Record success metrics
      timer.success({
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        totalTokens: usage?.totalTokens,
      });

      ${match.replace(usageMatch[0], "usage")}`;
      } else {
        // No usage tracking, just record success
        return `// Record success metrics
      timer.success();

      ${match}`;
      }
    });

    // Add error handling wrapper
    const chatMethodBodyRegex = /(async chat\([^{]+\{)([\s\S]*?)(\n\s+\})/;
    const bodyMatch = content.match(chatMethodBodyRegex);
    if (bodyMatch && !bodyMatch[2].includes("} catch (error)")) {
      // Wrap existing logic in try-catch
      const indentedBody = bodyMatch[2]
        .split("\n")
        .map(line => "  " + line)
        .join("\n");

      content = content.replace(chatMethodBodyRegex, `$1
    try {${indentedBody}
    } catch (error) {
      // Record error metrics if not already recorded
      if (error instanceof ProviderError) {
        timer.error(error);
      } else {
        timer.error({ status: 500, retryable: false });
      }
      throw error;
    }$3`);
    }

    if (content !== originalContent) {
      await fs.writeFile(filePath, content, "utf-8");
      console.log(`  ✓ Updated successfully`);
    } else {
      console.log(`  ℹ No changes needed`);
    }

  } catch (error) {
    console.error(`  ✗ Error updating ${path.basename(filePath)}:`, error);
  }
}

async function main() {
  console.log("Adding Prometheus metrics to provider implementations...\n");

  for (const provider of PROVIDERS_TO_UPDATE) {
    const filePath = path.join(PROVIDERS_DIR, provider);
    await updateProvider(filePath);
  }

  console.log("\n✅ Completed adding metrics to providers");
  console.log("\nNext steps:");
  console.log("1. Review the changes manually");
  console.log("2. Run tests to ensure everything works");
  console.log("3. Update provider tests to verify metrics");
}

main().catch(console.error);
