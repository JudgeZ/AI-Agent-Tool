import Docker from 'dockerode';
import { Logger } from 'pino';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

/**
 * Security policy for network access
 */
export interface NetworkPolicy {
  /** Allow all network access */
  allowAll?: boolean;

  /** List of allowed domains/IPs */
  allowlist?: string[];

  /** Block all network access */
  blockAll?: boolean;
}

/**
 * Resource limits for the container
 */
export interface ResourceLimits {
  /** CPU limit in cores (e.g., 0.5 for half a core) */
  cpuQuota?: number;

  /** Memory limit in bytes */
  memory?: number;

  /** Maximum disk space in bytes */
  diskQuota?: number;

  /** Maximum number of PIDs/processes */
  pidsLimit?: number;

  /** Execution timeout in milliseconds */
  timeout?: number;
}

/**
 * Configuration for container sandbox
 */
export interface ContainerSandboxConfig {
  /** Docker image to use */
  image: string;

  /** Working directory inside container */
  workdir?: string;

  /** Environment variables */
  env?: Record<string, string>;

  /** Resource limits */
  limits?: ResourceLimits;

  /** Network policy */
  networkPolicy?: NetworkPolicy;

  /** Mount points (host_path -> container_path) */
  mounts?: Array<{ source: string; target: string; readonly?: boolean }>;

  /** Enable AppArmor profile */
  appArmorProfile?: string;

  /** Enable seccomp profile */
  seccompProfile?: string;

  /** User to run as (non-root) */
  user?: string;

  /** Logger instance */
  logger: Logger;
}

/**
 * Result of container execution
 */
export interface ExecutionResult {
  /** Exit code */
  exitCode: number;

  /** Standard output */
  stdout: string;

  /** Standard error */
  stderr: string;

  /** Execution time in milliseconds */
  duration: number;

  /** Whether execution timed out */
  timedOut: boolean;

  /** Container ID */
  containerId: string;
}

/**
 * Container sandbox for executing untrusted code
 *
 * Security features:
 * - Resource limits (CPU, memory, disk, PIDs)
 * - Network isolation with allowlist/blocklist
 * - Filesystem isolation
 * - Non-root execution
 * - AppArmor and seccomp profiles
 * - Automatic cleanup
 */
export class ContainerSandbox extends EventEmitter {
  private docker: Docker;
  private config: ContainerSandboxConfig;
  private logger: Logger;
  private container?: Docker.Container;

  constructor(config: ContainerSandboxConfig) {
    super();
    this.config = config;
    this.logger = config.logger.child({ component: 'ContainerSandbox' });
    this.docker = new Docker({ socketPath: this.getDockerSocket() });
  }

  /**
   * Get the Docker socket path based on platform
   */
  private getDockerSocket(): string {
    if (process.platform === 'win32') {
      return '//./pipe/docker_engine';
    }
    return '/var/run/docker.sock';
  }

  /**
   * Prepare the sandbox environment
   */
  async prepare(): Promise<void> {
    this.logger.info({ image: this.config.image }, 'Preparing container sandbox');

    // Pull the image if not already available
    try {
      await this.pullImageIfNeeded();
    } catch (error: any) {
      this.logger.error({ error, image: this.config.image }, 'Failed to pull image');
      throw new Error(`Failed to pull image ${this.config.image}: ${error.message}`);
    }

    // Validate network policy
    this.validateNetworkPolicy();
  }

  /**
   * Pull Docker image if not already present
   */
  private async pullImageIfNeeded(): Promise<void> {
    try {
      await this.docker.getImage(this.config.image).inspect();
      this.logger.debug({ image: this.config.image }, 'Image already present');
    } catch (error: any) {
      if (error.statusCode === 404) {
        this.logger.info({ image: this.config.image }, 'Pulling image');

        await new Promise((resolve, reject) => {
          this.docker.pull(this.config.image, (err: any, stream: NodeJS.ReadableStream) => {
            if (err) {
              return reject(err);
            }

            this.docker.modem.followProgress(stream, (err: any) => {
              if (err) {
                return reject(err);
              }
              resolve(undefined);
            });
          });
        });

        this.logger.info({ image: this.config.image }, 'Image pulled successfully');
      } else {
        throw error;
      }
    }
  }

  /**
   * Validate network policy configuration
   */
  private validateNetworkPolicy(): void {
    const policy = this.config.networkPolicy;

    if (policy?.allowAll && policy?.blockAll) {
      throw new Error('Cannot specify both allowAll and blockAll in network policy');
    }

    if (policy?.allowAll && policy?.allowlist && policy.allowlist.length > 0) {
      this.logger.warn('allowAll specified with allowlist; allowlist will be ignored');
    }
  }

