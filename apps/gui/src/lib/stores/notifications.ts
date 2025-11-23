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

function enqueue(message: string, level: NotificationLevel, { timeoutMs = 6000 }: NotifyOptions = {}) {
  const id = ++counter;

  notificationsStore.update((current) => [...current, { id, message, level }]);

  if (browser && timeoutMs > 0) {
    const timeoutId = window.setTimeout(() => dismiss(id), timeoutMs);
    timeouts.set(id, timeoutId);
  }

  return id;
}

export function notifyInfo(message: string, options?: NotifyOptions) {
  return enqueue(message, 'info', options);
}

export function notifySuccess(message: string, options?: NotifyOptions) {
  return enqueue(message, 'success', options);
}

export function notifyError(message: string, options?: NotifyOptions) {
  return enqueue(message, 'error', options);
}

export function dismiss(id: number) {
  const timeoutId = timeouts.get(id);
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeouts.delete(id);
  }
  notificationsStore.update((current) => current.filter((notification) => notification.id !== id));
}

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

