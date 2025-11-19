/**
 * Complete workflow example using the OSS AI Agent Tool SDK
 *
 * This example demonstrates:
 * - Creating a client
 * - Registering a custom tool
 * - Creating and executing a plan
 * - Handling real-time events
 * - Searching the codebase
 */

import {
  createClient,
  defineTool,
  ToolCapability,
  EventType
} from '@oss-ai-agent-tool/sdk';
import { readFile } from 'fs/promises';

async function main() {
  // 1. Create the orchestrator client
  console.log('🔌 Connecting to orchestrator...');
  const client = createClient({
    endpoint: process.env.ORCHESTRATOR_URL || 'http://localhost:3000',
    apiKey: process.env.API_KEY,
    timeout: 30000
  });

  // Check health
  const health = await client.healthCheck();
  console.log(`✓ Orchestrator status: ${health.status}`);
  console.log(`  Version: ${health.version}`);

  // 2. Register a custom tool
  console.log('\n🔧 Registering custom file reader tool...');
  const fileReaderTool = defineTool({
    name: 'File Reader',
    description: 'Reads content from a file with error handling',
    version: '1.0.0',
    capabilities: [ToolCapability.READ_FILES],
    inputSchema: {
      path: {
        type: 'string',
        description: 'Absolute or relative file path'
      },
      encoding: {
        type: 'string',
        enum: ['utf-8', 'ascii', 'base64'],
        default: 'utf-8'
      }
    },
    outputSchema: {
      content: {
        type: 'string',
        description: 'File content'
      },
      size: {
        type: 'number',
        description: 'File size in bytes'
      },
      lines: {
        type: 'number',
        description: 'Number of lines'
      }
    },
    examples: [
      {
        input: { path: './README.md', encoding: 'utf-8' },
        output: { content: '# My Project...', size: 1234, lines: 42 }
      }
    ]
  }, async (input, context) => {
    console.log(`[Tool] Reading file: ${input.path}`);

    try {
      const content = await readFile(input.path, input.encoding || 'utf-8');
      const lines = content.split('\n').length;

      return {
        content: content.toString(),
        size: Buffer.byteLength(content),
        lines
      };
    } catch (error: any) {
      throw new Error(`Failed to read file: ${error.message}`);
    }
  });

  const toolResult = await client.tools.register(
    fileReaderTool.definition,
    fileReaderTool.handler
  );
  console.log(`✓ Tool registered with ID: ${toolResult.id}`);

  // 3. List available tools
  console.log('\n📋 Available tools:');
  const tools = await client.tools.list();
  tools.slice(0, 5).forEach(tool => {
    console.log(`  - ${tool.name}: ${tool.description}`);
  });
  console.log(`  ... and ${tools.length - 5} more`);

  // 4. Perform semantic search
  console.log('\n🔍 Searching for authentication code...');
  const searchResults = await client.search.semantic(
    'user authentication and authorization',
    {
      limit: 3,
      filters: {
        language: 'typescript'
      }
    }
  );

  console.log(`✓ Found ${searchResults.total} results in ${searchResults.took}ms:`);
  searchResults.results.forEach((result, i) => {
    console.log(`  ${i + 1}. [Score: ${result.score.toFixed(2)}] ${result.metadata.file || 'unknown'}`);
    console.log(`     ${result.content.substring(0, 100)}...`);
  });

  // 5. Create a plan
  console.log('\n📝 Creating execution plan...');
  const plan = await client.plans.create({
    goal: 'Analyze the authentication module and suggest improvements',
    context: {
      focus: 'security',
      includeTests: true
    },
    constraints: {
      maxSteps: 10,
      maxDuration: 300000, // 5 minutes
      allowedTools: ['file-reader', 'code-analyzer', 'security-scanner'],
      budget: {
        maxCost: 0.50,
        maxTokens: 50000
      }
    },
    approvalMode: 'manual'
  });

  console.log(`✓ Plan created: ${plan.id}`);
  console.log(`  Status: ${plan.status}`);
  console.log(`  Steps: ${plan.steps.length}`);

  // Display plan steps
  console.log('\n  Plan steps:');
  plan.steps.forEach((step, i) => {
    console.log(`    ${i + 1}. ${step.action} (${step.tool})`);
    if (step.requiresApproval) {
      console.log(`       ⚠️  Requires approval`);
    }
  });

  // 6. Approve the plan
  console.log('\n✅ Approving plan...');
  await client.plans.approve(plan.id, 'Looks good, proceeding with analysis');

  // 7. Execute the plan with event streaming
  console.log('\n▶️  Executing plan...\n');

  let currentStep = 0;
  const startTime = Date.now();

  try {
    for await (const event of client.plans.execute(plan.id)) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      switch (event.type) {
        case EventType.PLAN_EXECUTING:
          console.log(`[${elapsed}s] 🚀 Plan execution started`);
          break;

        case EventType.STEP_STARTED:
          currentStep++;
          console.log(`[${elapsed}s] ⏳ Step ${currentStep}/${plan.steps.length}: ${event.data.action}`);
          break;

        case EventType.STEP_COMPLETED:
          console.log(`[${elapsed}s] ✓ Step completed`);
          if (event.data.result) {
            console.log(`     Result: ${JSON.stringify(event.data.result).substring(0, 80)}...`);
          }
          break;

        case EventType.STEP_FAILED:
          console.log(`[${elapsed}s] ✗ Step failed: ${event.data.error}`);
          break;

        case EventType.TOOL_INVOKED:
          console.log(`[${elapsed}s] 🔧 Tool invoked: ${event.data.tool}`);
          break;

        case EventType.APPROVAL_REQUIRED:
          console.log(`[${elapsed}s] ⚠️  Approval required for step: ${event.data.stepId}`);
          console.log(`     Reason: ${event.data.reason}`);

          // Auto-approve for this demo
          await client.plans.approveStep(plan.id, event.data.stepId);
          console.log(`[${elapsed}s] ✅ Step approved`);
          break;

        case EventType.PLAN_COMPLETED:
          console.log(`[${elapsed}s] 🎉 Plan completed successfully!`);
          if (event.data.result) {
            console.log('\n📊 Final Results:');
            console.log(JSON.stringify(event.data.result, null, 2));
          }
          break;

        case EventType.PLAN_FAILED:
          console.log(`[${elapsed}s] ❌ Plan failed: ${event.data.error}`);
          break;
      }
    }
  } catch (error: any) {
    console.error('\n❌ Execution error:', error.message);
    throw error;
  }

  // 8. Get final plan status
  console.log('\n📈 Fetching final plan status...');
  const finalPlan = await client.plans.get(plan.id);

  console.log(`\n✓ Execution Summary:`);
  console.log(`  Status: ${finalPlan.status}`);
  console.log(`  Duration: ${finalPlan.metadata?.duration}ms`);
  console.log(`  Total Cost: $${finalPlan.metadata?.totalCost?.toFixed(4)}`);
  console.log(`  Total Tokens: ${finalPlan.metadata?.totalTokens?.toLocaleString()}`);
  console.log(`  Steps Completed: ${finalPlan.steps.filter(s => s.status === 'completed').length}/${finalPlan.steps.length}`);

  // 9. List recent plans
  console.log('\n📚 Recent plans:');
  const recentPlans = await client.plans.list({ limit: 5 });
  recentPlans.plans.forEach(p => {
    console.log(`  - ${p.id}: ${p.goal.substring(0, 50)}... [${p.status}]`);
  });

  console.log('\n✨ Workflow complete!');
}

// Run the example
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
