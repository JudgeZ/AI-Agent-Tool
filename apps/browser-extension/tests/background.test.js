const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let messageHandler;
let socket;
let __test;
let store;

class MockWebSocket {
  static OPEN = 1;

  constructor() {
    this.readyState = MockWebSocket.OPEN;
    this.sent = [];
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {}
}

beforeEach(async () => {
  store = {};
  global.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            return keys.reduce((acc, key) => {
              if (store[key]) acc[key] = store[key];
              return acc;
            }, {});
          }
          return store;
        },
        async set(values) {
          store = { ...store, ...values };
        },
      },
    },
    runtime: {
      onInstalled: { addListener: () => {} },
      onMessage: {
        addListener(handler) {
          messageHandler = handler;
        },
      },
    },
    tabs: {
      onRemoved: { addListener: () => {} },
      sendMessage: () => {},
      query: () => {},
    },
  };

  global.WebSocket = MockWebSocket;

  delete require.cache[require.resolve("../src/background.js")];
  ({ __test } = require("../src/background.js"));
  socket = new MockWebSocket();
  __test.setSocket(socket);
});

test("telemetry events are blocked when recording is disabled", async () => {
  let response;
  await messageHandler(
    { type: "telemetry:event", event: { type: "click" } },
    { tab: { id: 1 } },
    (payload) => {
      response = payload;
    },
  );

  assert.deepEqual(response, { ok: false, reason: "recording-disabled" });
  assert.equal(socket.sent.length, 0);
});

test("telemetry events are sent when recording is enabled", async () => {
  await __test.updateSettings({ recording: true, apiKey: "abc", gatewayUrl: "https://example.com" });

  let response;
  await messageHandler(
    { type: "telemetry:event", event: { type: "input", value: "hello" } },
    { tab: { id: 2 } },
    (payload) => {
      response = payload;
    },
  );

  assert.deepEqual(response, { ok: true });
  assert.equal(socket.sent.length, 1);
  const parsed = JSON.parse(socket.sent[0]);
  assert.equal(parsed.gateway, "https://example.com");
  assert.equal(parsed.data.value, "hello");
});
