import fs from "node:fs/promises";
import path from "node:path";

export interface PlanStep {
  id: string;
  action: string;
  tool: string;
  capability: string;
  capabilityLabel: string;
  timeoutSeconds: number;
  approvalRequired: boolean;
  labels?: string[];
}

export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  successCriteria?: string[];
}

interface GatewayConfig {
  baseUrl: string;
  token?: string;
  timeoutMs: number;
}

const DEFAULT_GATEWAY_URL = "http://localhost:8080";
const DEFAULT_TIMEOUT_MS = 30_000;

function resolveGatewayConfig(): GatewayConfig {
  const rawBaseUrl =
    process.env.AIDT_GATEWAY_URL ?? process.env.GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
  let baseUrl: string;
  try {
    const parsed = new URL(rawBaseUrl);
    baseUrl = parsed.toString().replace(/\/$/, "");
  } catch (error) {
    throw new Error(
      `Invalid gateway URL: ${rawBaseUrl}. Set AIDT_GATEWAY_URL or GATEWAY_URL to a valid HTTP(S) URL.`
    );
  }

  const token = process.env.AIDT_AUTH_TOKEN ?? process.env.AUTH_TOKEN;
  const rawTimeout =
    process.env.AIDT_GATEWAY_TIMEOUT_MS ?? process.env.GATEWAY_TIMEOUT_MS;

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout) {
    const parsed = Number.parseInt(rawTimeout, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid gateway timeout: ${rawTimeout}. Provide a positive integer number of milliseconds.`
      );
    }
    timeoutMs = parsed;
  }

  return { baseUrl, token, timeoutMs };
}

function joinUrl(baseUrl: string, pathname: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  return new URL(normalizedPath, normalizedBase).toString();
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  const bodyText = await response.text();
  if (!bodyText) {
    return undefined;
  }

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(bodyText);
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.error === "string" && parsed.error.trim()) {
          return parsed.error.trim();
        }
        if (typeof parsed.message === "string" && parsed.message.trim()) {
          return parsed.message.trim();
        }
        if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
          return parsed.errors.map(err => String(err)).join(", ");
        }
      }
    } catch {
      // fall through to return plain text
    }
  }

  return bodyText.trim() || undefined;
}

async function requestPlan(goal: string, config: GatewayConfig): Promise<Plan> {
  const url = joinUrl(config.baseUrl, "plan");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (config.token) {
      headers.authorization = `Bearer ${config.token}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ goal }),
      signal: controller.signal
    });

    if (!response.ok) {
      const requestId = response.headers.get("x-request-id");
      const message = await readErrorMessage(response);
      const suffix = requestId ? ` (request id ${requestId})` : "";

      switch (response.status) {
        case 400:
        case 422:
          throw new Error(
            message
              ? `Gateway rejected plan input: ${message}`
              : "Gateway rejected plan input with validation error."
          );
        case 401:
        case 403:
          throw new Error(
            message
              ? `Authentication failed: ${message}`
              : "Authentication failed. Provide a valid token via AIDT_AUTH_TOKEN or AUTH_TOKEN."
          );
        case 404:
          throw new Error(
            message
              ? `Gateway endpoint not found: ${message}`
              : "Gateway endpoint not found. Verify your gateway URL."
          );
        case 429:
          throw new Error(
            message
              ? `Gateway rate limited the request: ${message}`
              : "Gateway rate limited the request. Please retry shortly."
          );
        default: {
          const statusText = response.statusText || `HTTP ${response.status}`;
          const detail = message ? `: ${message}` : ".";
          throw new Error(
            `Gateway request failed${suffix} - ${statusText}${detail}`
          );
        }
      }
    }

    return (await response.json()) as Plan;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Gateway request timed out after ${config.timeoutMs}ms. Adjust AIDT_GATEWAY_TIMEOUT_MS if needed.`
      );
    }
    if (error instanceof Error) {
      throw new Error(`Failed to create plan: ${error.message}`);
    }
    throw new Error("Failed to create plan due to an unknown error");
  } finally {
    clearTimeout(timeout);
  }
}

const PLAN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function ensureSafePlanId(planId: string | undefined): string {
  const trimmed = planId?.trim() ?? "";
  if (!PLAN_ID_PATTERN.test(trimmed)) {
    throw new Error(
      `Gateway returned invalid plan id \"${planId ?? ""}\". Plan ids must match ${PLAN_ID_PATTERN}.`
    );
  }
  return trimmed;
}

async function persistPlanArtifacts(plan: Plan): Promise<void> {
  const safePlanId = ensureSafePlanId(plan.id);
  const plansRoot = path.join(process.cwd(), ".plans", safePlanId);
  await fs.mkdir(plansRoot, { recursive: true });
  const planJsonPath = path.join(plansRoot, "plan.json");
  const planMdPath = path.join(plansRoot, "plan.md");

  const markdownSteps = plan.steps
    .map(step => {
      const labelsText = step.labels?.length ? ` labels: ${step.labels.join(", ")}` : "";
      const approvalText = step.approvalRequired ? "approval required" : "auto";
      return `- **${step.action}** (${step.capabilityLabel}) — tool: ${step.tool}, timeout: ${step.timeoutSeconds}s, approval: ${approvalText}${labelsText}`;
    })
    .join("\n");

  const markdown = `# Plan ${safePlanId}\n\nGoal: ${plan.goal}\n\nSteps:\n${markdownSteps}`;

  await Promise.all([
    fs.writeFile(planJsonPath, JSON.stringify(plan, null, 2), "utf8"),
    fs.writeFile(planMdPath, markdown, "utf8")
  ]);
}

export async function createPlan(goal: string): Promise<Plan> {
  const config = resolveGatewayConfig();
  const plan = await requestPlan(goal, config);
  await persistPlanArtifacts(plan);
  return plan;
}

function formatSteps(plan: Plan): string[] {
  return plan.steps.map(step => {
    const approvalText = step.approvalRequired ? "requires approval" : "auto";
    return `  • ${step.action} (${step.capabilityLabel}) [tool=${step.tool}, timeout=${step.timeoutSeconds}s, ${approvalText}]`;
  });
}

function formatSuccessCriteria(plan: Plan): string[] {
  return (plan.successCriteria ?? []).map(criteria => `  - ${criteria}`);
}

export async function runPlan(goal: string): Promise<Plan> {
  const plan = await createPlan(goal);
  console.log(`Plan created: ${plan.id}`);
  console.log("Goal:", plan.goal);
  console.log("Steps:");
  for (const line of formatSteps(plan)) {
    console.log(line);
  }
  if (plan.successCriteria?.length) {
    console.log("Success criteria:");
    for (const line of formatSuccessCriteria(plan)) {
      console.log(line);
    }
  }
  console.log(`SSE stream: /plan/${plan.id}/events`);
  return plan;
}
