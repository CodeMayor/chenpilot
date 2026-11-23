import logger from "../config/logger";
import { QueueJob } from "./job.entity";
import { JobQueueService, jobQueueService } from "./jobQueue.service";
import { propagateJobContext } from "../observability/jobContext";
import {
  AuthenticatedActor,
  authorizeJobOperation,
  JOB_AUTH_METADATA_KEY,
  StoredJobAuthContext,
} from "../Security/authorization/channelAdapters";

export type JobHandlerResult =
  | { outcome: "completed"; result?: Record<string, unknown> }
  | { outcome: "retry"; delayMs?: number; error?: string }
  | { outcome: "reschedule"; availableAt: Date; metadata?: Record<string, unknown> }
  | { outcome: "dead_letter"; reason: string };

export interface JobHandler {
  jobType: string;
  /**
   * Catalog operation this job performs on a user's behalf. When set, the job
   * is authorized as its originating user under the current policy before
   * the handler runs, exactly as if the user invoked it directly.
   */
  operation?: string;
  /**
   * `signal` aborts when a graceful shutdown deadline expires (#1069); the job
   * has then been handed back to the queue and this handler's result is ignored.
   */
  handle(job: QueueJob, signal?: AbortSignal): Promise<JobHandlerResult | void>;
}

export interface JobWorkerOptions {
  workerId: string;
  queues: string[];
  pollIntervalMs?: number;
  leaseMs?: number;
  concurrency?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /**
   * How long `stop()` waits for in-flight handlers before handing their jobs
   * back to the queue (#1069). Default 25s, or JOB_SHUTDOWN_DEADLINE_MS.
   */
  shutdownDeadlineMs?: number;
  /** Re-reads a job's originating user (role, suspension) at execution time. */
  resolveJobActor?: (userId: string) => Promise<AuthenticatedActor | undefined>;
}

async function resolveActorFromDatabase(userId: string): Promise<AuthenticatedActor | undefined> {
  const [{ default: AppDataSource }, { User }] = await Promise.all([
    import("../config/Datasource"),
    import("../Auth/user.entity"),
  ]);
  const user = await AppDataSource.getRepository(User).findOne({ where: { id: userId }, select: ["id", "role"] });
  return user ? { userId: user.id, role: user.role } : undefined;
}

/**
 * Jobs enqueued without an explicit auth context (e.g. before contexts were
 * captured) are attributed to their owning user arriving over HTTP.
 */
