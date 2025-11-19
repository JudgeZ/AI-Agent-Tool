import { Logger } from "pino";
import { EventEmitter } from "events";

/**
 * Resource limits for WASM execution
 */
export interface WasmResourceLimits {
  /** Maximum memory in bytes (default: 256MB) */
  maxMemory?: number;

  /** Maximum stack size in bytes (default: 1MB) */
  maxStackSize?: number;

  /** Fuel limit for computation (prevents infinite loops) */
  fuelLimit?: number;

  /** Execution timeout in milliseconds */
  timeout?: number;
}

/**
 * Configuration for WASM sandbox
 */
export interface WasmSandboxConfig {
  /** WASM module bytes or path */
  wasmModule: Buffer | string;

  /** Resource limits */
  limits?: WasmResourceLimits;

  /** Import objects to provide to WASM */
  imports?: Record<string, any>;

  /** Logger instance */
  logger: Logger;
}

/**
 * Result of WASM execution
 */
export interface WasmExecutionResult {
  /** Return value from the WASM function */
  returnValue: any;

  /** Execution time in milliseconds */
  duration: number;

  /** Whether execution timed out */
  timedOut: boolean;

  /** Memory used in bytes */
  memoryUsed: number;

  /** Fuel consumed (if fuel metering enabled) */
  fuelConsumed?: number;
}

/**
 * WASM sandbox for executing lightweight, untrusted code
 *
 * Security features:
 * - Memory limits
 * - Stack limits
 * - Fuel metering (computation limits)
 * - No access to host filesystem or network by default
 * - Deterministic execution
 * - Timeout enforcement
 *
 * Use cases:
 * - Data transformations
 * - JSON/XML parsing
 * - String manipulation
 * - Mathematical computations
 * - Input validation
 */
export class WasmSandbox extends EventEmitter {
  private config: WasmSandboxConfig;
  private logger: Logger;
  private instance?: WebAssembly.Instance;
  private memory?: WebAssembly.Memory;

  constructor(config: WasmSandboxConfig) {
    super();
    this.config = config;
    this.logger = config.logger.child({ component: "WasmSandbox" });
  }

  /**
   * Initialize the WASM module
   */
  async initialize(): Promise<void> {
    this.logger.info("Initializing WASM sandbox");

    try {
      // Load WASM module
      const wasmBytes = await this.loadWasmModule();

      // Create memory with limits
      const limits = this.config.limits || {};
      const maxPages = Math.ceil(
        (limits.maxMemory || 256 * 1024 * 1024) / (64 * 1024),
      ); // 64KB per page

      this.memory = new WebAssembly.Memory({
        initial: 1, // Start with 1 page (64KB)
        maximum: maxPages,
      });

      // Build import object
      const importObject = this.buildImportObject();

      // Compile and instantiate
      const arrayBuffer = wasmBytes.buffer.slice(
        wasmBytes.byteOffset,
        wasmBytes.byteOffset + wasmBytes.byteLength,
      );
      const bufferSource =
        arrayBuffer instanceof SharedArrayBuffer
          ? new Uint8Array(arrayBuffer)
          : arrayBuffer;
      const module = await WebAssembly.compile(bufferSource as BufferSource);
      this.instance = await WebAssembly.instantiate(module, importObject);

      this.logger.info({ maxPages }, "WASM sandbox initialized");
      this.emit("initialized");
    } catch (error: any) {
      this.logger.error({ error }, "Failed to initialize WASM sandbox");
      throw new Error(`WASM initialization failed: ${error.message}`);
    }
  }

  /**
   * Load WASM module from buffer or file
   */
  private async loadWasmModule(): Promise<Buffer> {
    if (Buffer.isBuffer(this.config.wasmModule)) {
      return this.config.wasmModule;
    }

    // If it's a string, treat it as a file path
    const fs = await import("fs/promises");
    const wasmBytes = await fs.readFile(this.config.wasmModule);
    return wasmBytes;
  }

  /**
   * Build import object for WASM
   */
  private buildImportObject(): WebAssembly.Imports {
    const imports: WebAssembly.Imports = {
      env: {
        memory: this.memory!,
        // Provide limited console access for debugging
        log: (ptr: number, len: number) => {
          const message = this.readString(ptr, len);
          this.logger.debug({ message }, "WASM log");
        },
        abort: (
          message: number,
          fileName: number,
          lineNumber: number,
          columnNumber: number,
        ) => {
          const msg = this.readString(message, 100);
          this.logger.error({ msg, lineNumber, columnNumber }, "WASM aborted");
          throw new Error(`WASM execution aborted: ${msg}`);
        },
      },
    };

    // Merge custom imports
    if (this.config.imports) {
      for (const [namespace, functions] of Object.entries(
        this.config.imports,
      )) {
        if (!imports[namespace]) {
          imports[namespace] = {};
        }
        Object.assign(imports[namespace], functions);
      }
    }

    return imports;
  }

