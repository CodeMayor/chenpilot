import { DataSource, EntityManager, LessThan, Repository } from "typeorm";
import AppDataSource from "../config/Datasource";
import logger from "../config/logger";
import { QueueJob, type DeadLetterDisposition, type FailureClass } from "./job.entity";
import { getExecutionContext } from "../observability/context";
import { evaluateJobAbusePolicy } from "../Security/abusePrevention/channelGuards";
import { AbuseEvaluationResult } from "../Security/abusePrevention/types";
import { getRetryBudget, type RetryBudgetExhaustion } from "./retryBudget";

/** Thrown when a user schedules background work faster than the abuse policy allows. */
export class JobThrottledError extends Error {
  constructor(
    public readonly jobType: string,
    public readonly decision: AbuseEvaluationResult
  ) {
    super(`Job ${jobType} rejected by abuse policy: ${decision.reason ?? decision.decision}`);
    this.name = "JobThrottledError";
  }
}

export type JobAbuseGuard = (jobType: string, userId: string) => Promise<AbuseEvaluationResult>;

const defaultJobAbuseGuard: JobAbuseGuard = (jobType, userId) =>
  evaluateJobAbusePolicy(jobType, { userId });

export interface EnqueueJobInput {
  queue: string;
  jobType: string;
  payload: Record<string, unknown>;
  userId?: string;
  correlationId?: string;
  availableAt?: Date;
  maxAttempts?: number;
  metadata?: Record<string, unknown>;
}

export interface QueueStatsRow {
  queue: string;
  jobType: string;
  status: string;
  count: number;
}

export type ReplayResult =
  | { status: "replayed"; replayJobId: string; job: QueueJob }
  | { status: "already_replayed"; replayJobId: string }
  | { status: "not_found" | "not_dead_lettered" | "discarded" };

/** Metadata keys that describe a previous attempt chain and must not carry over. */
const ATTEMPT_CHAIN_METADATA = ["retryBudget", "interruptedAt", "interruptedBy", "interruptReason", "replay"];

/**
 * New job for replaying `dead`: same queue, type, payload, owner and stored
 * auth context; fresh attempt count; previous attempt-chain markers removed.
 */
export function buildReplayJob(dead: QueueJob, operatorId: string, now: Date = new Date()): Partial<QueueJob> {
  const metadata: Record<string, unknown> = { ...(dead.metadata ?? {}) };
  for (const key of ATTEMPT_CHAIN_METADATA) delete metadata[key];
  metadata.replay = {
    ofJobId: dead.id,
    requestedBy: operatorId,
    requestedAt: now.toISOString(),
    previousFailureClass: dead.failureClass ?? null,
    previousAttempts: dead.attempts,
  };

  return {
    queue: dead.queue,
    jobType: dead.jobType,
    payload: dead.payload,
    userId: dead.userId ?? null,
    correlationId: dead.correlationId ?? null,
    metadata,
    status: "pending",
    attempts: 0,
    maxAttempts: dead.maxAttempts,
    availableAt: now,
    replayOfJobId: dead.id,
  };
}

export class JobQueueService {
  constructor(
    private readonly dataSource: DataSource = AppDataSource,
    private readonly abuseGuard: JobAbuseGuard = defaultJobAbuseGuard
  ) {}

  private get repository(): Repository<QueueJob> {
    return this.dataSource.getRepository(QueueJob);
  }

  /**
   * Enqueue a job. Pass `manager` to insert the job inside the caller's
   * transaction so it commits (or rolls back) with the caller's state change.
   */
  async enqueue(input: EnqueueJobInput, manager?: EntityManager): Promise<QueueJob> {
    // User-initiated work is throttled before it reaches the queue; system
    // jobs (no userId) are not subject to per-user limits.
    if (input.userId) {
      const decision = await this.abuseGuard(input.jobType, input.userId);
      if (!decision.allowed) {
        logger.warn("Queue job rejected by abuse policy", {
          jobType: input.jobType,
          userId: input.userId,
          policyId: decision.policyId,
        });
        throw new JobThrottledError(input.jobType, decision);
      }
    }

    const repository = manager ? manager.getRepository(QueueJob) : this.repository;
    const job = repository.create({
      queue: input.queue,
      jobType: input.jobType,
      payload: input.payload,
      userId: input.userId,
      correlationId: input.correlationId,
      metadata: input.metadata,
      availableAt: input.availableAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? getRetryBudget(input.jobType).maxAttempts,
      status: "pending",
    });

    const saved = await repository.save(job);
    logger.info("Queue job enqueued", {
      jobId: saved.id,
      queue: saved.queue,
      jobType: saved.jobType,
      userId: saved.userId,
      availableAt: saved.availableAt,
    });
    return saved;
  }

