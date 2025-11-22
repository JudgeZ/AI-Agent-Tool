import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Response } from "express";
import { ChatController } from "./ChatController.js";
import type { AppConfig } from "../config.js";
import type { RateLimitStore } from "../rateLimit/store.js";
import type { ExtendedRequest } from "../http/types.js";
import * as providerRegistry from "../providers/ProviderRegistry.js";

import type { PolicyEnforcer } from "../policy/PolicyEnforcer.js";

// Mock dependencies
vi.mock("../providers/ProviderRegistry.js");
vi.mock("../http/requestIdentity.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../http/requestIdentity.js")>();
    return {
        ...actual,
        createRequestIdentity: vi.fn().mockReturnValue({ agentName: "test-agent", ip: "127.0.0.1" }),
    };
});
vi.mock("../observability/audit.js", () => ({
    logAuditEvent: vi.fn(),
    toAuditSubject: vi.fn(),
}));
vi.mock("../http/helpers.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../http/helpers.js")>();
    return {
        ...actual,
        getRequestIds: vi.fn().mockReturnValue({ requestId: "req-1", traceId: "trace-1" }),
        toPlanSubject: vi.fn().mockImplementation((s) => s),
        toAuditSubject: vi.fn().mockImplementation((s) => s),
    };
});

describe("ChatController", () => {
  let controller: ChatController;
  let config: AppConfig;
  let rateLimiter: RateLimitStore;
  let policy: PolicyEnforcer;
  let req: Partial<ExtendedRequest>;
  let res: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    config = {
      server: { rateLimits: { chat: { limit: 10, windowMs: 1000 } } },
      runMode: "production",
    } as any;

    rateLimiter = {
      allow: vi.fn().mockResolvedValue({ allowed: true }),
    } as any;

    policy = {
      enforceHttpAction: vi.fn().mockResolvedValue({ allow: true, deny: [] }),
    } as any;

    controller = new ChatController(config, rateLimiter, policy);

    req = {
      body: {},
      auth: { session: { tenantId: "tenant-1", subject: "user-1", id: "session-1", roles: [], scopes: [], issuedAt: "", expiresAt: "", claims: {} } },
      headers: {},
    };

    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      end: vi.fn(),
      setHeader: vi.fn(),
      getHeader: vi.fn().mockReturnValue("test-header"),
      locals: {},
    } as any;
  });

  it("handles chat message successfully", async () => {
    req.body = { messages: [{ role: "user", content: "hello" }], provider: "openai", model: "gpt-4" };
    const mockResponse = { output: "hi there" };
    vi.mocked(providerRegistry.routeChat).mockResolvedValue(mockResponse);

    await controller.chat(req as ExtendedRequest, res as Response);

    expect(providerRegistry.routeChat).toHaveBeenCalledWith(
        expect.objectContaining({ messages: [{ role: "user", content: "hello" }] }), 
        expect.objectContaining({ tenantId: "tenant-1" })
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ response: mockResponse }));
  });

  it("enforces rate limits", async () => {
    req.body = { messages: [{ role: "user", content: "hello" }] };
    rateLimiter.allow = vi.fn().mockResolvedValue({ allowed: false });

    await controller.chat(req as ExtendedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(providerRegistry.routeChat).not.toHaveBeenCalled();
  });

  it("validates input", async () => {
    req.body = {}; // Missing messages

    await controller.chat(req as ExtendedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(providerRegistry.routeChat).not.toHaveBeenCalled();
  });

  it("handles provider errors", async () => {
    req.body = { messages: [{ role: "user", content: "hello" }], provider: "openai", model: "gpt-4" };
    vi.mocked(providerRegistry.routeChat).mockRejectedValue(new Error("Provider error"));

    await controller.chat(req as ExtendedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
