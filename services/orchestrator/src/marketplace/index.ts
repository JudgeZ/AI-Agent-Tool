/**
 * Marketplace module exports
 */

export { MarketplaceRepository, type MarketplaceRepositoryConfig } from './MarketplaceRepository.js';
export { MarketplaceService, type MarketplaceServiceConfig } from './MarketplaceService.js';
export { SecurityScanner, createDefaultScannerConfig, type SecurityScannerConfig } from './SecurityScanner.js';
export { createMarketplaceRouter, type MarketplaceRoutesConfig } from './routes.js';
export {
  type ToolManifest,
  type ToolListing,
  type ToolPublishRequest,
  type ToolSearchQuery,
  type ToolSearchResults,
  type ToolVersion,
  type ToolVersionUpdate,
  type ToolReview,
  type ToolReviewWithMetadata,
  type SecurityScanResult,
  PublicationStatus,
  ScanStatus,
  ToolPublishRequestSchema,
  ToolSearchQuerySchema,
  ToolVersionUpdateSchema,
  ToolReviewSchema,
  compareVersions,
  formatVersion,
  parseVersion,
} from './types.js';

/**
 * Initialize marketplace with default configuration
 */
import type { Pool } from 'pg';
import { appLogger } from '../observability/logger.js';
import { MarketplaceRepository } from './MarketplaceRepository.js';
import { MarketplaceService } from './MarketplaceService.js';
import { SecurityScanner, createDefaultScannerConfig } from './SecurityScanner.js';

let marketplaceService: MarketplaceService | null = null;

export async function initializeMarketplace(pool: Pool): Promise<MarketplaceService> {
  if (marketplaceService) {
    return marketplaceService;
  }

  appLogger.info('initializing marketplace');

  // Create repository
  const repository = new MarketplaceRepository({
    pool,
    logger: appLogger,
  });

  // Initialize database schema
  await repository.initialize();

  // Create security scanner
  const scanner = new SecurityScanner(createDefaultScannerConfig(appLogger));

  // Create service
  marketplaceService = new MarketplaceService({
    repository,
    scanner,
    logger: appLogger,
    requireSecurityScan: process.env.NODE_ENV === 'production',
    autoPublish: process.env.NODE_ENV !== 'production',
  });

  appLogger.info('marketplace initialized');

  return marketplaceService;
}

export function getMarketplaceService(): MarketplaceService {
  if (!marketplaceService) {
    throw new Error('Marketplace not initialized. Call initializeMarketplace() first.');
  }
  return marketplaceService;
}
