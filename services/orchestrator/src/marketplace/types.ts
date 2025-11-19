/**
 * Marketplace types for tool publishing, discovery, and version management
 */

import { z } from "zod";
import { ToolCapability } from "../tools/McpTool.js";

/**
 * Tool version schema
 */
export const ToolVersionSchema = z.object({
  major: z.number().int().min(0),
  minor: z.number().int().min(0),
  patch: z.number().int().min(0),
  prerelease: z.string().optional(),
  build: z.string().optional(),
});

export type ToolVersion = z.infer<typeof ToolVersionSchema>;

/**
 * Tool publication status
 */
export enum PublicationStatus {
  DRAFT = "draft",
  PENDING_REVIEW = "pending_review",
  PUBLISHED = "published",
  DEPRECATED = "deprecated",
  ARCHIVED = "archived",
}

/**
 * Security scan result
 */
export enum ScanStatus {
  PENDING = "pending",
  SCANNING = "scanning",
  PASSED = "passed",
  FAILED = "failed",
  SKIPPED = "skipped",
}

export interface SecurityScanResult {
  status: ScanStatus;
  scannedAt?: Date;
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low" | "info";
    category: string;
    title: string;
    description: string;
    recommendation?: string;
  }>;
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
}

/**
 * Tool manifest for marketplace
 */
export interface ToolManifest {
  /** Unique tool identifier (e.g., "com.example.my-tool") */
  id: string;

  /** Display name */
  name: string;

  /** Short description */
  description: string;

  /** Semantic version */
  version: ToolVersion;

  /** Tool author */
  author: {
    name: string;
    email?: string;
    url?: string;
  };

  /** Repository URL */
  repository?: string;

  /** License identifier (SPDX) */
  license: string;

  /** Tool capabilities */
  capabilities: ToolCapability[];

  /** Category tags */
  tags: string[];

  /** Tool icon URL */
  icon?: string;

  /** Screenshots URLs */
  screenshots?: string[];

  /** Long-form documentation markdown */
  readme?: string;

  /** Changelog markdown */
  changelog?: string;

  /** Input schema (JSON Schema) */
  inputSchema: Record<string, unknown>;

  /** Output schema (JSON Schema) */
  outputSchema?: Record<string, unknown>;

  /** Example usage */
  examples?: Array<{
    title: string;
    description: string;
    input: Record<string, unknown>;
    output?: Record<string, unknown>;
  }>;

  /** Dependencies */
  dependencies?: Array<{
    toolId: string;
    version: string;
  }>;

  /** Minimum platform version required */
  platformVersion?: string;
}

/**
 * Tool publication request schema
 */
export const ToolPublishRequestSchema = z.object({
  manifest: z.object({
    id: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[a-z0-9][a-z0-9-_.]*[a-z0-9]$/),
    name: z.string().min(1).max(255),
    description: z.string().min(10).max(1000),
    version: ToolVersionSchema,
    author: z.object({
      name: z.string().min(1),
      email: z.string().email().optional(),
      url: z.string().url().optional(),
    }),
    repository: z.string().url().optional(),
    license: z.string().min(1),
    capabilities: z.array(z.nativeEnum(ToolCapability)).min(1),
    tags: z.array(z.string()).max(10),
    icon: z.string().url().optional(),
    screenshots: z.array(z.string().url()).max(5).optional(),
    readme: z.string().optional(),
    changelog: z.string().optional(),
    inputSchema: z.record(z.unknown()),
    outputSchema: z.record(z.unknown()).optional(),
    examples: z
      .array(
        z.object({
          title: z.string(),
          description: z.string(),
          input: z.record(z.unknown()),
          output: z.record(z.unknown()).optional(),
        }),
      )
      .max(10)
      .optional(),
    dependencies: z
      .array(
        z.object({
          toolId: z.string(),
          version: z.string(),
        }),
      )
      .optional(),
    platformVersion: z.string().optional(),
  }),
  packageUrl: z.string().url(),
  skipSecurityScan: z.boolean().optional(),
});

export type ToolPublishRequest = z.infer<typeof ToolPublishRequestSchema>;

/**
 * Published tool listing
 */
export interface ToolListing {
  id: string;
  manifest: ToolManifest;
  publisher: {
    tenantId: string;
    userId: string;
    name?: string;
    email?: string;
  };
  status: PublicationStatus;
  securityScan: SecurityScanResult;
  publishedAt?: Date;
  updatedAt: Date;
  createdAt: Date;
  downloads: number;
  rating?: {
    average: number;
    count: number;
  };
  packageUrl: string;
}

/**
 * Tool search query schema
 */
export const ToolSearchQuerySchema = z.object({
  q: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  author: z.string().optional(),
  minRating: z.number().min(0).max(5).optional(),
  status: z.nativeEnum(PublicationStatus).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
  sortBy: z
    .enum(["downloads", "rating", "updated", "created", "relevance"])
    .default("relevance"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type ToolSearchQuery = z.infer<typeof ToolSearchQuerySchema>;

/**
 * Tool search results
 */
export interface ToolSearchResults {
  items: ToolListing[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Tool version update schema
 */
export const ToolVersionUpdateSchema = z.object({
  toolId: z.string(),
  version: ToolVersionSchema,
  manifest: z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().min(10).max(1000).optional(),
    repository: z.string().url().optional(),
    icon: z.string().url().optional(),
    screenshots: z.array(z.string().url()).max(5).optional(),
    readme: z.string().optional(),
    changelog: z.string().optional(),
    inputSchema: z.record(z.unknown()).optional(),
    outputSchema: z.record(z.unknown()).optional(),
    examples: z
      .array(
        z.object({
          title: z.string(),
          description: z.string(),
          input: z.record(z.unknown()),
          output: z.record(z.unknown()).optional(),
        }),
      )
      .max(10)
      .optional(),
    dependencies: z
      .array(
        z.object({
          toolId: z.string(),
          version: z.string(),
        }),
      )
      .optional(),
    platformVersion: z.string().optional(),
  }),
  packageUrl: z.string().url(),
});

export type ToolVersionUpdate = z.infer<typeof ToolVersionUpdateSchema>;

/**
 * Tool review schema
 */
export const ToolReviewSchema = z.object({
  toolId: z.string(),
  rating: z.number().int().min(1).max(5),
  title: z.string().min(5).max(100).optional(),
  comment: z.string().min(10).max(2000).optional(),
});

export type ToolReview = z.infer<typeof ToolReviewSchema>;

/**
 * Tool review with metadata
 */
export interface ToolReviewWithMetadata extends ToolReview {
  id: string;
  reviewer: {
    userId: string;
    name?: string;
  };
  createdAt: Date;
  updatedAt: Date;
  helpful: number;
  verified: boolean;
}

/**
 * Version comparison helper
 */
export function compareVersions(a: ToolVersion, b: ToolVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // Prerelease versions have lower precedence
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease) {
    return a.prerelease.localeCompare(b.prerelease);
  }

  return 0;
}

/**
 * Format version as string
 */
export function formatVersion(version: ToolVersion): string {
  let str = `${version.major}.${version.minor}.${version.patch}`;
  if (version.prerelease) {
    str += `-${version.prerelease}`;
  }
  if (version.build) {
    str += `+${version.build}`;
  }
  return str;
}

/**
 * Parse version string
 */
export function parseVersion(versionStr: string): ToolVersion | null {
  const regex =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/;
  const match = versionStr.match(regex);

  if (!match) {
    return null;
  }

  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4],
    build: match[5],
  };
}