function storedAuthContext(job: QueueJob): unknown {
  const stored = job.metadata?.[JOB_AUTH_METADATA_KEY];
  if (stored || !job.userId) return stored;
  const fallback: StoredJobAuthContext = {
    originPrincipalId: job.userId,
    originRole: "user",
    originChannel: "http",
    policyVersion: "unversioned",
  };
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NonRetryableJobError extends Error {}

export interface ActiveJobHandler {
  jobId: string;
  jobType: string;
  slot: number;
  startedAt: Date;
}

export interface ShutdownReport {
  /** True when every in-flight handler finished before the deadline. */
  drained: boolean;
  deadlineMs: number;
  /** Jobs whose handlers were still running at the deadline and were returned to the queue. */
  released: string[];
  /** Jobs that could not be released (lease already lost); their lease will simply expire. */
  releaseFailed: string[];
}

const DEFAULT_SHUTDOWN_DEADLINE_MS = 25_000;

function resolveShutdownDeadline(explicit?: number): number {
  if (explicit !== undefined) return Math.max(0, explicit);
  const fromEnv = Number(process.env.JOB_SHUTDOWN_DEADLINE_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_SHUTDOWN_DEADLINE_MS;
}

export class JobWorker {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly concurrency: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly shutdownDeadlineMs: number;
  private running = false;
  private loops: Promise<void>[] = [];
  private stopping: Promise<ShutdownReport> | null = null;
  private readonly active = new Map<
    string,
    ActiveJobHandler & { controller: AbortController; abandoned: boolean }
  >();

  constructor(
    private readonly queueService: JobQueueService = jobQueueService,
    private readonly options: JobWorkerOptions,
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.leaseMs = options.leaseMs ?? 30000;
    this.concurrency = options.concurrency ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 5000;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 300000;
    this.shutdownDeadlineMs = resolveShutdownDeadline(options.shutdownDeadlineMs);
  }

  /** Handlers currently executing on this worker. */
  getActiveHandlers(): ActiveJobHandler[] {
    return [...this.active.values()].map(({ jobId, jobType, slot, startedAt }) => ({
      jobId,
      jobType,
      slot,
      startedAt,
    }));
  }

  isRunning(): boolean {
    return this.running;
  }

  registerHandler(handler: JobHandler): void {
    this.handlers.set(handler.jobType, handler);
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.loops = Array.from({ length: this.concurrency }, (_, index) =>
      this.runLoop(index),
    );
    logger.info("Job worker started", {
      workerId: this.options.workerId,
      queues: this.options.queues,
      concurrency: this.concurrency,
      leaseMs: this.leaseMs,
    });
  }

  /**
   * Graceful stop (#1069): stop leasing new jobs immediately, wait up to the
   * deadline for in-flight handlers, then hand any still-running jobs back to
   * the queue (no attempt consumed) and abort their signals. Idempotent.
   */
  async stop(deadlineMs: number = this.shutdownDeadlineMs): Promise<ShutdownReport> {
    if (this.stopping) return this.stopping;
    if (!this.running) {
      return { drained: true, deadlineMs, released: [], releaseFailed: [] };
    }

    this.running = false;
    this.stopping = this.drain(deadlineMs).finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async drain(deadlineMs: number): Promise<ShutdownReport> {
    logger.info("Job worker draining", {
      workerId: this.options.workerId,
      activeHandlers: this.active.size,
      deadlineMs,
    });

    let timer: NodeJS.Timeout | undefined;
    const loopsDone = Promise.all(this.loops).then(() => true);
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), deadlineMs);
    });
    const drained = await Promise.race([loopsDone, deadline]);
    clearTimeout(timer);

    const released: string[] = [];
    const releaseFailed: string[] = [];

    if (!drained) {
      for (const entry of this.active.values()) {
        entry.abandoned = true;
        entry.controller.abort(new Error("worker shutdown deadline exceeded"));
        try {
          const ok = await this.queueService.releaseJob(
            entry.jobId,
            this.options.workerId,
            `Interrupted by worker shutdown after ${deadlineMs}ms`,
          );
          (ok ? released : releaseFailed).push(entry.jobId);
        } catch (error) {
          releaseFailed.push(entry.jobId);
          logger.error("Failed to release job on shutdown", {
            jobId: entry.jobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      logger.warn("Job worker shutdown deadline expired", {
        workerId: this.options.workerId,
        deadlineMs,
        released,
        releaseFailed,
      });
    }

    this.loops = [];
    logger.info("Job worker stopped", { workerId: this.options.workerId, drained });
    return { drained, deadlineMs, released, releaseFailed };
  }

  private async runLoop(slot: number): Promise<void> {
    while (this.running) {
      try {
        const [job] = await this.queueService.leaseJobs(
          this.options.queues,
          this.options.workerId,
          this.leaseMs,
          1,
        );

        if (!job) {
          await sleep(this.pollIntervalMs);
          continue;
        }

        await this.processJob(job, slot);
      } catch (error) {
        logger.error("Job worker loop failed", {
          workerId: this.options.workerId,
          slot,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(this.pollIntervalMs);
      }
    }
  }

  private async processJob(job: QueueJob, slot: number): Promise<void> {
    const handler = this.handlers.get(job.jobType);
    if (!handler) {
      await this.queueService.deadLetterJob(
        job.id,
        this.options.workerId,
        `No handler registered for ${job.jobType}`,
      );
      logger.error("Job dead-lettered without handler", {
        jobId: job.id,
        jobType: job.jobType,
      });
      return;
    }

    logger.info("Job leased", {
      jobId: job.id,
      jobType: job.jobType,
      queue: job.queue,
      slot,
      attempt: job.attempts + 1,
    });

    // ---------------------------------------------------------------------------
    // Safe-point check: re-read the job status from the database before starting
    // the handler.  This prevents invoking an irreversible side effect on a job
    // that was cancelled after it was leased but before the handler ran.
    //
    // The check window is intentionally narrow (between lease acquisition and
    // handler invocation) so that jobs already mid-handler are not interrupted —
    // handlers must manage their own internal cancellation if needed.
    // ---------------------------------------------------------------------------
    const freshJob = await this.queueService.getJob(job.id);
    if (!freshJob || freshJob.status === "cancelled") {
      logger.info("Job cancelled before handler invocation — skipping", {
        jobId: job.id,
        jobType: job.jobType,
        status: freshJob?.status ?? "not_found",
      });
      return;
    }

    if (handler.operation) {
      const decision = await authorizeJobOperation(
        storedAuthContext(job),
        handler.operation,
        job.id,
        this.options.resolveJobActor ?? resolveActorFromDatabase,
      );
      if (!decision.allowed) {
        await this.queueService.deadLetterJob(
          job.id,
          this.options.workerId,
          `Authorization denied: ${decision.reason} (decision ${decision.decisionId})`,
        );
        logger.warn("Job dead-lettered by authorization policy", {
          jobId: job.id,
          jobType: job.jobType,
          operation: handler.operation,
          reason: decision.reason,
          decisionId: decision.decisionId,
        });
        return;
      }
    }

    const controller = new AbortController();
    const tracked = {
      jobId: job.id,
      jobType: job.jobType,
      slot,
      startedAt: new Date(),
      controller,
      abandoned: false,
    };
    this.active.set(job.id, tracked);

    const keepAlive = setInterval(() => {
      void this.queueService
        .renewLease(job.id, this.options.workerId, this.leaseMs)
        .then((renewed) => {
          if (!renewed) {
            logger.warn("Job lease renewal failed", {
              jobId: job.id,
              workerId: this.options.workerId,
            });
          }
        })
        .catch((error) => {
          logger.error("Job lease renewal error", {
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, Math.max(1000, Math.floor(this.leaseMs / 2)));

    try {
      const result = await propagateJobContext(
        job,
        async () => (await handler.handle(job, controller.signal)) ?? { outcome: "completed" as const },
      );

      if (tracked.abandoned) {
        // Shutdown already handed this job back to the queue.
        logger.warn("Ignoring result of job released during shutdown", { jobId: job.id });
        return;
      }

      switch (result.outcome) {
        case "completed":
          await this.queueService.completeJob(job.id, this.options.workerId, result.result);
          logger.info("Job completed", { jobId: job.id, jobType: job.jobType });
          return;
        case "reschedule":
          await this.queueService.rescheduleJob(
            job.id,
            this.options.workerId,
            result.availableAt,
            result.metadata,
          );
          logger.info("Job rescheduled", {
            jobId: job.id,
            jobType: job.jobType,
            availableAt: result.availableAt,
          });
          return;
        case "retry": {
          const retryDelayMs = result.delayMs ?? this.computeRetryDelay(job.attempts);
          const retryAt = new Date(Date.now() + retryDelayMs);
          const retryResult = await this.queueService.failJob(
            job,
            this.options.workerId,
            result.error ?? "Handler requested retry",
            retryAt,
          );
          logger.warn("Job retry scheduled", {
            jobId: job.id,
            jobType: job.jobType,
            retryAt,
            retryResult,
          });
          return;
        }
        case "dead_letter":
          await this.queueService.deadLetterJob(
            job.id,
            this.options.workerId,
            result.reason,
          );
          logger.error("Job moved to dead letter", {
            jobId: job.id,
            jobType: job.jobType,
            reason: result.reason,
          });
          return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (tracked.abandoned) {
        logger.warn("Ignoring failure of job released during shutdown", { jobId: job.id, error: message });
        return;
      }

      if (error instanceof NonRetryableJobError) {
        await this.queueService.deadLetterJob(job.id, this.options.workerId, message);
        logger.error("Job failed permanently", {
          jobId: job.id,
          jobType: job.jobType,
          error: message,
        });
        return;
      }

      const retryAt = new Date(Date.now() + this.computeRetryDelay(job.attempts));
      const retryResult = await this.queueService.failJob(
        job,
        this.options.workerId,
        message,
        retryAt,
      );
      logger.warn("Job handler threw error", {
        jobId: job.id,
        jobType: job.jobType,
        retryResult,
        error: message,
      });
    } finally {
      clearInterval(keepAlive);
      this.active.delete(job.id);
    }
  }

  private computeRetryDelay(attempts: number): number {
    const exponential = this.retryBaseDelayMs * 2 ** attempts;
    return Math.min(exponential, this.retryMaxDelayMs);
  }
}
