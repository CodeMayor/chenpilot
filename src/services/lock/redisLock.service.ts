import { randomUUID } from "crypto";
import { getRedisClient } from "../redis/client";
import logger from "../../config/logger";
import { LockOptions, LockResult, LockInfo, LockService } from "./types";

/** Thrown when a protected write carries a fencing token older than the latest issued (#1070). */
export class StaleFencingTokenError extends Error {
  constructor(
    public readonly resourceKey: string,
    public readonly fencingToken: number,
    public readonly currentToken: number | null
  ) {
    super(
      `Stale fencing token ${fencingToken} for ${resourceKey} (current ${currentToken ?? "none"}); ` +
        "the lock expired and a newer holder acquired it"
    );
    this.name = "StaleFencingTokenError";
  }
}

interface InstrumentationCounters {
  acquireSuccess: number;
  acquireFailure: number;
  releaseSuccess: number;
  releaseFailure: number;
  extendSuccess: number;
  extendFailure: number;
  forceRelease: number;
}

export class RedisLockService implements LockService {
  private readonly DEFAULT_TTL = 30000;
  private readonly DEFAULT_RETRY_DELAY = 100;
  private readonly DEFAULT_MAX_RETRIES = 10;

  private counters: InstrumentationCounters = {
    acquireSuccess: 0,
    acquireFailure: 0,
    releaseSuccess: 0,
    releaseFailure: 0,
    extendSuccess: 0,
    extendFailure: 0,
    forceRelease: 0,
  };

  private getLockKey(resourceKey: string): string {
    return `lock:${resourceKey}`;
  }

  private generateLockValue(identifier: string): string {
    return `${identifier}:${randomUUID()}:${Date.now()}`;
  }

  private extractOwnerId(lockValue: string): string {
    const colonIndex = lockValue.indexOf(":");
    return colonIndex === -1 ? lockValue : lockValue.substring(0, colonIndex);
  }

  /** Never expires, so tokens keep increasing across lock lifetimes. */
  private getFenceKey(resourceKey: string): string {
    return `lock:fence:${resourceKey}`;
  }

  /** SET NX PX and, only on success, issue the next fencing token atomically. */
  private acquireLuaScript(): string {
    return `
      if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then
        return redis.call('INCR', KEYS[2])
      end
      return 0
    `;
  }

  /** Returns 1 if ARGV[1] is the latest issued token, else 0. */
  private validateFenceLuaScript(): string {
    return `
      local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      if tonumber(ARGV[1]) == current then
        return 1
      end
      return 0
    `;
  }

  /**
   * Fenced write to a Redis key: applies SET only if ARGV[1] is the latest
   * token, atomically with the check. Returns 1 if written, 0 if stale.
   */
  private fencedSetLuaScript(): string {
    return `
      local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      if tonumber(ARGV[1]) ~= current then
        return 0
      end
      redis.call('SET', KEYS[2], ARGV[2])
      return 1
    `;
  }

  private releaseLuaScript(): string {
    return `
      local key = KEYS[1]
      local identifier = ARGV[1]
      local lockValue = redis.call('GET', key)
      if not lockValue then
        return 0
      end
      local prefix = identifier .. ':'
      if string.sub(lockValue, 1, #prefix) == prefix then
        return redis.call('DEL', key)
      else
        return 0
      end
    `;
  }

  private extendLuaScript(): string {
    return `
      local key = KEYS[1]
      local identifier = ARGV[1]
      local ttl = ARGV[2]
      local lockValue = redis.call('GET', key)
      if not lockValue then
        return 0
      end
      local prefix = identifier .. ':'
      if string.sub(lockValue, 1, #prefix) == prefix then
        return redis.call('EXPIRE', key, ttl)
      else
        return 0
      end
    `;
  }

