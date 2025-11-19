/**
 * Tests for MarketplaceService
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MarketplaceService } from "./MarketplaceService.js";
import { MarketplaceRepository } from "./MarketplaceRepository.js";
import { SecurityScanner } from "./SecurityScanner.js";
import {
  type ToolListing,
  type ToolPublishRequest,
  PublicationStatus,
  ScanStatus,
} from "./types.js";
import { ToolCapability } from "../tools/McpTool.js";
import { appLogger } from "../observability/logger.js";

describe("MarketplaceService", () => {
  let service: MarketplaceService;
  let mockRepository: Partial<MarketplaceRepository>;
  let mockScanner: Partial<SecurityScanner>;

  const mockPublisher = {
    tenantId: "tenant-1",
    userId: "user-1",
    name: "Test User",
    email: "test@example.com",
  };

  const mockToolManifest = {
    id: "com.example.test-tool",
    name: "Test Tool",
    description: "A test tool for unit testing purposes",
    version: { major: 1, minor: 0, patch: 0 },
    author: {
      name: "Test Author",
      email: "author@example.com",
    },
    license: "MIT",
    capabilities: [ToolCapability.READ_FILES],
    tags: ["testing", "example"],
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  };

  const mockPublishRequest: ToolPublishRequest = {
    manifest: mockToolManifest,
    packageUrl: "https://example.com/tool.tar.gz",
    skipSecurityScan: false,
  };

  beforeEach(() => {
    mockRepository = {
      getListing: vi.fn(),
      createListing: vi.fn(),
      updateListing: vi.fn(),
      deleteListing: vi.fn(),
      searchListings: vi.fn(),
      incrementDownloads: vi.fn(),
      createReview: vi.fn(),
      getReviews: vi.fn(),
      getListingsByPublisher: vi.fn(),
    };

    mockScanner = {
      scan: vi.fn(),
      quickScan: vi.fn(),
    };

    service = new MarketplaceService({
      repository: mockRepository as MarketplaceRepository,
      scanner: mockScanner as SecurityScanner,
      logger: appLogger,
      requireSecurityScan: true,
      autoPublish: false,
    });
  });

  describe("publishTool", () => {
    it("should publish a new tool successfully", async () => {
      const mockScanResult = {
        status: ScanStatus.PASSED,
        scannedAt: new Date(),
        findings: [],
        summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      };

      const mockListing: ToolListing = {
        id: mockToolManifest.id,
        manifest: mockToolManifest,
        publisher: mockPublisher,
        status: PublicationStatus.PENDING_REVIEW,
        securityScan: mockScanResult,
        updatedAt: new Date(),
        createdAt: new Date(),
        downloads: 0,
        packageUrl: mockPublishRequest.packageUrl,
      };

      vi.mocked(mockRepository.getListing!).mockResolvedValue(null);
      vi.mocked(mockScanner.scan!).mockResolvedValue(mockScanResult);
      vi.mocked(mockRepository.createListing!).mockResolvedValue(mockListing);

      const result = await service.publishTool(
        mockPublishRequest,
        mockPublisher,
      );

      expect(result).toEqual(mockListing);
      expect(mockRepository.getListing).toHaveBeenCalledWith(
        mockToolManifest.id,
      );
      expect(mockScanner.scan).toHaveBeenCalledWith(
        mockPublishRequest.packageUrl,
        mockToolManifest.id,
      );
      expect(mockRepository.createListing).toHaveBeenCalled();
    });

    it("should reject tool if it already exists", async () => {
      const existingListing: ToolListing = {
        id: mockToolManifest.id,
        manifest: mockToolManifest,
        publisher: mockPublisher,
        status: PublicationStatus.PUBLISHED,
        securityScan: {
          status: ScanStatus.PASSED,
          findings: [],
          summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
        updatedAt: new Date(),
        createdAt: new Date(),
        downloads: 10,
        packageUrl: "https://example.com/tool.tar.gz",
      };

      vi.mocked(mockRepository.getListing!).mockResolvedValue(existingListing);

      await expect(
        service.publishTool(mockPublishRequest, mockPublisher),
      ).rejects.toThrow("already exists");

      expect(mockScanner.scan).not.toHaveBeenCalled();
      expect(mockRepository.createListing).not.toHaveBeenCalled();
    });

    it("should set status to DRAFT if security scan fails", async () => {
      const mockScanResult = {
        status: ScanStatus.FAILED,
        scannedAt: new Date(),
        findings: [
          {
            severity: "critical" as const,
            category: "hardcoded_secret",
            title: "Hardcoded Secret",
            description: "Found hardcoded API key",
          },
        ],
        summary: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      };

      vi.mocked(mockRepository.getListing!).mockResolvedValue(null);
      vi.mocked(mockScanner.scan!).mockResolvedValue(mockScanResult);
      vi.mocked(mockRepository.createListing!).mockImplementation(
        async (listing) =>
          ({
            ...listing,
            updatedAt: new Date(),
            createdAt: new Date(),
            downloads: 0,
          }) as ToolListing,
      );

      const result = await service.publishTool(
        mockPublishRequest,
        mockPublisher,
      );

      expect(result.status).toBe(PublicationStatus.DRAFT);
      expect(result.securityScan.status).toBe(ScanStatus.FAILED);
    });

    it("should skip security scan when requested", async () => {
      const requestWithSkip = { ...mockPublishRequest, skipSecurityScan: true };

      vi.mocked(mockRepository.getListing!).mockResolvedValue(null);
      vi.mocked(mockRepository.createListing!).mockImplementation(
        async (listing) =>
          ({
            ...listing,
            updatedAt: new Date(),
            createdAt: new Date(),
            downloads: 0,
          }) as ToolListing,
      );

      await service.publishTool(requestWithSkip, mockPublisher);

      expect(mockScanner.scan).not.toHaveBeenCalled();
    });
  });

  describe("updateToolVersion", () => {
    it("should update tool version successfully", async () => {
      const existingListing: ToolListing = {
        id: mockToolManifest.id,
        manifest: {
          ...mockToolManifest,
          version: { major: 1, minor: 0, patch: 0 },
        },
        publisher: mockPublisher,
        status: PublicationStatus.PUBLISHED,
        securityScan: {
          status: ScanStatus.PASSED,
          findings: [],
          summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
        updatedAt: new Date(),
        createdAt: new Date(),
        downloads: 50,
        packageUrl: "https://example.com/tool-v1.tar.gz",
      };

      const updatedVersion = { major: 1, minor: 1, patch: 0 };
      const mockScanResult = {
        status: ScanStatus.PASSED,
        scannedAt: new Date(),
        findings: [],
        summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      };

      vi.mocked(mockRepository.getListing!).mockResolvedValue(existingListing);
      vi.mocked(mockScanner.scan!).mockResolvedValue(mockScanResult);
      vi.mocked(mockRepository.updateListing!).mockResolvedValue({
        ...existingListing,
        manifest: { ...existingListing.manifest, version: updatedVersion },
        packageUrl: "https://example.com/tool-v1.1.tar.gz",
      });

      const update = {
        toolId: mockToolManifest.id,
        version: updatedVersion,
        manifest: {},
        packageUrl: "https://example.com/tool-v1.1.tar.gz",
      };

      const result = await service.updateToolVersion(update, mockPublisher);

      expect(result.manifest.version).toEqual(updatedVersion);
      expect(mockScanner.scan).toHaveBeenCalled();
    });

    it("should reject version update if not owner", async () => {
      const existingListing: ToolListing = {
        id: mockToolManifest.id,
        manifest: mockToolManifest,
        publisher: { tenantId: "other-tenant", userId: "other-user" },
        status: PublicationStatus.PUBLISHED,
        securityScan: {
          status: ScanStatus.PASSED,
          findings: [],
          summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
        updatedAt: new Date(),
        createdAt: new Date(),
        downloads: 10,
        packageUrl: "https://example.com/tool.tar.gz",
      };

      vi.mocked(mockRepository.getListing!).mockResolvedValue(existingListing);

      const update = {
        toolId: mockToolManifest.id,
        version: { major: 2, minor: 0, patch: 0 },
        manifest: {},
        packageUrl: "https://example.com/tool-v2.tar.gz",
      };

      await expect(
        service.updateToolVersion(update, mockPublisher),
      ).rejects.toThrow("Not authorized");
    });

    it("should reject version update if version is not newer", async () => {
      const existingListing: ToolListing = {
        id: mockToolManifest.id,
        manifest: {
          ...mockToolManifest,
          version: { major: 2, minor: 0, patch: 0 },
        },
        publisher: mockPublisher,
        status: PublicationStatus.PUBLISHED,
        securityScan: {
          status: ScanStatus.PASSED,
          findings: [],
          summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
        updatedAt: new Date(),
        createdAt: new Date(),
        downloads: 10,
        packageUrl: "https://example.com/tool.tar.gz",
      };

      vi.mocked(mockRepository.getListing!).mockResolvedValue(existingListing);

      const update = {
        toolId: mockToolManifest.id,
        version: { major: 1, minor: 5, patch: 0 },
        manifest: {},
        packageUrl: "https://example.com/tool-v1.5.tar.gz",
      };

      await expect(
        service.updateToolVersion(update, mockPublisher),
      ).rejects.toThrow("must be greater than");
    });
  });

  describe("deleteTool", () => {
    it("should delete tool successfully", async () => {
      const existingListing: ToolListing = {
        id: mockToolManifest.id,
        manifest: mockToolManifest,
        publisher: mockPublisher,
        status: PublicationStatus.PUBLISHED,
        securityScan: {
          status: ScanStatus.PASSED,
          findings: [],
          summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
        updatedAt: new Date(),
        createdAt: new Date(),
        downloads: 10,
        packageUrl: "https://example.com/tool.tar.gz",
      };

      vi.mocked(mockRepository.getListing!).mockResolvedValue(existingListing);
      vi.mocked(mockRepository.deleteListing!).mockResolvedValue(true);

      const result = await service.deleteTool(
        mockToolManifest.id,
        mockPublisher,
      );

      expect(result).toBe(true);
      expect(mockRepository.deleteListing).toHaveBeenCalledWith(
        mockToolManifest.id,
      );
    });

    it("should reject delete if not owner", async () => {
      const existingListing: ToolListing = {
        id: mockToolManifest.id,
        manifest: mockToolManifest,
        publisher: { tenantId: "other-tenant", userId: "other-user" },
        status: PublicationStatus.PUBLISHED,
        securityScan: {
          status: ScanStatus.PASSED,
          findings: [],
          summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
        updatedAt: new Date(),
        createdAt: new Date(),
        downloads: 10,
        packageUrl: "https://example.com/tool.tar.gz",
      };

      vi.mocked(mockRepository.getListing!).mockResolvedValue(existingListing);

      await expect(
        service.deleteTool(mockToolManifest.id, mockPublisher),
      ).rejects.toThrow("Not authorized");
    });
  });

  describe("searchTools", () => {
    it("should search tools successfully", async () => {
      const mockResults = {
        items: [
          {
            id: "tool-1",
            manifest: mockToolManifest,
            publisher: mockPublisher,
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
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      };

      vi.mocked(mockRepository.searchListings!).mockResolvedValue(mockResults);

      const query = {
        q: "test",
        limit: 20,
        offset: 0,
        sortBy: "downloads" as const,
        sortOrder: "desc" as const,
      };

      const result = await service.searchTools(query);

      expect(result).toEqual(mockResults);
      expect(mockRepository.searchListings).toHaveBeenCalledWith(query);
    });
  });

  describe("submitReview", () => {
    it("should submit review successfully", async () => {
      const existingListing: ToolListing = {
        id: mockToolManifest.id,
        manifest: mockToolManifest,
        publisher: mockPublisher,
        status: PublicationStatus.PUBLISHED,
        securityScan: {
          status: ScanStatus.PASSED,
          findings: [],
          summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
        updatedAt: new Date(),
        createdAt: new Date(),
        downloads: 10,
        packageUrl: "https://example.com/tool.tar.gz",
      };

      const mockReview = {
        id: "review-1",
        toolId: mockToolManifest.id,
        reviewer: { userId: "reviewer-1", name: "Reviewer" },
        rating: 5,
        title: "Great tool!",
        comment: "Works perfectly",
        helpful: 0,
        verified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(mockRepository.getListing!).mockResolvedValue(existingListing);
      vi.mocked(mockRepository.createReview!).mockResolvedValue(mockReview);

      const review = {
        toolId: mockToolManifest.id,
        rating: 5,
        title: "Great tool!",
        comment: "Works perfectly",
      };

      const result = await service.submitReview(review, {
        userId: "reviewer-1",
        name: "Reviewer",
      });

      expect(result).toEqual(mockReview);
      expect(mockRepository.createReview).toHaveBeenCalled();
    });

    it("should reject review if tool not found", async () => {
      vi.mocked(mockRepository.getListing!).mockResolvedValue(null);

      const review = {
        toolId: "non-existent-tool",
        rating: 5,
      };

      await expect(
        service.submitReview(review, { userId: "reviewer-1" }),
      ).rejects.toThrow("not found");
    });
  });

  describe("archiveTool", () => {
    it("should archive tool successfully", async () => {
      const existingListing: ToolListing = {
        id: mockToolManifest.id,
        manifest: mockToolManifest,
        publisher: mockPublisher,
        status: PublicationStatus.PUBLISHED,
        securityScan: {
          status: ScanStatus.PASSED,
          findings: [],
          summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
        updatedAt: new Date(),
        createdAt: new Date(),
        downloads: 10,
        packageUrl: "https://example.com/tool.tar.gz",
      };

      const archivedListing = {
        ...existingListing,
        status: PublicationStatus.ARCHIVED,
      };

      vi.mocked(mockRepository.getListing!).mockResolvedValue(existingListing);
      vi.mocked(mockRepository.updateListing!).mockResolvedValue(
        archivedListing,
      );

      const result = await service.archiveTool(
        mockToolManifest.id,
        mockPublisher,
      );

      expect(result?.status).toBe(PublicationStatus.ARCHIVED);
    });
  });

  describe("deprecateTool", () => {
    it("should deprecate tool successfully", async () => {
      const existingListing: ToolListing = {
        id: mockToolManifest.id,
        manifest: mockToolManifest,
        publisher: mockPublisher,
        status: PublicationStatus.PUBLISHED,
        securityScan: {
          status: ScanStatus.PASSED,
          findings: [],
          summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        },
        updatedAt: new Date(),
        createdAt: new Date(),
        downloads: 10,
        packageUrl: "https://example.com/tool.tar.gz",
      };

      const deprecatedListing = {
        ...existingListing,
        status: PublicationStatus.DEPRECATED,
      };

      vi.mocked(mockRepository.getListing!).mockResolvedValue(existingListing);
      vi.mocked(mockRepository.updateListing!).mockResolvedValue(
        deprecatedListing,
      );

      const result = await service.deprecateTool(
        mockToolManifest.id,
        mockPublisher,
      );

      expect(result?.status).toBe(PublicationStatus.DEPRECATED);
    });
  });

  describe("getFeaturedTools", () => {
    it("should return featured tools", async () => {
      const mockResults = {
        items: [
          {
            id: "featured-tool",
            manifest: mockToolManifest,
            publisher: mockPublisher,
            status: PublicationStatus.PUBLISHED,
            securityScan: {
              status: ScanStatus.PASSED,
              findings: [],
              summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
            },
            updatedAt: new Date(),
            createdAt: new Date(),
            downloads: 1000,
            rating: { average: 4.8, count: 50 },
            packageUrl: "https://example.com/tool.tar.gz",
          },
        ],
        total: 1,
        limit: 10,
        offset: 0,
      };

      vi.mocked(mockRepository.searchListings!).mockResolvedValue(mockResults);

      const result = await service.getFeaturedTools(10);

      expect(result).toEqual(mockResults.items);
      expect(mockRepository.searchListings).toHaveBeenCalledWith(
        expect.objectContaining({
          status: PublicationStatus.PUBLISHED,
          sortBy: "downloads",
          sortOrder: "desc",
        }),
      );
    });
  });
});
