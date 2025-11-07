import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionStore } from "./SessionStore";

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    store = new SessionStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes roles and scopes when creating a session", () => {
    const session = store.createSession(
      {
        subject: "user-1",
        email: "user@example.com",
        name: "Test User",
        tenantId: "tenant-1",
        roles: [" admin ", "user", "admin", ""],
        scopes: ["write", "read", "write"],
        claims: { key: "value" },
        tokens: { accessToken: "access" }
      },
      60
    );

    expect(session.roles).toEqual(["admin", "user"]);
    expect(session.scopes).toEqual(["read", "write"]);

    const retrieved = store.getSession(session.id);
    expect(retrieved?.roles).toEqual(["admin", "user"]);
    expect(retrieved?.scopes).toEqual(["read", "write"]);
  });

  it("expires sessions after the configured ttl", () => {
    const session = store.createSession(
      {
        subject: "user-2",
        roles: [],
        scopes: [],
        claims: {},
        tokens: {}
      },
      1
    );

    expect(store.getSession(session.id)).toBeDefined();

    vi.setSystemTime(new Date("2024-01-01T00:00:01.500Z"));

    expect(store.getSession(session.id)).toBeUndefined();
  });

  it("removes expired sessions during cleanup", () => {
    const baseTime = Date.now();

    const expiring = store.createSession(
      {
        subject: "user-expire",
        roles: [],
        scopes: [],
        claims: {},
        tokens: {}
      },
      10,
      baseTime + 500
    );

    const persistent = store.createSession(
      {
        subject: "user-persist",
        roles: [],
        scopes: [],
        claims: {},
        tokens: {}
      },
      10
    );

    vi.setSystemTime(baseTime + 600);

    store.cleanupExpired();

    expect(store.getSession(expiring.id)).toBeUndefined();
    expect(store.getSession(persistent.id)).toBeDefined();
  });

  it("revokes sessions when requested", () => {
    const session = store.createSession(
      {
        subject: "user-3",
        roles: [],
        scopes: [],
        claims: {},
        tokens: {}
      },
      30
    );

    expect(store.revokeSession(session.id)).toBe(true);
    expect(store.getSession(session.id)).toBeUndefined();
    expect(store.revokeSession(session.id)).toBe(false);
  });
});
