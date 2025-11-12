import type { Response } from "express";
import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  respondWithError,
  respondWithValidationError,
} from "./errors.js";
import { runWithContext } from "../observability/requestContext.js";

type ResponseMocks = {
  response: Response;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
};

function createResponseMocks(): ResponseMocks {
  const json = vi.fn();
  const setHeader = vi.fn();
  const response = {} as Response;
  const status = vi
    .fn<Parameters<Response["status"]>, Response>()
    .mockImplementation(() => response);

  response.status = status as unknown as Response["status"];
  response.json = json as unknown as Response["json"];
  response.setHeader = setHeader as unknown as Response["setHeader"];

  return {
    response,
    status: status as unknown as ReturnType<typeof vi.fn>,
    json,
    setHeader,
  };
}

describe("respondWithError", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("includes request and trace identifiers from the active context", () => {
    const { response, status, json } = createResponseMocks();

    runWithContext(
      { requestId: "request-123", traceId: "trace-abc" },
      () => {
        respondWithError(response, 418, {
          code: "teapot",
          message: "Short and stout",
        });
      },
    );

    expect(status).toHaveBeenCalledWith(418);
    expect(json).toHaveBeenCalledWith({
      code: "teapot",
      message: "Short and stout",
      requestId: "request-123",
      traceId: "trace-abc",
    });
  });

  it("sanitizes unexpected properties and sets retry headers", () => {
    const { response, json, setHeader } = createResponseMocks();

    runWithContext({ requestId: "req", traceId: "trace" }, () => {
      respondWithError(
        response,
        503,
        {
          code: "unavailable",
          message: "try later",
          details: { reason: "busy" },
          // @ts-expect-error - deliberate extra property to verify sanitization
          leak: "secret",
        },
        { retryAfterMs: 1500 },
      );
    });

    expect(setHeader).toHaveBeenCalledWith("Retry-After", "2");
    expect(json).toHaveBeenCalledWith({
      code: "unavailable",
      message: "try later",
      details: { reason: "busy" },
      requestId: "req",
      traceId: "trace",
    });
  });
});

describe("respondWithValidationError", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns validation errors without mutating the provided issues", () => {
    const { response, status, json } = createResponseMocks();
    const issues = [
      { path: "body.email", message: "Email is required" },
      { path: "body.password", message: "Password is required" },
    ];

    respondWithValidationError(response, issues);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledTimes(1);

    const payload = json.mock.calls[0][0];
    expect(payload).toMatchObject({
      code: "invalid_request",
      message: "Request validation failed",
      details: issues,
    });
    expect(payload.details).toBe(issues);
    expect(payload).not.toHaveProperty("requestId");
    expect(payload).not.toHaveProperty("traceId");
  });
});
