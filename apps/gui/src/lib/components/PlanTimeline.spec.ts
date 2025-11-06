import '@testing-library/svelte/vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';

import PlanTimeline from './PlanTimeline.svelte';
import { timeline } from '$lib/stores/planTimeline';
import { MockEventSource } from '$lib/test-utils/mockEventSource';

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
  MockEventSource.reset();
});

afterEach(() => {
  timeline.disconnect();
  MockEventSource.reset();
});

function emitStep(planId: string) {
  const source = MockEventSource.instances.at(-1);
  source?.emit('plan.step', {
    plan_id: planId,
    step: {
      id: 's1',
      capability: 'repo.read',
      action: 'Index repository',
      state: 'running',
      summary: 'Scanning files'
    }
  });
}

function triggerOpen() {
  const source = MockEventSource.instances.at(-1);
  source?.triggerOpen();
  return source;
}

describe('PlanTimeline component', () => {
  it('renders connection status changes and step updates from the stream', async () => {
    render(PlanTimeline);
    timeline.connect('plan-component');
    await tick();

    await screen.findByText('Connecting…');
    const source = triggerOpen();
    expect(source?.url).toContain('plan-component');

    await screen.findByText('Connected');

    emitStep('plan-component');

    const step = await screen.findByTestId('step-s1');
    expect(step.textContent).toContain('Index repository');
    expect(step.textContent).toContain('running');
  });

  it('surfaces connection errors when the stream fails', async () => {
    render(PlanTimeline);
    timeline.connect('plan-error');
    await tick();

    const source = triggerOpen();
    expect(get(timeline).connected).toBe(true);

    source?.triggerError('stream failed');

    await screen.findByText('stream failed');
    await screen.findByText('Connecting…');
  });

  it('cleans up listeners when disconnecting', async () => {
    render(PlanTimeline);
    timeline.connect('plan-disconnect');
    await tick();

    const source = triggerOpen();
    expect(source?.listenerCount('plan.step')).toBe(1);

    timeline.disconnect();
    await tick();

    expect(source?.listenerCount('plan.step')).toBe(0);
    expect(source?.closed).toBe(true);
    await waitFor(() => {
      expect(get(timeline).connected).toBe(false);
    });
  });
});
