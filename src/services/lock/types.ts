export interface LockOptions {
  ttl?: number;
  retryDelay?: number;
  maxRetries?: number;
}

export interface LockResult {
  acquired: boolean;
  lockKey: string;
  lockValue?: string;
  ttl?: number;
  acquiredAt?: number;
  /**
   * Monotonically increasing per resource (#1070). Pass it with every write
   * the lock protects; writes carrying an older token than the latest issued
   * one are rejected.
   */
  fencingToken?: number;
  error?: string;
}

export interface LockInfo {
  key: string;
  value: string;
  ownerId: string;
  ttl: number;
  createdAt: number;
}

export interface LockService {
  acquireLock(
    resourceKey: string,
    identifier: string,
    options?: LockOptions
  ): Promise<LockResult>;

  releaseLock(resourceKey: string, identifier: string): Promise<boolean>;

  forceReleaseLock(resourceKey: string): Promise<boolean>;

  extendLock(
    resourceKey: string,
    identifier: string,
    ttl: number
  ): Promise<boolean>;

  isLocked(resourceKey: string): Promise<boolean>;

  getLockInfo(resourceKey: string): Promise<LockInfo | null>;
}
