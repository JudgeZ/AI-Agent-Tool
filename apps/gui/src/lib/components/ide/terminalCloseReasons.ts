type TerminalHaltReason = { message: string; status: 'error' | 'disconnected' };

const SESSION_ENDED_REASON = 'terminal session ended';
const TERMINAL_UNAVAILABLE_REASON = 'terminal unavailable';

export function resolveTerminalHaltMessage(code: number, reason?: string): TerminalHaltReason | null {
  const normalizedReason = reason?.trim().toLowerCase();

  if (normalizedReason === SESSION_ENDED_REASON) {
    return { status: 'disconnected', message: 'Terminal session ended. Click reconnect to start a new shell.' };
  }

  if (code === 1011 && normalizedReason === TERMINAL_UNAVAILABLE_REASON) {
    return {
      status: 'error',
      message: 'Terminal is currently unavailable. Please try again later or contact support.',
    };
  }

  if (code === 1008) {
    return {
      status: 'error',
      message: 'Terminal closed due to invalid input. Please refresh your workspace to restart.',
    };
  }

  if (code === 1009) {
    return {
      status: 'error',
      message: 'Terminal closed after sending a message that was too large. Please refresh to try again.',
    };
  }

  return null;
}
