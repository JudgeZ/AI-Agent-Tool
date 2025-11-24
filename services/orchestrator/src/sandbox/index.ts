/**
 * Sandbox module for secure execution of untrusted code
 *
 * Provides two sandbox implementations:
 * 1. ContainerSandbox - Docker-based isolation for heavy workloads
 * 2. WasmSandbox - WebAssembly-based isolation for lightweight computations
 */

export {
  ContainerSandbox,
  ContainerSandboxConfig,
  ExecutionResult,
  NetworkPolicy,
  ResourceLimits,
} from './ContainerSandbox.js';

export {
  WasmSandbox,
  WasmSandboxConfig,
  WasmExecutionResult,
  WasmResourceLimits,
  createTestWasmModule,
} from './WasmSandbox.js';

/**
 * Sandbox type enum for selecting appropriate sandbox
 */
export enum SandboxType {
  CONTAINER = 'container',
  WASM = 'wasm',
}

/**
 * Sandbox capability requirements
 */
export interface SandboxCapabilities {
  /** Requires filesystem access */
  filesystem?: boolean;

  /** Requires network access */
  network?: boolean;

  /** Requires heavy computation */
  heavyCompute?: boolean;

  /** Requires external binaries */
  externalBinaries?: boolean;

  /** Maximum memory required (bytes) */
  maxMemory?: number;

  /** Maximum execution time (ms) */
  maxExecutionTime?: number;
}

/**
 * Select appropriate sandbox type based on capabilities
 */
export function selectSandboxType(capabilities: SandboxCapabilities): SandboxType {
  // Container sandbox if:
  // - Needs filesystem access
  // - Needs network access
  // - Needs external binaries
  // - Heavy computation (>1GB memory)
  if (
    capabilities.filesystem ||
    capabilities.network ||
    capabilities.externalBinaries ||
    capabilities.heavyCompute ||
    (capabilities.maxMemory && capabilities.maxMemory > 1024 * 1024 * 1024)
  ) {
    return SandboxType.CONTAINER;
  }

  // WASM sandbox for lightweight, data-only operations
  return SandboxType.WASM;
}

export { TerminalManager } from "./TerminalManager.js";
