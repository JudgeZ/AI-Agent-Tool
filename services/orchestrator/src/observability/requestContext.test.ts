import { describe, expect, it } from "vitest";

import {
  getRequestContext,
  runWithContext,
  setActorInContext,
  updateContextIdentifiers,
} from "./requestContext.js";

describe("requestContext", () => {
  it("exposes the active context within runWithContext and clears afterwards", () => {
    expect(getRequestContext()).toBeUndefined();

    runWithContext(
      {
        requestId: "req-1",
        traceId: "trace-1",
      },
      () => {
        const context = getRequestContext();
        expect(context?.requestId).toBe("req-1");
        expect(context?.traceId).toBe("trace-1");
        expect(context?.actorId).toBeUndefined();
      },
    );

    expect(getRequestContext()).toBeUndefined();
  });

  it("isolates contexts between async flows and allows overriding the actor", async () => {
    const seen: Array<{ requestId?: string; actorId?: string }> = [];

    await Promise.all([
      runWithContext(
        { requestId: "req-a", traceId: "trace-a" },
        async () => {
          setActorInContext("actor-a");
          await Promise.resolve();
          const context = getRequestContext();
          seen.push({ requestId: context?.requestId, actorId: context?.actorId });
        },
      ),
      runWithContext(
        { requestId: "req-b", traceId: "trace-b" },
        async () => {
          await Promise.resolve();
          setActorInContext("actor-b");
          const context = getRequestContext();
          seen.push({ requestId: context?.requestId, actorId: context?.actorId });
        },
      ),
    ]);

    expect(seen).toContainEqual({ requestId: "req-a", actorId: "actor-a" });
    expect(seen).toContainEqual({ requestId: "req-b", actorId: "actor-b" });
    expect(getRequestContext()).toBeUndefined();
  });

  it("updates identifiers without losing other context fields", () => {
    runWithContext(
      { requestId: "req-initial", traceId: "trace-initial" },
      () => {
        updateContextIdentifiers({ requestId: "req-updated" });
        updateContextIdentifiers({ traceId: "trace-updated" });

        const context = getRequestContext();
        expect(context?.requestId).toBe("req-updated");
        expect(context?.traceId).toBe("trace-updated");
      },
    );
  });
});
