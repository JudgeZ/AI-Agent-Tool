const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let isSensitiveInput;
let buildTelemetryPayload;

class MockHTMLElement {}
class MockInput extends MockHTMLElement {
  constructor(type, value) {
    super();
    this._type = type;
    this.value = value;
    this.tagName = "INPUT";
  }

  getAttribute(name) {
    if (name === "type") return this._type;
    return null;
  }
}

class MockTextarea extends MockHTMLElement {
  constructor(value) {
    super();
    this.value = value;
  }

  getAttribute(name) {
    if (name === "type") return "textarea";
    return null;
  }
}

beforeEach(() => {
  global.HTMLElement = MockHTMLElement;
  global.HTMLInputElement = MockInput;
  global.HTMLTextAreaElement = MockTextarea;

  // Reload module to ensure it sees updated globals
  delete require.cache[require.resolve("../src/content.js")];
  ({ isSensitiveInput, buildTelemetryPayload } = require("../src/content.js"));
});

test("isSensitiveInput flags password and email inputs", () => {
  assert.equal(isSensitiveInput(new MockInput("password", "secret")), true);
  assert.equal(isSensitiveInput(new MockInput("email", "user@example.com")), true);
  assert.equal(isSensitiveInput(new MockInput("text", "ok")), false);
});

test("buildTelemetryPayload skips sensitive events", () => {
  const event = { type: "input", target: new MockInput("password", "secret") };
  assert.equal(buildTelemetryPayload(event), undefined);
});

test("buildTelemetryPayload captures non-sensitive value", () => {
  const target = new MockInput("text", "hello");
  const event = { type: "input", target };
  const payload = buildTelemetryPayload(event);
  assert.ok(payload);
  assert.equal(payload.type, "input");
  assert.equal(payload.tag, "INPUT");
  assert.equal(payload.value, "hello");
  assert.equal(payload.sensitive, false);
  assert.ok(typeof payload.timestamp === "number");
});

test("buildTelemetryPayload records textarea events without treating them as sensitive", () => {
  const target = new MockTextarea("notes");
  const event = { type: "input", target };
  const payload = buildTelemetryPayload(event);
  assert.ok(payload);
  assert.equal(payload.value, "notes");
});
