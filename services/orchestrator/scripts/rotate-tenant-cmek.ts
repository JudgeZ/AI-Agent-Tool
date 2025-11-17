import process from "node:process";

import { TenantKeyManager } from "../src/security/tenantKeys.js";

function parseTenantArg(): string | undefined {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--tenant" || arg === "-t") {
      return args[index + 1];
    }
    if (arg.startsWith("--tenant=")) {
      return arg.slice("--tenant=".length);
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const tenantId = parseTenantArg();
  if (!tenantId) {
    console.error("Usage: tsx services/orchestrator/scripts/rotate-tenant-cmek.ts --tenant <TENANT_ID>");
    process.exit(1);
  }
  const manager = new TenantKeyManager();
  const version = await manager.rotateTenantKey(tenantId);
  console.log(`Rotated CMEK for tenant ${tenantId.trim()} (active version ${version}).`);
}

main().catch(error => {
  console.error("Failed to rotate tenant CMEK:", error);
  process.exit(1);
});
