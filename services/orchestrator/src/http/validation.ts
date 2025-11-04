import { z } from "zod";

const MAX_GOAL_LENGTH = 2048;
const MAX_RATIONALE_LENGTH = 2000;
const MAX_MODEL_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 16000;
const MAX_MESSAGE_COUNT = 50;

export const PlanIdSchema = z
  .string()
  .trim()
  .regex(/^plan-[0-9a-f]{8}$/i, { message: "plan id is invalid" });

export const PlanRequestSchema = z.object({
  goal: z
    .string()
    .trim()
    .min(1, { message: "goal is required" })
    .max(MAX_GOAL_LENGTH, {
      message: `goal must not exceed ${MAX_GOAL_LENGTH} characters`,
    }),
});

export const StepIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{1,64}$/u, { message: "step id is invalid" });

const RawPlanApprovalSchema = z.object({
  decision: z.enum(["approve", "reject"]).default("approve"),
  rationale: z
    .string()
    .trim()
    .max(MAX_RATIONALE_LENGTH, {
      message: `rationale must not exceed ${MAX_RATIONALE_LENGTH} characters`,
    })
    .optional(),
});

export const PlanApprovalSchema = RawPlanApprovalSchema.transform(
  ({ decision, rationale }) => ({
    decision: decision === "reject" ? "rejected" : "approved",
    rationale: rationale && rationale.length > 0 ? rationale : undefined,
  }),
);

const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"], {
    errorMap: () => ({ message: "role must be system, user, or assistant" }),
  }),
  content: z
    .string()
    .trim()
    .min(1, { message: "content is required" })
    .max(MAX_MESSAGE_LENGTH, {
      message: `content must not exceed ${MAX_MESSAGE_LENGTH} characters`,
    }),
});

export const ChatRequestSchema = z
  .object({
    model: z
      .string()
      .trim()
      .max(MAX_MODEL_LENGTH, {
        message: `model must not exceed ${MAX_MODEL_LENGTH} characters`,
      })
      .optional(),
    messages: z
      .array(ChatMessageSchema)
      .min(1, { message: "messages must contain at least one entry" })
      .max(MAX_MESSAGE_COUNT, {
        message: `messages must not exceed ${MAX_MESSAGE_COUNT} entries`,
      }),
  })
  .transform(({ model, messages }) => ({
    model: model && model.length > 0 ? model : undefined,
    messages,
  }));

export type PlanRequestPayload = z.infer<typeof PlanRequestSchema>;
export type PlanApprovalPayload = z.infer<typeof PlanApprovalSchema>;
export type ChatRequestPayload = z.infer<typeof ChatRequestSchema>;

export function formatValidationIssues(
  issues: z.ZodIssue[],
): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

