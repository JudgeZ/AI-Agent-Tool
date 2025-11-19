/**
 * Integration tests for marketplace API routes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { createMarketplaceRouter } from "./routes.js";
import { MarketplaceService } from "./MarketplaceService.js";
import { PublicationStatus, ScanStatus, type ToolListing } from "./types.js";
import { ToolCapability } from "../tools/McpTool.js";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const mocks = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  } as any;
  // Fix circular reference for child
  logger.child = () => logger;

  return {
    appLogger: logger,
    enforceHttpActionMock: vi.fn().mockResolvedValue({ allow: true, deny: [] }),
  };
});

vi.mock("../observability/logger.js", () => ({
  appLogger: mocks.appLogger,
  default: mocks.appLogger,
}));

vi.mock("../observability/audit.js", () => ({
  logAuditEvent: vi.fn(),
}));

vi.mock("../policy/PolicyEnforcer.js", () => ({
  getPolicyEnforcer: () => ({
    enforceHttpAction: mocks.enforceHttpActionMock,
  }),
}));

describe("Marketplace API Routes", () => {
  let app: Express;
  let mockService: Partial<MarketplaceService>;
  let tempDir: string;
  let wasmPath: string;

  const mockSession = {
    id: "session-1",
    tenantId: "tenant-1",
    subject: "user-1",
    name: "Test User",
    email: "test@example.com",
    roles: ["user"],
    scopes: ["marketplace.publish"],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3600000),
  };

  const mockTool: ToolListing = {
    id: "com.example.test-tool",
    manifest: {
      id: "com.example.test-tool",
      name: "Test Tool",
      description: "A test tool for unit testing",
      version: { major: 1, minor: 0, patch: 0 },
      author: { name: "Test Author" },
      license: "MIT",
      capabilities: [ToolCapability.READ_FILES],
      tags: ["testing"],
      inputSchema: { type: "object", properties: {} },
    },
    publisher: {
      tenantId: "tenant-1",
      userId: "user-1",
      name: "Test User",
      email: "test@example.com",
    },
    status: PublicationStatus.PUBLISHED,
    securityScan: {
      status: ScanStatus.PASSED,
      findings: [],
      summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    },
    updatedAt: new Date(),
    createdAt: new Date(),
    downloads: 100,
    packageUrl: "https://example.com/tool.tar.gz",
  };

  beforeEach(() => {
    // Create dummy OPA wasm file for policy enforcement
    tempDir = mkdtempSync(path.join(tmpdir(), "marketplace-test-"));
    wasmPath = path.join(tempDir, "capabilities.wasm");
    // Minimal valid WASM file: magic number (0x00 0x61 0x73 0x6d) + version (0x01 0x00 0x00 0x00)
    writeFileSync(
      wasmPath,
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    process.env.OPA_POLICY_WASM_PATH = wasmPath;

    // Reset PolicyEnforcer mock
    mocks.enforceHttpActionMock.mockReset();
    mocks.enforceHttpActionMock.mockResolvedValue({ allow: true, deny: [] });

    mockService = {
      publishTool: vi.fn().mockResolvedValue(mockTool),
      getTool: vi.fn(),
      searchTools: vi.fn(),
      updateToolVersion: vi.fn(),
      deleteTool: vi.fn(),
      archiveTool: vi.fn(),
      deprecateTool: vi.fn(),
      recordDownload: vi.fn(),
      submitReview: vi.fn(),
      getReviews: vi.fn(),
      getFeaturedTools: vi.fn(),
      getTrendingTools: vi.fn(),
      getSimilarTools: vi.fn(),
      getPublisherTools: vi.fn(),
    };

    app = express();
    app.use(express.json());

    // Mock auth middleware
    app.use((req: any, res, next) => {
      req.auth = { session: mockSession };
      res.locals.requestId = "test-request-id";
      res.locals.traceId = "test-trace-id";
      next();
    });

    const router = createMarketplaceRouter({
      service: mockService as MarketplaceService,
      logger: mocks.appLogger,
      requireAuth: true,
      runMode: "development",
      rateLimiter: {
        checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
      } as any,
    });

    app.use("/marketplace", router);
  });

  afterEach(() => {
    delete process.env.OPA_POLICY_WASM_PATH;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("POST /marketplace/tools", () => {
    it("should publish a new tool", async () => {
      vi.mocked(mockService.publishTool!).mockResolvedValue(mockTool);

      const publishRequest = {
        manifest: mockTool.manifest,
        packageUrl: "https://example.com/tool.tar.gz",
      };

      const response = await request(app)
        .post("/marketplace/tools")
        .send(publishRequest)
        .expect(201);

      expect(response.body.tool).toBeDefined();
      expect(response.body.tool.id).toBe(mockTool.id);
      expect(mockService.publishTool).toHaveBeenCalledWith(
        expect.objectContaining(publishRequest),
        expect.objectContaining({
          tenantId: mockSession.tenantId,
          userId: mockSession.subject,
        }),
      );
    });

    it("should reject invalid publish request", async () => {
      const invalidRequest = {
        manifest: {
          // Missing required fields
          id: "invalid",
        },
        packageUrl: "not-a-url",
      };

      await request(app)
        .post("/marketplace/tools")
        .send(invalidRequest)
        .expect(400);

      expect(mockService.publishTool).not.toHaveBeenCalled();
    });
  });

  describe("GET /marketplace/tools", () => {
    it("should search tools", async () => {
      const searchResults = {
        items: [mockTool],
        total: 1,
        limit: 20,
        offset: 0,
      };

      vi.mocked(mockService.searchTools!).mockResolvedValue(searchResults);

      const response = await request(app)
        .get("/marketplace/tools")
        .query({ q: "test", limit: 20 })
        .expect(200);

      expect(response.body.tools).toHaveLength(1);
      expect(response.body.total).toBe(1);
      expect(mockService.searchTools).toHaveBeenCalledWith(
        expect.objectContaining({ q: "test", limit: 20 }),
      );
    });

    it("should handle empty search results", async () => {
      vi.mocked(mockService.searchTools!).mockResolvedValue({
        items: [],
        total: 0,
        limit: 20,
        offset: 0,
      });

      const response = await request(app).get("/marketplace/tools").expect(200);

      expect(response.body.tools).toHaveLength(0);
      expect(response.body.total).toBe(0);
    });

    it("should support filtering by capabilities", async () => {
      vi.mocked(mockService.searchTools!).mockResolvedValue({
        items: [mockTool],
        total: 1,
        limit: 20,
        offset: 0,
      });

      await request(app)
        .get("/marketplace/tools")
        .query({ capabilities: "READ_FILES" })
        .expect(200);

      expect(mockService.searchTools).toHaveBeenCalledWith(
        expect.objectContaining({
          capabilities: ["READ_FILES"],
        }),
      );
    });
  });

  describe("GET /marketplace/tools/:toolId", () => {
    it("should get a specific tool", async () => {
      vi.mocked(mockService.getTool!).mockResolvedValue(mockTool);

      const response = await request(app)
        .get(`/marketplace/tools/${mockTool.id}`)
        .expect(200);

      expect(response.body.tool).toBeDefined();
      expect(response.body.tool.id).toBe(mockTool.id);
      expect(mockService.getTool).toHaveBeenCalledWith(mockTool.id);
    });

    it("should return 404 for non-existent tool", async () => {
      vi.mocked(mockService.getTool!).mockResolvedValue(null);

      await request(app).get("/marketplace/tools/non-existent").expect(404);
    });
  });

  describe("PUT /marketplace/tools/:toolId", () => {
    it("should update a tool version", async () => {
      const updatedTool = {
        ...mockTool,
        manifest: {
          ...mockTool.manifest,
          version: { major: 1, minor: 1, patch: 0 },
        },
      };

      vi.mocked(mockService.updateToolVersion!).mockResolvedValue(updatedTool);

      const updateRequest = {
        version: { major: 1, minor: 1, patch: 0 },
        manifest: {},
        packageUrl: "https://example.com/tool-v1.1.tar.gz",
      };

      const response = await request(app)
        .put(`/marketplace/tools/${mockTool.id}`)
        .send(updateRequest)
        .expect(200);

      expect(response.body.tool.manifest.version.minor).toBe(1);
      expect(mockService.updateToolVersion).toHaveBeenCalled();
    });

    it("should reject invalid version update", async () => {
      const invalidUpdate = {
        version: { major: -1, minor: 0, patch: 0 },
        manifest: {},
        packageUrl: "https://example.com/tool.tar.gz",
      };

      await request(app)
        .put(`/marketplace/tools/${mockTool.id}`)
        .send(invalidUpdate)
        .expect(400);

      expect(mockService.updateToolVersion).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /marketplace/tools/:toolId", () => {
    it("should delete a tool", async () => {
      vi.mocked(mockService.deleteTool!).mockResolvedValue(true);

      await request(app)
        .delete(`/marketplace/tools/${mockTool.id}`)
        .expect(204);

      expect(mockService.deleteTool).toHaveBeenCalledWith(
        mockTool.id,
        expect.objectContaining({
          tenantId: mockSession.tenantId,
          userId: mockSession.subject,
        }),
      );
    });

    it("should return 404 for non-existent tool", async () => {
      vi.mocked(mockService.deleteTool!).mockResolvedValue(false);

      await request(app).delete("/marketplace/tools/non-existent").expect(404);
    });
  });

  describe("POST /marketplace/tools/:toolId/archive", () => {
    it("should archive a tool", async () => {
      const archivedTool = { ...mockTool, status: PublicationStatus.ARCHIVED };
      vi.mocked(mockService.archiveTool!).mockResolvedValue(archivedTool);

      const response = await request(app)
        .post(`/marketplace/tools/${mockTool.id}/archive`)
        .expect(200);

      expect(response.body.tool.status).toBe(PublicationStatus.ARCHIVED);
    });
  });

  describe("POST /marketplace/tools/:toolId/deprecate", () => {
    it("should deprecate a tool", async () => {
      const deprecatedTool = {
        ...mockTool,
        status: PublicationStatus.DEPRECATED,
      };
      vi.mocked(mockService.deprecateTool!).mockResolvedValue(deprecatedTool);

      const response = await request(app)
        .post(`/marketplace/tools/${mockTool.id}/deprecate`)
        .expect(200);

      expect(response.body.tool.status).toBe(PublicationStatus.DEPRECATED);
    });
  });

  describe("POST /marketplace/tools/:toolId/download", () => {
    it("should record a download", async () => {
      vi.mocked(mockService.recordDownload!).mockResolvedValue();

      await request(app)
        .post(`/marketplace/tools/${mockTool.id}/download`)
        .expect(204);

      expect(mockService.recordDownload).toHaveBeenCalledWith(mockTool.id);
    });
  });

  describe("POST /marketplace/tools/:toolId/reviews", () => {
    it("should submit a review", async () => {
      const mockReview = {
        id: "review-1",
        toolId: mockTool.id,
        reviewer: { userId: mockSession.subject, name: mockSession.name },
        rating: 5,
        title: "Great tool!",
        comment: "Works perfectly",
        helpful: 0,
        verified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(mockService.submitReview!).mockResolvedValue(mockReview);

      const reviewRequest = {
        rating: 5,
        title: "Great tool!",
        comment: "Works perfectly",
      };

      const response = await request(app)
        .post(`/marketplace/tools/${mockTool.id}/reviews`)
        .send(reviewRequest)
        .expect(201);

      expect(response.body.review.rating).toBe(5);
      expect(mockService.submitReview).toHaveBeenCalled();
    });

    it("should reject invalid rating", async () => {
      const invalidReview = {
        rating: 6, // Invalid: max is 5
        title: "Invalid",
      };

      await request(app)
        .post(`/marketplace/tools/${mockTool.id}/reviews`)
        .send(invalidReview)
        .expect(400);

      expect(mockService.submitReview).not.toHaveBeenCalled();
    });
  });

  describe("GET /marketplace/tools/:toolId/reviews", () => {
    it("should get tool reviews", async () => {
      const mockReviews = [
        {
          id: "review-1",
          toolId: mockTool.id,
          reviewer: { userId: "user-2", name: "Reviewer" },
          rating: 5,
          helpful: 10,
          verified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      vi.mocked(mockService.getReviews!).mockResolvedValue(mockReviews);

      const response = await request(app)
        .get(`/marketplace/tools/${mockTool.id}/reviews`)
        .expect(200);

      expect(response.body.reviews).toHaveLength(1);
      expect(mockService.getReviews).toHaveBeenCalledWith(mockTool.id, 20, 0);
    });
  });

  describe("GET /marketplace/featured", () => {
    it("should get featured tools", async () => {
      vi.mocked(mockService.getFeaturedTools!).mockResolvedValue([mockTool]);

      const response = await request(app)
        .get("/marketplace/featured")
        .expect(200);

      expect(response.body.tools).toHaveLength(1);
      expect(mockService.getFeaturedTools).toHaveBeenCalledWith(10);
    });
  });

  describe("GET /marketplace/trending", () => {
    it("should get trending tools", async () => {
      vi.mocked(mockService.getTrendingTools!).mockResolvedValue([mockTool]);

      const response = await request(app)
        .get("/marketplace/trending")
        .expect(200);

      expect(response.body.tools).toHaveLength(1);
      expect(mockService.getTrendingTools).toHaveBeenCalledWith(10);
    });
  });

  describe("GET /marketplace/tools/:toolId/similar", () => {
    it("should get similar tools", async () => {
      const similarTool = { ...mockTool, id: "similar-tool" };
      vi.mocked(mockService.getSimilarTools!).mockResolvedValue([similarTool]);

      const response = await request(app)
        .get(`/marketplace/tools/${mockTool.id}/similar`)
        .expect(200);

      expect(response.body.tools).toHaveLength(1);
      expect(mockService.getSimilarTools).toHaveBeenCalledWith(mockTool.id, 5);
    });
  });

  describe("GET /marketplace/my-tools", () => {
    it("should get publisher tools", async () => {
      vi.mocked(mockService.getPublisherTools!).mockResolvedValue([mockTool]);

      const response = await request(app)
        .get("/marketplace/my-tools")
        .expect(200);

      expect(response.body.tools).toHaveLength(1);
      expect(mockService.getPublisherTools).toHaveBeenCalledWith(
        mockSession.tenantId,
        mockSession.subject,
      );
    });
  });
});
