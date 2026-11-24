import {
  InMemoryTaskLeaseStore,
  PostgresTaskLeaseStore,
  runLeasedOccurrence,
  type TaskLease,
} from "../scheduledTaskLease";

jest.mock("../../config/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TASK = "retention.daily";
const DAY = "2026-11-23";
const TTL = 60_000;

describe("scheduled task leases (#1067)", () => {
  let clock: number;
  let store: InMemoryTaskLeaseStore;

  beforeEach(() => {
    clock = 1_000_000;
    store = new InMemoryTaskLeaseStore(() => clock);
  });

  it("lets exactly one of several competing workers run an occurrence", async () => {
    const runs: string[] = [];
    const workers = ["w1", "w2", "w3", "w4", "w5"];

    const outcomes = await Promise.all(
      workers.map((owner) =>
        runLeasedOccurrence(store, { taskKey: TASK, occurrenceKey: DAY, owner, ttlMs: TTL }, async () => {
          runs.push(owner);
        })
      )
    );

    expect(runs).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "completed")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "skipped")).toHaveLength(4);
  });

  it("never re-runs a completed occurrence, even after the lease would have expired", async () => {
    const fn = jest.fn(async () => undefined);
    await runLeasedOccurrence(store, { taskKey: TASK, occurrenceKey: DAY, owner: "w1", ttlMs: TTL }, fn);

    clock += TTL * 10;
    const again = await runLeasedOccurrence(store, { taskKey: TASK, occurrenceKey: DAY, owner: "w2", ttlMs: TTL }, fn);

    expect(again.status).toBe("skipped");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps the lease exclusive until it expires, then lets another worker take over with a higher fencing token", async () => {
    const first = (await store.tryAcquire(TASK, DAY, "w1", TTL)) as TaskLease;
    expect(first.fencingToken).toBe(1);

    clock += TTL - 1;
    expect(await store.tryAcquire(TASK, DAY, "w2", TTL)).toBeNull();

    clock += 1; // exactly at expiry
    const second = (await store.tryAcquire(TASK, DAY, "w2", TTL)) as TaskLease;
    expect(second.owner).toBe("w2");
    expect(second.fencingToken).toBe(2);
  });

  it("rejects completion from a stale worker whose lease was taken over", async () => {
    let resumeStale!: () => void;
    const staleRun = runLeasedOccurrence(
      store,
      { taskKey: TASK, occurrenceKey: DAY, owner: "stale", ttlMs: TTL },
      () => new Promise<string>((resolve) => (resumeStale = () => resolve("stale-result")))
    );
    // Let the stale worker acquire its lease and start running.
    await new Promise((r) => setImmediate(r));

    // The stale worker stalls past its expiry; a healthy worker takes over.
    clock += TTL + 1;
    const fresh = await runLeasedOccurrence(
      store,
      { taskKey: TASK, occurrenceKey: DAY, owner: "fresh", ttlMs: TTL },
      async () => "fresh-result"
    );
    expect(fresh).toMatchObject({ status: "completed", result: "fresh-result" });
    expect(fresh.status === "completed" && fresh.lease.fencingToken).toBe(2);

    resumeStale();
    const stale = await staleRun;
    expect(stale.status).toBe("stale");
    expect(stale.status === "stale" && stale.lease.fencingToken).toBe(1);
  });

  it("rejects completion with the right owner but an old fencing token", async () => {
    const first = (await store.tryAcquire(TASK, DAY, "w1", TTL)) as TaskLease;
    clock += TTL;
    const retaken = (await store.tryAcquire(TASK, DAY, "w1", TTL)) as TaskLease;

    expect(await store.complete(first)).toBe(false);
    expect(await store.complete(retaken)).toBe(true);
    expect(await store.complete(retaken)).toBe(false); // already completed
  });

  it("renews only a live lease held by the same owner and token", async () => {
    const lease = (await store.tryAcquire(TASK, DAY, "w1", TTL)) as TaskLease;
    clock += TTL / 2;
    const renewed = await store.renew(lease, TTL);
    expect(renewed?.expiresAt.getTime()).toBe(clock + TTL);

    clock += TTL;
    expect(await store.renew(lease, TTL)).toBeNull();
  });

  it("leaves the lease to expire when the task throws, so a retry can take over", async () => {
    await expect(
      runLeasedOccurrence(store, { taskKey: TASK, occurrenceKey: DAY, owner: "w1", ttlMs: TTL }, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(await store.tryAcquire(TASK, DAY, "w2", TTL)).toBeNull();
    clock += TTL;
    expect((await store.tryAcquire(TASK, DAY, "w2", TTL))?.fencingToken).toBe(2);
  });

  it("treats different occurrences of the same task independently", async () => {
    expect(await store.tryAcquire(TASK, "2026-11-23", "w1", TTL)).not.toBeNull();
    expect(await store.tryAcquire(TASK, "2026-11-24", "w2", TTL)).not.toBeNull();
  });
});

describe("PostgresTaskLeaseStore (#1067)", () => {
  const lease: TaskLease = {
    taskKey: TASK,
    occurrenceKey: DAY,
    owner: "w1",
    fencingToken: 3,
    expiresAt: new Date(),
  };

  it("claims atomically with an upsert that only takes over expired, uncompleted leases", async () => {
    const query = jest.fn().mockResolvedValue([{ fencing_token: "1", expires_at: "2026-11-23T00:01:00Z" }]);
    const pg = new PostgresTaskLeaseStore({ query } as never);

    const got = await pg.tryAcquire(TASK, DAY, "w1", TTL);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/ON CONFLICT \("task_key", "occurrence_key"\) DO UPDATE/);
    expect(sql).toMatch(/"fencing_token" = "scheduled_task_lease"."fencing_token" \+ 1/);
    expect(sql).toMatch(/"completed_at" IS NULL/);
    expect(sql).toMatch(/"expires_at" <= now\(\)/);
    expect(query.mock.calls[0][1]).toEqual([TASK, DAY, "w1", TTL]);
    expect(got).toMatchObject({ owner: "w1", fencingToken: 1 });
  });

  it("returns null when the conflicting lease is still live (no row returned)", async () => {
    const pg = new PostgresTaskLeaseStore({ query: jest.fn().mockResolvedValue([]) } as never);
    expect(await pg.tryAcquire(TASK, DAY, "w2", TTL)).toBeNull();
  });

  it("completes only with matching owner and fencing token, handling UPDATE's [rows, count] shape", async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([[{ fencing_token: "3", expires_at: "x" }], 1])
      .mockResolvedValueOnce([[], 0]);
    const pg = new PostgresTaskLeaseStore({ query } as never);

    expect(await pg.complete(lease)).toBe(true);
    expect(await pg.complete({ ...lease, fencingToken: 2 })).toBe(false);

    expect(query.mock.calls[0][0]).toMatch(/"owner" = \$3 AND "fencing_token" = \$4/);
    expect(query.mock.calls[1][1]).toEqual([TASK, DAY, "w1", 2]);
  });
});
