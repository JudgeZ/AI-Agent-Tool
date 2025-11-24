<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import * as Y from 'yjs';
  import { WebsocketProvider } from 'y-websocket';
  import { collaborationContext } from '$lib/stores/ide';
  import { session, type SessionState } from '$lib/stores/session';
  import { gatewayBaseUrl } from '$lib/config';
  import { isCollaborationSessionValid } from './sessionAuth';
  import { notifyError } from '$lib/stores/notifications';

  type ChatMessage = {
    id: string;
    userId: string;
    userName: string;
    text: string;
    timestamp: number;
  };

  type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

  import {
    MAX_CONTEXT_ID_LENGTH,
    MAX_MESSAGE_ID_LENGTH,
    MAX_MESSAGE_LENGTH,
    MAX_RENDERED_MESSAGES,
    MAX_STORED_MESSAGES,
    MAX_USER_ID_LENGTH,
    MAX_USER_NAME_LENGTH
  } from './chat.constants';

  const websocketBase = toWebsocketBase(gatewayBaseUrl);

  const connectionMessageDefaults: Record<ConnectionState, string | ((userName: string) => string)> = {
    idle: 'Sign in to chat with your team.',
    connecting: 'Connecting to live chat…',
    connected: (userName: string) =>
      `You are live as ${userName}. Messages sync instantly across collaborators.`,
    disconnected: 'Reconnecting… check your connection if this persists.',
    error: 'Unable to reach chat server. Please retry.'
  };

  let doc: Y.Doc | null = null;
  let provider: WebsocketProvider | null = null;
  let messageArray: Y.Array<ChatMessage> | null = null;
  let sessionValue: SessionState = get(session);
  let contextValue = get(collaborationContext);
  let connectionState: ConnectionState = 'idle';
  let messages: ChatMessage[] = [];
  let messageInput = '';
  let scrollContainer: HTMLDivElement | null = null;
  let messageInputEl: HTMLTextAreaElement | null = null;
  let currentRoomId: string | null = null;
  let userDisplayName = 'User';
  let userInitial = 'U';
  let connectionMessageOverride: string | undefined;
  let connectionMessage = resolveConnectionMessage('idle');
  let safeTenantId = sanitizeContextId(contextValue.tenantId) ?? 'default';
  let safeProjectId = sanitizeContextId(contextValue.projectId) ?? 'default-project';
  let didShowContextError = false;
  refreshUserIdentity(sessionValue);
  let isPruningHistory = false;
  let sanitizedDraft = '';
  let sanitizedDraftTrimmed = '';
  let providerConnected = false;
  // Internal caches; reactive tracking is not required.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const messageCache = new Map<string, ChatMessage>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const messageSignatureCache = new Map<string, string>();

  const subscriptions = [
    session.subscribe((value) => {
      sessionValue = value;
      refreshUserIdentity(value);

      if (!isCollaborationSessionValid(sessionValue)) {
        teardown();
        return;
      }

      maybeReconnect();
    }),
    collaborationContext.subscribe((value) => {
      contextValue = value;
      maybeReconnect();
    })
  ];

  onMount(() => {
    maybeReconnect();
  });

  onDestroy(() => {
    subscriptions.forEach((unsubscribe) => unsubscribe());
    teardown();
  });

  function toWebsocketBase(httpUrl: string) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const parsed = new URL(httpUrl);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  }

  function buildRoomName(roomId: string) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
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

    if (roomName.length > 2048) {
      throw new Error('chat room name exceeds length limits');
    }

    return roomName;
  }

  function maybeReconnect() {
    if (!isCollaborationSessionValid(sessionValue)) {
      setConnectionState('idle');
      return;
    }

    if (!refreshContextIdentifiers()) {
      return;
    }

    const roomId = `chat:${safeTenantId}:${safeProjectId}`;
    if (roomId === currentRoomId && provider) {
      return;
    }
    currentRoomId = roomId;
    void connect(roomId);
  }

  function refreshContextIdentifiers() {
    const nextTenantId = sanitizeContextId(contextValue.tenantId);
    const nextProjectId = sanitizeContextId(contextValue.projectId);

    if (!nextTenantId || !nextProjectId) {
      teardown('error', 'Project context is invalid. Please refresh and retry.');

      if (!didShowContextError) {
        notifyError('Project context is invalid. Please refresh and retry.', { timeoutMs: 8000 });
      }

      didShowContextError = true;
      return false;
    }

    didShowContextError = false;

    if (nextTenantId === safeTenantId && nextProjectId === safeProjectId) {
      return true;
    }

    safeTenantId = nextTenantId;
    safeProjectId = nextProjectId;

    return true;
  }

  async function connect(roomId: string) {
    teardown();

    if (!isCollaborationSessionValid(sessionValue)) {
      setConnectionState('error', 'You need an active session to join the chat.');
      notifyError('Sign in to use project chat', { timeoutMs: 8000 });
      return;
    }

    setConnectionState('connecting');

    try {
      doc = new Y.Doc({ gc: false });
      messageArray = doc.getArray<ChatMessage>('messages');
      syncMessages();
      messageArray.observe(syncMessages);

      providerConnected = false;
      provider = new WebsocketProvider(websocketBase, buildRoomName(roomId), doc, {
        maxBackoffTime: 5000
      });

      provider.on('status', (event: { status: string }) => {
        providerConnected = event.status === 'connected';

        if (event.status === 'connected') {
          setConnectionState('connected');
          scrollToBottom();
        } else if (event.status === 'disconnected') {
          setConnectionState('disconnected');
          providerConnected = false;
        } else {
          setConnectionState('connecting');
        }
      });

      provider.on('connection-error', () => {
        setConnectionState('error');
        notifyError('Chat connection failed. Please retry.', { timeoutMs: 8000 });
      });
    } catch (error) {
      console.error('Failed to initialize chat collaboration', error);
      teardown('error', 'Unable to start chat collaboration. Please retry.');
      notifyError('Unable to start chat collaboration. Please retry.', { timeoutMs: 8000 });
    }
  }

  function teardown(targetState: ConnectionState = 'idle', overrideMessage?: string) {
    if (messageArray) {
      messageArray.unobserve(syncMessages);
      messageArray = null;
    }

    provider?.destroy();
    provider = null;

    doc?.destroy();
    doc = null;

    messageCache.clear();
    messageSignatureCache.clear();
    providerConnected = false;
    setConnectionState(targetState, overrideMessage);
    messages = [];
  }

  function syncMessages() {
    if (!messageArray) {
      return;
    }

    if (isPruningHistory) {
      return;
    }

    pruneHistory(messageArray, doc);

    const nextMessages = buildRenderedMessages(messageArray);

    if (areMessagesEqual(messages, nextMessages)) {
      return;
    }

    messages = nextMessages;
    scrollToBottom();
  }

  function sanitizeContextId(value: unknown) {
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

  function pruneHistory(history: Y.Array<ChatMessage> | null, historyDoc: Y.Doc | null) {
    if (!history || isPruningHistory) {
      return;
    }

    if (history.length <= MAX_STORED_MESSAGES) {
      return;
    }

    isPruningHistory = true;
    try {
      const excess = history.length - MAX_STORED_MESSAGES;
      historyDoc?.transact(() => history.delete(0, excess));
    } finally {
      isPruningHistory = false;
    }
  }

  function buildRenderedMessages(history: Y.Array<ChatMessage> | null): ChatMessage[] {
    if (!history) {
      return [];
    }

    const length = history.length;
    const start = Math.max(0, length - MAX_RENDERED_MESSAGES);
    const nextMessages: ChatMessage[] = [];
    const activeMessageIds = new Set<string>();

    for (let index = start; index < length; index += 1) {
      const sanitized = getSanitizedMessage(history.get(index), activeMessageIds);
      if (sanitized) {
        nextMessages.push(sanitized);
      }
    }

    pruneMessageCaches(activeMessageIds);

    return nextMessages;
  }

  function getSanitizedMessage(
    message: unknown,
    activeMessageIds: Set<string>
  ): ChatMessage | null {
    const candidate = message as Partial<ChatMessage>;
    const signature = buildMessageSignature(candidate);
    const messageId = typeof candidate?.id === 'string' ? candidate.id : null;

    if (signature && messageId) {
      activeMessageIds.add(messageId);

      const cachedSignature = messageSignatureCache.get(messageId);
      const cachedMessage = messageCache.get(messageId);

      if (cachedSignature === signature && cachedMessage) {
        return cachedMessage;
      }
    }

    const sanitized = sanitizeIncomingMessage(message);

    if (sanitized && messageId && signature) {
      messageCache.set(messageId, sanitized);
      messageSignatureCache.set(messageId, signature);
      activeMessageIds.add(messageId);
    }

    return sanitized;
  }

  function pruneMessageCaches(activeMessageIds: Set<string>) {
    if (activeMessageIds.size === 0) {
      messageCache.clear();
      messageSignatureCache.clear();
      return;
    }

    for (const cachedId of messageCache.keys()) {
      if (!activeMessageIds.has(cachedId)) {
        messageCache.delete(cachedId);
        messageSignatureCache.delete(cachedId);
      }
    }
  }

  function areMessagesEqual(current: ChatMessage[], next: ChatMessage[]) {
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

  function sanitizeIncomingMessage(message: unknown): ChatMessage | null {
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

    const safeText = sanitizeMessageText(candidate.text).slice(0, MAX_MESSAGE_LENGTH).trim();
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

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (!scrollContainer) return;
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
  }

  function refreshUserIdentity(nextSession: SessionState = sessionValue) {
    const nextDisplayName = resolveUserName(nextSession);
    const didUpdateDisplayName = nextDisplayName !== userDisplayName;

    if (nextDisplayName !== userDisplayName) {
      userDisplayName = nextDisplayName;
    }

    const nextInitial = resolveUserInitial(nextDisplayName);
    if (nextInitial !== userInitial) {
      userInitial = nextInitial;
    }

    if (didUpdateDisplayName) {
      refreshConnectionMessage();
    }
  }

  function resolveUserName(currentSession: SessionState = sessionValue) {
    const candidates = [
      sanitizeDisplayName(currentSession.info?.name),
      sanitizeDisplayName(currentSession.info?.subject),
      obfuscateEmail(currentSession.info?.email)
    ];

    for (const candidate of candidates) {
      if (candidate) {
        return candidate;
      }
    }

    return 'User';
  }

  function resolveUserInitial(name: string) {
    return (name?.trim()[0] || 'U').toUpperCase();
  }

  function sanitizeUserName(name: unknown) {
    if (typeof name !== 'string') return '';

    const trimmed = name.trim();
    if (!trimmed || hasControlCharacters(trimmed)) return '';

    return trimmed.slice(0, MAX_USER_NAME_LENGTH);
  }

  function sanitizeIdentifier(value: unknown, maxLength: number) {
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

  function sanitizeDisplayName(name: unknown) {
    const sanitized = sanitizeUserName(name);
    if (!sanitized) return '';

    return sanitized.includes('@') ? obfuscateEmail(sanitized) : sanitized;
  }

  function obfuscateEmail(email: unknown) {
    if (typeof email !== 'string') return '';

    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@')) return '';

    const [localPart, domain] = trimmed.split('@');
    if (!localPart || !domain) return '';

    const safeLocal = `${localPart[0]}***`;
    const safeDomain = domain
      .split('.')
      .filter(Boolean)
      .map((part) => {
        if (part.length <= 2) {
          return `${part[0]}*`;
        }

        return `${part[0]}***${part.slice(-1)}`;
      })
      .join('.');

    return sanitizeUserName(`${safeLocal}@${safeDomain}`);
  }

  function sanitizeMessageText(value: unknown) {
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

  function updateDraft(rawValue: string) {
    const sanitizedValue = sanitizeMessageText(rawValue);

    if (messageInputEl && messageInputEl.value !== sanitizedValue) {
      messageInputEl.value = sanitizedValue;
    }

    if (sanitizedValue !== messageInput) {
      messageInput = sanitizedValue;
    }

    if (sanitizedValue !== sanitizedDraft) {
      sanitizedDraft = sanitizedValue;
    }

    const trimmed = sanitizedValue.trim();
    if (trimmed !== sanitizedDraftTrimmed) {
      sanitizedDraftTrimmed = trimmed;
    }
  }

  function handleInput(event: Event) {
    const target = (event.currentTarget ?? event.target) as HTMLTextAreaElement | null;
    if (!target) return;

    updateDraft(target.value);
  }

  $: if (messageInput !== sanitizedDraft) {
    updateDraft(messageInput);
  }

  function resolveConnectionMessage(
    state: ConnectionState,
    overrideMessage?: string,
    userName: string = userDisplayName
  ) {
    if (overrideMessage) return overrideMessage;

    const defaultMessage = connectionMessageDefaults[state];
    return typeof defaultMessage === 'function' ? defaultMessage(userName) : defaultMessage;
  }

  function setConnectionState(state: ConnectionState, overrideMessage?: string) {
    const hasStateChanged = connectionState !== state || connectionMessageOverride !== overrideMessage;
    const nextConnectionMessage = resolveConnectionMessage(state, overrideMessage);

    if (!hasStateChanged && nextConnectionMessage === connectionMessage) {
      return;
    }

    connectionState = state;
    connectionMessageOverride = overrideMessage;
    connectionMessage = nextConnectionMessage;
  }

  function refreshConnectionMessage() {
    const nextConnectionMessage = resolveConnectionMessage(
      connectionState,
      connectionMessageOverride,
      userDisplayName
    );

    if (nextConnectionMessage !== connectionMessage) {
      connectionMessage = nextConnectionMessage;
    }
  }

  function isCollaborationReady() {
    const connectionStatus = provider?.wsconnected === true;

    if (connectionStatus !== providerConnected) {
      providerConnected = connectionStatus;
    }

    return (
      Boolean(messageArray) &&
      Boolean(doc) &&
      providerConnected &&
      isCollaborationSessionValid(sessionValue)
    );
  }

  function sendMessage() {
    if (!isCollaborationReady()) return;

    updateDraft(messageInput);

    const trimmedDraft = sanitizedDraftTrimmed;

    if (!trimmedDraft) return;

    if (trimmedDraft.length > MAX_MESSAGE_LENGTH) {
      notifyError(`Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`, { timeoutMs: 6000 });
      return;
    }

    const userId = sessionValue.info?.id;
    const sanitizedUserId = sanitizeIdentifier(userId, MAX_USER_ID_LENGTH);
    if (!sanitizedUserId) {
      notifyError('Your session is invalid. Please sign in again.', { timeoutMs: 6000 });
      return;
    }

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      userId: sanitizedUserId,
      userName: userDisplayName,
      text: trimmedDraft,
      timestamp: Date.now()
    };

    doc?.transact(() => {
      messageArray?.push([message]);
    });

    updateDraft('');
  }

  $: canSend = sanitizeMessageText(messageInput).trim().length > 0;

  $: if (connectionState === 'connected' && messageInputEl) {
    messageInputEl.focus();
  }

  $: statusLabel = (() => {
    switch (connectionState) {
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
  })();

  $: showRetry = connectionState === 'error' || connectionState === 'disconnected';

  function handleRetry() {
    if (!currentRoomId) {
      return;
    }

    setConnectionState('connecting', 'Reconnecting to live chat…');
    void connect(currentRoomId);
  }
</script>

<section class="chat-panel">
  <header class="chat-header">
    <div>
      <p class="eyebrow">Project Chat</p>
      <p class="subtitle">Room for {safeTenantId}/{safeProjectId}</p>
    </div>
    <div class="identity-chip" aria-live="polite">
      <span class="chip-avatar" aria-hidden="true">{userInitial}</span>
      <div>
        <span class="chip-label">You</span>
        <p class="chip-name">{userDisplayName}</p>
      </div>
    </div>
    <span class={`status status--${connectionState}`}>
      <span class="pulse" aria-hidden="true"></span>
      {statusLabel}
    </span>
  </header>

  {#if connectionMessage}
    <div class="connection-hint" role="status">
      <span>{connectionMessage}</span>
      {#if showRetry}
        <button class="retry" type="button" on:click={handleRetry}>Retry</button>
      {/if}
    </div>
  {/if}

  <div class="chat-body" bind:this={scrollContainer}>
    {#if messages.length === 0}
      <p class="empty">No messages yet. Start the conversation!</p>
    {:else}
      {#each messages as message (message.id)}
        <article class={`message ${message.userId === sessionValue.info?.id ? 'mine' : ''}`}>
          <header>
            <div class="identity">
              <span class="avatar" aria-hidden="true">{message.userName.slice(0, 1).toUpperCase()}</span>
              <span class="author">{message.userName}</span>
            </div>
            <span class="timestamp">{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </header>
          <p class="content">{message.text}</p>
        </article>
      {/each}
    {/if}
  </div>

  <div class="chat-input">
    <textarea
      placeholder="Send a message"
      bind:value={messageInput}
      bind:this={messageInputEl}
      rows={2}
      aria-label="Chat message"
      title="Press Enter to send, Shift+Enter for a new line"
      on:input={handleInput}
      on:keydown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendMessage();
        }
      }}
    ></textarea>
    <button class="send" class:send-disabled={!canSend} on:click={sendMessage} aria-label="Send message" disabled={!canSend}>
      <svg viewBox="0 0 24 24" role="presentation" aria-hidden="true">
        <path d="M3.4 19.8 21 12 3.4 4.2l1.6 7.1-1.6 8.5Z" />
      </svg>
      Send
    </button>
  </div>
</section>

<style>
  .chat-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: linear-gradient(165deg, rgba(15, 23, 42, 0.9), rgba(11, 17, 31, 0.92));
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 14px;
    padding: 14px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
    min-height: 0;
    backdrop-filter: blur(12px);
    background-image: linear-gradient(145deg, rgba(15, 23, 42, 0.95), rgba(15, 118, 178, 0.08));
    flex: 1;
    height: 100%;
    position: relative;
    isolation: isolate;
  }

  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .connection-hint {
    margin: 0;
    font-size: 0.92rem;
    color: #e0e7ff;
    background: linear-gradient(120deg, rgba(79, 70, 229, 0.18), rgba(14, 165, 233, 0.16));
    border: 1px solid rgba(129, 140, 248, 0.35);
    padding: 10px 12px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .retry {
    background: transparent;
    color: #c7d2fe;
    border: 1px solid rgba(129, 140, 248, 0.6);
    border-radius: 999px;
    padding: 6px 10px;
    cursor: pointer;
    font-weight: 600;
    transition: border-color 140ms ease, color 140ms ease, background 140ms ease;
  }

  .retry:hover {
    background: rgba(129, 140, 248, 0.2);
    border-color: rgba(129, 140, 248, 0.9);
  }

  .eyebrow {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0;
    color: #94a3b8;
  }

  .subtitle {
    margin: 2px 0 0;
    color: #cbd5e1;
    font-weight: 600;
  }

  .identity-chip {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    background: rgba(148, 163, 184, 0.12);
    border: 1px solid rgba(148, 163, 184, 0.25);
    padding: 6px 10px;
    border-radius: 12px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  .chip-avatar {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.32), rgba(14, 165, 233, 0.32));
    color: #e2e8f0;
    font-weight: 800;
    box-shadow: 0 10px 30px rgba(14, 165, 233, 0.25);
  }

  .chip-label {
    display: block;
    font-size: 0.72rem;
    color: #cbd5e1;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .chip-name {
    margin: 0;
    font-weight: 700;
    color: #e2e8f0;
  }

  .status {
    font-size: 0.8rem;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid rgba(148, 163, 184, 0.4);
    color: #e2e8f0;
    background: rgba(148, 163, 184, 0.16);
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .status--connected {
    border-color: rgba(16, 185, 129, 0.5);
    background: rgba(16, 185, 129, 0.15);
    color: #a7f3d0;
  }

  .status--connecting {
    border-color: rgba(14, 165, 233, 0.5);
    background: rgba(14, 165, 233, 0.15);
    color: #bae6fd;
  }

  .status--disconnected,
  .status--error {
    border-color: rgba(248, 113, 113, 0.5);
    background: rgba(248, 113, 113, 0.15);
    color: #fecdd3;
  }

  .pulse {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 0 0 currentColor;
    animation: pulse 1.8s infinite;
  }

  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 currentColor;
    }
    70% {
      box-shadow: 0 0 0 10px rgba(255, 255, 255, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(255, 255, 255, 0);
    }
  }

  .chat-body {
    flex: 1;
    min-height: 240px;
    max-height: none;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px;
    border-radius: 12px;
    background: radial-gradient(circle at 20% 20%, rgba(59, 130, 246, 0.1), transparent 45%),
      radial-gradient(circle at 80% 0%, rgba(14, 165, 233, 0.12), transparent 35%),
      rgba(15, 23, 42, 0.7);
    border: 1px solid rgba(148, 163, 184, 0.12);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
    min-height: 0;
  }

  .chat-body::-webkit-scrollbar {
    width: 10px;
  }

  .chat-body::-webkit-scrollbar-track {
    background: rgba(15, 23, 42, 0.4);
  }

  .chat-body::-webkit-scrollbar-thumb {
    background: rgba(148, 163, 184, 0.4);
    border-radius: 999px;
  }

  .empty {
    margin: 0;
    text-align: center;
    color: #94a3b8;
  }

  .message {
    padding: 10px 12px;
    border-radius: 12px;
    background: linear-gradient(150deg, rgba(30, 41, 59, 0.9), rgba(30, 41, 59, 0.7));
    border: 1px solid rgba(148, 163, 184, 0.2);
    display: grid;
    gap: 4px;
    position: relative;
    overflow: hidden;
  }

  .message.mine {
    background: linear-gradient(145deg, rgba(59, 130, 246, 0.25), rgba(14, 165, 233, 0.28));
    border-color: rgba(14, 165, 233, 0.35);
    align-self: flex-end;
    box-shadow: 0 12px 30px rgba(14, 165, 233, 0.16);
  }

  .message header {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
    color: #cbd5e1;
    align-items: center;
  }

  .identity {
    display: inline-flex;
    gap: 8px;
    align-items: center;
  }

  .avatar {
    width: 28px;
    height: 28px;
    border-radius: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(145deg, rgba(59, 130, 246, 0.24), rgba(14, 165, 233, 0.3));
    color: #e2e8f0;
    font-weight: 800;
  }

  .author {
    font-weight: 700;
    color: #e2e8f0;
  }

  .timestamp {
    color: #94a3b8;
  }

  .content {
    margin: 0;
    white-space: pre-wrap;
    color: #e2e8f0;
  }

  .chat-input {
    display: grid;
    gap: 10px;
    grid-template-columns: 1fr auto;
    align-items: center;
  }

  textarea {
    width: 100%;
    border-radius: 10px;
    border: 1px solid rgba(148, 163, 184, 0.25);
    background: rgba(15, 23, 42, 0.9);
    color: #e2e8f0;
    padding: 10px 12px;
    resize: none;
    font: inherit;
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }

  textarea:focus {
    outline: 2px solid rgba(59, 130, 246, 0.4);
    outline-offset: 1px;
    border-color: rgba(59, 130, 246, 0.7);
    box-shadow: 0 12px 28px rgba(14, 165, 233, 0.2);
  }

  .send {
    background: linear-gradient(135deg, #0ea5e9, #22d3ee);
    color: #0f172a;
    border: none;
    border-radius: 999px;
    padding: 8px 14px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 10px 25px rgba(14, 165, 233, 0.25);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease, opacity 120ms ease;
  }

  .send:hover {
    filter: brightness(1.05);
    transform: translateY(-1px);
    box-shadow: 0 12px 28px rgba(14, 165, 233, 0.35);
  }

  .send svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
  }

  .send-disabled {
    opacity: 0.6;
    cursor: not-allowed;
    box-shadow: none;
    filter: grayscale(0.2);
  }
</style>
