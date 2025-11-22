import type { Response } from "express";

import { getRequestContext } from "../observability/requestContext.js";
import { appLogger, normalizeError } from "../observability/logger.js";

export type ErrorDetails = Array<{ path: string; message: string }>;

type ErrorBody = {
  code: string;
  message: string;
  details?: unknown;
};

function sanitize(body: ErrorBody): ErrorBody {
  const sanitized: ErrorBody = {
    code: body.code,
    message: body.message,
  };

  if (body.details !== undefined) {
    sanitized.details = body.details;
  }

  return sanitized;
}

function enrich(body: ErrorBody): ErrorBody & { requestId?: string; traceId?: string } {
  const context = getRequestContext();
  const metadata: { requestId?: string; traceId?: string } = {};

  if (context) {
    metadata.requestId = context.requestId;
    metadata.traceId = context.traceId;
  }

  return {
    ...sanitize(body),
    ...metadata,
  };
}

export function respondWithError(res: Response, status: number, body: ErrorBody, options: { retryAfterMs?: number } = {}): void {
  if (options.retryAfterMs && Number.isFinite(options.retryAfterMs) && options.retryAfterMs > 0) {
    const seconds = Math.ceil(options.retryAfterMs / 1000);
    res.setHeader("Retry-After", seconds.toString());
  }
  res.status(status).json(enrich(body));
}

export function respondWithValidationError(res: Response, details: ErrorDetails): void {
  respondWithError(res, 400, {
    code: "invalid_request",
    message: "Request validation failed",
    details,
  });
}

type ExpressPayloadTooLargeError = Error & {
  status?: number;
  statusCode?: number;
  type?: string;
  limit?: number;
};

function isPayloadTooLargeError(error: unknown): error is ExpressPayloadTooLargeError {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as ExpressPayloadTooLargeError;
  const status = candidate.status ?? candidate.statusCode;

  return status === 413 || candidate.type === "entity.too.large";
}

export function respondWithPayloadTooLargeError(
  res: Response,
  error: ExpressPayloadTooLargeError,
): void {
  const details = Number.isFinite(error.limit) ? { limit: error.limit } : undefined;

  respondWithError(res, 413, {
    code: "payload_too_large",
    message: "Request body exceeds the configured limit",
    details,
  });
}

export function respondWithUnexpectedError(res: Response, error: unknown): void {
  if (isPayloadTooLargeError(error)) {
    respondWithPayloadTooLargeError(res, error);
    return;
  }

  const normalized = normalizeError(error);
  const context = getRequestContext();
  appLogger.error({
    err: normalized,
    requestId: context?.requestId ?? res.locals.requestId,
    traceId: context?.traceId ?? res.locals.traceId,
  }, "Unexpected request error");

  const message = error instanceof Error ? error.message : "unexpected error";
  respondWithError(res, 500, {
    code: "internal_error",
    message,
  });
}

