import type { IncomingMessage } from "node:http";

const WS_HANDLED_SYMBOL = Symbol.for("orchestrator.wsHandled");

export function markUpgradeHandled(request: IncomingMessage): void {
  (request as Record<symbol, unknown>)[WS_HANDLED_SYMBOL] = true;
}

export function isUpgradeHandled(request: IncomingMessage): boolean {
  return Boolean((request as Record<symbol, unknown>)[WS_HANDLED_SYMBOL]);
}

export { WS_HANDLED_SYMBOL };
