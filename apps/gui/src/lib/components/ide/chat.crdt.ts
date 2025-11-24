import * as Y from 'yjs';

import {
  MAX_MESSAGE_ID_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_RENDERED_MESSAGES,
  MAX_STORED_MESSAGES,
  MAX_USER_ID_LENGTH
} from './chat.constants';
import type { ChatMessage, MessageCaches } from './chat.types';
import {
  sanitizeIdentifier,
  sanitizeIncomingMessage,
  sanitizeMessageText,
  sanitizeUserName
} from './chat.sanitization';

export function pruneHistory(history: Y.Array<ChatMessage> | null, historyDoc: Y.Doc | null) {
  if (!history) {
    return;
  }

  if (history.length <= MAX_STORED_MESSAGES) {
    return;
  }

  historyDoc?.transact(() => history.delete(0, history.length - MAX_STORED_MESSAGES));
}

export function buildRenderedMessages(
  history: Y.Array<ChatMessage> | null,
  caches: MessageCaches
): ChatMessage[] {
  if (!history) {
    return [];
  }

  const length = history.length;
  const start = Math.max(0, length - MAX_RENDERED_MESSAGES);
  const nextMessages: ChatMessage[] = [];
  const activeMessageIds = new Set<string>();

  for (let index = start; index < length; index += 1) {
    const sanitized = getSanitizedMessage(history.get(index), activeMessageIds, caches);
    if (sanitized) {
      nextMessages.push(sanitized);
    }
  }

  pruneMessageCaches(activeMessageIds, caches);

  return nextMessages;
}

export function areMessagesEqual(current: ChatMessage[], next: ChatMessage[]) {
  if (current.length !== next.length) {
    return false;
  }

  return current.every((message, index) => {
    const candidate = next[index];

    return (
      message.id === candidate.id &&
      message.userId === candidate.userId &&
      message.userName === candidate.userName &&
      message.text === candidate.text &&
      message.timestamp === candidate.timestamp
    );
  });
}

function getSanitizedMessage(
  message: unknown,
  activeMessageIds: Set<string>,
  caches: MessageCaches
): ChatMessage | null {
  const candidate = message as Partial<ChatMessage>;
  const signature = buildMessageSignature(candidate);
  const messageId = typeof candidate?.id === 'string' ? candidate.id : null;

  if (signature && messageId) {
    activeMessageIds.add(messageId);

    const cachedSignature = caches.messageSignatureCache.get(messageId);
    const cachedMessage = caches.messageCache.get(messageId);

    if (cachedSignature === signature && cachedMessage) {
      return cachedMessage;
    }
  }

  const sanitized = sanitizeIncomingMessage(message);

  if (sanitized && messageId && signature) {
    caches.messageCache.set(messageId, sanitized);
    caches.messageSignatureCache.set(messageId, signature);
    activeMessageIds.add(messageId);
  }

  return sanitized;
}

function pruneMessageCaches(activeMessageIds: Set<string>, caches: MessageCaches) {
  if (activeMessageIds.size === 0) {
    caches.messageCache.clear();
    caches.messageSignatureCache.clear();
    return;
  }

  for (const cachedId of caches.messageCache.keys()) {
    if (!activeMessageIds.has(cachedId)) {
      caches.messageCache.delete(cachedId);
      caches.messageSignatureCache.delete(cachedId);
    }
  }
}

function buildMessageSignature(message: unknown): string | null {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const candidate = message as Partial<ChatMessage>;

  const id = sanitizeIdentifier(candidate.id, MAX_MESSAGE_ID_LENGTH);
  const userId = sanitizeIdentifier(candidate.userId, MAX_USER_ID_LENGTH);

  if (
    !id ||
    !userId ||
    typeof candidate.text !== 'string' ||
    typeof candidate.timestamp !== 'number'
  ) {
    return null;
  }

  const boundedText = sanitizeMessageText(candidate.text).slice(0, MAX_MESSAGE_LENGTH).trim();
  if (!boundedText) {
    return null;
  }
  const boundedUserName = sanitizeUserName(candidate.userName);

  return `${id}|${userId}|${boundedUserName}|${boundedText}|${candidate.timestamp}`;
}
