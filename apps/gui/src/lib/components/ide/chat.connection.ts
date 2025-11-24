import type { SessionState } from '$lib/stores/session';

import { MAX_ROOM_NAME_LENGTH } from './chat.constants';
import type { ConnectionState } from './chat.types';

export const connectionMessageDefaults: Record<
  ConnectionState,
  string | ((userName: string) => string)
> = {
  idle: 'Sign in to chat with your team.',
  connecting: 'Connecting to live chat…',
  connected: (userName: string) =>
    `You are live as ${userName}. Messages sync instantly across collaborators.`,
  disconnected: 'Reconnecting… check your connection if this persists.',
  error: 'Unable to reach chat server. Please retry.'
};

export function buildRoomName(
  roomId: string,
  sessionValue: SessionState,
  safeTenantId: string,
  safeProjectId: string
): string {
  const params = new URLSearchParams({
    roomId,
    authMode: 'session-cookie',
    tenantId: safeTenantId,
    projectId: safeProjectId
  });

  if (sessionValue.info?.id) {
    params.set('sessionId', sessionValue.info.id);
  }

  const roomName = `collaboration/ws?${params.toString()}`;

  if (roomName.length > MAX_ROOM_NAME_LENGTH) {
    throw new Error('chat room name exceeds length limits');
  }

  return roomName;
}

export function resolveConnectionMessage(
  state: ConnectionState,
  overrideMessage?: string,
  userName?: string
) {
  if (overrideMessage) return overrideMessage;

  const defaultMessage = connectionMessageDefaults[state];
  return typeof defaultMessage === 'function' ? defaultMessage(userName ?? '') : defaultMessage;
}

export function computeStatusLabel(state: ConnectionState) {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'disconnected':
      return 'Disconnected';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
  }
}
