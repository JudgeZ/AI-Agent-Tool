import { register } from "prom-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  const setOptions = new Map<string, any>();
  const redisClient: any = {
    isOpen: false,
    connect: vi.fn(async () => {
      redisClient.isOpen = true;
    }),
    quit: vi.fn(async () => {
      redisClient.isOpen = false;
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, options?: any) => {
      store.set(key, value);
      if (options) {
        setOptions.set(key, options);
      } else {
        setOptions.delete(key);
      }
      return "OK";
    }),
    on: vi.fn(),
  };

    return {
      store,
      setOptions,
      redisClient,
      mockAcquireLock: vi.fn(async (_resource: string) => vi.fn(async () => {})),
      mockIsRoomBusy: vi.fn(() => false),
      mockConnect: vi.fn(async () => {}),
      startSpanMock: vi.fn(() => ({
        context: { traceId: "trace-id", spanId: "span-id" },
        attributes: {},
        setAttribute: vi.fn(),
        addEvent: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn(),
      })),
    };
});

vi.mock("../collaboration/index.js", () => ({ isRoomBusy: mocks.mockIsRoomBusy }));
vi.mock("./DistributedLockService.js", async () => {
  const actual = await vi.importActual<typeof import("./DistributedLockService.js")>(
    "./DistributedLockService.js",
  );
  return {
    ...actual,
    getDistributedLockService: async () => ({
      acquireLock: mocks.mockAcquireLock,
      connect: mocks.mockConnect,
      getClient: () => mocks.redisClient,
    }),
  };
});
vi.mock("../observability/tracing.js", () => ({
  startSpan: mocks.startSpanMock,
}));

// Import after mocks are set up
import { FileLockError, FileLockManager } from "./FileLockManager.js";
import { LockAcquisitionError } from "./DistributedLockService.js";

const {
  store: mockStore,
  setOptions: mockSetOptions,
  redisClient: mockRedisClient,
  mockAcquireLock,
  mockIsRoomBusy,
  startSpanMock,
} = mocks;
const sessionKey = (sessionId: string) => `session:locks:${sessionId}`;

async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const metrics = await register.getMetricsAsJSON();
  const directMatch = metrics.find((entry) => entry.name === name);
  const directValue = directMatch?.values?.find((value: any) =>
    Object.entries(labels).every(([key, val]) => value.labels?.[key] === val),
  );
  if (typeof directValue?.value === "number") {
    return directValue.value;
  }

  for (const metric of metrics) {
    const nested = metric.values?.find(
      (value: any) =>
        value.metricName === name &&
        Object.entries(labels).every(([key, val]) => value.labels?.[key] === val),
    );
    if (typeof nested?.value === "number") {
      return nested.value;
    }
  }

  return 0;
}

