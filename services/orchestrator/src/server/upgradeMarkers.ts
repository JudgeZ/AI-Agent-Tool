import type { IncomingMessage } from "node:http";

const WS_HANDLED_SYMBOL = Symbol.for("orchestrator.wsHandled");

/**
 * Mark an HTTP request as having its WebSocket upgrade handled.
 *
 * Sets the `WS_HANDLED_SYMBOL` symbol-keyed property on the provided `request` to `true`.
 *
 * @param request - The IncomingMessage to mark
 */
export function markUpgradeHandled(request: IncomingMessage): void {
  (request as Record<symbol, unknown>)[WS_HANDLED_SYMBOL] = true;
}

/**
 * Determines whether a request's WebSocket upgrade has been marked as handled.
 *
 * @param request - The incoming HTTP request to inspect
 * @returns `true` if the request has been marked as having its WebSocket upgrade handled, `false` otherwise
 */
export function isUpgradeHandled(request: IncomingMessage): boolean {
  return Boolean((request as Record<symbol, unknown>)[WS_HANDLED_SYMBOL]);
}

export { WS_HANDLED_SYMBOL };