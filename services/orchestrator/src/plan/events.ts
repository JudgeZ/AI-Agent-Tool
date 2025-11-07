import { EventEmitter } from "node:events";

import {
  parsePlanStepEvent,
  type PlanStepEvent,
  type PlanStepState,
} from "./validation.js";
const MAX_EVENTS_PER_PLAN = 200;
export const HISTORY_RETENTION_MS = 5 * 60 * 1000; // 5 minutes

type PlanHistoryEntry = {
  events: PlanStepEvent[];
  cleanupTimer?: NodeJS.Timeout;
  lastActivity: number;
};

const ACTIVE_STEP_STATES: ReadonlySet<PlanStepState> = new Set([
  "queued",
  "running",
  "retrying",
  "waiting_approval",
  "approved",
]);

function hasActiveSteps(entry: PlanHistoryEntry): boolean {
  const latestStates = new Map<string, PlanStepState>();
  for (const event of entry.events) {
    latestStates.set(event.step.id, event.step.state);
  }

  for (const state of latestStates.values()) {
    if (ACTIVE_STEP_STATES.has(state)) {
      return true;
    }
  }

  return false;
}

const emitter = new EventEmitter();
// Allow arbitrarily many listeners so streaming multiple plan subscriptions does not trigger
// the Node.js default memory leak warning for EventEmitter listeners.
emitter.setMaxListeners(0);
const history = new Map<string, PlanHistoryEntry>();

function scheduleCleanup(planId: string): void {
  const entry = history.get(planId);
  if (!entry) {
    return;
  }

  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
  }

  entry.cleanupTimer = setTimeout(() => {
    const currentEntry = history.get(planId);
    if (!currentEntry) {
      return;
    }

    const idleDuration = Date.now() - currentEntry.lastActivity;
    if (idleDuration >= HISTORY_RETENTION_MS) {
      if (hasActiveSteps(currentEntry)) {
        scheduleCleanup(planId);
        return;
      }

      history.delete(planId);
      return;
    }

    scheduleCleanup(planId);
  }, HISTORY_RETENTION_MS);

  entry.cleanupTimer.unref?.();
}

export function publishPlanStepEvent(event: PlanStepEvent): void {
  const enrichedEvent: PlanStepEvent = {
    ...event,
    occurredAt: event.occurredAt ?? new Date().toISOString()
  };
  const parsed = parsePlanStepEvent(enrichedEvent);
  const planId = parsed.planId;
  const now = Date.now();
  const entry = history.get(planId) ?? { events: [], lastActivity: now };

  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = undefined;
  }

  entry.lastActivity = now;
  entry.events = [...entry.events, parsed].slice(-MAX_EVENTS_PER_PLAN);
  history.set(planId, entry);
  emitter.emit(parsed.event, parsed);

  scheduleCleanup(planId);
}

export function getPlanHistory(planId: string): PlanStepEvent[] {
  const entry = history.get(planId);
  return entry ? [...entry.events] : [];
}

export function getLatestPlanStepEvent(planId: string, stepId: string): PlanStepEvent | undefined {
  const entry = history.get(planId);
  if (!entry) {
    return undefined;
  }
  for (let index = entry.events.length - 1; index >= 0; index -= 1) {
    const event = entry.events[index];
    if (event.step.id === stepId) {
      return event;
    }
  }
  return undefined;
}

export function subscribeToPlanSteps(planId: string, listener: (event: PlanStepEvent) => void): () => void {
  const scopedListener = (event: PlanStepEvent): void => {
    if (event.planId === planId) {
      listener(event);
    }
  };
  emitter.on("plan.step", scopedListener);
  return () => {
    emitter.off("plan.step", scopedListener);
  };
}

export function clearPlanHistory(): void {
  history.forEach(entry => {
    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer);
    }
  });
  history.clear();
  emitter.removeAllListeners("plan.step");
}

export type { PlanStepEvent };
