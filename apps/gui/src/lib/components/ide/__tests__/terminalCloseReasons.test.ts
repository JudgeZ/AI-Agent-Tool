import { describe, expect, it } from 'vitest';

import { resolveTerminalHaltMessage } from '../terminalCloseReasons';

describe('resolveTerminalHaltMessage', () => {
  it('halts when the server reports a policy violation', () => {
    expect(resolveTerminalHaltMessage(1008)).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/invalid input/i),
    });
  });

  it('halts when the client sends a payload that is too large', () => {
    expect(resolveTerminalHaltMessage(1009)).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/too large/i),
    });
  });

  it('halts cleanly when the server closes the session after the pty exits', () => {
    expect(resolveTerminalHaltMessage(1011, 'terminal session ended')).toMatchObject({
      status: 'disconnected',
      message: expect.stringMatching(/terminal session ended/i),
    });
  });

  it('halts when the terminal is unavailable', () => {
    expect(resolveTerminalHaltMessage(1011, 'terminal unavailable')).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/unavailable/i),
    });
  });

  it('does not halt on normal closures', () => {
    expect(resolveTerminalHaltMessage(1000)).toBeNull();
  });
});
