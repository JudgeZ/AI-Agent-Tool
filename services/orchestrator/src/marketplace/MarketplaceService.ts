/**
 * Marketplace service for tool publishing, discovery, and management
 */

import { Logger } from "pino";
import { MarketplaceRepository } from "./MarketplaceRepository.js";
import { SecurityScanner } from "./SecurityScanner.js";
import {
  type ToolListing,
  type ToolPublishRequest,
  type ToolSearchQuery,
  type ToolSearchResults,
  type ToolReview,
  type ToolReviewWithMetadata,
  type ToolVersionUpdate,
  type SecurityScanResult,
  PublicationStatus,
  ScanStatus,
  compareVersions,
  formatVersion,
} from "./types.js";

export interface MarketplaceServiceConfig {
  repository: MarketplaceRepository;
  scanner: SecurityScanner;
  logger: Logger;
  /** Require security scan before publishing */
  requireSecurityScan: boolean;
  /** Auto-publish tools that pass security scan */
  autoPublish: boolean;
}

/**
 * Service for marketplace operations
 */
export class MarketplaceService {
  private repository: MarketplaceRepository;
  private scanner: SecurityScanner;
  private logger: Logger;
  private config: MarketplaceServiceConfig;

  constructor(config: MarketplaceServiceConfig) {
    this.repository = config.repository;
    this.scanner = config.scanner;
    this.config = config;
    this.logger = config.logger.child({ component: "MarketplaceService" });
  }

  /**
   * Publish a new tool to the marketplace
   */
  async publishTool(
    request: ToolPublishRequest,
    publisher: {
      tenantId: string;
      userId: string;
      name?: string;
      email?: string;
    },
  ): Promise<ToolListing> {
    this.logger.info(
      { toolId: request.manifest.id, publisher: publisher.userId },
      "publishing tool to marketplace",
    );

    // Check if tool already exists
    const existing = await this.repository.getListing(request.manifest.id);
    if (existing) {
      throw new Error(
        `Tool ${request.manifest.id} already exists in marketplace`,
      );
    }

    // Perform security scan
    let securityScan: SecurityScanResult = {
      status: ScanStatus.SKIPPED,
      findings: [],
      summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    };

    if (!request.skipSecurityScan && this.config.requireSecurityScan) {
      securityScan = await this.scanner.scan(
        request.packageUrl,
        request.manifest.id,
      );
    }

    // Determine initial status
    let status = PublicationStatus.DRAFT;
    if (this.config.autoPublish && securityScan.status === ScanStatus.PASSED) {
      status = PublicationStatus.PUBLISHED;
    } else if (securityScan.status === ScanStatus.FAILED) {
      status = PublicationStatus.DRAFT;
    } else {
      status = PublicationStatus.PENDING_REVIEW;
    }

    // Create listing
    const listing = await this.repository.createListing({
      id: request.manifest.id,
      manifest: request.manifest,
      publisher,
      status,
      securityScan,
      publishedAt:
        status === PublicationStatus.PUBLISHED ? new Date() : undefined,
      packageUrl: request.packageUrl,
    });

    this.logger.info(
      {
        toolId: listing.id,
        status: listing.status,
        scanStatus: securityScan.status,
      },
      "tool published to marketplace",
    );

    return listing;
  }

  /**
   * Update a tool version
   */
  async updateToolVersion(
    update: ToolVersionUpdate,
    publisher: { tenantId: string; userId: string },
  ): Promise<ToolListing> {
    this.logger.info(
      { toolId: update.toolId, version: formatVersion(update.version) },
      "updating tool version",
    );

    const existing = await this.repository.getListing(update.toolId);
    if (!existing) {
      throw new Error(`Tool ${update.toolId} not found`);
    }

    // Verify ownership
    if (
      existing.publisher.tenantId !== publisher.tenantId ||
      existing.publisher.userId !== publisher.userId
    ) {
      throw new Error("Not authorized to update this tool");
    }

    // Verify version is newer
    const versionComparison = compareVersions(
      update.version,
      existing.manifest.version,
    );
    if (versionComparison <= 0) {
      throw new Error(
        `New version ${formatVersion(update.version)} must be greater than current version ${formatVersion(existing.manifest.version)}`,
      );
    }

    // Update manifest
    const updatedManifest = {
      ...existing.manifest,
      ...update.manifest,
      version: update.version,
    };

    // Perform security scan on new version
    const securityScan = await this.scanner.scan(
      update.packageUrl,
      update.toolId,
    );

    // Update listing
    const updated = await this.repository.updateListing(update.toolId, {
      manifest: updatedManifest,
      packageUrl: update.packageUrl,
      securityScan,
      status:
        securityScan.status === ScanStatus.PASSED
          ? PublicationStatus.PUBLISHED
          : PublicationStatus.PENDING_REVIEW,
    });

    if (!updated) {
      throw new Error("Failed to update tool");
    }

    this.logger.info(
      { toolId: update.toolId, version: formatVersion(update.version) },
      "tool version updated",
    );

    return updated;
  }

  /**
   * Get a tool listing by ID
   */
  async getTool(toolId: string): Promise<ToolListing | null> {
    return this.repository.getListing(toolId);
  }

  /**
   * Search marketplace tools
   */
  async searchTools(query: ToolSearchQuery): Promise<ToolSearchResults> {
    return this.repository.searchListings(query);
  }

