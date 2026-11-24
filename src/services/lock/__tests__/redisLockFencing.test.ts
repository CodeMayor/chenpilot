/**
 * #1070: an owner whose lock expired must not commit after a newer holder
 * acquired the resource. Uses a small in-memory Redis that interprets the
 * service's Lua scripts with the same semantics (atomic, PX expiry).
 */
let now = 0;

class FakeRedis {
  private data = new Map<string, { value: string; expiresAt?: number }>();

  private live(key: string) {
    const e = this.data.get(key);
    if (e && e.expiresAt !== undefined && e.expiresAt <= now) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async eval(script: string, numKeys: number, ...rest: Array<string | number>): Promise<number> {
    const keys = rest.slice(0, numKeys).map(String);
    const argv = rest.slice(numKeys).map(String);

    if (script.includes("'INCR'")) {
      // acquire: SET NX PX + INCR fence
      if (this.live(keys[0])) return 0;
      this.data.set(keys[0], { value: argv[0], expiresAt: now + Number(argv[1]) });
      const next = Number(this.live(keys[1])?.value ?? "0") + 1;
      this.data.set(keys[1], { value: String(next) });
      return next;
    }
    if (script.includes("'SET', KEYS[2]")) {
      // fencedSet
      const current = Number(this.live(keys[0])?.value ?? "0");
      if (Number(argv[0]) !== current) return 0;
      this.data.set(keys[1], { value: argv[1] });
      return 1;
    }
    if (script.includes("return 1") && numKeys === 1 && !script.includes("'DEL'") && !script.includes("'EXPIRE'")) {
      // validate fence
      return Number(argv[0]) === Number(this.live(keys[0])?.value ?? "0") ? 1 : 0;
    }
    if (script.includes("'DEL'")) {
      const e = this.live(keys[0]);
      if (e && e.value.startsWith(`${argv[0]}:`)) {
        this.data.delete(keys[0]);
        return 1;
      }
      return 0;
    }
    throw new Error("unexpected script");
  }

  async del(key: string) {
    return this.data.delete(key) ? 1 : 0;
  }
}

const redis = new FakeRedis();

jest.mock("../../redis/client", () => ({ getRedisClient: () => redis }));
jest.mock("../../../config/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { RedisLockService, StaleFencingTokenError } from "../redisLock.service";

const once = { maxRetries: 1, retryDelay: 0 };

describe("Redis lock fencing tokens (#1070)", () => {
  const svc = new RedisLockService();
  let resource = "";
  let n = 0;

  beforeEach(() => {
    now = 1_000_000;
    resource = `trade:user-${++n}`;
  });

  it("issues monotonically increasing tokens across lock lifetimes", async () => {
    const a = await svc.acquireLock(resource, "owner-a", { ttl: 1000, ...once });
    await svc.releaseLock(resource, "owner-a");
    const b = await svc.acquireLock(resource, "owner-b", { ttl: 1000, ...once });
    now += 2000; // expiry instead of release
    const c = await svc.acquireLock(resource, "owner-c", { ttl: 1000, ...once });

    expect([a.fencingToken, b.fencingToken, c.fencingToken]).toEqual([1, 2, 3]);
  });

  it("rejects the expired owner's write after a newer holder acquired the resource", async () => {
    const stale = await svc.acquireLock(resource, "slow-owner", { ttl: 1000, ...once });
    now += 1500; // slow owner is still working; its lock expired
    const fresh = await svc.acquireLock(resource, "new-owner", { ttl: 1000, ...once });
    expect(fresh.fencingToken).toBeGreaterThan(stale.fencingToken as number);

    await expect(
      svc.fencedSet(resource, stale.fencingToken as number, "balance:user", "stale-write")
    ).rejects.toBeInstanceOf(StaleFencingTokenError);
    expect(await redis.get("balance:user")).toBeNull();

    await svc.fencedSet(resource, fresh.fencingToken as number, "balance:user", "fresh-write");
    expect(await redis.get("balance:user")).toBe("fresh-write");

    // The stale owner's late attempt still fails after the newer write.
    await expect(
      svc.fencedSet(resource, stale.fencingToken as number, "balance:user", "stale-write")
    ).rejects.toThrow(/Stale fencing token 1/);
    expect(await redis.get("balance:user")).toBe("fresh-write");
  });

  it("never runs a fenced side effect for a stale token", async () => {
    const stale = await svc.acquireLock(resource, "slow-owner", { ttl: 1000, ...once });
    now += 1001;
    await svc.acquireLock(resource, "new-owner", { ttl: 1000, ...once });

    const write = jest.fn(async () => "submitted");
    await expect(svc.runFenced(resource, stale.fencingToken as number, write)).rejects.toMatchObject({
      name: "StaleFencingTokenError",
      fencingToken: 1,
      currentToken: 2,
    });
    expect(write).not.toHaveBeenCalled();
  });

  it("allows the current holder's write and passes the token through", async () => {
    const held = await svc.acquireLock(resource, "owner", { ttl: 1000, ...once });
    const write = jest.fn(async (token: number) => token);

    await expect(svc.runFenced(resource, held.fencingToken as number, write)).resolves.toBe(1);
  });

  it("boundary: an expired owner may still write while no newer holder exists", async () => {
    const held = await svc.acquireLock(resource, "owner", { ttl: 1000, ...once });
    now += 5000;

    await expect(svc.isFencingTokenCurrent(resource, held.fencingToken as number)).resolves.toBe(true);
  });

  it("a failed acquisition does not advance the token", async () => {
    await svc.acquireLock(resource, "owner-a", { ttl: 1000, ...once });
    const blocked = await svc.acquireLock(resource, "owner-b", { ttl: 1000, ...once });

    expect(blocked.acquired).toBe(false);
    expect(blocked.fencingToken).toBeUndefined();
    expect(await svc.getCurrentFencingToken(resource)).toBe(1);
  });
});
