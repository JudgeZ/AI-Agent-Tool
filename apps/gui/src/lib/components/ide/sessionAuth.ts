import type { SessionState } from '$lib/stores/session';

export function isCollaborationSessionValid(session: SessionState): boolean {
  return Boolean(session.authenticated && session.info?.id);
}