  /**
   * Delete a tool from marketplace
   */
  async deleteTool(
    toolId: string,
    publisher: { tenantId: string; userId: string },
  ): Promise<boolean> {
    this.logger.info(
      { toolId, publisher: publisher.userId },
      "deleting tool from marketplace",
    );

    const existing = await this.repository.getListing(toolId);
    if (!existing) {
      return false;
    }

    // Verify ownership
    if (
      existing.publisher.tenantId !== publisher.tenantId ||
      existing.publisher.userId !== publisher.userId
    ) {
      throw new Error("Not authorized to delete this tool");
    }

    const deleted = await this.repository.deleteListing(toolId);

    if (deleted) {
      this.logger.info({ toolId }, "tool deleted from marketplace");
    }

    return deleted;
  }

  /**
   * Archive a tool (soft delete)
   */
  async archiveTool(
    toolId: string,
    publisher: { tenantId: string; userId: string },
  ): Promise<ToolListing | null> {
    this.logger.info({ toolId, publisher: publisher.userId }, "archiving tool");

    const existing = await this.repository.getListing(toolId);
    if (!existing) {
      return null;
    }

    // Verify ownership
    if (
      existing.publisher.tenantId !== publisher.tenantId ||
      existing.publisher.userId !== publisher.userId
    ) {
      throw new Error("Not authorized to archive this tool");
    }

    const updated = await this.repository.updateListing(toolId, {
      status: PublicationStatus.ARCHIVED,
    });

    if (updated) {
      this.logger.info({ toolId }, "tool archived");
    }

    return updated;
  }

  /**
   * Deprecate a tool
   */
  async deprecateTool(
    toolId: string,
    publisher: { tenantId: string; userId: string },
  ): Promise<ToolListing | null> {
    this.logger.info(
      { toolId, publisher: publisher.userId },
      "deprecating tool",
    );

    const existing = await this.repository.getListing(toolId);
    if (!existing) {
      return null;
    }

    // Verify ownership
    if (
      existing.publisher.tenantId !== publisher.tenantId ||
      existing.publisher.userId !== publisher.userId
    ) {
      throw new Error("Not authorized to deprecate this tool");
    }

    const updated = await this.repository.updateListing(toolId, {
      status: PublicationStatus.DEPRECATED,
    });

    if (updated) {
      this.logger.info({ toolId }, "tool deprecated");
    }

    return updated;
  }

  /**
   * Approve a tool for publication (admin only)
   */
  async approveTool(toolId: string): Promise<ToolListing | null> {
    this.logger.info({ toolId }, "approving tool for publication");

    const existing = await this.repository.getListing(toolId);
    if (!existing) {
      return null;
    }

    if (existing.status !== PublicationStatus.PENDING_REVIEW) {
      throw new Error("Tool is not pending review");
    }

    const updated = await this.repository.updateListing(toolId, {
      status: PublicationStatus.PUBLISHED,
      publishedAt: new Date(),
    });

    if (updated) {
      this.logger.info({ toolId }, "tool approved and published");
    }

    return updated;
  }

  /**
   * Record a tool download
   */
  async recordDownload(toolId: string): Promise<void> {
    await this.repository.incrementDownloads(toolId);
  }

  /**
   * Submit a tool review
   */
  async submitReview(
    review: ToolReview,
    reviewer: { userId: string; name?: string },
  ): Promise<ToolReviewWithMetadata> {
    this.logger.info(
      { toolId: review.toolId, reviewer: reviewer.userId },
      "submitting tool review",
    );

    // Verify tool exists
    const tool = await this.repository.getListing(review.toolId);
    if (!tool) {
      throw new Error(`Tool ${review.toolId} not found`);
    }

    const reviewWithMetadata = await this.repository.createReview({
      toolId: review.toolId,
      reviewer,
      rating: review.rating,
      title: review.title,
      comment: review.comment,
    });

    this.logger.info(
      {
        toolId: review.toolId,
        reviewId: reviewWithMetadata.id,
        rating: review.rating,
      },
      "tool review submitted",
    );

    return reviewWithMetadata;
  }

  /**
   * Get reviews for a tool
   */
  async getReviews(
    toolId: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<ToolReviewWithMetadata[]> {
    return this.repository.getReviews(toolId, limit, offset);
  }

  /**
   * Get tools by publisher
   */
  async getPublisherTools(
    tenantId: string,
    userId: string,
  ): Promise<ToolListing[]> {
    return this.repository.getListingsByPublisher(tenantId, userId);
  }

  /**
   * Get featured tools (most downloaded/highest rated)
   */
  async getFeaturedTools(limit: number = 10): Promise<ToolListing[]> {
    const results = await this.repository.searchListings({
      status: PublicationStatus.PUBLISHED,
      limit,
      offset: 0,
      sortBy: "downloads",
      sortOrder: "desc",
    });

    return results.items;
  }

  /**
   * Get trending tools (recently popular)
   */
  async getTrendingTools(limit: number = 10): Promise<ToolListing[]> {
    const results = await this.repository.searchListings({
      status: PublicationStatus.PUBLISHED,
      limit,
      offset: 0,
      sortBy: "updated",
      sortOrder: "desc",
    });

    // Filter to tools with significant downloads
    return results.items.filter((tool) => tool.downloads > 10);
  }

  /**
   * Get similar tools based on capabilities and tags
   */
  async getSimilarTools(
    toolId: string,
    limit: number = 5,
  ): Promise<ToolListing[]> {
    const tool = await this.repository.getListing(toolId);
    if (!tool) {
      return [];
    }

    // Search by capabilities and tags
    const results = await this.repository.searchListings({
      capabilities: tool.manifest.capabilities,
      tags: tool.manifest.tags,
      status: PublicationStatus.PUBLISHED,
      limit: limit + 1, // +1 to exclude the tool itself
      offset: 0,
      sortBy: "relevance",
      sortOrder: "desc",
    });

    // Remove the tool itself from results
    return results.items.filter((t) => t.id !== toolId).slice(0, limit);
  }
}
