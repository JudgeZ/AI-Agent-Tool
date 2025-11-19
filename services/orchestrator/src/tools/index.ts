/**
 * Tools module - Global tool registry and initialization
 */

import { appLogger } from "../observability/logger.js";
import { ToolRegistry } from "./ToolRegistry.js";
import { BrowserTool } from "./core/BrowserTool.js";
import { DatabaseTool } from "./core/DatabaseTool.js";
import { RepositoryTool } from "./core/RepositoryTool.js";
import { TestRunnerTool } from "./core/TestRunnerTool.js";

// Export types
export { ToolRegistry } from "./ToolRegistry.js";
export { McpTool, ToolCapability, type ToolMetadata } from "./McpTool.js";
export { BrowserTool } from "./core/BrowserTool.js";
export { DatabaseTool } from "./core/DatabaseTool.js";
export { RepositoryTool } from "./core/RepositoryTool.js";
export { TestRunnerTool } from "./core/TestRunnerTool.js";

// Global registry instance
let globalRegistry: ToolRegistry | null = null;

/**
 * Initialize the global tool registry with core tools
 */
export async function initializeToolRegistry(): Promise<ToolRegistry> {
  if (globalRegistry) {
    return globalRegistry;
  }

  appLogger.info("Initializing global tool registry");

  // Create registry
  globalRegistry = new ToolRegistry(appLogger);

  // Register core tools
  try {
    // Browser automation tool
    const browserTool = new BrowserTool(appLogger);
    globalRegistry.register(browserTool);

    // Database interaction tool
    const databaseTool = new DatabaseTool(appLogger);
    globalRegistry.register(databaseTool);

    // Repository management tool
    const repositoryTool = new RepositoryTool(appLogger);
    globalRegistry.register(repositoryTool);

    // Test runner tool
    const testRunnerTool = new TestRunnerTool(appLogger);
    globalRegistry.register(testRunnerTool);

    appLogger.info(
      { toolCount: globalRegistry.list().length },
      "Tool registry initialized with core tools"
    );
  } catch (error) {
    appLogger.error(
      { err: error },
      "Failed to register core tools"
    );
    throw error;
  }

  return globalRegistry;
}

/**
 * Get the global tool registry instance
 * @throws Error if registry is not initialized
 */
export function getToolRegistry(): ToolRegistry {
  if (!globalRegistry) {
    throw new Error("Tool registry not initialized. Call initializeToolRegistry() first.");
  }
  return globalRegistry;
}

/**
 * Shutdown the tool registry
 */
export async function shutdownToolRegistry(): Promise<void> {
  if (!globalRegistry) {
    return;
  }

  appLogger.info("Shutting down tool registry");

  // Cleanup all tools
  const tools = globalRegistry.list();
  for (const tool of tools) {
    try {
      await globalRegistry.unregister(tool.id);
    } catch (error) {
      appLogger.error(
        { err: error, toolId: tool.id },
        "Error unregistering tool during shutdown"
      );
    }
  }

  globalRegistry = null;

  appLogger.info("Tool registry shut down");
}