describe("FileLockManager", () => {
  beforeEach(() => {
    mockStore.clear();
    vi.clearAllMocks();
    mockRedisClient.isOpen = false;
    mockIsRoomBusy.mockReturnValue(false);
    mockAcquireLock.mockImplementation(async () => vi.fn(async () => {}));
    register.resetMetrics();
  });

  it("acquires locks with normalized keys and persists history", async () => {
    const manager = new FileLockManager("redis://example");
    const lock = await manager.acquireLock("s1", "project/file.txt", "agent-1");

    expect(lock.path).toBe("/project/file.txt");
    expect(mockAcquireLock).toHaveBeenCalledWith("file:/project/file.txt", 30_000, undefined, undefined, {
      traceId: "trace-id",
      spanId: "span-id",
      requestId: undefined,
    });

    const stored = JSON.parse(mockStore.get(sessionKey("s1")) ?? "[]");
    expect(stored).toEqual(["/project/file.txt"]);

    await manager.releaseSessionLocks("s1");
    const afterRelease = JSON.parse(mockStore.get(sessionKey("s1")) ?? "[]");
    expect(afterRelease).toEqual([]);
  });

  it("sets a TTL when persisting session history if configured", async () => {
    const manager = new FileLockManager("redis://example", 30_000, 3600);

    await manager.acquireLock("s1", "project/file.txt", "agent-1");

    const options = mockSetOptions.get(sessionKey("s1"));
    expect(options).toEqual({ EX: 3600 });
  });

  it("caps excessively large lock TTL values", async () => {
    const manager = new FileLockManager("redis://example", 1_000_000);

    await manager.acquireLock("s1", "project/file.txt", "agent-1");

    expect(mockAcquireLock).toHaveBeenCalledWith(
      "file:/project/file.txt",
      300_000,
      undefined,
      undefined,
      {
        traceId: "trace-id",
        spanId: "span-id",
        requestId: undefined,
      },
    );
  });

  it("restores locks from persisted history", async () => {
    mockStore.set(sessionKey("rehydrate"), JSON.stringify(["/foo.txt", "/bar/baz.md"]));
    const manager = new FileLockManager("redis://example");

    await manager.restoreSessionLocks("rehydrate");

    expect(mockAcquireLock).toHaveBeenCalledWith("file:/foo.txt", 30_000, undefined, undefined, {
      traceId: "trace-id",
      spanId: "span-id",
      requestId: undefined,
    });
    expect(mockAcquireLock).toHaveBeenCalledWith("file:/bar/baz.md", 30_000, undefined, undefined, {
      traceId: "trace-id",
      spanId: "span-id",
      requestId: undefined,
    });
  });

  it("returns busy errors when room is active", async () => {
    mockIsRoomBusy.mockReturnValue(true);
    const manager = new FileLockManager("redis://example");

    const baselineContention = await metricValue("orchestrator_file_lock_contention_total", {
      operation: "acquire",
      reason: "room_busy",
    });

    await expect(manager.acquireLock("s1", "busy/file.txt")).rejects.toBeInstanceOf(FileLockError);
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(
      await metricValue("orchestrator_file_lock_contention_total", {
        operation: "acquire",
        reason: "room_busy",
      }),
    ).toBeGreaterThan(baselineContention);
  });

  it("propagates unavailable errors when redis cannot connect", async () => {
    mockRedisClient.connect.mockRejectedValueOnce(new Error("redis down"));
    const manager = new FileLockManager("redis://example");

    await expect(manager.acquireLock("s1", "file.txt")).rejects.toMatchObject({ code: "unavailable" });
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  it("rolls back and surfaces errors when persisting history fails", async () => {
    const releaseSpy = vi.fn(async () => {});
    mockAcquireLock.mockResolvedValueOnce(releaseSpy);
    mockRedisClient.set.mockRejectedValueOnce(new Error("persist failed"));

    const manager = new FileLockManager("redis://example");

    await expect(manager.acquireLock("s1", "project/ok.txt")).rejects.toMatchObject({ code: "unavailable" });
    expect(releaseSpy).toHaveBeenCalled();
  });

  it("wraps errors during restore acquisitions as unavailable", async () => {
    mockStore.set(sessionKey("rehydrate"), JSON.stringify(["/foo.txt"]));
    const manager = new FileLockManager("redis://example");
    mockAcquireLock.mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(manager.restoreSessionLocks("rehydrate")).resolves.not.toThrow();
    expect(mockAcquireLock).toHaveBeenCalledWith("file:/foo.txt", 30_000, undefined, undefined, {
      traceId: "trace-id",
      spanId: "span-id",
      requestId: undefined,
    });
  });

  it("wraps connection errors during restore acquisitions", async () => {
    const manager = new FileLockManager("redis://example");
    mockRedisClient.connect.mockRejectedValueOnce(new Error("redis down"));

    await expect((manager as any).acquireLockWithoutPersist("s1", "foo.txt")).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("times out hung restore attempts and continues with subsequent locks", async () => {
    vi.useFakeTimers();
    mockStore.set(sessionKey("rehydrate"), JSON.stringify(["/hung.txt", "/ok.txt"]));
    mockAcquireLock
      .mockImplementationOnce(
        () => new Promise<() => Promise<void>>(() => {}),
      )
      .mockResolvedValueOnce(vi.fn(async () => {}));

    const manager = new FileLockManager("redis://example");

    try {
      const restorePromise = manager.restoreSessionLocks("rehydrate");
      await vi.advanceTimersByTimeAsync(5_200);
      await restorePromise;

      expect(mockAcquireLock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips restore when history is invalid JSON", async () => {
    mockStore.set(sessionKey("rehydrate"), "not-json");
    const manager = new FileLockManager("redis://example");

    await manager.restoreSessionLocks("rehydrate");

    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  it("rejects invalid session identifiers", async () => {
    const manager = new FileLockManager("redis://example");
    await expect(manager.acquireLock("bad:id", "project/file.txt")).rejects.toBeInstanceOf(FileLockError);
  });

  it("rejects overly long session identifiers", async () => {
    const manager = new FileLockManager("redis://example");
    const longId = "a".repeat(129);
    await expect(manager.acquireLock(longId, "project/file.txt")).rejects.toBeInstanceOf(FileLockError);
  });

  it("throttles repeated lock attempts per session", async () => {
    const manager = new FileLockManager("redis://example", 30_000, 0, 1, 60_000);

    await manager.acquireLock("s1", "project/file.txt");

    await expect(manager.acquireLock("s1", "project/other.txt")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("maps distributed busy errors to busy responses", async () => {
    mockAcquireLock.mockRejectedValueOnce(new LockAcquisitionError("contended", "busy"));
    const manager = new FileLockManager("redis://example");

    await expect(manager.acquireLock("s1", "project/contended.txt")).rejects.toMatchObject({
      code: "busy",
      details: { reason: "lock_contended" },
    });
  });

  it("surfaces timeout errors as busy with timeout reason", async () => {
    mockAcquireLock.mockRejectedValueOnce(new LockAcquisitionError("timeout", "timeout"));
    const manager = new FileLockManager("redis://example");

    await expect(manager.acquireLock("s1", "project/timeout.txt")).rejects.toMatchObject({
      code: "busy",
      details: { reason: "lock_timeout" },
    });
  });

  it("propagates span context into distributed lock requests", async () => {
    startSpanMock.mockReturnValueOnce({
      context: { traceId: "span-trace", spanId: "span-child" },
      attributes: {},
      setAttribute: vi.fn(),
      addEvent: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    } as any);
    const manager = new FileLockManager("redis://example");

    await manager.acquireLock("trace-session", "project/file.txt", "agent-1", { requestId: "req-123" });

    expect(startSpanMock).toHaveBeenCalledWith("file_lock.acquire", {
      path: "/project/file.txt",
      sessionId: "trace-session",
      agentId: "agent-1",
    });
    expect(mockAcquireLock).toHaveBeenCalledWith("file:/project/file.txt", 30_000, undefined, undefined, {
      traceId: "span-trace",
      spanId: "span-child",
      requestId: "req-123",
    });
  });

  it("rejects concurrent acquisitions while a lock is active", async () => {
    const manager = new FileLockManager("redis://example");
    const release = vi.fn(async () => {});
    mockAcquireLock
      .mockResolvedValueOnce(release)
      .mockRejectedValueOnce(new LockAcquisitionError("busy", "busy"))
      .mockResolvedValueOnce(vi.fn(async () => {}));

    await manager.acquireLock("s1", "project/shared.txt");
    await expect(manager.acquireLock("s2", "project/shared.txt")).rejects.toMatchObject({ code: "busy" });
    await release();
  });

  it("allows reacquisition after TTL expiry", async () => {
    vi.useFakeTimers();
    let allowReacquire = false;
    mockAcquireLock.mockImplementation(async () => {
      if (mockAcquireLock.mock.calls.length > 0 && !allowReacquire) {
        throw new LockAcquisitionError("contended", "busy");
      }
      return vi.fn(async () => {});
    });

    const manager = new FileLockManager("redis://example", 1_000);

    try {
      await manager.acquireLock("ttl-session-1", "project/temp.txt");
      await expect(manager.acquireLock("ttl-session-2", "project/temp.txt")).rejects.toMatchObject({ code: "busy" });

      vi.advanceTimersByTime(1_100);
      allowReacquire = true;

      await expect(manager.acquireLock("ttl-session-2", "project/temp.txt")).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits metrics for successful acquisitions and releases", async () => {
    const manager = new FileLockManager("redis://example");

    const baselineAttempt = await metricValue("orchestrator_file_lock_attempts_total", {
      operation: "acquire",
      outcome: "success",
    });
    const baselineLatencyCount = await metricValue("orchestrator_file_lock_acquire_seconds_count", {
      operation: "acquire",
    });
    const baselineRelease = await metricValue("orchestrator_file_lock_release_total", { outcome: "success" });

    const lock = await manager.acquireLock("metrics-session", "project/file.txt");
    await lock.release();

    expect(
      await metricValue("orchestrator_file_lock_attempts_total", {
        operation: "acquire",
        outcome: "success",
      }),
    ).toBeGreaterThan(baselineAttempt);
    expect(await metricValue("orchestrator_file_lock_release_total", { outcome: "success" })).toBeGreaterThan(
      baselineRelease,
    );
    expect(
      await metricValue("orchestrator_file_lock_acquire_seconds_count", { operation: "acquire" }),
    ).toBeGreaterThan(baselineLatencyCount);
  });

  it("records metrics when rate limiting blocks acquisitions", async () => {
    const manager = new FileLockManager("redis://example", 30_000, 0, 1, 60_000);

    const baselineAllowed = await metricValue("orchestrator_file_lock_rate_limit_total", {
      operation: "acquire",
      result: "allowed",
    });
    const baselineBlocked = await metricValue("orchestrator_file_lock_rate_limit_total", {
      operation: "acquire",
      result: "blocked",
    });
    const baselineRateLimitedAttempt = await metricValue("orchestrator_file_lock_attempts_total", {
      operation: "acquire",
      outcome: "rate_limited",
    });

    await manager.acquireLock("rate-limited", "project/one.txt");
    await expect(manager.acquireLock("rate-limited", "project/two.txt")).rejects.toMatchObject({
      code: "rate_limited",
    });

    expect(
      await metricValue("orchestrator_file_lock_rate_limit_total", { operation: "acquire", result: "allowed" }),
    ).toBeGreaterThan(baselineAllowed);

    expect(
      await metricValue("orchestrator_file_lock_rate_limit_total", { operation: "acquire", result: "blocked" }),
    ).toBeGreaterThan(baselineBlocked);

    expect(
      await metricValue("orchestrator_file_lock_attempts_total", {
        operation: "acquire",
        outcome: "rate_limited",
      }),
    ).toBeGreaterThan(baselineRateLimitedAttempt);
  });
});
