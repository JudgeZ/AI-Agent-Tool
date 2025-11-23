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

export const notifications = {
  subscribe: notificationsStore.subscribe
};

function enqueue(message: string, level: NotificationLevel, { timeoutMs = 6000 }: NotifyOptions = {}) {
  const id = ++counter;

  notificationsStore.update((current) => [...current, { id, message, level }]);

  if (browser && timeoutMs > 0) {
    window.setTimeout(() => dismiss(id), timeoutMs);
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
  notificationsStore.update((current) => current.filter((notification) => notification.id !== id));
}

export function clearNotifications() {
  notificationsStore.set([]);
}

