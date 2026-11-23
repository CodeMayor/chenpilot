import type { QueueJob } from "../job.entity";
import type { JobQueueService } from "../jobQueue.service";
import {
  DEFAULT_RETRY_BUDGET,
  JOB_RETRY_BUDGETS,
  backoffDelay,
  decideRetry,
  getRetryBudget,
  type RetryBudget,
} from "../retryBudget";

jest.mock("../../config/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../Security/authorization/channelAdapters", () => ({
  JOB_AUTH_METADATA_KEY: "auth",
  authorizeJobOperation: jest.fn(),
}));

import { JobWorker, NonRetryableJobError } from "../jobWorker";

const budget: RetryBudget = { maxAttempts: 3, maxElapsedMs: 60_000, baseDelayMs: 1_000, maxDelayMs: 10_000 };
const NOW = new Date("2026-11-23T12:00:00Z");
const enqueuedAgo = (ms: number) => new Date(NOW.getTime() - ms);

describe("decideRetry (#1066)", () => {
  it("schedules a transient retry with exponential backoff inside the budget", () => {
    const d = decideRetry({ attempts: 1, createdAt: enqueuedAgo(5_000), maxAttempts: 10 }, budget, NOW);
    expect(d).toEqual({ retry: true, retryAt: new Date(NOW.getTime() + 2_000), attempt: 3 });
  });

  it("stops at the attempt budget (boundary: last allowed attempt failed)", () => {
    const d = decideRetry({ attempts: 2, createdAt: enqueuedAgo(1_000), maxAttempts: 10 }, budget, NOW);
    expect(d).toMatchObject({ retry: false, reason: "attempts_exhausted", attempts: 3 });
  });

  it("respects a stricter per-job maxAttempts", () => {
    const d = decideRetry({ attempts: 0, createdAt: enqueuedAgo(0), maxAttempts: 1 }, budget, NOW);
    expect(d).toMatchObject({ retry: false, reason: "attempts_exhausted" });
  });

  it("does not schedule a retry that would start after the elapsed budget", () => {
    const d = decideRetry({ attempts: 0, createdAt: enqueuedAgo(59_500), maxAttempts: 10 }, budget, NOW);
    expect(d).toMatchObject({ retry: false, reason: "elapsed_exhausted", elapsedMs: 59_500 });
  });

  it("applies a handler-requested delay against the elapsed budget", () => {
    const job = { attempts: 0, createdAt: enqueuedAgo(10_000), maxAttempts: 10 };
    expect(decideRetry(job, budget, NOW, 50_000).retry).toBe(true);
    expect(decideRetry(job, budget, NOW, 50_001).retry).toBe(false);
  });

  it("caps backoff at maxDelayMs", () => {
    expect(backoffDelay(budget, 10)).toBe(10_000);
  });

  it("defines budgets per job class and falls back to the default", () => {
    expect(getRetryBudget("funding.auto_deploy")).toBe(JOB_RETRY_BUDGETS["funding.auto_deploy"]);
    expect(getRetryBudget("unknown.job")).toBe(DEFAULT_RETRY_BUDGET);
    for (const b of Object.values(JOB_RETRY_BUDGETS)) {
      expect(b.maxAttempts).toBeGreaterThan(0);
      expect(b.maxElapsedMs).toBeGreaterThan(0);
    }
  });
});

// ─── Worker integration ──────────────────────────────────────────────────────

const makeJob = (overrides: Partial<QueueJob> = {}): QueueJob =>
  ({
    id: "job-1",
    queue: "side-effects",
    jobType: "unknown.job",
    status: "leased",
    payload: {},
    attempts: 0,
    maxAttempts: 5,
    availableAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as QueueJob;

function runOnce(job: QueueJob, handle: () => Promise<unknown>, statusOnRecheck = "leased") {
  const queue = {
    leaseJobs: jest.fn().mockResolvedValueOnce([job]).mockResolvedValue([]),
    getJob: jest
      .fn()
      .mockResolvedValueOnce({ ...job, status: "leased" }) // safe-point check before handler
      .mockResolvedValue({ ...job, status: statusOnRecheck }),
    renewLease: jest.fn(async () => true),
    completeJob: jest.fn(async () => true),
    failJob: jest.fn(async () => "retried"),
    deadLetterJob: jest.fn(async () => true),
    exhaustRetryBudget: jest.fn(async () => true),
    rescheduleJob: jest.fn(async () => true),
    releaseJob: jest.fn(async () => true),
  };
  const worker = new JobWorker(queue as unknown as JobQueueService, {
    workerId: "w1",
    queues: ["side-effects"],
    concurrency: 1,
    pollIntervalMs: 5,
  });
  worker.registerHandler({ jobType: job.jobType, handle: handle as never });
  return { queue, worker };
}

async function settle(worker: JobWorker, queue: { leaseJobs: jest.Mock }) {
  worker.start();
  const start = Date.now();
  while (queue.leaseJobs.mock.calls.length < 2 && Date.now() - start < 1000) {
    await new Promise((r) => setTimeout(r, 5));
  }
  await worker.stop();
}

describe("JobWorker retry budgets (#1066)", () => {
  it("retries a transient failure within budget", async () => {
    const { queue, worker } = runOnce(makeJob(), async () => {
      throw new Error("ECONNRESET");
    });
    await settle(worker, queue);

    expect(queue.failJob).toHaveBeenCalledWith(expect.objectContaining({ id: "job-1" }), "w1", "ECONNRESET", expect.any(Date));
    expect(queue.exhaustRetryBudget).not.toHaveBeenCalled();
  });

  it("dead-letters a permanent failure without retrying", async () => {
    const { queue, worker } = runOnce(makeJob(), async () => {
      throw new NonRetryableJobError("invalid destination");
    });
    await settle(worker, queue);

    expect(queue.deadLetterJob).toHaveBeenCalledWith("job-1", "w1", "invalid destination");
    expect(queue.failJob).not.toHaveBeenCalled();
  });

  it("does not retry a job cancelled while its handler ran", async () => {
    const { queue, worker } = runOnce(
      makeJob(),
      async () => {
        throw new Error("timeout");
      },
      "cancelled",
    );
    await settle(worker, queue);

    expect(queue.failJob).not.toHaveBeenCalled();
    expect(queue.exhaustRetryBudget).not.toHaveBeenCalled();
  });

  it("never retries after the attempt budget is spent and records why", async () => {
    const job = makeJob({ attempts: DEFAULT_RETRY_BUDGET.maxAttempts - 1, maxAttempts: 99 });
    const { queue, worker } = runOnce(job, async () => ({ outcome: "retry", error: "still failing" }));
    await settle(worker, queue);

    expect(queue.failJob).not.toHaveBeenCalled();
    expect(queue.exhaustRetryBudget).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1" }),
      "w1",
      "still failing",
      expect.objectContaining({
        reason: "attempts_exhausted",
        attempts: DEFAULT_RETRY_BUDGET.maxAttempts,
        maxAttempts: DEFAULT_RETRY_BUDGET.maxAttempts,
      }),
    );
  });

  it("never retries after the elapsed budget is spent", async () => {
    const job = makeJob({ createdAt: new Date(Date.now() - DEFAULT_RETRY_BUDGET.maxElapsedMs) });
    const { queue, worker } = runOnce(job, async () => {
      throw new Error("503");
    });
    await settle(worker, queue);

    expect(queue.failJob).not.toHaveBeenCalled();
    expect(queue.exhaustRetryBudget).toHaveBeenCalledWith(
      expect.anything(),
      "w1",
      "503",
      expect.objectContaining({ reason: "elapsed_exhausted" }),
    );
  });
});
