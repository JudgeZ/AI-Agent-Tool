import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HISTORY_RETENTION_MS,
  clearPlanHistory,
  getPlanHistory,
  subscribeToPlanSteps,
  publishPlanStepEvent,
  type PlanStepEvent,
} from "./events.js";

const baseEvent: PlanStepEvent = {
  event: "plan.step",
  traceId: "trace-123",
  planId: "plan-123",
  step: {
    id: "step-1",
    action: "index_repo",
    tool: "repo_indexer",
    state: "queued",
    capability: "repo.read",
    capabilityLabel: "Read repository",
    labels: ["repo"],
    timeoutSeconds: 60,
    approvalRequired: false,
  },
};

describe("plan events history", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearPlanHistory();
  });

  afterEach(() => {
    clearPlanHistory();
    vi.useRealTimers();
  });

  it("cleans up plan history shortly after a terminal step", () => {
    publishPlanStepEvent(baseEvent);
    publishPlanStepEvent({
      ...baseEvent,
      step: { ...baseEvent.step, state: "completed" },
    });
    publishPlanStepEvent({
      ...baseEvent,
      step: { ...baseEvent.step, id: "step-2", state: "running" },
    });
    publishPlanStepEvent({
      ...baseEvent,
      step: { ...baseEvent.step, id: "step-2", state: "completed" },
    });

    expect(getPlanHistory(baseEvent.planId)).toHaveLength(4);
    expect(getPlanHistory(baseEvent.planId)[0]?.occurredAt).toBeTruthy();

    publishPlanStepEvent({
      ...baseEvent,
      step: { ...baseEvent.step, id: "step-3", state: "completed" },
    });

    expect(getPlanHistory(baseEvent.planId)).toHaveLength(5);

    vi.advanceTimersByTime(HISTORY_RETENTION_MS - 1);
    expect(getPlanHistory(baseEvent.planId)).toHaveLength(5);

    vi.advanceTimersByTime(1);
    expect(getPlanHistory(baseEvent.planId)).toHaveLength(0);
  });

  it("cleans up plan history after a rejected step", () => {
    publishPlanStepEvent(baseEvent);
    publishPlanStepEvent({
      ...baseEvent,
      step: { ...baseEvent.step, state: "waiting_approval" },
    });

    publishPlanStepEvent({
      ...baseEvent,
      step: { ...baseEvent.step, state: "rejected" },
    });

    expect(getPlanHistory(baseEvent.planId)).toHaveLength(3);

    vi.advanceTimersByTime(HISTORY_RETENTION_MS - 1);
    expect(getPlanHistory(baseEvent.planId)).toHaveLength(3);

    vi.advanceTimersByTime(1);
    expect(getPlanHistory(baseEvent.planId)).toHaveLength(0);
  });

  it("retains non-terminal plan history until steps reach a terminal state", () => {
    publishPlanStepEvent({
      ...baseEvent,
      step: { ...baseEvent.step, state: "waiting_approval" },
    });

    expect(getPlanHistory(baseEvent.planId)).toHaveLength(1);

    vi.advanceTimersByTime(HISTORY_RETENTION_MS);
    expect(getPlanHistory(baseEvent.planId)).toHaveLength(1);

    vi.advanceTimersByTime(HISTORY_RETENTION_MS);
    expect(getPlanHistory(baseEvent.planId)).toHaveLength(1);

    publishPlanStepEvent({
      ...baseEvent,
      step: { ...baseEvent.step, state: "completed" },
    });

    expect(getPlanHistory(baseEvent.planId)).toHaveLength(2);

    vi.advanceTimersByTime(HISTORY_RETENTION_MS - 1);
    expect(getPlanHistory(baseEvent.planId)).toHaveLength(2);

    vi.advanceTimersByTime(1);
    expect(getPlanHistory(baseEvent.planId)).toHaveLength(0);
  });

  it("caps the stored events for a plan", () => {
    for (let index = 0; index < 250; index += 1) {
      publishPlanStepEvent({
        ...baseEvent,
        step: { ...baseEvent.step, id: `step-${index}`, state: "running" },
      });
    }

    const events = getPlanHistory(baseEvent.planId);
    expect(events).toHaveLength(200);
    expect(events[0]!.step.id).toBe("step-50");
    expect(events.at(-1)!.step.id).toBe("step-249");
  });

  it("preserves provided timestamps when replaying events", () => {
    const occurredAt = "2024-04-15T12:00:00.000Z";
    publishPlanStepEvent({
      ...baseEvent,
      occurredAt,
      step: { ...baseEvent.step, state: "running" },
    });

    const [event] = getPlanHistory(baseEvent.planId);
    expect(event?.occurredAt).toBe(occurredAt);
  });

  it("does not emit warnings when more than ten listeners are registered", () => {
    const warningSpy = vi.spyOn(process, "emitWarning");
    const unsubscribers = new Array<() => void>();

    try {
      for (let index = 0; index < 12; index += 1) {
        unsubscribers.push(subscribeToPlanSteps(baseEvent.planId, () => {}));
      }

      expect(warningSpy).not.toHaveBeenCalled();
    } finally {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      warningSpy.mockRestore();
    }
  });
});
