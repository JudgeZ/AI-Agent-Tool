import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export type NotificationLevel = 'info' | 'success' | 'error';

export interface Notification {
  id: number;
  message: string;
  level: NotificationLevel;
}

type NotifyOptions = {
  timeoutMs?: number;
};

const notificationsStore = writable<Notification[]>([]);

let counter = 0;
const timeouts = new Map<number, number>();

export const notifications = {
  subscribe: notificationsStore.subscribe
};

/**
 * Enqueues a notification and optionally schedules its automatic dismissal.
 *
 * When run in a browser and `options.timeoutMs` is greater than 0, schedules a dismissal after that many milliseconds.
 *
 * @param message - The notification text to display
 * @param level - The notification level (`'info' | 'success' | 'error'`)
 * @param options - Optional settings for the notification
 * @param options.timeoutMs - Milliseconds before automatic dismissal; defaults to 6000. A value <= 0 disables auto-dismissal.
 * @returns The unique numeric id assigned to the created notification
 */
function enqueue(message: string, level: NotificationLevel, { timeoutMs = 6000 }: NotifyOptions = {}) {
  const id = ++counter;

  notificationsStore.update((current) => [...current, { id, message, level }]);

  if (browser && timeoutMs > 0) {
    const timeoutId = window.setTimeout(() => dismiss(id), timeoutMs);
    timeouts.set(id, timeoutId);
  }

  return id;
}

/**
 * Enqueue an info-level notification.
 *
 * @param options - Optional settings. `timeoutMs` is the auto-dismiss timeout in milliseconds; when omitted the default is 6000, and when set to a value less than or equal to 0 the notification will not be auto-dismissed.
 * @returns The id of the created notification
 */
export function notifyInfo(message: string, options?: NotifyOptions) {
  return enqueue(message, 'info', options);
}

/**
 * Queue a success-level notification to be shown to the user.
 *
 * @param message - The notification text
 * @param options - Optional settings; may include `timeoutMs` to auto-dismiss after the given milliseconds
 * @returns The unique id of the created notification
 */
export function notifySuccess(message: string, options?: NotifyOptions) {
  return enqueue(message, 'success', options);
}

/**
 * Enqueues an error-level notification to be shown to the user.
 *
 * @param message - The notification text to display.
 * @param options - Optional settings; `timeoutMs` (milliseconds) sets an auto-dismiss delay.
 * @returns The numeric id of the created notification.
 */
export function notifyError(message: string, options?: NotifyOptions) {
  return enqueue(message, 'error', options);
}

/**
 * Dismisses a notification by id, removing it from the store and cancelling any scheduled auto-dismissal.
 *
 * @param id - The id of the notification to remove
 */
export function dismiss(id: number) {
  const timeoutId = timeouts.get(id);
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeouts.delete(id);
  }
  notificationsStore.update((current) => current.filter((notification) => notification.id !== id));
}

/**
 * Cancel all scheduled notification timeouts, clear the notification list, and reset internal state.
 *
 * Clears any pending auto-dismiss timers, empties the notifications store, and resets the ID counter.
 */
export function clearNotifications() {
  timeouts.forEach((timeoutId) => clearTimeout(timeoutId));
  timeouts.clear();
  notificationsStore.set([]);
  counter = 0;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    clearNotifications();
  });
}
