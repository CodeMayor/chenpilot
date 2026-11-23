import type { QueueJob } from "../job.entity";

jest.mock("../../config/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../config/Datasource", () => ({ __esModule: true, default: {} }));
jest.mock("../../Security/abusePrevention/channelGuards", () => ({ evaluateJobAbusePolicy: jest.fn() }));
const authorizeJobOperation = jest.fn();
jest.mock("../../Security/authorization/channelAdapters", () => ({
  JOB_AUTH_METADATA_KEY: "auth",
  authorizeJobOperation: (...args: unknown[]) => authorizeJobOperation(...args),
}));

import { JobQueueService, buildReplayJob } from "../jobQueue.service";
import { JobWorker } from "../jobWorker";

const ORIGINAL_AUTH = { originPrincipalId: "user-1", originRole: "user", originChannel: "http", policyVersion: "v3" };

const deadJob = (overrides: Partial<QueueJob> = {}): QueueJob =>
  ({
    id: "dead-1",
    queue: "transactions",
    jobType: "delayed_transaction.submit",
    status: "dead_letter",
    userId: "user-1",
    correlationId: "corr-1",
    payload: { amount: "10" },
    metadata: {
      auth: ORIGINAL_AUTH,
      retryBudget: { reason: "attempts_exhausted" },
      interruptedAt: "2026-11-23T00:00:00Z",
    },
    attempts: 4,
    maxAttempts: 4,
    failureClass: "retry_budget_exhausted",
    disposition: "pending_review",
    availableAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as QueueJob;

/** In-memory DataSource whose transactions run one at a time (row lock). */
function fakeDataSource(rows: QueueJob[]) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const repo = {
    findOne: async ({ where }: { where: { id: string } }) => {
      const row = table.get(where.id);
      return row ? { ...row } : null;
    },
    create: (data: Partial<QueueJob>) => ({ ...data }) as QueueJob,
    save: async (row: QueueJob) => {
      if (!row.id) row.id = `replay-${++seq}`;
      table.set(row.id, { ...row });
      return row;
    },
  };
  const ds = {
    getRepository: () => repo,
    transaction: <T>(cb: (m: { getRepository: () => typeof repo }) => Promise<T>) => {
      const run = chain.then(() => cb({ getRepository: () => repo }));
      chain = run.catch(() => undefined);
      return run;
    },
  };
  return { ds, table };
}

describe("buildReplayJob (#1068)", () => {
  it("starts a fresh attempt chain with the original owner and auth context", () => {
    const now = new Date("2026-11-23T10:00:00Z");
    const job = buildReplayJob(deadJob(), "admin-9", now);

    expect(job).toMatchObject({
      queue: "transactions",
      jobType: "delayed_transaction.submit",
      payload: { amount: "10" },
      userId: "user-1",
      status: "pending",
      attempts: 0,
      maxAttempts: 4,
      replayOfJobId: "dead-1",
      availableAt: now,
    });
    expect(job.metadata?.auth).toEqual(ORIGINAL_AUTH);
    expect(job.metadata).not.toHaveProperty("retryBudget");
    expect(job.metadata).not.toHaveProperty("interruptedAt");
    expect(job.metadata?.replay).toMatchObject({
      ofJobId: "dead-1",
      requestedBy: "admin-9",
      previousFailureClass: "retry_budget_exhausted",
      previousAttempts: 4,
    });
  });
});

describe("JobQueueService.replayDeadLetterJob (#1068)", () => {
  it("creates exactly one new job even when replayed concurrently", async () => {
    const { ds, table } = fakeDataSource([deadJob()]);
    const svc = new JobQueueService(ds as never, jest.fn());

    const results = await Promise.all([
      svc.replayDeadLetterJob("dead-1", "admin-1"),
      svc.replayDeadLetterJob("dead-1", "admin-2"),
      svc.replayDeadLetterJob("dead-1", "admin-1"),
    ]);

    const created = results.filter((r) => r.status === "replayed");
    expect(created).toHaveLength(1);
    const replayId = (created[0] as { replayJobId: string }).replayJobId;
    expect(results.filter((r) => r.status === "already_replayed")).toEqual([
      { status: "already_replayed", replayJobId: replayId },
      { status: "already_replayed", replayJobId: replayId },
    ]);

    const replays = [...table.values()].filter((r) => r.replayOfJobId === "dead-1");
    expect(replays).toHaveLength(1);
    expect(table.get("dead-1")).toMatchObject({
      status: "dead_letter",
      disposition: "replayed",
      dispositionBy: "admin-1",
      replayedAsJobId: replayId,
    });
  });

  it("refuses to replay a discarded job, a live job, or an unknown id", async () => {
    const { ds } = fakeDataSource([
      deadJob({ id: "discarded", disposition: "discarded" }),
      deadJob({ id: "live", status: "pending", disposition: null }),
    ]);
    const svc = new JobQueueService(ds as never, jest.fn());

    await expect(svc.replayDeadLetterJob("discarded", "a")).resolves.toEqual({ status: "discarded" });
    await expect(svc.replayDeadLetterJob("live", "a")).resolves.toEqual({ status: "not_dead_lettered" });
    await expect(svc.replayDeadLetterJob("missing", "a")).resolves.toEqual({ status: "not_found" });
  });
});

describe("replayed jobs never bypass authorization (#1068)", () => {
  it("re-authorizes as the original user and dead-letters if that user is no longer allowed", async () => {
    authorizeJobOperation.mockResolvedValue({ allowed: false, reason: "role_revoked", decisionId: "d-1" });
    const replayed = {
      ...buildReplayJob(deadJob(), "admin-9"),
      id: "replay-1",
      status: "leased",
    } as QueueJob;
    const handle = jest.fn();
    const queue = {
      leaseJobs: jest.fn().mockResolvedValueOnce([replayed]).mockResolvedValue([]),
      getJob: jest.fn(async () => replayed),
      deadLetterJob: jest.fn(async () => true),
      completeJob: jest.fn(),
      renewLease: jest.fn(),
    };
    const worker = new JobWorker(queue as never, {
      workerId: "w1",
      queues: ["transactions"],
      concurrency: 1,
      pollIntervalMs: 5,
      resolveJobActor: jest.fn(),
    });
    worker.registerHandler({ jobType: "delayed_transaction.submit", operation: "payments.submit", handle });

    worker.start();
    const start = Date.now();
    while (queue.leaseJobs.mock.calls.length < 2 && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await worker.stop();

    expect(authorizeJobOperation).toHaveBeenCalledWith(ORIGINAL_AUTH, "payments.submit", "replay-1", expect.any(Function));
    expect(handle).not.toHaveBeenCalled();
    expect(queue.deadLetterJob).toHaveBeenCalledWith(
      "replay-1",
      "w1",
      expect.stringContaining("Authorization denied"),
      "authorization_denied",
    );
  });
});
