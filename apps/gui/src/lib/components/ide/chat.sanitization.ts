import {
  MAX_CONTEXT_ID_LENGTH,
  MAX_MESSAGE_ID_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_USER_ID_LENGTH,
  MAX_USER_NAME_LENGTH
} from './chat.constants';
import type { ChatMessage } from './chat.types';

export function sanitizeContextId(value: unknown) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CONTEXT_ID_LENGTH || hasControlCharacters(trimmed)) {
    return null;
  }

  if (!/^[-\w.:]+$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export function sanitizeIncomingMessage(message: unknown): ChatMessage | null {
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
    console.warn('Dropping malformed chat message');
    return null;
  }

  if (!Number.isFinite(candidate.timestamp)) {
    console.warn('Dropping chat message with invalid timestamp');
    return null;
  }

  const truncated = candidate.text.slice(0, MAX_MESSAGE_LENGTH);
  const safeText = sanitizeMessageText(truncated).trim();
  if (!safeText) {
    console.warn('Dropping chat message with unsafe content');
    return null;
  }
  const safeUserName = sanitizeDisplayName(candidate.userName) || 'Unknown user';

  return {
    id,
    userId,
    userName: safeUserName,
    text: safeText,
    timestamp: candidate.timestamp
  };
}

export function sanitizeUserName(name: unknown) {
  if (typeof name !== 'string') return '';

  const trimmed = name.trim();
  if (!trimmed || hasControlCharacters(trimmed)) return '';

  return trimmed.slice(0, MAX_USER_NAME_LENGTH);
}

export function sanitizeIdentifier(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();

  if (!trimmed || trimmed.length > maxLength || hasControlCharacters(trimmed)) {
    return null;
  }

  return trimmed;
}

function hasControlCharacters(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0 && code <= 31) || code === 127) {
      return true;
    }
  }

  return false;
}

export function sanitizeDisplayName(name: unknown) {
  const sanitized = sanitizeUserName(name);
  if (!sanitized) return '';

  return sanitized.includes('@') ? obfuscateEmail(sanitized) : sanitized;
}

export function obfuscateEmail(email: unknown) {
  if (typeof email !== 'string') return '';

  const trimmed = email.trim();
  if (!trimmed || hasControlCharacters(trimmed)) return '';

  const [localPart, ...domainPartsRaw] = trimmed.split('@');
  if (!localPart || domainPartsRaw.length === 0) return '';

  const domainCombined = domainPartsRaw.join('@').replace(/@+/g, '');
  const domainSegments = domainCombined.split('.').filter(Boolean);

  if (domainSegments.length < 2 || domainSegments[domainSegments.length - 1].length < 2) {
    return '';
  }

  const safeLocal = `${localPart[0]}***`;
  const safeDomain = domainSegments
    .map((part) => {
      if (part.length <= 2) {
        return `${part[0]}*`;
      }

      return `${part[0]}***${part.slice(-1)}`;
    })
    .join('.');

  return sanitizeUserName(`${safeLocal}@${safeDomain}`);
}

export function sanitizeMessageText(value: unknown) {
  if (typeof value !== 'string') return '';

  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code === 9 || code === 10 || code === 13) {
      result += value[index];
      continue;
    }

    if ((code >= 0 && code <= 31) || code === 127) {
      continue;
    }

    result += value[index];
  }

  return result;
}
