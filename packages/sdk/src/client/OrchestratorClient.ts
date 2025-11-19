/**
 * OrchestratorClient - Main client for interacting with OSS AI Agent Tool
 */

import { request } from 'undici';
import type {
  ClientConfig,
  Plan,
  PlanRequest,
  Event,
  EventType,
  SDKError,
  AuthenticationError
} from '../types';
import { ToolRegistry } from '../tools/ToolRegistry';
import { PlanExecutor } from './PlanExecutor';
import { SearchClient } from './SearchClient';

export class OrchestratorClient {
  private endpoint: string;
  private apiKey?: string;
  private timeout: number;
  private retries: number;
  private headers: Record<string, string>;

  public readonly tools: ToolRegistry;
  public readonly plans: PlanExecutor;
  public readonly search: SearchClient;

  constructor(config: ClientConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.timeout = config.timeout || 30000;
    this.retries = config.retries || 3;
    this.headers = {
      'Content-Type': 'application/json',
      'User-Agent': '@oss-ai-agent-tool/sdk',
      ...config.headers
    };

    if (this.apiKey) {
      this.headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    // Initialize sub-clients
    this.tools = new ToolRegistry(this);
    this.plans = new PlanExecutor(this);
    this.search = new SearchClient(this);
  }

  /**
   * Make an HTTP request to the orchestrator
   */
  async request<T = any>(
    method: string,
    path: string,
    options?: {
      body?: any;
      query?: Record<string, string>;
      headers?: Record<string, string>;
    }
  ): Promise<T> {
    const url = new URL(path, this.endpoint);

    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.append(key, value);
      }
    }

    const headers = {
      ...this.headers,
      ...options?.headers
    };

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const response = await request(url.toString(), {
          method,
          headers,
          body: options?.body ? JSON.stringify(options.body) : undefined,
          bodyTimeout: this.timeout,
          headersTimeout: this.timeout
        });

        const statusCode = response.statusCode;
        const body = await response.body.text();

        if (statusCode === 401 || statusCode === 403) {
          throw new AuthenticationError('Invalid or missing API key');
        }

        if (statusCode >= 400) {
          let errorData: any = {};
          try {
            errorData = JSON.parse(body);
          } catch {
            errorData = { message: body };
          }

          const error: any = new Error(errorData.message || `HTTP ${statusCode}`);
          error.statusCode = statusCode;
          error.code = errorData.code;
          error.details = errorData.details;
          throw error;
        }

        if (!body) {
          return {} as T;
        }

        try {
          return JSON.parse(body) as T;
        } catch {
          return body as T;
        }
      } catch (error) {
        lastError = error as Error;

        // Don't retry on auth errors or client errors
        if ((error as any).statusCode && (error as any).statusCode < 500) {
          throw error;
        }

        // Exponential backoff for retries
        if (attempt < this.retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Request failed after retries');
  }

  /**
   * Create a Server-Sent Events stream
   */
  async *stream<T = Event>(
    path: string,
    options?: {
      query?: Record<string, string>;
      signal?: AbortSignal;
    }
  ): AsyncGenerator<T, void, undefined> {
    const url = new URL(path, this.endpoint);

    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.append(key, value);
      }
    }

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.headers,
      signal: options?.signal
    });

    if (!response.ok) {
      throw new Error(`Stream failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();

            if (data === '[DONE]') {
              return;
            }

            try {
              yield JSON.parse(data) as T;
            } catch (error) {
              console.error('Failed to parse SSE data:', data, error);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<{
    status: 'ok' | 'degraded' | 'down';
    version?: string;
    uptime?: number;
    checks?: Record<string, boolean>;
  }> {
    return this.request('GET', '/healthz');
  }

  /**
   * Get orchestrator version
   */
  async getVersion(): Promise<{ version: string; commit?: string; buildDate?: string }> {
    return this.request('GET', '/version');
  }
}

/**
 * Create a client instance
 */
export function createClient(config: ClientConfig): OrchestratorClient {
  return new OrchestratorClient(config);
}
