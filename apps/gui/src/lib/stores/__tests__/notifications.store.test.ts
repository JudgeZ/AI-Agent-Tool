import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  clearNotifications,
  dismiss,
  notifications,
  notifyInfo,
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

test('clears pending timeouts on manual dismiss and clear', () => {
  const unsubscribe = notifications.subscribe(() => {});

  const firstId = notifySuccess('saved', { timeoutMs: 1000 });
  notifyError('oops', { timeoutMs: 1000 });

  dismiss(firstId);
  vi.advanceTimersByTime(1100);

  expect(() => vi.runOnlyPendingTimers()).not.toThrow();

  clearNotifications();
  vi.advanceTimersByTime(1100);

  expect(() => vi.runOnlyPendingTimers()).not.toThrow();
  unsubscribe();
});

test('resets id counter when clearing notifications', () => {
  const first = notifySuccess('one', { timeoutMs: 0 });
  const second = notifyError('two', { timeoutMs: 0 });

  expect(first).toBe(1);
  expect(second).toBe(2);

  clearNotifications();

  const next = notifyInfo('again', { timeoutMs: 0 });
  expect(next).toBe(1);
});
