import { describe, expect, it } from 'vitest';
import { isCollaborationSessionValid } from '../ide/sessionAuth';
import type { SessionState } from '$lib/stores/session';

const baseSession: SessionState = {
  loading: false,
  authenticated: false,
  info: null,
  error: null
};

describe('isCollaborationSessionValid', () => {
  it('returns false when unauthenticated', () => {
    expect(isCollaborationSessionValid(baseSession)).toBe(false);
  });

  it('returns false when authenticated but missing id', () => {
    const session: SessionState = {
      ...baseSession,
      authenticated: true,
      info: {
        id: '',
        subject: 'user',
        roles: [],
        scopes: [],
        issuedAt: 'now',
        expiresAt: 'later'
      }
    };

    expect(isCollaborationSessionValid(session)).toBe(false);
  });

  it('returns true when authenticated with session id', () => {
    const session: SessionState = {
      ...baseSession,
      authenticated: true,
      info: {
        id: 'session-123',
        subject: 'user',
        roles: [],
        scopes: [],
        issuedAt: 'now',
        expiresAt: 'later'
      }
    };

    expect(isCollaborationSessionValid(session)).toBe(true);
  });
});
