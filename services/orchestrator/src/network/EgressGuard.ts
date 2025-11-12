import { appLogger } from "../observability/logger.js";

type EgressMetadata = {
  action?: string;
  metadata?: Record<string, unknown>;
};

export function ensureEgressAllowed(target: string, context: EgressMetadata = {}): void {
  if (!target) {
    throw new Error("egress target must be specified");
  }
  appLogger.debug?.({ event: "egress.guard", target, ...context }, "egress allowed");
}

