import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger';

describe('logger', () => {
  const originalConsole = globalThis.console;

  let debugSpy: ReturnType<typeof vi.fn>;
  let infoSpy: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    debugSpy = vi.fn();
    infoSpy = vi.fn();
    warnSpy = vi.fn();
    errorSpy = vi.fn();
    logSpy = vi.fn();

    globalThis.console = {
      debug: debugSpy as unknown as typeof console.debug,
      info: infoSpy as unknown as typeof console.info,
      warn: warnSpy as unknown as typeof console.warn,
      error: errorSpy as unknown as typeof console.error,
      log: logSpy as unknown as typeof console.log
    } as Console;
  });

  afterEach(() => {
    globalThis.console = originalConsole;
    vi.restoreAllMocks();
  });

  it('emits structured log lines with the provided name', () => {
    const logger = createLogger({ name: 'ui-test', clock: () => '2024-05-01T10:00:00.000Z' });

    logger.info('hello world');

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(infoSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({
      level: 'info',
      msg: 'hello world',
      name: 'ui-test',
      time: '2024-05-01T10:00:00.000Z'
    });
  });

  it('normalizes error contexts for easier inspection', () => {
    const logger = createLogger({ name: 'ui-test', clock: () => '2024-05-01T10:00:00.000Z' });
    const error = new Error('boom');
    error.name = 'ExplodeError';

    logger.error('failed to submit', error);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(errorSpy.mock.calls[0][0]);
    expect(payload.level).toBe('error');
    expect(payload.msg).toBe('failed to submit');
    expect(payload.context).toMatchObject({
      message: 'boom',
      name: 'ExplodeError'
    });
    expect(payload.context.stack).toContain('Error: boom');
  });

  it('filters undefined values from object contexts and falls back to console.log when needed', () => {
    // Remove the warn implementation to force the fallback path.
    // @ts-expect-error intentional deletion to exercise fallback logic
    delete globalThis.console.warn;

    const logger = createLogger({ name: 'ui-test', clock: () => '2024-05-01T10:00:00.000Z' });

    logger.warn('context check', { keep: 'value', drop: undefined });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(logSpy.mock.calls[0][0]);
    expect(payload.level).toBe('warn');
    expect(payload.context).toEqual({ keep: 'value' });
  });
});
