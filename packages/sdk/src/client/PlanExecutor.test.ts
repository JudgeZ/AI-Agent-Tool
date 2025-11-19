/**
 * Unit tests for PlanExecutor
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlanExecutor } from './PlanExecutor';
import { OrchestratorClient } from './OrchestratorClient';
import type { PlanResponse, PlanStepEvent } from '../types';

vi.mock('./OrchestratorClient');

describe('PlanExecutor', () => {
  let executor: PlanExecutor;
  let mockClient: OrchestratorClient;

  beforeEach(() => {
    mockClient = new OrchestratorClient({
      endpoint: 'http://localhost:4000',
      apiKey: 'test-key',
    });
    executor = new PlanExecutor(mockClient);
    vi.clearAllMocks();
  });

  describe('executePlan', () => {
    const mockPlanResponse: PlanResponse = {
      id: 'plan-123',
      status: 'pending',
      prompt: 'Test plan',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    it('should create and execute a plan', async () => {
      const mockEvents: PlanStepEvent[] = [
        {
          type: 'plan.started',
          planId: 'plan-123',
          timestamp: new Date().toISOString(),
        },
        {
          type: 'step.started',
          step: {
            id: 'step-1',
            name: 'Initialize',
            type: 'action',
            status: 'running',
          },
          timestamp: new Date().toISOString(),
        },
        {
          type: 'step.completed',
          step: {
            id: 'step-1',
            name: 'Initialize',
            type: 'action',
            status: 'completed',
          },
          timestamp: new Date().toISOString(),
        },
        {
          type: 'plan.completed',
          planId: 'plan-123',
          result: { success: true },
          timestamp: new Date().toISOString(),
        },
      ];

      vi.spyOn(mockClient, 'createPlan').mockResolvedValue(mockPlanResponse);

      // Mock async generator for streaming events
      const mockGenerator = async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      };
      vi.spyOn(mockClient, 'streamPlanEvents').mockImplementation(mockGenerator);

      const onProgress = vi.fn();
      const result = await executor.executePlan(
        { prompt: 'Test plan', capabilities: [] },
        { onProgress }
      );

      expect(mockClient.createPlan).toHaveBeenCalledWith({
        prompt: 'Test plan',
        capabilities: [],
      });
      expect(mockClient.streamPlanEvents).toHaveBeenCalledWith('plan-123');
      expect(onProgress).toHaveBeenCalledTimes(4);
      expect(result).toEqual({
        planId: 'plan-123',
        status: 'completed',
        result: { success: true },
      });
    });

    it('should handle plan errors', async () => {
      const mockEvents: PlanStepEvent[] = [
        {
          type: 'plan.started',
          planId: 'plan-123',
          timestamp: new Date().toISOString(),
        },
        {
          type: 'plan.error',
          planId: 'plan-123',
          error: 'Something went wrong',
          timestamp: new Date().toISOString(),
        },
      ];

      vi.spyOn(mockClient, 'createPlan').mockResolvedValue(mockPlanResponse);

      const mockGenerator = async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      };
      vi.spyOn(mockClient, 'streamPlanEvents').mockImplementation(mockGenerator);

      await expect(executor.executePlan({
        prompt: 'Test plan',
        capabilities: [],
      })).rejects.toThrow('Plan execution failed: Something went wrong');
    });

    it('should handle approval requirements', async () => {
      const mockEvents: PlanStepEvent[] = [
        {
          type: 'plan.started',
          planId: 'plan-123',
          timestamp: new Date().toISOString(),
        },
        {
          type: 'step.approval_required',
          step: {
            id: 'step-1',
            name: 'Sensitive Operation',
            type: 'action',
            status: 'pending_approval',
          },
          timestamp: new Date().toISOString(),
        },
      ];

      vi.spyOn(mockClient, 'createPlan').mockResolvedValue(mockPlanResponse);

      const mockGenerator = async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      };
      vi.spyOn(mockClient, 'streamPlanEvents').mockImplementation(mockGenerator);

      const onApprovalRequired = vi.fn().mockResolvedValue(true);
      const approveStep = vi.fn().mockResolvedValue({ approved: true });

      vi.spyOn(mockClient, 'approveStep').mockImplementation(approveStep);

      await executor.executePlan(
        { prompt: 'Test plan', capabilities: [] },
        { onApprovalRequired }
      );

      expect(onApprovalRequired).toHaveBeenCalledWith({
        stepId: 'step-1',
        stepName: 'Sensitive Operation',
        planId: 'plan-123',
      });
    });

    it('should handle rejection of approval', async () => {
      const mockEvents: PlanStepEvent[] = [
        {
          type: 'plan.started',
          planId: 'plan-123',
          timestamp: new Date().toISOString(),
        },
        {
          type: 'step.approval_required',
          step: {
            id: 'step-1',
            name: 'Sensitive Operation',
            type: 'action',
            status: 'pending_approval',
          },
          timestamp: new Date().toISOString(),
        },
      ];

      vi.spyOn(mockClient, 'createPlan').mockResolvedValue(mockPlanResponse);

      const mockGenerator = async function* () {
        for (const event of mockEvents) {
          yield event;
          // After rejection, emit cancelled event
          yield {
            type: 'plan.cancelled',
            planId: 'plan-123',
            timestamp: new Date().toISOString(),
          } as PlanStepEvent;
        }
      };
      vi.spyOn(mockClient, 'streamPlanEvents').mockImplementation(mockGenerator);

      const onApprovalRequired = vi.fn().mockResolvedValue(false);
      const rejectStep = vi.fn().mockResolvedValue({ rejected: true });

      vi.spyOn(mockClient, 'rejectStep').mockImplementation(rejectStep);

      const result = await executor.executePlan(
        { prompt: 'Test plan', capabilities: [] },
        { onApprovalRequired }
      );

      expect(onApprovalRequired).toHaveBeenCalled();
      expect(result.status).toBe('cancelled');
    });
  });

  describe('resumePlan', () => {
    it('should resume an existing plan', async () => {
      const mockEvents: PlanStepEvent[] = [
        {
          type: 'plan.resumed',
          planId: 'plan-123',
          timestamp: new Date().toISOString(),
        },
        {
          type: 'step.started',
          step: {
            id: 'step-2',
            name: 'Continue',
            type: 'action',
            status: 'running',
          },
          timestamp: new Date().toISOString(),
        },
        {
          type: 'step.completed',
          step: {
            id: 'step-2',
            name: 'Continue',
            type: 'action',
            status: 'completed',
          },
          timestamp: new Date().toISOString(),
        },
        {
          type: 'plan.completed',
          planId: 'plan-123',
          result: { success: true },
          timestamp: new Date().toISOString(),
        },
      ];

      const mockGenerator = async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      };
      vi.spyOn(mockClient, 'streamPlanEvents').mockImplementation(mockGenerator);

      const result = await executor.resumePlan('plan-123');

      expect(mockClient.streamPlanEvents).toHaveBeenCalledWith('plan-123');
      expect(result).toEqual({
        planId: 'plan-123',
        status: 'completed',
        result: { success: true },
      });
    });
  });

  describe('cancelPlan', () => {
    it('should cancel a running plan', async () => {
      vi.spyOn(mockClient, 'cancelPlan').mockResolvedValue({
        id: 'plan-123',
        status: 'cancelled',
        prompt: 'Test plan',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await executor.cancelPlan('plan-123');

      expect(mockClient.cancelPlan).toHaveBeenCalledWith('plan-123');
    });
  });

  describe('event handling', () => {
    it('should emit progress events', async () => {
      const mockEvents: PlanStepEvent[] = [
        {
          type: 'plan.started',
          planId: 'plan-123',
          timestamp: new Date().toISOString(),
        },
        {
          type: 'step.progress',
          step: {
            id: 'step-1',
            name: 'Processing',
            type: 'action',
            status: 'running',
            progress: 50,
          },
          timestamp: new Date().toISOString(),
        },
        {
          type: 'plan.completed',
          planId: 'plan-123',
          result: { success: true },
          timestamp: new Date().toISOString(),
        },
      ];

      vi.spyOn(mockClient, 'createPlan').mockResolvedValue({
        id: 'plan-123',
        status: 'pending',
        prompt: 'Test plan',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockGenerator = async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      };
      vi.spyOn(mockClient, 'streamPlanEvents').mockImplementation(mockGenerator);

      const progressEvents: any[] = [];
      await executor.executePlan(
        { prompt: 'Test plan', capabilities: [] },
        {
          onProgress: (event) => progressEvents.push(event),
        }
      );

      expect(progressEvents).toHaveLength(3);
      expect(progressEvents[1].type).toBe('step.progress');
      expect(progressEvents[1].step?.progress).toBe(50);
    });

    it('should handle tool execution events', async () => {
      const mockEvents: PlanStepEvent[] = [
        {
          type: 'plan.started',
          planId: 'plan-123',
          timestamp: new Date().toISOString(),
        },
        {
          type: 'tool.execution_started',
          tool: {
            name: 'ReadFile',
            parameters: { path: '/test.txt' },
          },
          timestamp: new Date().toISOString(),
        },
        {
          type: 'tool.execution_completed',
          tool: {
            name: 'ReadFile',
            parameters: { path: '/test.txt' },
            result: { content: 'Hello World' },
          },
          timestamp: new Date().toISOString(),
        },
        {
          type: 'plan.completed',
          planId: 'plan-123',
          result: { success: true },
          timestamp: new Date().toISOString(),
        },
      ];

      vi.spyOn(mockClient, 'createPlan').mockResolvedValue({
        id: 'plan-123',
        status: 'pending',
        prompt: 'Test plan',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const mockGenerator = async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      };
      vi.spyOn(mockClient, 'streamPlanEvents').mockImplementation(mockGenerator);

      const toolEvents: any[] = [];
      await executor.executePlan(
        { prompt: 'Test plan', capabilities: [] },
        {
          onToolExecution: (event) => toolEvents.push(event),
        }
      );

      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[0].status).toBe('started');
      expect(toolEvents[1].status).toBe('completed');
      expect(toolEvents[1].result).toEqual({ content: 'Hello World' });
    });
  });
});
