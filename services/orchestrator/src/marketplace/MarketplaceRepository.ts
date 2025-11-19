/**
 * Marketplace repository for tool listings persistence
 */

import { Logger } from 'pino';
import type { Pool } from 'pg';
import {
  type ToolListing,
  type ToolManifest,
  type ToolSearchQuery,
  type ToolSearchResults,
  type ToolReviewWithMetadata,
  type SecurityScanResult,
  PublicationStatus,
  ScanStatus,
  formatVersion,
  parseVersion,
} from './types.js';

export interface MarketplaceRepositoryConfig {
  pool: Pool;
  logger: Logger;
}

/**
 * Repository for marketplace tool listings
 */
export class MarketplaceRepository {
  private pool: Pool;
  private logger: Logger;

  constructor(config: MarketplaceRepositoryConfig) {
    this.pool = config.pool;
    this.logger = config.logger.child({ component: 'MarketplaceRepository' });
  }

  /**
   * Initialize database schema
   */
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Tool listings table
      await client.query(`
        CREATE TABLE IF NOT EXISTS marketplace_tools (
          id TEXT PRIMARY KEY,
          manifest JSONB NOT NULL,
          publisher_tenant_id TEXT NOT NULL,
          publisher_user_id TEXT NOT NULL,
          publisher_name TEXT,
          publisher_email TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          package_url TEXT NOT NULL,
          published_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          downloads INTEGER NOT NULL DEFAULT 0,
          rating_average NUMERIC(3, 2),
          rating_count INTEGER NOT NULL DEFAULT 0,
          security_scan_status TEXT NOT NULL DEFAULT 'pending',
          security_scan_result JSONB,
          security_scan_at TIMESTAMPTZ
        )
      `);

      // Create indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_marketplace_tools_status
        ON marketplace_tools(status)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_marketplace_tools_publisher
        ON marketplace_tools(publisher_tenant_id, publisher_user_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_marketplace_tools_downloads
        ON marketplace_tools(downloads DESC)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_marketplace_tools_rating
        ON marketplace_tools(rating_average DESC NULLS LAST)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_marketplace_tools_updated
        ON marketplace_tools(updated_at DESC)
      `);

      // Full-text search index
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_marketplace_tools_search
        ON marketplace_tools USING gin(to_tsvector('english',
          manifest->>'name' || ' ' || manifest->>'description'
        ))
      `);

      // Tool reviews table
      await client.query(`
        CREATE TABLE IF NOT EXISTS marketplace_reviews (
          id TEXT PRIMARY KEY,
          tool_id TEXT NOT NULL REFERENCES marketplace_tools(id) ON DELETE CASCADE,
          reviewer_user_id TEXT NOT NULL,
          reviewer_name TEXT,
          rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
          title TEXT,
          comment TEXT,
          helpful INTEGER NOT NULL DEFAULT 0,
          verified BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(tool_id, reviewer_user_id)
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_tool
        ON marketplace_reviews(tool_id)
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_rating
        ON marketplace_reviews(rating DESC)
      `);

      await client.query('COMMIT');

