/**
 * Core types for OSS AI Agent Tool SDK
 */

import { z } from 'zod';

// ============================================================================
// Tool Types
// ============================================================================

export enum ToolCapability {
  READ_FILES = 'read_files',
  WRITE_FILES = 'write_files',
  EXECUTE_COMMANDS = 'execute_commands',
  NETWORK_ACCESS = 'network_access',
  DATABASE_ACCESS = 'database_access',
  BROWSER_ACCESS = 'browser_access',
  API_CALLS = 'api_calls',
  SEARCH = 'search',
  READ = 'read',
  WRITE = 'write'
}

export const ToolDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string().optional().default('1.0.0'),
  capabilities: z.array(z.nativeEnum(ToolCapability)),
  inputSchema: z.record(z.any()),
  outputSchema: z.record(z.any()).optional(),
  examples: z.array(z.object({
    input: z.record(z.any()),
    output: z.record(z.any())
  })).optional(),
  metadata: z.record(z.any()).optional()
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export interface ToolExecutionContext {
  executionId: string;
  userId?: string;
  tenantId?: string;
  workspace?: string;
  environment: 'development' | 'staging' | 'production';
  metadata?: Record<string, any>;
}

export interface ToolExecutionResult<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  metadata?: {
    duration?: number;
    cost?: number;
    tokensUsed?: number;
  };
}

// ============================================================================
// Plan Types
// ============================================================================

export enum PlanStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  EXECUTING = 'executing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled'
}

export const PlanRequestSchema = z.object({
  goal: z.string(),
  context: z.record(z.any()).optional(),
  constraints: z.object({
    maxSteps: z.number().optional(),
    maxDuration: z.number().optional(),
    allowedTools: z.array(z.string()).optional(),
    budget: z.object({
      maxCost: z.number().optional(),
      maxTokens: z.number().optional()
    }).optional()
  }).optional(),
  approvalMode: z.enum(['auto', 'manual', 'conditional']).optional().default('manual')
});

export type PlanRequest = z.infer<typeof PlanRequestSchema>;

export interface PlanStep {
  id: string;
  action: string;
  tool: string;
  input: Record<string, any>;
  dependencies: string[];
  estimatedDuration?: number;
  estimatedCost?: number;
  requiresApproval: boolean;
  status: 'pending' | 'approved' | 'executing' | 'completed' | 'failed' | 'skipped';
}

export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  status: PlanStatus;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  result?: {
    success: boolean;
    output?: any;
    error?: string;
  };
  metadata?: {
    totalCost?: number;
    totalTokens?: number;
    duration?: number;
  };
}

// ============================================================================
// Event Types
// ============================================================================

export enum EventType {
  PLAN_CREATED = 'plan.created',
  PLAN_APPROVED = 'plan.approved',
  PLAN_REJECTED = 'plan.rejected',
  PLAN_EXECUTING = 'plan.executing',
  PLAN_COMPLETED = 'plan.completed',
  PLAN_FAILED = 'plan.failed',
  STEP_STARTED = 'step.started',
  STEP_COMPLETED = 'step.completed',
  STEP_FAILED = 'step.failed',
  TOOL_INVOKED = 'tool.invoked',
  TOOL_COMPLETED = 'tool.completed',
  APPROVAL_REQUIRED = 'approval.required'
}

export interface Event<T = any> {
  type: EventType;
  planId: string;
  stepId?: string;
  data: T;
  timestamp: Date;
}

// ============================================================================
// Search Types
// ============================================================================

export enum SearchType {
  SEMANTIC = 'semantic',
  CODE = 'code',
  FULL_TEXT = 'full_text'
}

export interface SearchRequest {
  query: string;
  type: SearchType;
  limit?: number;
  offset?: number;
  filters?: {
    language?: string;
    repository?: string;
    path?: string;
    dateRange?: {
      start: Date;
      end: Date;
    };
  };
}

export interface SearchResult {
  id: string;
  score: number;
  content: string;
  metadata: {
    source?: string;
    file?: string;
    line?: number;
    language?: string;
    [key: string]: any;
  };
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  took: number;
}

// ============================================================================
// Client Configuration
// ============================================================================

export interface ClientConfig {
  endpoint: string;
  apiKey?: string;
  timeout?: number;
  retries?: number;
  headers?: Record<string, string>;
}

// ============================================================================
// Error Types
// ============================================================================

export class SDKError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public details?: any
  ) {
    super(message);
    this.name = 'SDKError';
  }
}

export class AuthenticationError extends SDKError {
  constructor(message: string = 'Authentication failed') {
    super(message, 'AUTHENTICATION_ERROR', 401);
    this.name = 'AuthenticationError';
  }
}

export class ValidationError extends SDKError {
  constructor(message: string, details?: any) {
    super(message, 'VALIDATION_ERROR', 400, details);
    this.name = 'ValidationError';
  }
}

export class ToolExecutionError extends SDKError {
  constructor(message: string, details?: any) {
    super(message, 'TOOL_EXECUTION_ERROR', 500, details);
    this.name = 'ToolExecutionError';
  }
}