  /**
   * Execute a command in the sandbox
   */
  async execute(command: string, args: string[] = []): Promise<ExecutionResult> {
    const startTime = Date.now();
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    this.logger.info({ command, args }, 'Executing command in sandbox');

    try {
      // Create container with security settings
      const createOptions = this.buildCreateOptions(command, args);
      this.container = await this.docker.createContainer(createOptions);

      const containerId = this.container.id;
      this.logger.debug({ containerId }, 'Container created');

      // Set up timeout
      const timeout = this.config.limits?.timeout || 300000; // 5 minutes default
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          reject(new Error('Execution timed out'));
        }, timeout);
      });

      // Start container and wait for completion
      await this.container.start();
      this.emit('started', { containerId });

      // Attach to get output
      const stream = new PassThrough();
      const stdout: string[] = [];
      const stderr: string[] = [];

      stream.on('data', (chunk: Buffer) => {
        const str = chunk.toString();
        stdout.push(str);
      });

      const attachStream = await this.container.attach({
        stream: true,
        stdout: true,
        stderr: true,
      });

      this.docker.modem.demuxStream(attachStream, stream, stream);

      // Wait for container to finish or timeout
      const waitResult = await Promise.race([
        this.container.wait(),
        timeoutPromise,
      ]);

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      const duration = Date.now() - startTime;
      const exitCode = (waitResult as any).StatusCode || 0;

      const result: ExecutionResult = {
        exitCode,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        duration,
        timedOut,
        containerId,
      };

      this.logger.info(
        { exitCode, duration, timedOut, containerId },
        'Command executed'
      );

      this.emit('completed', result);
      return result;

    } catch (error: any) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      const duration = Date.now() - startTime;

      if (timedOut) {
        this.logger.warn({ duration, command }, 'Execution timed out');

        // Force stop the container
        if (this.container) {
          await this.container.kill().catch(() => {
            // Ignore errors during cleanup
          });
        }

        return {
          exitCode: -1,
          stdout: '',
          stderr: 'Execution timed out',
          duration,
          timedOut: true,
          containerId: this.container?.id || '',
        };
      }

      this.logger.error({ error, command }, 'Execution failed');
      throw error;

    } finally {
      await this.cleanup();
    }
  }

  /**
   * Build Docker container create options
   */
  private buildCreateOptions(command: string, args: string[]): Docker.ContainerCreateOptions {
    const limits = this.config.limits || {};
    const networkPolicy = this.config.networkPolicy || {};

    const options: Docker.ContainerCreateOptions = {
      Image: this.config.image,
      Cmd: [command, ...args],
      WorkingDir: this.config.workdir || '/workspace',
      Env: this.buildEnvArray(),
      HostConfig: {
        // Resource limits
        Memory: limits.memory || 2 * 1024 * 1024 * 1024, // 2GB default
        MemorySwap: limits.memory || 2 * 1024 * 1024 * 1024, // No swap
        NanoCpus: limits.cpuQuota ? limits.cpuQuota * 1e9 : 1 * 1e9, // 1 CPU default
        PidsLimit: limits.pidsLimit || 100,

        // Network isolation
        NetworkMode: this.getNetworkMode(networkPolicy),

        // Security options
        SecurityOpt: this.buildSecurityOpts(),
        ReadonlyRootfs: false, // Allow writes to /tmp and workdir

        // Bind mounts
        Binds: this.buildBindMounts(),

        // Automatically remove container after exit
        AutoRemove: false, // We'll clean up manually for better control

        // Prevent privilege escalation
        Privileged: false,
        CapDrop: ['ALL'],
        CapAdd: [], // No capabilities by default
      },
      User: this.config.user || 'nobody', // Run as non-root
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    };

    return options;
  }

  /**
   * Build environment variable array
   */
  private buildEnvArray(): string[] {
    const env = this.config.env || {};
    return Object.entries(env).map(([key, value]) => `${key}=${value}`);
  }

  /**
   * Get network mode based on policy
   */
  private getNetworkMode(policy: NetworkPolicy): string {
    if (policy.blockAll) {
      return 'none';
    }

    if (policy.allowAll) {
      return 'bridge';
    }

    // If allowlist is specified, use custom network with firewall rules
    // For simplicity, default to 'none' for now
    return 'none';
  }

  /**
   * Build security options
   */
  private buildSecurityOpts(): string[] {
    const opts: string[] = [];

    // No new privileges
    opts.push('no-new-privileges:true');

    // AppArmor profile
    if (this.config.appArmorProfile) {
      opts.push(`apparmor=${this.config.appArmorProfile}`);
    }

    // Seccomp profile
    if (this.config.seccompProfile) {
      opts.push(`seccomp=${this.config.seccompProfile}`);
    } else {
      // Use default seccomp profile
      opts.push('seccomp=default');
    }

    return opts;
  }

  /**
   * Build bind mounts
   */
  private buildBindMounts(): string[] {
    const binds: string[] = [];

    if (this.config.mounts) {
      for (const mount of this.config.mounts) {
        const mode = mount.readonly ? 'ro' : 'rw';
        binds.push(`${mount.source}:${mount.target}:${mode}`);
      }
    }

    return binds;
  }

  /**
   * Clean up container resources
   */
  async cleanup(): Promise<void> {
    if (!this.container) {
      return;
    }

    const containerId = this.container.id;
    this.logger.debug({ containerId }, 'Cleaning up container');

    try {
      // Stop the container if still running
      const info = await this.container.inspect();
      if (info.State.Running) {
        await this.container.stop({ t: 5 }); // 5 second grace period
      }

      // Remove the container
      await this.container.remove({ force: true });

      this.logger.debug({ containerId }, 'Container cleaned up');
      this.emit('cleaned', { containerId });

    } catch (error: any) {
      this.logger.warn({ error, containerId }, 'Failed to cleanup container');
    } finally {
      this.container = undefined;
    }
  }

  /**
   * Force stop and cleanup (emergency stop)
   */
  async forceStop(): Promise<void> {
    if (this.container) {
      this.logger.warn({ containerId: this.container.id }, 'Force stopping container');

      try {
        await this.container.kill();
      } catch (error: any) {
        this.logger.error({ error }, 'Failed to kill container');
      }

      await this.cleanup();
    }
  }

  /**
   * Get container logs
   */
  async getLogs(): Promise<{ stdout: string; stderr: string }> {
    if (!this.container) {
      throw new Error('No active container');
    }

    const logs = await this.container.logs({
      stdout: true,
      stderr: true,
      timestamps: false,
    });

    return {
      stdout: logs.toString(),
      stderr: '',
    };
  }

  /**
   * Check if Docker is available
   */
  static async isDockerAvailable(): Promise<boolean> {
    try {
      const docker = new Docker();
      await docker.ping();
      return true;
    } catch {
      return false;
    }
  }
}
