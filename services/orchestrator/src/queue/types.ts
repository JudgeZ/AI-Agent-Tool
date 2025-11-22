import type { PlanJob, ToolEvent } from "../plan/validation.js";

export type PlanStepTaskPayload = PlanJob;

export type PlanStepCompletionPayload = {
    planId: string;
    stepId: string;
    state: ToolEvent["state"];
    summary?: string;
    output?: Record<string, unknown>;
    attempt?: number;
    requestId?: string;
    traceId?: string;
    occurredAt?: string;
    approvals?: Record<string, boolean>;
};

export type ApprovalDecision = "approved" | "rejected";
