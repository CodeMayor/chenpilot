/**
 * Retry budgets per job class (#1066).
 *
 * A budget caps both the total number of attempts and the total elapsed time
 * since the job was first enqueued. Once either is spent the job is not
 * retried again: it is moved to the dead-letter state with the exhausted
 * budget recorded in `metadata.retryBudget` so operators can act on it.
 */
import type { QueueJob } from "./job.entity";

export interface RetryBudget {
  /** Total attempts including the first one. */
  maxAttempts: number;
  /** Max time from enqueue (`createdAt`) during which retries may still be scheduled. */
  maxElapsedMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const DEFAULT_RETRY_BUDGET: RetryBudget = {
  maxAttempts: 5,
  maxElapsedMs: 1 * HOUR,
  baseDelayMs: 5_000,
  maxDelayMs: 5 * MINUTE,
};

/** Per job class budgets. Unlisted job types use DEFAULT_RETRY_BUDGET. */
export const JOB_RETRY_BUDGETS: Readonly<Record<string, RetryBudget>> = {
  // User-visible payment submission: fail fast so the user can act.
  "delayed_transaction.submit": { maxAttempts: 4, maxElapsedMs: 15 * MINUTE, baseDelayMs: 5_000, maxDelayMs: 2 * MINUTE },
  // Contract deployment after funding: network hiccups are common, allow longer.
  "funding.auto_deploy": { maxAttempts: 8, maxElapsedMs: 6 * HOUR, baseDelayMs: 15_000, maxDelayMs: 30 * MINUTE },
  // Housekeeping: rescheduled anyway, so keep the budget small.
  "workflow.expire_cleanup": { maxAttempts: 3, maxElapsedMs: 30 * MINUTE, baseDelayMs: 10_000, maxDelayMs: 5 * MINUTE },
  "progress.monitor": { maxAttempts: 5, maxElapsedMs: 2 * HOUR, baseDelayMs: 10_000, maxDelayMs: 10 * MINUTE },
};

export function getRetryBudget(jobType: string): RetryBudget {
  return JOB_RETRY_BUDGETS[jobType] ?? DEFAULT_RETRY_BUDGET;
}

export type RetryBudgetExhaustion = "attempts_exhausted" | "elapsed_exhausted";

export type RetryDecision =
  | { retry: true; retryAt: Date; attempt: number }
  | {
      retry: false;
      reason: RetryBudgetExhaustion;
      attempts: number;
      elapsedMs: number;
      budget: RetryBudget;
    };

/** Exponential backoff for the given number of attempts already made. */
export function backoffDelay(budget: RetryBudget, attemptsMade: number): number {
  return Math.min(budget.baseDelayMs * 2 ** Math.max(0, attemptsMade), budget.maxDelayMs);
}

/**
 * Decide whether a failed attempt may be retried.
 * @param job        the job as leased (attempts = attempts before this one)
 * @param delayMs    requested delay; defaults to the budget's backoff
 */
export function decideRetry(
  job: Pick<QueueJob, "attempts" | "createdAt" | "maxAttempts">,
  budget: RetryBudget,
  now: Date = new Date(),
  delayMs?: number
): RetryDecision {
  const attempts = job.attempts + 1; // including the attempt that just failed
  const elapsedMs = now.getTime() - new Date(job.createdAt).getTime();
  const maxAttempts = Math.min(budget.maxAttempts, job.maxAttempts ?? budget.maxAttempts);

  if (attempts >= maxAttempts) {
    return { retry: false, reason: "attempts_exhausted", attempts, elapsedMs, budget };
  }

  const delay = delayMs ?? backoffDelay(budget, job.attempts);
  // A retry that would start after the elapsed budget is not scheduled.
  if (elapsedMs + delay > budget.maxElapsedMs) {
    return { retry: false, reason: "elapsed_exhausted", attempts, elapsedMs, budget };
  }

  return { retry: true, retryAt: new Date(now.getTime() + delay), attempt: attempts + 1 };
}
