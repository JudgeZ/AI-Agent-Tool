import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  ChannelCredentials,
  type ClientOptions,
  Metadata,
  status,
  type ServiceError
} from "@grpc/grpc-js";

import { loadConfig, type ToolAgentTlsConfig } from "../config.js";
import {
  parseToolEvent,
  parseToolInvocation,
  type ToolEvent,
  type ToolInvocation
} from "../plan/validation.js";
import { AgentServiceClient, type ExecuteToolRequest } from "./generated/agent.js";

const RETRYABLE_CODES = new Set<number>([
  status.UNAVAILABLE,
  status.RESOURCE_EXHAUSTED,
  status.ABORTED,
  status.DEADLINE_EXCEEDED
]);

const DEFAULT_BASE_DELAY_MS = 200;

function buildCredentialsFromTlsConfig(tls: ToolAgentTlsConfig | undefined): ChannelCredentials {
  if (!tls || tls.insecure) {
    return ChannelCredentials.createInsecure();
  }

  if ((tls.certPath && !tls.keyPath) || (!tls.certPath && tls.keyPath)) {
    throw new Error(
      "Tool agent TLS configuration requires both certPath and keyPath when configuring client certificates",
    );
  }

  let rootCerts: Buffer | undefined;
  if (tls.caPaths && tls.caPaths.length > 0) {
    const pemContent = tls.caPaths
      .map(filePath => readFileSync(filePath, "utf-8"))
      .map(content => (content.endsWith("\n") ? content : `${content}\n`))
      .join("");
    rootCerts = Buffer.from(pemContent, "utf-8");
  }

  const privateKey = tls.keyPath ? readFileSync(tls.keyPath) : undefined;
  const certChain = tls.certPath ? readFileSync(tls.certPath) : undefined;

  return ChannelCredentials.createSsl(rootCerts, privateKey, certChain);
}

export class ToolClientError extends Error {
  readonly retryable: boolean;
  readonly code?: number;
  readonly cause?: unknown;

