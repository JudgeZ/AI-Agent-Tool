export function toError(maybeError: unknown): Error {
  if (maybeError instanceof Error) {
    return maybeError;
  }
  
  if (typeof maybeError === 'object' && maybeError !== null && 'message' in maybeError) {
      return new Error(String((maybeError as { message: unknown }).message));
  }

  return new Error(String(maybeError));
}

