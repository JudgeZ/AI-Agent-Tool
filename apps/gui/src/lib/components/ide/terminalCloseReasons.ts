type TerminalHaltReason = { message: string; status: 'error' | 'disconnected' };

const SESSION_ENDED_REASON = 'terminal session ended';

/**
 * Determine a user-facing halt reason from a terminal close code and optional close reason.
 *
 * @param code - The numeric WebSocket/close status code reported by the terminal connection
 * @param reason - Optional close reason string provided by the remote; compared case-insensitively after trimming
 * @returns A `TerminalHaltReason` containing a `status` and `message` for known cases (session ended, invalid input, message too large), or `null` if the code/reason are not recognized
 */
export function resolveTerminalHaltMessage(code: number, reason?: string): TerminalHaltReason | null {
  const normalizedReason = reason?.trim().toLowerCase();

  if (normalizedReason === SESSION_ENDED_REASON) {
    return { status: 'disconnected', message: 'Terminal session ended. Click reconnect to start a new shell.' };
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