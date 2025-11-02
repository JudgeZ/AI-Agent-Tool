import { z } from "zod";

export const CapabilityLabelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional()
});

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  capability: z.string().min(1),
  capabilityLabel: z.string().min(1),
  labels: z.array(z.string().min(1)).default([]),
  tool: z.string().min(1),
  timeoutSeconds: z.number().int().nonnegative().default(0),
  approvalRequired: z.boolean().default(false),
  input: z.record(z.any()).default({}),
  metadata: z.record(z.any()).default({})
});

export const PlanSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1),
  successCriteria: z.array(z.string().min(1)).min(1)
});

export const PlanStepStateSchema = z.union([
  z.literal("queued"),
  z.literal("running"),
  z.literal("retrying"),
  z.literal("waiting_approval"),
  z.literal("approved"),
  z.literal("rejected"),
  z.literal("completed"),
  z.literal("failed"),
  z.literal("dead_lettered")
]);

export const PlanStepEventSchema = z.object({
  event: z.literal("plan.step"),
  traceId: z.string().min(1),
  planId: z.string().min(1),
  occurredAt: z.string().optional(),
  step: z.object({
    id: z.string().min(1),
    action: z.string().min(1),
    state: PlanStepStateSchema,
    capability: z.string().min(1),
    capabilityLabel: z.string().min(1),
    labels: z.array(z.string().min(1)).default([]),
    tool: z.string().min(1),
    timeoutSeconds: z.number().int().nonnegative(),
    approvalRequired: z.boolean(),
    attempt: z.number().int().nonnegative().optional(),
    summary: z.string().optional(),
    output: z.record(z.any()).optional()
  })
});

export const ToolInvocationSchema = z.object({
  invocationId: z.string().min(1),
  planId: z.string().min(1),
  stepId: z.string().min(1),
  tool: z.string().min(1),
  capability: z.string().min(1),
  capabilityLabel: z.string().min(1),
  labels: z.array(z.string().min(1)).default([]),
  timeoutSeconds: z.number().int().positive().optional(),
  approvalRequired: z.boolean().optional(),
  input: z.record(z.any()).default({}),
  metadata: z.record(z.any()).default({})
});

export const ToolEventSchema = z.object({
  invocationId: z.string().min(1),
  planId: z.string().min(1),
  stepId: z.string().min(1),
  state: PlanStepStateSchema,
  summary: z.string().optional(),
  output: z.record(z.any()).optional(),
  occurredAt: z.string().optional(),
  attempt: z.number().int().nonnegative().optional()
});

export const PlanJobSchema = z.object({
  planId: z.string().min(1),
  step: PlanStepSchema,
  traceId: z.string().min(1),
  attempt: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime()
});

export type CapabilityLabel = z.infer<typeof CapabilityLabelSchema>;
export type PlanStep = z.infer<typeof PlanStepSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type PlanStepEvent = z.infer<typeof PlanStepEventSchema>;
export type PlanStepState = z.infer<typeof PlanStepStateSchema>;
export type ToolInvocation = z.infer<typeof ToolInvocationSchema>;
export type ToolEvent = z.infer<typeof ToolEventSchema>;
export type PlanJob = z.infer<typeof PlanJobSchema>;

export function parsePlan(input: unknown): Plan {
  return PlanSchema.parse(input);
}

export function parsePlanStepEvent(input: unknown): PlanStepEvent {
  return PlanStepEventSchema.parse(input);
}

export function parseToolInvocation(input: unknown): ToolInvocation {
  return ToolInvocationSchema.parse(input);
}

export function parseToolEvent(input: unknown): ToolEvent {
  return ToolEventSchema.parse(input);
}

export function parsePlanJob(input: unknown): PlanJob {
  return PlanJobSchema.parse(input);
}
