import { describe, expect, it } from 'vitest';

import { type TimelineState, __test } from '../planTimeline';

const baseState: TimelineState = {
  planId: 'plan-1',
  connected: false,
  steps: [],
  awaitingApproval: null,
  approvalSubmitting: false,
  connectionError: null,
  approvalError: null,
  retrying: false,
  retryAttempt: 0,
  maxRetryAttempts: 5
};

describe('planTimeline helpers', () => {
  it('coalesces the first non-nullish value', () => {
    expect(__test.coalesce(null, undefined, 'value', 'later')).toBe('value');
    expect(__test.coalesce(undefined, null)).toBeUndefined();
  });

  it('parses and compares step ids with numeric suffixes', () => {
    expect(__test.parseStepId('s10')).toEqual({ prefix: 's', number: 10 });
    expect(__test.compareStepIds('s2', 's10')).toBeLessThan(0);
    expect(__test.compareStepIds('alpha', 'alpha')).toBe(0);
  });

  it('resolves timestamps using transitioned values first', () => {
    const timestamp = __test.resolveTimestamp({
      step: { id: 's1', capability: 'repo.read', state: 'running', transitioned_at: '2024-01-01T00:00:00Z' }
    });
    expect(timestamp).toBe('2024-01-01T00:00:00Z');

    const fallbackTimestamp = __test.resolveTimestamp({
      occurred_at: '2024-02-02T00:00:00Z',
      step: { id: 's1', capability: 'repo.read', state: 'running' }
    });
    expect(fallbackTimestamp).toBe('2024-02-02T00:00:00Z');
  });

  it('caps retry delays based on exponential backoff rules', () => {
    expect(__test.getRetryDelay(1)).toBe(1_000);
    expect(__test.getRetryDelay(4)).toBe(8_000);
    expect(__test.getRetryDelay(10)).toBe(30_000);
  });

  it('transforms raw diff output into a consistent payload', () => {
    expect(__test.toDiffPayload({ diff: '@@change' })?.files[0]).toMatchObject({ path: 'changes', patch: '@@change' });

    const arrayDiff = __test.toDiffPayload({ diff: [{ path: 'file.ts', patch: '-a +b' }, { path: 'ignored' }] });
    expect(arrayDiff?.files).toEqual([{ path: 'file.ts', patch: '-a +b' }]);

    const objectFiles = __test.toDiffPayload({ diff: { files: [{ path: 'file.ts', patch: '-a +b' }] } });
    expect(objectFiles?.files).toEqual([{ path: 'file.ts', patch: '-a +b' }]);

    expect(__test.toDiffPayload({ diff: 123 as unknown as Record<string, unknown> })).toBeUndefined();
  });

  it('records history entries and awaiting approval state consistently', () => {
    const initialPayload = {
      step: {
        id: 's1',
        capability: 'repo.read',
        state: 'running',
        transitioned_at: '2024-01-01T00:00:00Z'
      }
    };

    const withStep = __test.upsertStep(baseState, initialPayload);
    expect(withStep.steps[0].history).toHaveLength(1);
    expect(withStep.awaitingApproval).toBeNull();

    const approvalPayload = {
      step: {
        id: 's1',
        capability: 'repo.read',
        state: 'waiting_approval',
        summary: 'needs review',
        output: { diff: '@@change' },
        transitioned_at: '2024-01-01T00:00:00Z'
      },
      detail: { step: { approval_required: true } }
    };

    const awaiting = __test.upsertStep(withStep, approvalPayload);
    expect(awaiting.awaitingApproval?.id).toBe('s1');
    expect(awaiting.steps[0].diff?.files[0].patch).toBe('@@change');
    expect(awaiting.steps[0].history).toHaveLength(2);

    const completedPayload = {
      step: {
        id: 's1',
        capability: 'repo.read',
        state: 'completed',
        transitioned_at: '2024-01-01T00:00:00Z'
      }
    };

    const completed = __test.upsertStep(awaiting, completedPayload);
    expect(completed.awaitingApproval).toBeNull();
    expect(completed.steps[0].history).toHaveLength(3);
    expect(completed.steps[0].state).toBe('completed');
  });
});
