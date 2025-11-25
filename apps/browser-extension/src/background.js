/* eslint-disable no-console */
const SETTINGS_KEY = "aidt_settings";
const DEFAULT_SETTINGS = {
  gatewayUrl: "https://gateway.example.com",
  apiKey: "",
  recording: false,
};

/**
 * Retrieve settings from storage with defaults.
 * @returns {Promise<{gatewayUrl: string, apiKey: string, recording: boolean}>}
 */
async function getSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  const merged = { ...DEFAULT_SETTINGS, ...(stored?.[SETTINGS_KEY] ?? {}) };
  return merged;
}

/**
 * Persist settings to storage.
 * @param {Partial<{gatewayUrl: string, apiKey: string, recording: boolean}>} updates
 */
async function updateSettings(updates) {
  const current = await getSettings();
  const next = { ...current, ...updates };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * Build a telemetry websocket URL using the configured gateway.
 * @param {string} gatewayUrl
 * @param {string} apiKey
 */
function buildTelemetryUrl(gatewayUrl, apiKey) {
  const parsed = new URL(gatewayUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/telemetry";
  if (apiKey) {
    parsed.searchParams.set("apiKey", apiKey);
  }
  return parsed.toString();
}

let socket;
let reconnectTimer;
let recordingTabs = new Set();

function setSocket(newSocket) {
  socket = newSocket;
}

function clearSocket() {
  if (socket) {
    socket.close();
    socket = undefined;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

async function connectTelemetry() {
  clearSocket();
  const { gatewayUrl, apiKey } = await getSettings();
  if (!gatewayUrl || !apiKey) {
    console.warn("Gateway URL or API key not configured; telemetry disabled");
    return;
  }
  try {
    const target = buildTelemetryUrl(gatewayUrl, apiKey);
    socket = new WebSocket(target);
    socket.onopen = () => {
      console.info("Telemetry connected", target);
    };
    socket.onmessage = async (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.command === "Record" && event.source instanceof WebSocket) {
          await updateSettings({ recording: true });
          recordingTabs.forEach((tabId) => chrome.tabs.sendMessage(tabId, { type: "recording:start" }));
        }
        if (payload.command === "Stop") {
          await updateSettings({ recording: false });
          recordingTabs.forEach((tabId) => chrome.tabs.sendMessage(tabId, { type: "recording:stop" }));
        }
        if (payload.command === "Replay" && payload.events) {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTab = tabs[0];
            if (activeTab?.id) {
              chrome.tabs.sendMessage(activeTab.id, {
                type: "recording:replay",
                events: payload.events,
              });
            }
          });
        }
      } catch (error) {
        console.error("Failed to handle telemetry message", error);
      }
    };
    socket.onclose = () => {
      reconnectTimer = setTimeout(connectTelemetry, 3000);
    };
    socket.onerror = (err) => {
      console.error("Telemetry connection error", err);
    };
  } catch (error) {
    console.error("Failed to connect telemetry", error);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await updateSettings(DEFAULT_SETTINGS);
});

async function handleMessage(message, sender, sendResponse) {
  if (message?.type === "telemetry:event" && socket?.readyState === WebSocket.OPEN) {
    const { gatewayUrl, recording } = await getSettings();
    if (!recording) {
      sendResponse({ ok: false, reason: "recording-disabled" });
      return true;
    }
    if (message.event?.sensitive) {
      console.warn("Dropping sensitive telemetry event");
      sendResponse({ ok: false, reason: "sensitive" });
      return true;
    }
    const tabId = sender.tab?.id;
    if (typeof tabId === "number") {
      recordingTabs.add(tabId);
    }
    socket.send(
      JSON.stringify({
        type: "event",
        gateway: gatewayUrl,
        data: message.event,
      }),
    );
    sendResponse({ ok: true });
    return true;
  }
  if (message?.type === "telemetry:settings") {
    const settings = await getSettings();
    sendResponse(settings);
    return true;
  }
  if (message?.type === "telemetry:update-settings") {
    const next = await updateSettings(message.data ?? {});
    if (message.data?.apiKey || message.data?.gatewayUrl) {
      await connectTelemetry();
    }
    sendResponse(next);
    return true;
  }
  return false;
}

chrome.runtime.onMessage.addListener(handleMessage);

chrome.tabs.onRemoved.addListener((tabId) => {
  recordingTabs.delete(tabId);
});

connectTelemetry();

if (typeof module !== "undefined" && module.exports) {
  module.exports.__test = {
    getSettings,
    updateSettings,
    handleMessage,
    setSocket,
    DEFAULT_SETTINGS,
  };
}
