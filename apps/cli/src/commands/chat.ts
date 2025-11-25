import { GatewayConfig, postJson, resolveGatewayConfig } from "../gateway";
import { printLine } from "../output";

interface ChatResponse {
  response: {
    output: string;
    provider?: string;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    };
    warnings?: string[];
  };
  requestId?: string;
  traceId?: string;
}

function formatUsage(usage?: ChatResponse["response"]["usage"]): string | undefined {
  if (!usage) return undefined;
  const parts: string[] = [];
  if (typeof usage.promptTokens === "number") {
    parts.push(`prompt=${usage.promptTokens}`);
  }
  if (typeof usage.completionTokens === "number") {
    parts.push(`completion=${usage.completionTokens}`);
  }
  if (typeof usage.totalTokens === "number") {
    parts.push(`total=${usage.totalTokens}`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

async function sendChat(
  message: string,
  config: GatewayConfig,
  options?: {
    model?: string;
    provider?: string;
    temperature?: number;
    routing?: "balanced" | "high_quality" | "low_cost" | "default";
  },
): Promise<ChatResponse> {
  const payload: Record<string, unknown> = {
    messages: [{ role: "user", content: message }],
  };
  if (options?.model) payload.model = options.model;
  if (options?.provider) payload.provider = options.provider;
  if (typeof options?.temperature === "number") {
    payload.temperature = options.temperature;
  }
  if (options?.routing) payload.routing = options.routing;

  return postJson<ChatResponse>("chat", payload, config);
}

export async function runChat(
  message: string,
  options?: { model?: string; provider?: string; temperature?: number },
): Promise<void> {
  if (!message.trim()) {
    throw new Error("Chat message is required");
  }
  const config = resolveGatewayConfig();
  const response = await sendChat(message, config, options);
  printLine(response.response.output);
  if (response.response.provider) {
    printLine("Provider:", response.response.provider);
  }
  const usageText = formatUsage(response.response.usage);
  if (usageText) {
    printLine("Usage:", usageText);
  }
  if (response.response.warnings?.length) {
    for (const warning of response.response.warnings) {
      printLine("Warning:", warning);
    }
  }
}

export async function requestCommitMessage(diff: string, goal?: string): Promise<string> {
  const config = resolveGatewayConfig();
  const prompt = [
    "Generate a concise git commit message in imperative mood for the following diff.",
    goal ? `Goal: ${goal}` : "",
    "Limit the message to 72 characters.",
    "Diff:",
    diff,
  ]
    .filter(Boolean)
    .join("\n");
  const response = await sendChat(prompt, config, { routing: "low_cost" });
  return response.response.output.split("\n")[0].trim();
}
