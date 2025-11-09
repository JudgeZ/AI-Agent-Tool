import { get } from 'svelte/store';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MockEventSource } from '$lib/test-utils/mockEventSource';
import { timeline } from './planTimeline';

vi.mock('$lib/config', () => ({
  ssePath: (planId: string) => `https://example.test/plans/${planId}/events`,
  approvalPath: (planId: string, stepId: string) => `https://example.test/plans/${planId}/steps/${stepId}`
}));

const VALID_PLAN_ID = 'plan-550e8400-e29b-41d4-a716-446655440000';
const ORDERING_PLAN_ID = 'plan-12345678-9abc-4def-8abc-1234567890ab';
const ERROR_PLAN_ID = 'plan-abcdefab-cdef-4abc-8def-abcdefabcdef';
const CLEANUP_PLAN_ID = 'plan-00112233-4455-4677-8899-aabbccddeeff';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Global {
      EventSource: typeof MockEventSource;
    }
  }
}

beforeAll(() => {
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  timeline.disconnect();
});

afterEach(() => {
  timeline.disconnect();
  MockEventSource.reset();
});

describe('timeline.connect', () => {
  it('marks the store as connected when the stream opens and applies step updates', () => {
    timeline.connect(VALID_PLAN_ID);
    const source = MockEventSource.instances.at(-1);
    expect(source).toBeTruthy();
    expect(source?.url).toContain(VALID_PLAN_ID);

    source?.triggerOpen();
    const afterOpen = get(timeline);
    expect(afterOpen.connected).toBe(true);
    expect(afterOpen.connectionError).toBeNull();

    const stepPayload = {
      plan_id: VALID_PLAN_ID,
      step: {
        id: 's1',
        capability: 'repo.read',
        state: 'running',
        labels: ['repo'],
        summary: 'Indexing repository'
      }
    };

    source?.emit('plan.step', stepPayload);

    const afterStep = get(timeline);
    expect(afterStep.steps).toHaveLength(1);
    expect(afterStep.steps[0]).toMatchObject({
      id: 's1',
      state: 'running',
      capability: 'repo.read',
      summary: 'Indexing repository'
    });
    expect(afterStep.awaitingApproval).toBeNull();
  });

  it('orders steps with numeric suffixes based on their numeric value', () => {
    timeline.connect(ORDERING_PLAN_ID);
    const source = MockEventSource.instances.at(-1);
    expect(source).toBeTruthy();

    source?.triggerOpen();

    const emitStep = (id: string) => {
      source?.emit('plan.step', {
        plan_id: ORDERING_PLAN_ID,
        step: {
          id,
          capability: 'repo.read',
          state: 'queued'
        }
      });
    };

    emitStep('s1');
    emitStep('s10');
    emitStep('s2');

    const afterSteps = get(timeline);
    expect(afterSteps.steps.map((step) => step.id)).toEqual(['s1', 's2', 's10']);
  });

  it('captures stream errors and marks the connection as disconnected', () => {
    timeline.connect(ERROR_PLAN_ID);
    const source = MockEventSource.instances.at(-1);
    expect(source).toBeTruthy();

    source?.triggerOpen();
    expect(get(timeline).connected).toBe(true);

    source?.triggerError('stream failed');

    const afterError = get(timeline);
    expect(afterError.connected).toBe(false);
    expect(afterError.connectionError).toContain('stream failed');
    expect(afterError.retrying).toBe(true);
    expect(afterError.retryAttempt).toBe(1);
  });

  it('cleans up listeners and closes the stream on disconnect', () => {
    timeline.connect(CLEANUP_PLAN_ID);
    const source = MockEventSource.instances.at(-1);
    expect(source).toBeTruthy();
    expect(source?.listenerCount('plan.step')).toBe(1);

    timeline.disconnect();

    expect(source?.closed).toBe(true);
    expect(source?.listenerCount('plan.step')).toBe(0);
    expect(get(timeline).connected).toBe(false);
  });

  it('retries with exponential backoff after a connection error', () => {
    vi.useFakeTimers();
    try {
      timeline.connect(ERROR_PLAN_ID);
      const initialSource = MockEventSource.instances.at(-1);
      expect(initialSource).toBeTruthy();

      initialSource?.triggerError('temporary failure');

      const afterFirstError = get(timeline);
      expect(afterFirstError.retrying).toBe(true);
      expect(afterFirstError.retryAttempt).toBe(1);

      expect(MockEventSource.instances).toHaveLength(1);

      vi.advanceTimersByTime(1_000);

      expect(MockEventSource.instances).toHaveLength(2);
      const retrySource = MockEventSource.instances.at(-1);
      expect(retrySource).not.toBe(initialSource);

      retrySource?.triggerOpen();

      const afterReconnect = get(timeline);
      expect(afterReconnect.connected).toBe(true);
      expect(afterReconnect.retrying).toBe(false);
      expect(afterReconnect.retryAttempt).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retrying after the maximum attempt count and surfaces a descriptive error', () => {
    vi.useFakeTimers();
    try {
      timeline.connect(ERROR_PLAN_ID);
      const maxRetries = get(timeline).maxRetryAttempts;

      for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
        const source = MockEventSource.instances.at(-1);
        expect(source).toBeTruthy();

        source?.triggerError(`failure ${attempt}`);

        const state = get(timeline);
        const expectedAttempt = Math.min(attempt, state.maxRetryAttempts);
        expect(state.retryAttempt).toBe(expectedAttempt);

        if (attempt <= state.maxRetryAttempts) {
          expect(state.retrying).toBe(true);
          const expectedDelay = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
          vi.advanceTimersByTime(expectedDelay);
          expect(MockEventSource.instances.length).toBe(attempt + 1);
        } else {
          expect(state.retrying).toBe(false);
          expect(state.retryAttempt).toBe(state.maxRetryAttempts);
          expect(state.connectionError).toContain('Retry limit reached');
          const instanceCount = MockEventSource.instances.length;
          vi.advanceTimersByTime(60_000);
          expect(MockEventSource.instances.length).toBe(instanceCount);
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