  async enqueueWithContext<T extends Record<string, unknown>>(
    input: EnqueueJobInput,
    manager?: EntityManager
  ): Promise<QueueJob> {
    const context = getExecutionContext();
    return this.enqueue({
      ...input,
      correlationId: input.correlationId ?? context?.correlationId,
      metadata: {
        ...input.metadata,
        ...(context
          ? {
              requestId: context.requestId,
              executionId: context.executionId,
              rootExecutionId: context.rootExecutionId,
              parentExecutionId: context.parentExecutionId,
            }
          : {}),
      },
    }, manager);
  }

  async leaseJobs(
    queues: string[],
    workerId: string,
    leaseMs: number,
    limit = 1,
  ): Promise<QueueJob[]> {
    if (queues.length === 0 || limit <= 0) {
      return [];
    }

    const jobs = await this.dataSource.query(
      `
        WITH candidate_jobs AS (
          SELECT id
          FROM job_queue
          WHERE queue = ANY($1)
            AND "availableAt" <= NOW()
            AND (
              status = 'pending'
              OR (status = 'leased' AND "leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" < NOW())
            )
          ORDER BY "availableAt" ASC, "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE job_queue AS jobs
        SET status = 'leased',
            "leasedBy" = $3,
            "leaseExpiresAt" = NOW() + ($4 * INTERVAL '1 millisecond'),
            "updatedAt" = NOW()
        FROM candidate_jobs
        WHERE jobs.id = candidate_jobs.id
        RETURNING jobs.*
      `,
      [queues, limit, workerId, leaseMs],
    );

    return jobs.map((job: Record<string, unknown>) =>
      this.repository.create(job),
    );
  }

  async renewLease(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(QueueJob)
      .set({
        leaseExpiresAt: () => `NOW() + (${leaseMs} * INTERVAL '1 millisecond')`,
        updatedAt: () => "NOW()",
      })
      .where("id = :jobId", { jobId })
      .andWhere("status = 'leased'")
      .andWhere("leasedBy = :workerId", { workerId })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  async completeJob(
    jobId: string,
    workerId: string,
    result?: Record<string, unknown>,
  ): Promise<boolean> {
    const updateResult = await this.repository
      .createQueryBuilder()
      .update(QueueJob)
      .set({
        status: "completed",
        result: result ?? null,
        completedAt: () => "NOW()",
        leaseExpiresAt: null,
        leasedBy: null,
        lastError: null,
      })
      .where("id = :jobId", { jobId })
      .andWhere("status = 'leased'")
      .andWhere("leasedBy = :workerId", { workerId })
      .execute();

    return (updateResult.affected ?? 0) > 0;
  }

  async rescheduleJob(
    jobId: string,
    workerId: string,
    availableAt: Date,
    metadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job || job.status !== "leased" || job.leasedBy !== workerId) {
      return false;
    }

    job.status = "pending";
    job.availableAt = availableAt;
    job.leaseExpiresAt = null;
    job.leasedBy = null;
    if (metadata) {
      job.metadata = metadata;
    }
    await this.repository.save(job);
    return true;
  }