  async acquireLock(
    resourceKey: string,
    identifier: string,
    options: LockOptions = {}
  ): Promise<LockResult> {
    const {
      ttl = this.DEFAULT_TTL,
      retryDelay = this.DEFAULT_RETRY_DELAY,
      maxRetries = this.DEFAULT_MAX_RETRIES,
    } = options;

    const lockKey = this.getLockKey(resourceKey);
    const lockValue = this.generateLockValue(identifier);
    const startTime = Date.now();

    logger.debug("Attempting to acquire lock", {
      resourceKey,
      identifier,
      ttl,
      maxRetries,
    });

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const redis = getRedisClient();
        const token = Number(
          await redis.eval(
            this.acquireLuaScript(),
            2,
            lockKey,
            this.getFenceKey(resourceKey),
            lockValue,
            ttl
          )
        );

        if (token > 0) {
          const acquiredAt = Date.now();
          this.counters.acquireSuccess++;

          logger.info("Lock acquired successfully", {
            resourceKey,
            identifier,
            fencingToken: token,
            attempt,
            ttl,
            acquireMs: acquiredAt - startTime,
          });

          return {
            acquired: true,
            lockKey,
            lockValue,
            ttl,
            acquiredAt,
            fencingToken: token,
          };
        }

        logger.debug("Lock acquisition failed, retrying", {
          resourceKey,
          identifier,
          attempt,
          maxRetries,
        });

        if (attempt < maxRetries) {
          await this.delay(retryDelay);
        }
      } catch (error) {
        logger.error("Error during lock acquisition", {
          resourceKey,
          identifier,
          attempt,
          error: error instanceof Error ? error.message : "Unknown error",
        });

        if (attempt === maxRetries) {
          this.counters.acquireFailure++;
          return {
            acquired: false,
            lockKey,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }

        await this.delay(retryDelay);
      }
    }

    this.counters.acquireFailure++;

    logger.warn("Failed to acquire lock after max retries", {
      resourceKey,
      identifier,
      maxRetries,
    });

