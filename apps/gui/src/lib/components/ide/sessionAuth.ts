import type { SessionState } from '$lib/stores/session';

export function isCollaborationSessionValid(sessionValue: SessionState): boolean {
  if (!sessionValue?.authenticated || !sessionValue.info?.id) {
    return false;
  }

  return Boolean(sessionValue.info.id.trim());
}
