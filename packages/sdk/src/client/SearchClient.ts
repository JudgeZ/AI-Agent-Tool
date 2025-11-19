/**
 * SearchClient - Semantic and code search capabilities
 */

import type { OrchestratorClient } from './OrchestratorClient';
import type { SearchRequest, SearchResponse, SearchType } from '../types';

export class SearchClient {
  constructor(private client: OrchestratorClient) {}

  /**
   * Perform semantic search
   */
  async semantic(query: string, options?: {
    limit?: number;
    filters?: SearchRequest['filters'];
  }): Promise<SearchResponse> {
    return this.client.request<SearchResponse>('POST', '/api/search/semantic', {
      body: {
        query,
        type: 'semantic',
        limit: options?.limit || 10,
        filters: options?.filters
      }
    });
  }

  /**
   * Perform code search
   */
  async code(query: string, options?: {
    language?: string;
    repository?: string;
    limit?: number;
  }): Promise<SearchResponse> {
    return this.client.request<SearchResponse>('POST', '/api/search/code', {
      body: {
        query,
        type: 'code',
        language: options?.language,
        repository: options?.repository,
        limit: options?.limit || 10
      }
    });
  }

  /**
   * Perform full-text search
   */
  async fullText(query: string, options?: {
    limit?: number;
    offset?: number;
  }): Promise<SearchResponse> {
    return this.client.request<SearchResponse>('POST', '/api/search', {
      body: {
        query,
        type: 'full_text',
        limit: options?.limit || 10,
        offset: options?.offset || 0
      }
    });
  }
}