  /**
   * Hand a leased job back to the queue without spending an attempt (#1069).
   * Used when a graceful shutdown deadline expires while the handler is still
   * running: the work stays pending and another worker picks it up. Guarded by
   * `leasedBy`, so the abandoned handler can no longer complete or fail it.
   */
  async releaseJob(jobId: string, workerId: string, reason: string): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job || job.status !== "leased" || job.leasedBy !== workerId) {
      return false;
    }

    const result = await this.repository
      .createQueryBuilder()
      .update(QueueJob)
      .set({
        status: "pending",
        availableAt: () => "NOW()",
        leaseExpiresAt: null,
        leasedBy: null,
        lastError: reason,
        metadata: {
          ...(job.metadata ?? {}),
          interruptedAt: new Date().toISOString(),
          interruptedBy: workerId,
          interruptReason: reason,
        },
      })
      .where("id = :jobId", { jobId })
      .andWhere("status = 'leased'")
      .andWhere("leasedBy = :workerId", { workerId })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  async failJob(
    job: QueueJob,
    workerId: string,
    errorMessage: string,
    retryAt: Date,
  ): Promise<"retried" | "dead_letter" | "lost_lease"> {
    const nextAttempts = job.attempts + 1;
    const shouldDeadLetter = nextAttempts >= job.maxAttempts;

    const updatePayload = shouldDeadLetter
      ? {
          status: "dead_letter" as const,
          attempts: nextAttempts,
          lastError: errorMessage,
          leaseExpiresAt: null,
          leasedBy: null,
          deadLetteredAt: () => "NOW()",
          failureClass: "attempts_exhausted" as const,
          disposition: "pending_review" as const,
        }
      : {
          status: "pending" as const,
          attempts: nextAttempts,
          lastError: errorMessage,
          availableAt: retryAt,
          leaseExpiresAt: null,
          leasedBy: null,
        };

    const result = await this.repository
      .createQueryBuilder()
      .update(QueueJob)
      .set(updatePayload)
      .where("id = :jobId", { jobId: job.id })
      .andWhere("status = 'leased'")
      .andWhere("leasedBy = :workerId", { workerId })
      .execute();

    if ((result.affected ?? 0) === 0) {
      return "lost_lease";
    }

    return shouldDeadLetter ? "dead_letter" : "retried";
  }

  /**
   * Dead-letter a job whose retry budget is spent (#1066), recording the
   * budget in `metadata.retryBudget` so operators can see why it stopped.
   */
  async exhaustRetryBudget(
    job: QueueJob,
    workerId: string,
    errorMessage: string,
    details: {
      reason: RetryBudgetExhaustion;
      attempts: number;
      elapsedMs: number;
      maxAttempts: number;
      maxElapsedMs: number;
    },
  ): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(QueueJob)
      .set({
        status: "dead_letter",
        attempts: details.attempts,
        lastError: errorMessage,
        leaseExpiresAt: null,
        leasedBy: null,
        deadLetteredAt: () => "NOW()",
        failureClass: "retry_budget_exhausted",
        disposition: "pending_review",
        metadata: {
          ...(job.metadata ?? {}),
          retryBudget: { ...details, exhaustedAt: new Date().toISOString() },
        },
      })
      .where("id = :jobId", { jobId: job.id })
      .andWhere("status = 'leased'")
      .andWhere("leasedBy = :workerId", { workerId })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  async deadLetterJob(
    jobId: string,
    workerId: string,
    errorMessage: string,
    failureClass: FailureClass = "handler_dead_letter",
  ): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(QueueJob)
      .set({
        status: "dead_letter",
        // The leased attempt that ended here counts toward the attempt total.
        attempts: () => '"attempts" + 1',
        lastError: errorMessage,
        leaseExpiresAt: null,
        leasedBy: null,
        deadLetteredAt: () => "NOW()",
        failureClass,
        disposition: "pending_review",
      })
      .where("id = :jobId", { jobId })
      .andWhere("status = 'leased'")
      .andWhere("leasedBy = :workerId", { workerId })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  async cancelJob(jobId: string, userId?: string): Promise<boolean> {
    const query = this.repository
      .createQueryBuilder()
      .update(QueueJob)
      .set({
        status: "cancelled",
        leaseExpiresAt: null,
        leasedBy: null,
      })
      .where("id = :jobId", { jobId })
      .andWhere("status IN ('pending', 'leased')");

    if (userId) {
      query.andWhere("userId = :userId", { userId });
    }

    const result = await query.execute();
    return (result.affected ?? 0) > 0;
  }

  async getJob(jobId: string): Promise<QueueJob | null> {
    return this.repository.findOne({ where: { id: jobId } });
  }

  async saveJob(job: QueueJob): Promise<QueueJob> {
    return this.repository.save(job);
  }

  async getJobsForUser(userId: string, jobType: string): Promise<QueueJob[]> {
    return this.repository.find({
      where: { userId, jobType },
      order: { createdAt: "DESC" },
    });
  }

  async getQueueStats(): Promise<QueueStatsRow[]> {
    const rows = await this.dataSource.query(
      `
        SELECT queue, "jobType", status, COUNT(*)::int AS count
        FROM job_queue
        GROUP BY queue, "jobType", status
        ORDER BY queue, "jobType", status
      `,
    );

    return rows as QueueStatsRow[];
  }

  async getDeadLetterJobs(
    limit = 50,
    disposition?: DeadLetterDisposition,
  ): Promise<QueueJob[]> {
    return this.repository.find({
      where: disposition ? { status: "dead_letter", disposition } : { status: "dead_letter" },
      order: { deadLetteredAt: "DESC" },
      take: limit,
    });
  }

  /**
   * Replay a dead-lettered job (#1068) as a fresh attempt chain.
   *
   * - Runs in one transaction with the dead job row locked, so concurrent
   *   replays produce exactly one new job; later calls return the existing one
   *   (also enforced by a unique index on `replayOfJobId`).
   * - The new job keeps the original user and stored auth context; the worker
   *   re-authorizes it under current policy before the handler runs. The
   *   operator's identity is recorded but never used for authorization.
   */
  async replayDeadLetterJob(jobId: string, operatorId: string): Promise<ReplayResult> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(QueueJob);
      const dead = await repo.findOne({ where: { id: jobId }, lock: { mode: "pessimistic_write" } });

      if (!dead) return { status: "not_found" };
      if (dead.status !== "dead_letter") return { status: "not_dead_lettered" };
      if (dead.disposition === "replayed" && dead.replayedAsJobId) {
        return { status: "already_replayed", replayJobId: dead.replayedAsJobId };
      }
      if (dead.disposition === "discarded") return { status: "discarded" };

      const replay = await repo.save(repo.create(buildReplayJob(dead, operatorId)));

      dead.disposition = "replayed";
      dead.dispositionBy = operatorId;
      dead.dispositionAt = new Date();
      dead.replayedAsJobId = replay.id;
      await repo.save(dead);

      logger.info("Dead-letter job replayed", {
        jobId: dead.id,
        replayJobId: replay.id,
        jobType: dead.jobType,
        operatorId,
      });
      return { status: "replayed", replayJobId: replay.id, job: replay };
    });
  }

  /** Close a dead-lettered job without replaying it (#1068). */
  async discardDeadLetterJob(jobId: string, operatorId: string, note?: string): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(QueueJob)
      .set({
        disposition: "discarded",
        dispositionBy: operatorId,
        dispositionAt: () => "NOW()",
        dispositionNote: note ?? null,
      })
      .where("id = :jobId", { jobId })
      .andWhere("status = 'dead_letter'")
      .andWhere("(disposition IS NULL OR disposition = 'pending_review')")
      .execute();

    return (result.affected ?? 0) > 0;
  }

  async reapCancelledOrCompletedOlderThan(cutoff: Date): Promise<number> {
    const completedResult = await this.repository.delete({
      status: "completed",
      completedAt: LessThan(cutoff),
    });
    const cancelledResult = await this.repository.delete({
      status: "cancelled",
      updatedAt: LessThan(cutoff),
    });
    const deadLetterResult = await this.repository.delete({
      status: "dead_letter",
      deadLetteredAt: LessThan(cutoff),
    });

    return (
      (completedResult.affected ?? 0) +
      (cancelledResult.affected ?? 0) +
      (deadLetterResult.affected ?? 0)
    );
  }
}

export const jobQueueService = new JobQueueService();