      this.logger.info('marketplace repository initialized');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Create a new tool listing
   */
  async createListing(listing: Omit<ToolListing, 'createdAt' | 'updatedAt' | 'downloads' | 'rating'>): Promise<ToolListing> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO marketplace_tools (
          id, manifest, publisher_tenant_id, publisher_user_id,
          publisher_name, publisher_email, status, package_url,
          published_at, security_scan_status, security_scan_result, security_scan_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *`,
        [
          listing.id,
          JSON.stringify(listing.manifest),
          listing.publisher.tenantId,
          listing.publisher.userId,
          listing.publisher.name ?? null,
          listing.publisher.email ?? null,
          listing.status,
          listing.packageUrl,
          listing.publishedAt ?? null,
          listing.securityScan.status,
          JSON.stringify(listing.securityScan),
          listing.securityScan.scannedAt ?? null,
        ],
      );

      return this.rowToListing(result.rows[0]);
    } finally {
      client.release();
    }
  }

  /**
   * Get a tool listing by ID
   */
  async getListing(id: string): Promise<ToolListing | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'SELECT * FROM marketplace_tools WHERE id = $1',
        [id],
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.rowToListing(result.rows[0]);
    } finally {
      client.release();
    }
  }

  /**
   * Update a tool listing
   */
  async updateListing(id: string, updates: Partial<Omit<ToolListing, 'id' | 'createdAt' | 'publisher'>>): Promise<ToolListing | null> {
    const client = await this.pool.connect();
    try {
      const setClauses: string[] = ['updated_at = NOW()'];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (updates.manifest !== undefined) {
        setClauses.push(`manifest = $${paramIndex++}`);
        values.push(JSON.stringify(updates.manifest));
      }

      if (updates.status !== undefined) {
        setClauses.push(`status = $${paramIndex++}`);
        values.push(updates.status);
      }

      if (updates.packageUrl !== undefined) {
        setClauses.push(`package_url = $${paramIndex++}`);
        values.push(updates.packageUrl);
      }

      if (updates.publishedAt !== undefined) {
        setClauses.push(`published_at = $${paramIndex++}`);
        values.push(updates.publishedAt);
      }

      if (updates.securityScan !== undefined) {
        setClauses.push(`security_scan_status = $${paramIndex++}`);
        values.push(updates.securityScan.status);
        setClauses.push(`security_scan_result = $${paramIndex++}`);
        values.push(JSON.stringify(updates.securityScan));
        setClauses.push(`security_scan_at = $${paramIndex++}`);
        values.push(updates.securityScan.scannedAt ?? null);
      }

      values.push(id);

      const result = await client.query(
        `UPDATE marketplace_tools
         SET ${setClauses.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING *`,
        values,
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.rowToListing(result.rows[0]);
    } finally {
      client.release();
    }
  }

  /**
   * Delete a tool listing
   */
  async deleteListing(id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        'DELETE FROM marketplace_tools WHERE id = $1',
        [id],
      );

      return result.rowCount !== null && result.rowCount > 0;
    } finally {
      client.release();
    }
  }

  /**
   * Search tool listings
   */
  async searchListings(query: ToolSearchQuery): Promise<ToolSearchResults> {
    const client = await this.pool.connect();
    try {
      const conditions: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      // Text search
      if (query.q && query.q.trim().length > 0) {
        conditions.push(`to_tsvector('english', manifest->>'name' || ' ' || manifest->>'description') @@ plainto_tsquery('english', $${paramIndex++})`);
        values.push(query.q.trim());
      }

      // Capabilities filter
      if (query.capabilities && query.capabilities.length > 0) {
        conditions.push(`manifest->'capabilities' ?| $${paramIndex++}`);
        values.push(query.capabilities);
      }

      // Tags filter
      if (query.tags && query.tags.length > 0) {
        conditions.push(`manifest->'tags' ?| $${paramIndex++}`);
        values.push(query.tags);
      }

      // Author filter
      if (query.author) {
        conditions.push(`manifest->'author'->>'name' ILIKE $${paramIndex++}`);
        values.push(`%${query.author}%`);
      }

      // Rating filter
      if (query.minRating !== undefined) {
        conditions.push(`rating_average >= $${paramIndex++}`);
        values.push(query.minRating);
      }

      // Status filter
      if (query.status !== undefined) {
        conditions.push(`status = $${paramIndex++}`);
        values.push(query.status);
      } else {
        // Default: only show published tools
        conditions.push(`status = 'published'`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Determine sort column
      let orderByClause = '';
      switch (query.sortBy) {
        case 'downloads':
          orderByClause = 'downloads';
          break;
        case 'rating':
          orderByClause = 'rating_average';
          break;
        case 'updated':
          orderByClause = 'updated_at';
          break;
        case 'created':
          orderByClause = 'created_at';
          break;
        case 'relevance':
          if (query.q) {
            orderByClause = `ts_rank(to_tsvector('english', manifest->>'name' || ' ' || manifest->>'description'), plainto_tsquery('english', $${paramIndex++}))`;
            values.push(query.q.trim());
          } else {
            orderByClause = 'downloads';
          }
          break;
        default:
          orderByClause = 'downloads';
      }

      const sortOrder = query.sortOrder === 'asc' ? 'ASC' : 'DESC';

      // Count total
      const countResult = await client.query(
        `SELECT COUNT(*) as total FROM marketplace_tools ${whereClause}`,
        values,
      );
      const total = parseInt(countResult.rows[0].total, 10);

      // Fetch paginated results
      const listingsResult = await client.query(
        `SELECT * FROM marketplace_tools
         ${whereClause}
         ORDER BY ${orderByClause} ${sortOrder}
         LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
        [...values, query.limit, query.offset],
      );

      const items = listingsResult.rows.map((row) => this.rowToListing(row));

      return {
        items,
        total,
        limit: query.limit,
        offset: query.offset,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Increment download count
   */
  async incrementDownloads(id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        'UPDATE marketplace_tools SET downloads = downloads + 1 WHERE id = $1',
        [id],
      );
    } finally {
      client.release();
    }
  }