  constructor(message: string, options: { code?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = "ToolClientError";
    this.retryable = options.retryable ?? false;
    this.code = options.code;
    this.cause = options.cause;
  }
}

export type ToolAgentClientOptions = {
  endpoint?: string;
  retryAttempts?: number;
  defaultTimeoutMs?: number;
  baseDelayMs?: number;
  credentials?: ChannelCredentials;
  clientOptions?: Partial<ClientOptions>;
  clientFactory?: (address: string, credentials: ChannelCredentials, options?: Partial<ClientOptions>) => AgentServiceClient;
};

function toProtoInvocation(input: ToolInvocation): ExecuteToolRequest {
  const invocation = parseToolInvocation({
    ...input,
    invocationId: input.invocationId ?? randomUUID()
  });
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(invocation.metadata)) {
    if (value === undefined || value === null) {
      continue;
    }
    metadata[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  const payload = JSON.stringify(invocation.input ?? {});
  return {
    invocation: {
      invocationId: invocation.invocationId,
      planId: invocation.planId,
      stepId: invocation.stepId,
      tool: invocation.tool,
      capability: invocation.capability,
      capabilityLabel: invocation.capabilityLabel,
      labels: invocation.labels ?? [],
      inputJson: payload,
      metadata,
      timeoutSeconds: invocation.timeoutSeconds ?? 0,
      approvalRequired: invocation.approvalRequired ?? false
    }
  };
}

function safeParseJson(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

type ProtoToolEvent = {
  invocationId?: unknown;
  planId?: unknown;
  stepId?: unknown;
  state?: unknown;
  summary?: unknown;
  outputJson?: unknown;
  occurredAt?: unknown;
};

function isProtoToolEvent(value: unknown): value is ProtoToolEvent {
  return typeof value === "object" && value !== null;
}

function toToolEvents(
  responseEvents: unknown,
  fallback: NonNullable<ExecuteToolRequest["invocation"]>
): ToolEvent[] {
  if (!Array.isArray(responseEvents)) {
    return [];
  }

  return responseEvents
    .filter(isProtoToolEvent)
    .map(event => {
      const invocationId = typeof event.invocationId === "string" && event.invocationId.length > 0
        ? event.invocationId
        : fallback.invocationId;
      const planId = typeof event.planId === "string" && event.planId.length > 0 ? event.planId : fallback.planId;
      const stepId = typeof event.stepId === "string" && event.stepId.length > 0 ? event.stepId : fallback.stepId;
      const state = typeof event.state === "string" ? event.state : "queued";
      const summary = typeof event.summary === "string" && event.summary.length > 0 ? event.summary : undefined;
      const occurredAt =
        typeof event.occurredAt === "string" && event.occurredAt.length > 0
          ? event.occurredAt
          : new Date().toISOString();

      return parseToolEvent({
        invocationId,
        planId,
        stepId,
        state,
        summary,
        output: safeParseJson(typeof event.outputJson === "string" ? event.outputJson : undefined),
        occurredAt
      });
    });
}

export class ToolAgentClient {
  private readonly endpoint: string;
  private readonly retryAttempts: number;
  private readonly defaultTimeoutMs: number;
  private readonly baseDelayMs: number;
  private readonly credentials: ChannelCredentials;
  private readonly clientOptions?: Partial<ClientOptions>;
  private readonly factory: (address: string, credentials: ChannelCredentials, options?: Partial<ClientOptions>) => AgentServiceClient;
  private client?: AgentServiceClient;

  constructor(options: ToolAgentClientOptions = {}) {
    const config = loadConfig();
    this.endpoint = options.endpoint ?? config.tooling.agentEndpoint;
    this.retryAttempts = Math.max(1, options.retryAttempts ?? config.tooling.retryAttempts);
    this.defaultTimeoutMs = Math.max(1000, options.defaultTimeoutMs ?? config.tooling.defaultTimeoutMs);
    this.baseDelayMs = Math.max(50, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
    this.credentials = options.credentials ?? buildCredentialsFromTlsConfig(config.tooling.tls);
    this.clientOptions = options.clientOptions;
    this.factory = options.clientFactory ?? ((address, credentials, clientOptions) => new AgentServiceClient(address, credentials, clientOptions));
  }

  private getClient(): AgentServiceClient {
    if (!this.client) {
      this.client = this.factory(this.endpoint, this.credentials, this.clientOptions);
    }
    return this.client;
  }

  async executeTool(invocation: ToolInvocation, options: { timeoutMs?: number; metadata?: Record<string, string> } = {}): Promise<ToolEvent[]> {
    const request = toProtoInvocation(invocation);
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const metadata = new Metadata();
    metadata.set("plan-id", request.invocation!.planId);
    metadata.set("step-id", request.invocation!.stepId);
    metadata.set("tool", request.invocation!.tool);
    for (const [key, value] of Object.entries(options.metadata ?? {})) {
      if (value !== undefined) {
        metadata.set(key, value);
      }
    }

    let lastError: ToolClientError | undefined;
    for (let attempt = 0; attempt < this.retryAttempts; attempt += 1) {
      try {
        const response = await this.invoke(request, metadata, timeoutMs);
        return toToolEvents(response.events, request.invocation!);
      } catch (error) {
        const toolError = this.normalizeError(error);
        lastError = toolError;
        if (!toolError.retryable || attempt === this.retryAttempts - 1) {
          throw toolError;
        }
        await delay(this.baseDelayMs * (attempt + 1));
      }
    }
    throw lastError ?? new ToolClientError("Tool execution failed");
  }

  private invoke(request: ExecuteToolRequest, metadata: Metadata, timeoutMs: number): Promise<{ events: unknown[] }> {
    const client = this.getClient();
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      client.executeTool(
        request,
        metadata,
        { deadline: new Date(deadline) },
        (error, response) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(response ?? { events: [] });
        }
      );
    });
  }

  private normalizeError(error: unknown): ToolClientError {
    if (error instanceof ToolClientError) {
      return error;
    }
    const serviceError = error as ServiceError | undefined;
    const code = typeof serviceError?.code === "number" ? serviceError.code : undefined;
    const retryable = typeof code === "number" ? RETRYABLE_CODES.has(code) : false;
    const message = typeof serviceError?.message === "string" ? serviceError.message : "Tool agent request failed";
    return new ToolClientError(message, { code, retryable, cause: error });
  }

  close(): void {
    this.client?.close();
    this.client = undefined;
  }
}

let sharedClient: ToolAgentClient | undefined;

export function getToolAgentClient(): ToolAgentClient {
  if (!sharedClient) {
    sharedClient = new ToolAgentClient();
  }
  return sharedClient;
}

export function resetToolAgentClient(): void {
  sharedClient?.close();
  sharedClient = undefined;
}