    return {
      acquired: false,
      lockKey,
      error: "Maximum retry attempts exceeded",
    };
  }

  async releaseLock(resourceKey: string, identifier: string): Promise<boolean> {
    const lockKey = this.getLockKey(resourceKey);

    try {
      const redis = getRedisClient();
      const result = await redis.eval(
        this.releaseLuaScript(),
        1,
        lockKey,
        identifier
      );

      const released = result === 1;

      if (released) {
        this.counters.releaseSuccess++;
        logger.info("Lock released successfully", {
          resourceKey,
          identifier,
        });
      } else {
        this.counters.releaseFailure++;
        logger.warn("Lock release failed", {
          resourceKey,
          identifier,
          reason: "Lock not found or not owned by identifier",
        });
      }

      return released;
    } catch (error) {
      this.counters.releaseFailure++;
      logger.error("Error during lock release", {
        resourceKey,
        identifier,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  async forceReleaseLock(resourceKey: string): Promise<boolean> {
    const lockKey = this.getLockKey(resourceKey);

    try {
      const redis = getRedisClient();
      const result = await redis.del(lockKey);

      if (result === 1) {
        this.counters.forceRelease++;
        logger.info("Lock force-released", { resourceKey });
        return true;
      }

      logger.warn("Force release: lock not found", { resourceKey });
      return false;
    } catch (error) {
      logger.error("Error during force lock release", {
        resourceKey,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  async extendLock(
    resourceKey: string,
    identifier: string,
    ttl: number
  ): Promise<boolean> {
    const lockKey = this.getLockKey(resourceKey);
    const ttlSeconds = Math.ceil(ttl / 1000);

    try {
      const redis = getRedisClient();
      const result = await redis.eval(
        this.extendLuaScript(),
        1,
        lockKey,
        identifier,
        ttlSeconds
      );

      const extended = result === 1;

      if (extended) {
        this.counters.extendSuccess++;
        logger.info("Lock extended successfully", {
          resourceKey,
          identifier,
          ttl,
        });
      } else {
        this.counters.extendFailure++;
        logger.warn("Lock extension failed", {
          resourceKey,
          identifier,
          ttl,
          reason: "Lock not found or not owned by identifier",
        });
      }

      return extended;
    } catch (error) {
      this.counters.extendFailure++;
      logger.error("Error during lock extension", {
        resourceKey,
        identifier,
        ttl,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  async isLocked(resourceKey: string): Promise<boolean> {
    const lockKey = this.getLockKey(resourceKey);

    try {
      const redis = getRedisClient();
      const result = await redis.exists(lockKey);
      return result === 1;
    } catch (error) {
      logger.error("Error checking lock status", {
        resourceKey,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  async getLockInfo(resourceKey: string): Promise<LockInfo | null> {
    const lockKey = this.getLockKey(resourceKey);

    try {
      const redis = getRedisClient();
      const pipeline = redis.pipeline();
      pipeline.get(lockKey);
      pipeline.ttl(lockKey);
      const results = await pipeline.exec();

      if (!results) {
        return null;
      }

      const valueResult = results[0];
      const ttlResult = results[1];

      if (!valueResult || !valueResult[1]) {
        return null;
      }

      const lockValue = valueResult[1] as string;
      const lockTtl = ttlResult[1] as number;

      const parts = lockValue.split(":");
      const ownerId = this.extractOwnerId(lockValue);
      const timestamp = parseInt(parts[parts.length - 1], 10);

      return {
        key: resourceKey,
        value: lockValue,
        ownerId,
        ttl: lockTtl > 0 ? lockTtl * 1000 : 0,
        createdAt: timestamp || Date.now(),
      };
    } catch (error) {
      logger.error("Error getting lock info", {
        resourceKey,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return null;
    }
  }

  async cleanupStaleLocks(
    pattern: string = "lock:*"
  ): Promise<number> {
    let cleaned = 0;

    try {
      const redis = getRedisClient();
      let cursor = "0";

      do {
        const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = result[0];
        const keys = result[1];

        for (const key of keys) {
          const ttl = await redis.ttl(key);
          if (ttl === -1) {
            await redis.del(key);
            cleaned++;
            logger.warn("Cleaned up stale lock (no TTL)", { key });
          }
        }
      } while (cursor !== "0");

      if (cleaned > 0) {
        logger.info("Stale lock cleanup completed", { cleaned });
      }

      return cleaned;
    } catch (error) {
      logger.error("Error during stale lock cleanup", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return cleaned;
    }
  }

  getCounters(): InstrumentationCounters {
    return { ...this.counters };
  }

  resetCounters(): void {
    this.counters = {
      acquireSuccess: 0,
      acquireFailure: 0,
      releaseSuccess: 0,
      releaseFailure: 0,
      extendSuccess: 0,
      extendFailure: 0,
      forceRelease: 0,
    };
  }

  // ─── Fencing (#1070) ────────────────────────────────────────────────────────

  /** True if `fencingToken` is still the latest token issued for the resource. */
  async isFencingTokenCurrent(resourceKey: string, fencingToken: number): Promise<boolean> {
    const redis = getRedisClient();
    const result = await redis.eval(
      this.validateFenceLuaScript(),
      1,
      this.getFenceKey(resourceKey),
      fencingToken
    );
    return Number(result) === 1;
  }

  /** Latest token issued for the resource, or null if it was never locked. */
  async getCurrentFencingToken(resourceKey: string): Promise<number | null> {
    const value = await getRedisClient().get(this.getFenceKey(resourceKey));
    return value === null ? null : Number(value);
  }

  /** Throw StaleFencingTokenError unless `fencingToken` is the latest issued. */
  async assertFencingToken(resourceKey: string, fencingToken: number): Promise<void> {
    if (!(await this.isFencingTokenCurrent(resourceKey, fencingToken))) {
      const current = await this.getCurrentFencingToken(resourceKey);
      logger.warn("Rejected write with stale fencing token", {
        resourceKey,
        fencingToken,
        currentToken: current,
      });
      throw new StaleFencingTokenError(resourceKey, fencingToken, current);
    }
  }

  /**
   * Run a protected write only if the caller still holds the latest token.
   * The token is passed to `write` so downstream stores can persist/compare it.
   * For non-Redis side effects this check narrows but cannot close the race;
   * prefer storing the token with the write (see fencedSet) where possible.
   */
  async runFenced<T>(
    resourceKey: string,
    fencingToken: number,
    write: (fencingToken: number) => Promise<T>
  ): Promise<T> {
    await this.assertFencingToken(resourceKey, fencingToken);
    return write(fencingToken);
  }

  /** Atomic fenced write of a Redis value: stale tokens never commit. */
  async fencedSet(
    resourceKey: string,
    fencingToken: number,
    dataKey: string,
    value: string
  ): Promise<void> {
    const redis = getRedisClient();
    const written = await redis.eval(
      this.fencedSetLuaScript(),
      2,
      this.getFenceKey(resourceKey),
      dataKey,
      fencingToken,
      value
    );
    if (Number(written) !== 1) {
      throw new StaleFencingTokenError(
        resourceKey,
        fencingToken,
        await this.getCurrentFencingToken(resourceKey)
      );
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
