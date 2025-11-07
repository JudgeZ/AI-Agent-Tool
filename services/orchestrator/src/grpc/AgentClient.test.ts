import {
  ChannelCredentials,
  Server,
  ServerCredentials,
  status,
  type ServerUnaryCall,
  type ServiceError,
  type sendUnaryData
} from "@grpc/grpc-js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ToolAgentClient, ToolClientError, resetToolAgentClient } from "./AgentClient.js";
import {
  AgentServiceService,
  type AgentServiceClient,
  type ExecuteToolRequest,
  type ExecuteToolResponse
} from "./generated/agent.js";
import * as configModule from "../config.js";

let server: Server;
let port: number;
let handler: (request: ExecuteToolRequest) => Promise<ExecuteToolResponse>;

beforeAll(async () => {
  handler = async () => ({ events: [] });
  server = new Server();
  server.addService(AgentServiceService, {
    executeTool: (
      call: ServerUnaryCall<ExecuteToolRequest, ExecuteToolResponse>,
      callback: sendUnaryData<ExecuteToolResponse>
    ) => {
      handler(call.request)
        .then(response => callback(null, response))
        .catch(error => {
          if (error && typeof error === "object" && "code" in error) {
            callback(error as ServiceError, null);
          } else {
            callback(
              {
                code: status.UNKNOWN,
                message: (error as Error | undefined)?.message ?? "unknown"
              } as ServiceError,
              null
            );
          }
        });
    }
  });
  port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, actualPort) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(actualPort);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.start();
    resolve();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetToolAgentClient();
});

afterAll(async () => {
  await new Promise<void>(resolve => {
    server.tryShutdown(() => resolve());
  });
});

describe("ToolAgentClient", () => {
  it("returns tool events from the agent server", async () => {
    handler = async request => {
      expect(request.invocation?.tool).toBe("code_writer");
      return {
        events: [
          {
            invocationId: request.invocation?.invocationId ?? "inv", 
            planId: request.invocation?.planId ?? "plan-1",
            stepId: request.invocation?.stepId ?? "s1",
            state: "completed",
            summary: "done",
            outputJson: "{}",
            occurredAt: new Date().toISOString()
          }
        ]
      };
    };

    const client = new ToolAgentClient({
      endpoint: `127.0.0.1:${port}`,
      retryAttempts: 2,
      defaultTimeoutMs: 2000
    });

    const events = await client.executeTool({
      invocationId: "inv-1",
      planId: "plan-1",
      stepId: "s1",
      tool: "code_writer",
      capability: "repo.write",
      capabilityLabel: "Apply repository changes",
      labels: ["repo"],
      input: { goal: "test" },
      metadata: { actor: "tester" }
    });

    expect(events).toHaveLength(1);
    expect(events[0].state).toBe("completed");
    expect(events[0].summary).toBe("done");
  });

  it("retries transient errors before succeeding", async () => {
    let attempt = 0;
    handler = async request => {
      attempt += 1;
      if (attempt === 1) {
        const error: Partial<ToolClientError> & { code: number; message: string } = {
          code: status.UNAVAILABLE,
          message: "temporarily unavailable"
        };
        throw error;
      }
      return {
        events: [
          {
            invocationId: request.invocation?.invocationId ?? "inv",
            planId: request.invocation?.planId ?? "plan",
            stepId: request.invocation?.stepId ?? "step",
            state: "completed",
            summary: "ok",
            outputJson: "{}",
            occurredAt: new Date().toISOString()
          }
        ]
      };
    };

    const client = new ToolAgentClient({
      endpoint: `127.0.0.1:${port}`,
      retryAttempts: 3,
      defaultTimeoutMs: 2000,
      baseDelayMs: 5
    });

    const events = await client.executeTool({
      invocationId: "inv-retry",
      planId: "plan-retry",
      stepId: "step-1",
      tool: "test_runner",
      capability: "test.run",
      capabilityLabel: "Execute tests",
      labels: [],
      input: {},
      metadata: {}
    });

    expect(attempt).toBe(2);
    expect(events[0].state).toBe("completed");
  });

  it("surfaces non-retryable errors", async () => {
    handler = async () => {
      const error: Partial<ToolClientError> & { code: number; message: string } = {
        code: status.INVALID_ARGUMENT,
        message: "bad input"
      };
      throw error;
    };

    const client = new ToolAgentClient({
      endpoint: `127.0.0.1:${port}`,
      retryAttempts: 1,
      defaultTimeoutMs: 1000
    });

    try {
      await client.executeTool({
        invocationId: "inv-error",
        planId: "plan-fail",
        stepId: "s42",
        tool: "code_writer",
        capability: "repo.write",
        capabilityLabel: "Apply repository changes",
        labels: [],
        input: {},
        metadata: {}
      });
      throw new Error("expected client to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolClientError);
      const toolError = error as ToolClientError;
      expect(toolError.retryable).toBe(false);
      expect(toolError.message).toContain("bad input");
    }
  });

  it("uses insecure credentials when TLS config is absent", () => {
    const baseConfig = configModule.loadConfig();
    const loadConfigSpy = vi.spyOn(configModule, "loadConfig").mockReturnValue({
      ...baseConfig,
      tooling: { ...baseConfig.tooling, tls: undefined }
    });
    const createInsecureSpy = vi.spyOn(ChannelCredentials, "createInsecure");

    new ToolAgentClient({
      clientFactory: vi.fn(() => ({} as unknown as AgentServiceClient))
    });

    expect(loadConfigSpy).toHaveBeenCalled();
    expect(createInsecureSpy).toHaveBeenCalledTimes(1);
  });

  it("creates secure credentials when TLS config is provided", () => {
    const baseConfig = configModule.loadConfig();
    const tempDir = mkdtempSync(join(tmpdir(), "agent-client-tls-"));
    const caPath = join(tempDir, "ca.pem");
    const certPath = join(tempDir, "client.pem");
    const keyPath = join(tempDir, "client-key.pem");
    writeFileSync(caPath, "CA-CERT\n");
    writeFileSync(certPath, "CLIENT-CERT\n");
    writeFileSync(keyPath, "CLIENT-KEY\n");

    const loadConfigSpy = vi.spyOn(configModule, "loadConfig").mockReturnValue({
      ...baseConfig,
      tooling: {
        ...baseConfig.tooling,
        tls: {
          insecure: false,
          caPaths: [caPath],
          certPath,
          keyPath
        }
      }
    });

    const createSslSpy = vi.spyOn(ChannelCredentials, "createSsl").mockReturnValue({} as ChannelCredentials);
    const createInsecureSpy = vi.spyOn(ChannelCredentials, "createInsecure");

    try {
      new ToolAgentClient({
        clientFactory: vi.fn(() => ({} as unknown as AgentServiceClient))
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    expect(loadConfigSpy).toHaveBeenCalled();
    expect(createSslSpy).toHaveBeenCalledTimes(1);
    const [rootCerts, privateKey, certChain] = createSslSpy.mock.calls[0]!;
    expect(rootCerts?.toString()).toContain("CA-CERT");
    expect(privateKey?.toString()).toContain("CLIENT-KEY");
    expect(certChain?.toString()).toContain("CLIENT-CERT");
    expect(createInsecureSpy).not.toHaveBeenCalled();
  });
});
