import { z } from "zod";
import type { ApprovalDecision } from "../queue/PlanQueueRuntime.js";

const MAX_GOAL_LENGTH = 2048;
const MAX_RATIONALE_LENGTH = 2000;
const MAX_MODEL_LENGTH = 256;
const MAX_PROVIDER_NAME_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 16000;
const MAX_MESSAGE_COUNT = 50;
const MIN_CODE_VERIFIER_LENGTH = 43;
const MAX_CODE_VERIFIER_LENGTH = 128;
const MAX_SECRET_KEY_LENGTH = 128;
const MAX_SECRET_LABEL_KEY_LENGTH = 64;
const MAX_SECRET_LABEL_VALUE_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 64;
const MAX_SECRET_LABEL_ENTRIES = 20;
const MAX_SECRET_VALUE_LENGTH = 8192;

const LEGACY_PLAN_ID_REGEX = /^plan-[0-9a-f]{8}$/i;
const UUID_PLAN_ID_REGEX =
  /^plan-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PlanIdSchema = z
  .string()
  .trim()
  .refine((value) => LEGACY_PLAN_ID_REGEX.test(value) || UUID_PLAN_ID_REGEX.test(value), {
    message: "plan id is invalid",
  });

export const SessionIdSchema = z
  .string({ required_error: "session id is required" })
  .trim()
  .min(1, { message: "session id is required" })
  .max(MAX_SESSION_ID_LENGTH, {
    message: `session id must not exceed ${MAX_SESSION_ID_LENGTH} characters`,
  })
  .uuid({ message: "session id must be a valid uuid" });

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

const PlanApprovalDecisionMap: Record<"approve" | "reject", ApprovalDecision> = {
  approve: "approved",
  reject: "rejected",
};

export const PlanApprovalSchema = RawPlanApprovalSchema.transform(
  ({ decision, rationale }) => ({
    decision: PlanApprovalDecisionMap[decision],
    rationale: rationale && rationale.length > 0 ? rationale : undefined,
  }),
);

const RoutingModeValues = ["balanced", "high_quality", "low_cost", "default"] as const;

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
    provider: z
      .string()
      .trim()
      .max(MAX_PROVIDER_NAME_LENGTH, {
        message: `provider must not exceed ${MAX_PROVIDER_NAME_LENGTH} characters`,
      })
      .regex(/^[A-Za-z0-9._-]+$/, {
        message: "provider may only include letters, numbers, '.', '_' or '-'",
      })
      .optional(),
    routing: z.enum(RoutingModeValues, {
      errorMap: () => ({ message: "routing must be balanced, high_quality, low_cost, or default" }),
    }).optional(),
    temperature: z
      .number({ invalid_type_error: "temperature must be a number" })
      .min(0, { message: "temperature must be between 0 and 2" })
      .max(2, { message: "temperature must be between 0 and 2" })
      .optional(),
    messages: z
      .array(ChatMessageSchema)
      .min(1, { message: "messages must contain at least one entry" })
      .max(MAX_MESSAGE_COUNT, {
        message: `messages must not exceed ${MAX_MESSAGE_COUNT} entries`,
      }),
  })
  .transform(({ model, provider, routing, temperature, messages }) => {
    const payload: {
      model?: string;
      provider?: string;
      routing?: typeof RoutingModeValues[number];
      temperature?: number;
      messages: typeof messages;
    } = { messages };
    if (model && model.length > 0) {
      payload.model = model;
    }
    if (provider && provider.length > 0) {
      payload.provider = provider;
    }
    if (routing && routing !== "default") {
      payload.routing = routing as "balanced" | "high_quality" | "low_cost";
    }
    if (typeof temperature === "number") {
      payload.temperature = temperature;
    }
    return payload;
  });

export type PlanRequestPayload = z.infer<typeof PlanRequestSchema>;
export type PlanApprovalPayload = z.infer<typeof PlanApprovalSchema>;
export type ChatRequestPayload = z.infer<typeof ChatRequestSchema>;

