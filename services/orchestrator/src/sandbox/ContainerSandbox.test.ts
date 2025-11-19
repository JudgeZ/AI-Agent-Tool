import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ContainerSandbox, ContainerSandboxConfig, ExecutionResult } from './ContainerSandbox';
import pino from 'pino';

describe('ContainerSandbox', () => {
  const logger = pino({ level: 'silent' });
  let sandbox: ContainerSandbox | undefined;

  afterEach(async () => {
    if (sandbox) {
      await sandbox.cleanup();
      sandbox = undefined;
    }
  });

  describe('Configuration', () => {
    it('should create sandbox with valid config', () => {
      const config: ContainerSandboxConfig = {
        image: 'alpine:latest',
        logger,
      };

      sandbox = new ContainerSandbox(config);
      expect(sandbox).toBeDefined();
    });

    it('should reject conflicting network policies', () => {
      const config: ContainerSandboxConfig = {
        image: 'alpine:latest',
        logger,
        networkPolicy: {
          allowAll: true,
          blockAll: true,
        },
      };

      sandbox = new ContainerSandbox(config);
      expect(async () => await sandbox!.prepare()).rejects.toThrow(
        'Cannot specify both allowAll and blockAll'
      );
    });

    it('should build correct environment array', () => {
      const config: ContainerSandboxConfig = {
        image: 'alpine:latest',
        logger,
        env: {
          FOO: 'bar',
          BAZ: 'qux',
        },
      };

      sandbox = new ContainerSandbox(config);
      const envArray = (sandbox as any).buildEnvArray();

      expect(envArray).toContain('FOO=bar');
      expect(envArray).toContain('BAZ=qux');
    });

    it('should apply resource limits', () => {
      const config: ContainerSandboxConfig = {
        image: 'alpine:latest',
        logger,
        limits: {
          cpuQuota: 0.5,
          memory: 512 * 1024 * 1024, // 512MB
          pidsLimit: 50,
          timeout: 60000, // 1 minute
        },
      };

      sandbox = new ContainerSandbox(config);
      const createOptions = (sandbox as any).buildCreateOptions('echo', ['hello']);

      expect(createOptions.HostConfig.Memory).toBe(512 * 1024 * 1024);
      expect(createOptions.HostConfig.NanoCpus).toBe(0.5 * 1e9);
      expect(createOptions.HostConfig.PidsLimit).toBe(50);
    });

    it('should configure network isolation', () => {
      const config: ContainerSandboxConfig = {
        image: 'alpine:latest',
        logger,
        networkPolicy: {
          blockAll: true,
        },
      };

      sandbox = new ContainerSandbox(config);
      const networkMode = (sandbox as any).getNetworkMode(config.networkPolicy);

      expect(networkMode).toBe('none');
    });

    it('should run as non-root user by default', () => {
      const config: ContainerSandboxConfig = {
        image: 'alpine:latest',
        logger,
      };

      sandbox = new ContainerSandbox(config);
      const createOptions = (sandbox as any).buildCreateOptions('whoami', []);

      expect(createOptions.User).toBe('nobody');
    });

    it('should include security options', () => {
      const config: ContainerSandboxConfig = {
        image: 'alpine:latest',
        logger,
        appArmorProfile: 'docker-default',
      };

      sandbox = new ContainerSandbox(config);
      const securityOpts = (sandbox as any).buildSecurityOpts();

      expect(securityOpts).toContain('no-new-privileges:true');
      expect(securityOpts).toContain('apparmor=docker-default');
      expect(securityOpts.some((opt: string) => opt.startsWith('seccomp='))).toBe(true);
    });

    it('should configure read-only mounts', () => {
      const config: ContainerSandboxConfig = {
        image: 'alpine:latest',
        logger,
        mounts: [
          { source: '/host/data', target: '/data', readonly: true },
          { source: '/host/output', target: '/output', readonly: false },
        ],
      };

      sandbox = new ContainerSandbox(config);
      const binds = (sandbox as any).buildBindMounts();

      expect(binds).toContain('/host/data:/data:ro');
      expect(binds).toContain('/host/output:/output:rw');
    });
  });

  describe('Docker availability', () => {
    it('should check Docker availability', async () => {
      const available = await ContainerSandbox.isDockerAvailable();
      // This will depend on whether Docker is running in the test environment
      expect(typeof available).toBe('boolean');
    });
  });

  // Integration tests - only run if Docker is available
  describe.skipIf(!process.env.DOCKER_AVAILABLE)('Execution', () => {
    beforeAll(async () => {
      const available = await ContainerSandbox.isDockerAvailable();
      if (!available) {
        console.warn('Docker not available, skipping integration tests');
      }
    });

    it('should execute simple command', async () => {
      const config: ContainerSandboxConfig = {
        image: 'alpine:latest',
        logger,
        limits: {
          timeout: 10000,
        },
      };

      sandbox = new ContainerSandbox(config);
      await sandbox.prepare();

      const result = await sandbox.execute('echo', ['hello world']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello world');
      expect(result.timedOut).toBe(false);
    });

    it('should handle timeout', async () => {
      const config: ContainerSandboxConfig = {
        image: 'alpine:latest',
        logger,
        limits: {
          timeout: 1000, // 1 second
        },
      };

      sandbox = new ContainerSandbox(config);
      await sandbox.prepare();

      const result = await sandbox.execute('sleep', ['10']);

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(-1);
    });

    it('should enforce network isolation', async () => {
      const config: ContainerSandboxConfig = {
        image: 'alpine:latest',
        logger,
        networkPolicy: {
          blockAll: true,
        },
        limits: {
          timeout: 5000,
        },
      };

      sandbox = new ContainerSandbox(config);
      await sandbox.prepare();

      // Try to ping - should fail with network blocked
      const result = await sandbox.execute('ping', ['-c', '1', 'google.com']);

      expect(result.exitCode).not.toBe(0);
    });

    it('should emit events during execution', async () => {
      const config: ContainerSandboxConfig = {
        image: 'alpine:latest',
        logger,
      };

      sandbox = new ContainerSandbox(config);
      await sandbox.prepare();

      const events: string[] = [];
      sandbox.on('started', () => events.push('started'));
      sandbox.on('completed', () => events.push('completed'));
      sandbox.on('cleaned', () => events.push('cleaned'));

      await sandbox.execute('echo', ['test']);

      expect(events).toContain('started');
      expect(events).toContain('completed');
      expect(events).toContain('cleaned');
    });
  });
});
