import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  clearNotifications,
  dismiss,
  notifications,
  notifyError,
  notifySuccess,
  type Notification
} from '../notifications';

beforeEach(() => {
  clearNotifications();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  clearNotifications();
});

test('queues notifications and auto-dismisses after timeout', () => {
  const states: Notification[][] = [];
  const unsubscribe = notifications.subscribe((value) => states.push(value));

  const id = notifyError('collaboration failed', { timeoutMs: 1000 });

  expect(states.at(-1)).toEqual([{ id, message: 'collaboration failed', level: 'error' }]);

  vi.advanceTimersByTime(1100);

  expect(states.at(-1)).toEqual([]);
  unsubscribe();
});

test('manual dismissal keeps remaining notifications intact', () => {
  const states: Notification[][] = [];
  const unsubscribe = notifications.subscribe((value) => states.push(value));

  const successId = notifySuccess('layout saved', { timeoutMs: 0 });
  const errorId = notifyError('connection lost', { timeoutMs: 0 });

  dismiss(successId);

  expect(states.at(-1)?.map((notification) => notification.id)).toEqual([errorId]);
  unsubscribe();
});
