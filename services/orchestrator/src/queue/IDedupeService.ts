/**
 * Interface for distributed deduplication/idempotency services.
 *
 * Used by queue adapters to prevent duplicate message processing
 * across multiple orchestrator instances.
 */
export interface IDedupeService {
  /**
   * Attempt to claim an idempotency key.
   *
   * Returns true if the key was successfully claimed (not already in-flight).
   * Returns false if the key is already claimed by another consumer.
   *
   * The claim automatically expires after the specified TTL to prevent
   * deadlocks if a consumer crashes without releasing the key.
   *
   * @param key - The idempotency key to claim
   * @param ttlMs - Time-to-live in milliseconds for the claim
   * @returns true if successfully claimed, false if already claimed
   */
  claim(key: string, ttlMs: number): Promise<boolean>;

  /**
   * Release an idempotency key after processing is complete.
   *
   * This should be called when message processing finishes (successfully or not)
   * to allow the same message to be retried if needed.
   *
   * @param key - The idempotency key to release
   */
  release(key: string): Promise<void>;

  /**
   * Check if a key is currently claimed.
   *
   * Note: Due to distributed nature, this check may be subject to race conditions.
   * Prefer using claim() for atomic claim-or-fail semantics.
   *
   * @param key - The idempotency key to check
   * @returns true if the key is currently claimed, false otherwise
   */
  isClaimed(key: string): Promise<boolean>;

  /**
   * Close the service and release any resources.
   */
  close?(): Promise<void>;
}
