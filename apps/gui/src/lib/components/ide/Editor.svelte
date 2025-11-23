<script lang="ts">
  import { derived, get } from 'svelte/store';
  import { onMount, onDestroy } from 'svelte';
  import * as monaco from 'monaco-editor';
  import * as Y from 'yjs';
  import { MonacoBinding } from 'y-monaco';
  import { WebsocketProvider } from 'y-websocket';
  import { Awareness } from 'y-protocols/awareness';
  import {
    activeFile,
    fileContents,
    saveFile,
    isDirty,
    deriveCollaborationRoom,
    setCollaborationStatus,
    resetCollaborationConnection,
    currentRoomId,
    setCollaborationContext,
    restoreLocalCollaborationContext,
    getLocalProjectId,
    collaborationContextVersion,
    type CollaborationRoomInfo
  } from '$lib/stores/ide';
  import { gatewayBaseUrl } from '$lib/config';
  import { session } from '$lib/stores/session';
  import { isCollaborationSessionValid } from './sessionAuth';
  import { notifyError } from '$lib/stores/notifications';

  let editorContainer: HTMLElement;
  let editor: monaco.editor.IStandaloneCodeEditor;
  let currentModel: monaco.editor.ITextModel | null = null;
  let binding: MonacoBinding | null = null;
  let provider: WebsocketProvider | null = null;
  let doc: Y.Doc | null = null;
  let yText: Y.Text | null = null;
  let awareness: Awareness | null = null;
  let textObserver: ((event: Y.YTextEvent) => void) | null = null;
  let queuedTextObserver: number | null = null;
  let attachedFile: string | null = null;
  let appliedContextVersion = 0;
  let configureRequestId = 0;
  let configureQueue: Promise<void> = Promise.resolve();
  let sessionValue = get(session);
  let activeFileValue = get(activeFile);
  let collaborationContextVersionValue = get(collaborationContextVersion);
  let subscriptions: Array<() => void> = [];

  const cleanupSubscriptions = () => {
    subscriptions.forEach((unsubscribe) => unsubscribe());
    subscriptions = [];
  };

  // Worker setup for Monaco (Vite specific)
  import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
  import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
  import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
  import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
  import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

  self.MonacoEnvironment = {
    getWorker: function (_: string, label: string) {
      if (label === 'json') {
        return new jsonWorker();
      }
      if (label === 'css' || label === 'scss' || label === 'less') {
        return new cssWorker();
      }
      if (label === 'html' || label === 'handlebars' || label === 'razor') {
        return new htmlWorker();
      }
      if (label === 'typescript' || label === 'javascript') {
        return new tsWorker();
      }
      return new editorWorker();
    }
  };

  const websocketBase = toWebsocketBase(gatewayBaseUrl);

  onMount(() => {
    editor = monaco.editor.create(editorContainer, {
      value: '',
      language: 'plaintext',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false }
    });

    editor.onDidChangeModelContent(() => {
      if (typeof activeFileValue === 'string') {
        const activeFileKey = activeFileValue;
        isDirty.update((d) => ({ ...d, [activeFileKey]: true }));
      }
    });

    // Ctrl+S to save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (typeof activeFileValue === 'string') {
        saveFile(activeFileValue, editor.getValue());
      }
    });

    cleanupSubscriptions();
    const activeFileWithContext = derived(
      [activeFile, collaborationContextVersion],
      ([$activeFile, $collaborationContextVersion]) => ({
        file: $activeFile,
        version: $collaborationContextVersion
      })
    );

    subscriptions = [
      session.subscribe((value) => {
        sessionValue = value;
        syncCollaborationContext();
      }),
      activeFileWithContext.subscribe(({ file, version }) => {
        activeFileValue = file;
        collaborationContextVersionValue = version;
        syncActiveFile();
      })
    ];
  });

  onDestroy(() => {
    teardownCollaboration();
    editor?.dispose();
    cleanupSubscriptions();
  });

  function toWebsocketBase(httpUrl: string) {
    const parsed = new URL(httpUrl);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    const normalized = new URL(parsed.origin);
    normalized.protocol = protocol;
    return normalized.toString().replace(/\/$/, '');
  }

  function notifyCollaborationError(message: string) {
    notifyError(message, { timeoutMs: 8000 });
  }

  async function configureForFile(path: string, forceReload = false) {
    const requestId = ++configureRequestId;
    configureQueue = configureQueue.then(async () => {
      try {
        if (requestId !== configureRequestId) return;
        if (path === attachedFile && currentModel && !forceReload) return;
        attachedFile = path;
        teardownCollaboration();

        const content = get(fileContents)[path] ?? '';
        const lang = getLangFromExt(path.split('.').pop() || 'txt');

        currentModel?.dispose();
        const model = monaco.editor.createModel(content, lang);
        currentModel = model;
        editor.setModel(model);
        isDirty.update((d) => ({ ...d, [path]: false }));

        await setupCollaboration(model, content, path, requestId);
        if (requestId !== configureRequestId) {
          model.dispose();
          return;
        }
        appliedContextVersion = collaborationContextVersionValue;
      } catch (error) {
        console.error('Failed to configure file for collaboration', { path, error });
        setCollaborationStatus('error');
        notifyCollaborationError('Unable to open the file for collaboration. Please try again.');
      }
    });
    return configureQueue;
  }

  function setupTextObserver(filePath: string, requestId: number) {
    if (!yText) return;
    const observedText = yText;
    textObserver = () => {
      if (queuedTextObserver !== null) return;

      queuedTextObserver = requestAnimationFrame(() => {
        queuedTextObserver = null;
        if (requestId !== configureRequestId || observedText !== yText) return;
        const value = observedText.toString();
        fileContents.update((c) => ({ ...c, [filePath]: value }));
        isDirty.update((d) => ({ ...d, [filePath]: true }));
      });
    };
    observedText.observe(textObserver);
  }

  function setLocalAwareness(awareness: Awareness) {
    awareness.setLocalStateField('user', {
      name: sessionValue.info?.name ?? sessionValue.info?.email ?? 'Guest',
      color: userColor(sessionValue.info?.id ?? 'guest')
    });
  }

  function logCollaborationEvent(event: string, detail: Record<string, unknown> = {}) {
    console.info('[collaboration]', event, {
      file: attachedFile,
      sessionId: sessionValue.info?.id,
      timestamp: Date.now(),
      ...detail
    });
  }

  async function setupCollaboration(
    model: monaco.editor.ITextModel,
    initialContent: string,
    filePath: string,
    requestId: number
  ) {
    const isStale = () => requestId !== configureRequestId;
    const cleanupStaleCollaboration = () => {
      if (yText && textObserver) {
        yText.unobserve(textObserver);
      }
      if (awareness) {
        awareness.destroy();
        awareness = null;
      }
      if (queuedTextObserver !== null) {
        cancelAnimationFrame(queuedTextObserver);
        queuedTextObserver = null;
      }
      if (provider) {
        provider.destroy();
        provider = null;
      }
      if (doc) {
        doc.destroy();
        doc = null;
        yText = null;
      }
      textObserver = null;
    };

    if (isStale()) return;

    if (!isCollaborationSessionValid(sessionValue)) {
      logCollaborationEvent('auth-required');
      setCollaborationStatus('error');
      return;
    }

    setCollaborationStatus('connecting');
    let roomInfo: CollaborationRoomInfo | null = null;

    try {
      roomInfo = await deriveCollaborationRoom(filePath);
      if (isStale()) return;
    } catch (error) {
      console.error('Failed to derive collaboration room', error);
      setCollaborationStatus('error');
      logCollaborationEvent('room-derivation-failed', { message: (error as Error).message });
      notifyCollaborationError('Could not start collaboration. Check your session and retry.');
      return;
    }

    if (!roomInfo) {
      setCollaborationStatus('error');
      logCollaborationEvent('room-derivation-failed');
      return;
    }

    try {
      if (isStale()) {
        cleanupStaleCollaboration();
        return;
      }

      doc = new Y.Doc({ gc: false });
      yText = doc.getText('content');
      if (yText.length === 0 && initialContent) {
        yText.insert(0, initialContent);
      }

      awareness = new Awareness(doc);

      if (isStale()) {
        cleanupStaleCollaboration();
        return;
      }

      setupTextObserver(filePath, requestId);

      provider = new WebsocketProvider(
        websocketBase,
        buildRoomName(roomInfo),
        doc,
        {
          awareness,
          maxBackoffTime: 5000
        }
      );

      provider.on('status', (event: { status: string }) => {
        logCollaborationEvent('ws-status', { status: event.status, roomId: roomInfo?.roomId });
        if (event.status === 'connected') {
          setCollaborationStatus('connected');
          logCollaborationEvent('room-joined', { roomId: roomInfo?.roomId });
        } else if (event.status === 'disconnected') {
          setCollaborationStatus('disconnected');
          logCollaborationEvent('room-left', { roomId: roomInfo?.roomId });
        } else {
          setCollaborationStatus('connecting');
        }
      });
      provider.on('connection-close', () => {
        logCollaborationEvent('ws-closed', { roomId: roomInfo?.roomId });
        setCollaborationStatus('disconnected');
      });
      provider.on('connection-error', () => {
        logCollaborationEvent('ws-error', { roomId: roomInfo?.roomId });
        setCollaborationStatus('error');
      });
    } catch (error) {
      console.error('Failed to initialize collaboration provider', error);
      setCollaborationStatus('error');
      logCollaborationEvent('ws-init-failed', { message: (error as Error).message });
      notifyCollaborationError('Collaboration connection failed to initialize. Please retry.');
      cleanupStaleCollaboration();
      return;
    }

    if (isStale()) {
      cleanupStaleCollaboration();
      return;
    }

    const activeAwareness = provider?.awareness ?? awareness;
    if (!activeAwareness) {
      logCollaborationEvent('awareness-init-failed');
      setCollaborationStatus('error');
      cleanupStaleCollaboration();
      return;
    }

    setLocalAwareness(activeAwareness);
    binding = new MonacoBinding(yText, model, new Set([editor]), activeAwareness);
  }

  function buildRoomName(info: CollaborationRoomInfo) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const params = new URLSearchParams({
      tenantId: info.tenantId,
      projectId: info.projectId,
      filePath: info.filePath,
      roomId: info.roomId,
      // Authentication relies on same-origin session cookies; avoid embedding tokens in URLs.
      authMode: 'session-cookie'
    });

    if (sessionValue.info?.id) {
      params.set('sessionId', sessionValue.info.id);
    }

    const roomName = `collaboration/ws?${params.toString()}`;

    if (roomName.length > 2048) {
      throw new Error('collaboration room name exceeds length limits');
    }

    return roomName;
  }

  function teardownCollaboration() {
    binding?.destroy();
    binding = null;

    if (yText && textObserver) {
      yText.unobserve(textObserver);
    }
    textObserver = null;
    if (queuedTextObserver !== null) {
      cancelAnimationFrame(queuedTextObserver);
      queuedTextObserver = null;
    }

    provider?.destroy();
    provider = null;

    logCollaborationEvent('room-teardown', { roomId: get(currentRoomId) });

    doc?.destroy();
    doc = null;
    yText = null;
    if (awareness) {
      awareness.destroy();
      awareness = null;
    }

    resetCollaborationConnection();
  }

  function syncCollaborationContext() {
    if (sessionValue.authenticated && sessionValue.info) {
      setCollaborationContext({
        tenantId: sessionValue.info.tenantId ?? undefined,
        projectId: sessionValue.info.projectId ?? getLocalProjectId()
      });
    } else if (!sessionValue.loading) {
      restoreLocalCollaborationContext();
    }
  }

  function syncActiveFile() {
    if (!editor) return;

    if (activeFileValue) {
      const forceReload = collaborationContextVersionValue !== appliedContextVersion;
      void configureForFile(activeFileValue, forceReload);
    } else {
      attachedFile = null;
      teardownCollaboration();
      currentModel?.dispose();
      currentModel = null;
      editor.setValue('');
    }
  }

  function userColor(seed: string) {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash = (hash << 5) - hash + seed.charCodeAt(i);
      hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 60%)`;
  }

  function getLangFromExt(ext: string) {
    const map: Record<string, string> = {
      ts: 'typescript',
      js: 'javascript',
      json: 'json',
      html: 'html',
      css: 'css',
      md: 'markdown',
      rs: 'rust',
      go: 'go',
      py: 'python'
    };
    return map[ext] || 'plaintext';
  }
</script>

<div class="w-full h-full" bind:this={editorContainer}></div>