const CodeVerifierSchema = z
  .string({ required_error: "code_verifier is required" })
  .trim()
  .min(MIN_CODE_VERIFIER_LENGTH, {
    message: `code_verifier must be at least ${MIN_CODE_VERIFIER_LENGTH} characters`,
  })
  .max(MAX_CODE_VERIFIER_LENGTH, {
    message: `code_verifier must not exceed ${MAX_CODE_VERIFIER_LENGTH} characters`,
  })
  .regex(/^[A-Za-z0-9._~-]+$/u, {
    message: "code_verifier contains invalid characters",
  });

const RedirectUriSchema = z
  .string({ required_error: "redirect_uri is required" })
  .trim()
  .url({ message: "redirect_uri must be a valid URL" });

const RawOAuthCallbackSchema = z.object({
  code: z
    .string({ required_error: "code is required" })
    .trim()
    .min(1, { message: "code is required" }),
  code_verifier: CodeVerifierSchema,
  redirect_uri: RedirectUriSchema,
});

export const OAuthCallbackSchema = RawOAuthCallbackSchema.transform(
  ({ code, code_verifier, redirect_uri }) => ({
    code,
    codeVerifier: code_verifier,
    redirectUri: redirect_uri,
  }),
);

export const OidcCallbackSchema = RawOAuthCallbackSchema.extend({
  state: z
    .string()
    .trim()
    .min(1, { message: "state is required" })
    .optional(),
}).transform(({ code, code_verifier, redirect_uri, state }) => ({
  code,
  codeVerifier: code_verifier,
  redirectUri: redirect_uri,
  state: state && state.length > 0 ? state : undefined,
}));

export type OAuthCallbackPayload = z.infer<typeof OAuthCallbackSchema>;
export type OidcCallbackPayload = z.infer<typeof OidcCallbackSchema>;

const SecretKeyRegex = /^[A-Za-z0-9._:-]{1,128}$/u;
const SecretLabelKeyRegex = /^[A-Za-z0-9._:-]{1,64}$/u;

export const SecretKeySchema = z
  .string({ required_error: "secret key is required" })
  .trim()
  .min(1, { message: "secret key is required" })
  .max(MAX_SECRET_KEY_LENGTH, {
    message: `secret key must not exceed ${MAX_SECRET_KEY_LENGTH} characters`,
  })
  .regex(SecretKeyRegex, { message: "secret key contains invalid characters" });

const SecretLabelKeySchema = z
  .string()
  .trim()
  .min(1, { message: "label key is required" })
  .max(MAX_SECRET_LABEL_KEY_LENGTH, {
    message: `label keys must not exceed ${MAX_SECRET_LABEL_KEY_LENGTH} characters`,
  })
  .regex(SecretLabelKeyRegex, { message: "label key contains invalid characters" });

const SecretLabelValueSchema = z
  .string()
  .min(1, { message: "label value is required" })
  .max(MAX_SECRET_LABEL_VALUE_LENGTH, {
    message: `label values must not exceed ${MAX_SECRET_LABEL_VALUE_LENGTH} characters`,
  });

const SecretLabelsSchema = z
  .record(SecretLabelKeySchema, SecretLabelValueSchema)
  .refine(
    (labels) => Object.keys(labels).length <= MAX_SECRET_LABEL_ENTRIES,
    { message: `labels must not exceed ${MAX_SECRET_LABEL_ENTRIES} entries` },
  );

export const SecretRotateSchema = z.object({
  value: z
    .string({ required_error: "value is required" })
    .min(1, { message: "value is required" })
    .max(MAX_SECRET_VALUE_LENGTH, {
      message: `value must not exceed ${MAX_SECRET_VALUE_LENGTH} characters`,
    }),
  retain: z
    .number()
    .int({ message: "retain must be an integer" })
    .min(1, { message: "retain must be at least 1" })
    .max(50, { message: "retain must not exceed 50" })
    .optional(),
  labels: SecretLabelsSchema.optional(),
});

export const SecretPromoteSchema = z.object({
  versionId: z
    .string({ required_error: "versionId is required" })
    .trim()
    .min(1, { message: "versionId is required" })
    .max(128, {
      message: "versionId must not exceed 128 characters",
    }),
});

export type SecretRotatePayload = z.infer<typeof SecretRotateSchema>;
export type SecretPromotePayload = z.infer<typeof SecretPromoteSchema>;

export function formatValidationIssues(
  issues: z.ZodIssue[],
): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

