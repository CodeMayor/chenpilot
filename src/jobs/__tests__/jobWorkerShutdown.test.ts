import type { QueueJob } from "../job.entity";
import type { JobQueueService } from "../jobQueue.service";

jest.mock("../../config/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../Security/authorization/channelAdapters", () => ({
  JOB_AUTH_METADATA_KEY: "auth",
  authorizeJobOperation: jest.fn(),
}));

import { JobWorker } from "../jobWorker";

const makeJob = (id: string): QueueJob =>
  ({
    id,
    queue: "side-effects",
    jobType: "test.job",
    status: "leased",
    payload: {},
    attempts: 0,
    maxAttempts: 5,
    availableAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as QueueJob;

function fakeQueue(jobs: QueueJob[]) {
  const pending = [...jobs];
  return {
    leaseJobs: jest.fn(async () => (pending.length ? [pending.shift() as QueueJob] : [])),
    getJob: jest.fn(async (id: string) => jobs.find((j) => j.id === id) ?? null),
    renewLease: jest.fn(async () => true),
    completeJob: jest.fn(async () => true),
    failJob: jest.fn(async () => "retried" as const),
    deadLetterJob: jest.fn(async () => true),
    rescheduleJob: jest.fn(async () => true),
    releaseJob: jest.fn(async () => true),
  };
}

const waitFor = async (cond: () => boolean, timeoutMs = 1000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const worker = (queue: ReturnType<typeof fakeQueue>, shutdownDeadlineMs = 1000) =>
  new JobWorker(queue as unknown as JobQueueService, {
    workerId: "w1",
    queues: ["side-effects"],
    concurrency: 1,
    pollIntervalMs: 10,
    leaseMs: 60_000,
    shutdownDeadlineMs,
  });

describe("JobWorker graceful shutdown (#1069)", () => {
  it("drains an in-flight handler that finishes before the deadline", async () => {
    const queue = fakeQueue([makeJob("job-1")]);
    const w = worker(queue);
    let finish!: () => void;
    w.registerHandler({
      jobType: "test.job",
      handle: () => new Promise<void>((r) => (finish = r)),
    });

    w.start();
    await waitFor(() => w.getActiveHandlers().length === 1);
    expect(w.getActiveHandlers()[0]).toMatchObject({ jobId: "job-1", jobType: "test.job" });

    const stopping = w.stop();
    setTimeout(() => finish(), 20);
    const report = await stopping;

    expect(report).toEqual({ drained: true, deadlineMs: 1000, released: [], releaseFailed: [] });
    expect(queue.completeJob).toHaveBeenCalledWith("job-1", "w1", undefined);
    expect(queue.releaseJob).not.toHaveBeenCalled();
    expect(w.getActiveHandlers()).toHaveLength(0);
  });

  it("stops leasing new work as soon as shutdown begins", async () => {
    const queue = fakeQueue([makeJob("job-1"), makeJob("job-2")]);
    const w = worker(queue);
    let finish!: () => void;
    w.registerHandler({ jobType: "test.job", handle: () => new Promise<void>((r) => (finish = r)) });

    w.start();
    await waitFor(() => w.getActiveHandlers().length === 1);
    const stopping = w.stop();
    finish();
    await stopping;

    expect(queue.leaseJobs).toHaveBeenCalledTimes(1);
    expect(queue.completeJob).toHaveBeenCalledTimes(1);
  });

  it("returns still-running jobs to the queue when the deadline expires and ignores their late result", async () => {
    const queue = fakeQueue([makeJob("job-slow")]);
    const w = worker(queue, 30);
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    w.registerHandler({
      jobType: "test.job",
      handle: (_job, s) => {
        signal = s;
        return new Promise<void>((r) => (finish = r));
      },
    });

    w.start();
    await waitFor(() => w.getActiveHandlers().length === 1);
    const report = await w.stop();

    expect(report).toEqual({ drained: false, deadlineMs: 30, released: ["job-slow"], releaseFailed: [] });
    expect(queue.releaseJob).toHaveBeenCalledWith(
      "job-slow",
      "w1",
      expect.stringContaining("shutdown"),
    );
    expect(signal?.aborted).toBe(true);

    // The abandoned handler finishing later must not complete or fail the job.
    finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.completeJob).not.toHaveBeenCalled();
    expect(queue.failJob).not.toHaveBeenCalled();
  });

  it("does not consume a retry attempt for an interrupted handler that throws on abort", async () => {
    const queue = fakeQueue([makeJob("job-abort")]);
    const w = worker(queue, 20);
    w.registerHandler({
      jobType: "test.job",
      handle: (_job, s) =>
        new Promise<void>((_, reject) => s?.addEventListener("abort", () => reject(new Error("aborted")))),
    });

    w.start();
    await waitFor(() => w.getActiveHandlers().length === 1);
    await w.stop();
    await new Promise((r) => setTimeout(r, 10));

    expect(queue.releaseJob).toHaveBeenCalledTimes(1);
    expect(queue.failJob).not.toHaveBeenCalled();
    expect(queue.deadLetterJob).not.toHaveBeenCalled();
  });

  it("reports jobs it could not release (lease already lost)", async () => {
    const queue = fakeQueue([makeJob("job-lost")]);
    queue.releaseJob.mockResolvedValueOnce(false);
    const w = worker(queue, 10);
    w.registerHandler({ jobType: "test.job", handle: () => new Promise<void>(() => undefined) });

    w.start();
    await waitFor(() => w.getActiveHandlers().length === 1);
    const report = await w.stop();

    expect(report.drained).toBe(false);
    expect(report.released).toEqual([]);
    expect(report.releaseFailed).toEqual(["job-lost"]);
  });

  it("is idempotent and a no-op when not running", async () => {
    const queue = fakeQueue([]);
    const w = worker(queue);
    await expect(w.stop()).resolves.toMatchObject({ drained: true, released: [] });

    w.start();
    const [a, b] = await Promise.all([w.stop(), w.stop()]);
    expect(a).toBe(b);
  });

  it("reads the deadline from JOB_SHUTDOWN_DEADLINE_MS when not configured", async () => {
    process.env.JOB_SHUTDOWN_DEADLINE_MS = "1234";
    try {
      const w = new JobWorker(fakeQueue([]) as unknown as JobQueueService, {
        workerId: "w1",
        queues: ["q"],
        pollIntervalMs: 5,
      });
      w.start();
      expect((await w.stop()).deadlineMs).toBe(1234);
    } finally {
      delete process.env.JOB_SHUTDOWN_DEADLINE_MS;
    }
  });
});
