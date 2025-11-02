import { EventEmitter } from "node:events";

import { parsePlanStepEvent, type PlanStepEvent, type PlanStepState } from "./validation.js";

const TERMINAL_STATES = new Set<PlanStepState>(["approved", "completed", "failed", "rejected", "dead_lettered"]);
const MAX_EVENTS_PER_PLAN = 200;
export const HISTORY_RETENTION_MS = 5 * 60 * 1000; // 5 minutes

type PlanHistoryEntry = {
  events: PlanStepEvent[];
  cleanupTimer?: NodeJS.Timeout;
};

const emitter = new EventEmitter();
const history = new Map<string, PlanHistoryEntry>();

function scheduleCleanup(planId: string, entry: PlanHistoryEntry): void {
  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
  }
  entry.cleanupTimer = setTimeout(() => {
    history.delete(planId);
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
  const entry = history.get(planId) ?? { events: [] };

  if (entry.cleanupTimer) {
    clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = undefined;
  }

  entry.events = [...entry.events, parsed].slice(-MAX_EVENTS_PER_PLAN);
  history.set(planId, entry);
  emitter.emit(parsed.event, parsed);

  if (TERMINAL_STATES.has(parsed.step.state)) {
    scheduleCleanup(planId, entry);
  }
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
