import { get } from 'svelte/store';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MockEventSource } from '$lib/test-utils/mockEventSource';
import { timeline } from './planTimeline';

vi.mock('$lib/config', () => ({
  ssePath: (planId: string) => `https://example.test/plans/${planId}/events`,
  approvalPath: (planId: string, stepId: string) => `https://example.test/plans/${planId}/steps/${stepId}`
}));

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
    timeline.connect('plan-123');
    const source = MockEventSource.instances.at(-1);
    expect(source).toBeTruthy();
    expect(source?.url).toContain('plan-123');

    source?.triggerOpen();
    const afterOpen = get(timeline);
    expect(afterOpen.connected).toBe(true);
    expect(afterOpen.connectionError).toBeNull();

    const stepPayload = {
      plan_id: 'plan-123',
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

  it('captures stream errors and marks the connection as disconnected', () => {
    timeline.connect('plan-err');
    const source = MockEventSource.instances.at(-1);
    expect(source).toBeTruthy();

    source?.triggerOpen();
    expect(get(timeline).connected).toBe(true);

    source?.triggerError('stream failed');

    const afterError = get(timeline);
    expect(afterError.connected).toBe(false);
    expect(afterError.connectionError).toContain('stream failed');
  });

  it('cleans up listeners and closes the stream on disconnect', () => {
    timeline.connect('plan-cleanup');
    const source = MockEventSource.instances.at(-1);
    expect(source).toBeTruthy();
    expect(source?.listenerCount('plan.step')).toBe(1);

    timeline.disconnect();

    expect(source?.closed).toBe(true);
    expect(source?.listenerCount('plan.step')).toBe(0);
    expect(get(timeline).connected).toBe(false);
  });
});
