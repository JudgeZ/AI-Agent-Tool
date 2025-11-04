import { describe, expect, it } from "vitest";

import { SseQuotaManager } from "./SseQuotaManager.js";

describe("SseQuotaManager", () => {
  it("limits concurrent connections per IP", () => {
    const manager = new SseQuotaManager({ perIp: 2, perSubject: 0 });

    const first = manager.acquire({ ip: "127.0.0.1" });
    const second = manager.acquire({ ip: "127.0.0.1" });
    const third = manager.acquire({ ip: "127.0.0.1" });

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(third).toBeNull();

    first?.();
    const afterRelease = manager.acquire({ ip: "127.0.0.1" });
    expect(afterRelease).toBeTruthy();
  });

  it("limits concurrent connections per subject", () => {
    const manager = new SseQuotaManager({ perIp: 0, perSubject: 1 });

    const first = manager.acquire({ subjectId: "session-1" });
    const second = manager.acquire({ subjectId: "session-1" });

    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });

  it("applies both IP and subject quotas", () => {
    const manager = new SseQuotaManager({ perIp: 1, perSubject: 1 });

    const first = manager.acquire({ ip: "::1", subjectId: "session-1" });
    const ipBlocked = manager.acquire({ ip: "::1" });
    const subjectBlocked = manager.acquire({ subjectId: "session-1" });

    expect(first).toBeTruthy();
    expect(ipBlocked).toBeNull();
    expect(subjectBlocked).toBeNull();

    first?.();
    const afterRelease = manager.acquire({ ip: "::1", subjectId: "session-1" });
    expect(afterRelease).toBeTruthy();
  });

  it("treats non-positive quotas as unlimited", () => {
    const manager = new SseQuotaManager({ perIp: 0, perSubject: 0 });

    const acquisitions = Array.from({ length: 10 }, (_, index) =>
      manager.acquire({ ip: "10.0.0.1", subjectId: `session-${index}` }),
    );

    expect(acquisitions.every(handle => handle !== null)).toBe(true);
  });
});

