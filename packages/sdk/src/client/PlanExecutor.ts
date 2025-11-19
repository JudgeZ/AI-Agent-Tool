/**
 * PlanExecutor - Manages plan creation and execution
 */

import type { OrchestratorClient } from './OrchestratorClient';
import type { Plan, PlanRequest, Event, EventType } from '../types';

export class PlanExecutor {
  constructor(private client: OrchestratorClient) {}

  /**
   * Create a new plan
   */
  async create(request: PlanRequest): Promise<Plan> {
    return this.client.request<Plan>('POST', '/api/plans', {
      body: request
    });
  }

  /**
   * Get a plan by ID
   */
  async get(planId: string): Promise<Plan> {
    return this.client.request<Plan>('GET', `/api/plans/${planId}`);
  }

  /**
   * List plans with optional filters
   */
  async list(options?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ plans: Plan[]; total: number }> {
    return this.client.request('GET', '/api/plans', {
      query: options as any
    });
  }

  /**
   * Execute a plan with real-time events
   */
  async *execute(planId: string, options?: {
    signal?: AbortSignal;
  }): AsyncGenerator<Event, void, undefined> {
    // Start execution
    await this.client.request('POST', `/api/plans/${planId}/execute`);

    // Stream events
    yield* this.client.stream<Event>(`/api/plans/${planId}/events`, {
      signal: options?.signal
    });
  }

  /**
   * Approve a plan
   */
  async approve(planId: string, comment?: string): Promise<Plan> {
    return this.client.request<Plan>('POST', `/api/plans/${planId}/approve`, {
      body: { comment }
    });
  }

  /**
   * Reject a plan
   */
  async reject(planId: string, reason: string): Promise<Plan> {
    return this.client.request<Plan>('POST', `/api/plans/${planId}/reject`, {
      body: { reason }
    });
  }

  /**
   * Cancel a running plan
   */
  async cancel(planId: string): Promise<Plan> {
    return this.client.request<Plan>('POST', `/api/plans/${planId}/cancel`);
  }

  /**
   * Approve a specific step
   */
  async approveStep(planId: string, stepId: string): Promise<void> {
    return this.client.request('POST', `/api/plans/${planId}/steps/${stepId}/approve`);
  }

  /**
   * Reject a specific step
   */
  async rejectStep(planId: string, stepId: string, reason: string): Promise<void> {
    return this.client.request('POST', `/api/plans/${planId}/steps/${stepId}/reject`, {
      body: { reason }
    });
  }
}