  /**
   * Create a tool review
   */
  async createReview(review: Omit<ToolReviewWithMetadata, 'id' | 'createdAt' | 'updatedAt' | 'helpful' | 'verified'>): Promise<ToolReviewWithMetadata> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const reviewId = `review_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Insert review
      const reviewResult = await client.query(
        `INSERT INTO marketplace_reviews (
          id, tool_id, reviewer_user_id, reviewer_name, rating, title, comment
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (tool_id, reviewer_user_id)
        DO UPDATE SET
          rating = EXCLUDED.rating,
          title = EXCLUDED.title,
          comment = EXCLUDED.comment,
          updated_at = NOW()
        RETURNING *`,
        [
          reviewId,
          review.toolId,
          review.reviewer.userId,
          review.reviewer.name ?? null,
          review.rating,
          review.title ?? null,
          review.comment ?? null,
        ],
      );

      // Update tool rating
      await client.query(
        `UPDATE marketplace_tools
         SET rating_average = (
           SELECT AVG(rating) FROM marketplace_reviews WHERE tool_id = $1
         ),
         rating_count = (
           SELECT COUNT(*) FROM marketplace_reviews WHERE tool_id = $1
         )
         WHERE id = $1`,
        [review.toolId],
      );

      await client.query('COMMIT');

      return this.rowToReview(reviewResult.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get reviews for a tool
   */
  async getReviews(toolId: string, limit: number = 20, offset: number = 0): Promise<ToolReviewWithMetadata[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM marketplace_reviews
         WHERE tool_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [toolId, limit, offset],
      );

      return result.rows.map((row) => this.rowToReview(row));
    } finally {
      client.release();
    }
  }

  /**
   * Get listings by publisher
   */
  async getListingsByPublisher(tenantId: string, userId: string): Promise<ToolListing[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT * FROM marketplace_tools
         WHERE publisher_tenant_id = $1 AND publisher_user_id = $2
         ORDER BY updated_at DESC`,
        [tenantId, userId],
      );

      return result.rows.map((row) => this.rowToListing(row));
    } finally {
      client.release();
    }
  }

  /**
   * Convert database row to ToolListing
   */
  private rowToListing(row: Record<string, unknown>): ToolListing {
    const manifest = row.manifest as ToolManifest;
    const securityScanResult = row.security_scan_result as Record<string, unknown> | null;

    return {
      id: row.id as string,
      manifest,
      publisher: {
        tenantId: row.publisher_tenant_id as string,
        userId: row.publisher_user_id as string,
        name: row.publisher_name as string | undefined,
        email: row.publisher_email as string | undefined,
      },
      status: row.status as PublicationStatus,
      securityScan: securityScanResult
        ? {
            status: securityScanResult.status as ScanStatus,
            scannedAt: securityScanResult.scannedAt
              ? new Date(securityScanResult.scannedAt as string)
              : undefined,
            findings: securityScanResult.findings as SecurityScanResult['findings'],
            summary: securityScanResult.summary as SecurityScanResult['summary'],
          }
        : {
            status: row.security_scan_status as ScanStatus,
            scannedAt: row.security_scan_at ? new Date(row.security_scan_at as string) : undefined,
            findings: [],
            summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
          },
      publishedAt: row.published_at ? new Date(row.published_at as string) : undefined,
      updatedAt: new Date(row.updated_at as string),
      createdAt: new Date(row.created_at as string),
      downloads: row.downloads as number,
      rating: row.rating_average !== null
        ? {
            average: parseFloat(row.rating_average as string),
            count: row.rating_count as number,
          }
        : undefined,
      packageUrl: row.package_url as string,
    };
  }

  /**
   * Convert database row to ToolReviewWithMetadata
   */
  private rowToReview(row: Record<string, unknown>): ToolReviewWithMetadata {
    return {
      id: row.id as string,
      toolId: row.tool_id as string,
      reviewer: {
        userId: row.reviewer_user_id as string,
        name: row.reviewer_name as string | undefined,
      },
      rating: row.rating as number,
      title: row.title as string | undefined,
      comment: row.comment as string | undefined,
      helpful: row.helpful as number,
      verified: row.verified as boolean,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
