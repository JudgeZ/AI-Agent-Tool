/* eslint-disable no-console */
const SENSITIVE_INPUT_TYPES = new Set(["password", "email", "tel"]);
const SENSITIVE_ATTRIBUTES = new Set(["data-sensitive", "data-private"]);
const SENSITIVE_NAMES = ["creditcard", "cc-number", "cvv", "ssn", "social"];
const SENSITIVE_CLASSES = ["sensitive", "private", "cc-number", "ssn"];

function isHTMLElement(target) {
  return typeof HTMLElement !== "undefined" && target instanceof HTMLElement;
}

function isTextInput(target) {
  const hasInput = typeof HTMLInputElement !== "undefined";
  const hasTextarea = typeof HTMLTextAreaElement !== "undefined";
  return (
    (hasInput && target instanceof HTMLInputElement) ||
    (hasTextarea && target instanceof HTMLTextAreaElement)
  );
}

function isSensitiveInput(target) {
  if (!isTextInput(target)) {
    return false;
  }
  const type = target.getAttribute?.("type")?.toLowerCase();
  if (type && SENSITIVE_INPUT_TYPES.has(type)) {
    return true;
  }

  const nameAttr = target.getAttribute?.("name")?.toLowerCase();
  if (nameAttr && SENSITIVE_NAMES.some((needle) => nameAttr.includes(needle))) {
    return true;
  }

  const autocomplete = target.getAttribute?.("autocomplete")?.toLowerCase();
  if (autocomplete && SENSITIVE_NAMES.some((needle) => autocomplete.includes(needle))) {
    return true;
  }

  const hasSensitiveAttr = Array.from(SENSITIVE_ATTRIBUTES).some((attr) => target.hasAttribute?.(attr));
  if (hasSensitiveAttr) {
    return true;
  }

  const className = target.className?.toString().toLowerCase?.() ?? "";
  if (className && SENSITIVE_CLASSES.some((needle) => className.includes(needle))) {
    return true;
  }

  return false;
}

function buildTelemetryPayload(event) {
  const target = event?.target;
  const sensitive = isSensitiveInput(target);
  if (sensitive) {
    return undefined;
  }

  const tag = isHTMLElement(target) ? target.tagName : undefined;
  const value = isTextInput(target) ? target.value : undefined;

  return {
    type: event?.type,
    tag,
    value,
    timestamp: Date.now(),
    sensitive: false,
  };
}

function sendTelemetryEvent(event) {
  const payload = buildTelemetryPayload(event);
  if (!payload) return;
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    chrome.runtime
      .sendMessage({ type: "telemetry:event", event: payload })
      .catch(() => {
        // ignore communication errors
      });
  }
}

function captureEvent(event) {
  sendTelemetryEvent(event);
}

function attachListeners() {
  if (typeof document === "undefined") return;
  document.addEventListener("click", captureEvent, true);
  document.addEventListener("input", captureEvent, true);
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "recording:replay" && Array.isArray(message.events)) {
      console.info("Replaying events", message.events.length);
    }
  });
}

attachListeners();

if (typeof module !== "undefined") {
  module.exports = { isSensitiveInput, buildTelemetryPayload };
}