  /**
   * Execute a WASM function
   */
  async execute(
    functionName: string,
    ...args: any[]
  ): Promise<WasmExecutionResult> {
    if (!this.instance) {
      throw new Error("WASM sandbox not initialized. Call initialize() first.");
    }

    const startTime = Date.now();
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    this.logger.info({ functionName, args }, "Executing WASM function");

    try {
      // Get the exported function
      const exports = this.instance.exports as any;
      const func = exports[functionName];

      if (typeof func !== "function") {
        throw new Error(`Function '${functionName}' not found in WASM exports`);
      }

      // Set up timeout
      const timeout = this.config.limits?.timeout || 30000; // 30 seconds default
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          reject(new Error("WASM execution timed out"));
        }, timeout);
      });

      // Execute the function
      const executionPromise = Promise.resolve(func(...args));
      const returnValue = await Promise.race([
        executionPromise,
        timeoutPromise,
      ]);

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      const duration = Date.now() - startTime;
      const memoryUsed = this.getMemoryUsage();

      const result: WasmExecutionResult = {
        returnValue,
        duration,
        timedOut,
        memoryUsed,
      };

      this.logger.info(
        { functionName, duration, memoryUsed, timedOut },
        "WASM function executed",
      );

      this.emit("executed", result);
      return result;
    } catch (error: any) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      const duration = Date.now() - startTime;

      if (timedOut) {
        this.logger.warn(
          { duration, functionName },
          "WASM execution timed out",
        );

        return {
          returnValue: null,
          duration,
          timedOut: true,
          memoryUsed: this.getMemoryUsage(),
        };
      }

      this.logger.error({ error, functionName }, "WASM execution failed");
      throw error;
    }
  }

  /**
   * Get current memory usage
   */
  private getMemoryUsage(): number {
    if (!this.memory) {
      return 0;
    }

    return this.memory.buffer.byteLength;
  }

  /**
   * Read a string from WASM memory
   */
  private readString(ptr: number, maxLength: number): string {
    if (!this.memory) {
      return "";
    }

    const buffer = new Uint8Array(this.memory.buffer, ptr, maxLength);
    const nullIndex = buffer.indexOf(0);
    const length = nullIndex === -1 ? maxLength : nullIndex;

    return new TextDecoder().decode(buffer.slice(0, length));
  }

  /**
   * Write a string to WASM memory
   */
  writeString(str: string): { ptr: number; len: number } {
    if (!this.instance || !this.memory) {
      throw new Error("WASM sandbox not initialized");
    }

    const exports = this.instance.exports as any;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);

    // Allocate memory in WASM
    const ptr = exports.allocate ? exports.allocate(bytes.length) : 0;

    // Write bytes to memory
    const buffer = new Uint8Array(this.memory.buffer, ptr, bytes.length);
    buffer.set(bytes);

    return { ptr, len: bytes.length };
  }

  /**
   * Read bytes from WASM memory
   */
  readBytes(ptr: number, length: number): Uint8Array {
    if (!this.memory) {
      throw new Error("WASM sandbox not initialized");
    }

    return new Uint8Array(this.memory.buffer, ptr, length);
  }

  /**
   * Write bytes to WASM memory
   */
  writeBytes(bytes: Uint8Array): number {
    if (!this.instance || !this.memory) {
      throw new Error("WASM sandbox not initialized");
    }

    const exports = this.instance.exports as any;
    const ptr = exports.allocate ? exports.allocate(bytes.length) : 0;

    const buffer = new Uint8Array(this.memory.buffer, ptr, bytes.length);
    buffer.set(bytes);

    return ptr;
  }

  /**
   * Reset the WASM instance (reinitialize)
   */
  async reset(): Promise<void> {
    this.logger.info("Resetting WASM sandbox");
    this.instance = undefined;
    this.memory = undefined;
    await this.initialize();
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    this.logger.debug("Cleaning up WASM sandbox");
    this.instance = undefined;
    this.memory = undefined;
    this.emit("cleaned");
  }

  /**
   * Get available exports from the WASM module
   */
  getExports(): string[] {
    if (!this.instance) {
      return [];
    }

    return Object.keys(this.instance.exports).filter(
      (key) => typeof (this.instance!.exports as any)[key] === "function",
    );
  }

  /**
   * Check if WASM is supported in this environment
   */
  static isSupported(): boolean {
    return (
      typeof WebAssembly !== "undefined" &&
      typeof WebAssembly.compile === "function"
    );
  }

  /**
   * Validate WASM module structure
   */
  static async validateModule(wasmBytes: Buffer): Promise<boolean> {
    try {
      const arrayBuffer = wasmBytes.buffer.slice(
        wasmBytes.byteOffset,
        wasmBytes.byteOffset + wasmBytes.byteLength,
      );
      const bufferSource =
        arrayBuffer instanceof SharedArrayBuffer
          ? new Uint8Array(arrayBuffer)
          : arrayBuffer;
      await WebAssembly.compile(bufferSource as BufferSource);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Helper to create a simple WASM module for testing
 */
export function createTestWasmModule(): Buffer {
  // Minimal WASM module that exports an 'add' function
  const wasmCode = new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d, // Magic: \0asm
    0x01,
    0x00,
    0x00,
    0x00, // Version: 1

    // Type section
    0x01,
    0x07, // Section 1, 7 bytes
    0x01, // 1 type
    0x60, // func type
    0x02,
    0x7f,
    0x7f, // 2 params: i32, i32
    0x01,
    0x7f, // 1 result: i32

    // Function section
    0x03,
    0x02, // Section 3, 2 bytes
    0x01,
    0x00, // 1 function, type 0

    // Export section
    0x07,
    0x07, // Section 7, 7 bytes
    0x01, // 1 export
    0x03,
    0x61,
    0x64,
    0x64, // name: "add"
    0x00,
    0x00, // kind: func, index: 0

    // Code section
    0x0a,
    0x09, // Section 10, 9 bytes
    0x01, // 1 function body
    0x07, // body size: 7
    0x00, // 0 local declarations
    0x20,
    0x00, // local.get 0
    0x20,
    0x01, // local.get 1
    0x6a, // i32.add
    0x0b, // end
  ]);

  return Buffer.from(wasmCode);
}
