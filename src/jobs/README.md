# Background Jobs

Jobs live in the `job_queue` table and are processed by `JobWorker`
(`src/jobs/jobWorker.ts`), which leases them with `FOR UPDATE SKIP LOCKED`.

## Graceful shutdown (#1069)

On `SIGTERM` / `SIGINT` the API process:

1. Stops accepting new work: closes the HTTP server, stops streamers and the
   retention scheduler, and the job worker stops leasing new jobs immediately.
2. Drains in-flight job handlers for up to the **shutdown deadline**
   (`JobWorkerOptions.shutdownDeadlineMs`, else `JOB_SHUTDOWN_DEADLINE_MS`,
   default `25000` ms).
3. Closes the database and exits.

| Outcome | What happens to the job |
|---|---|
| Handler finishes before the deadline | Normal completion / retry / dead-letter |
| Handler still running at the deadline | Returned to `pending` immediately **without consuming an attempt**; `metadata.interruptedAt`, `interruptedBy`, `interruptReason` are recorded; the handler's `AbortSignal` fires and any later result is ignored |
| Lease already lost when releasing | Reported in `releaseFailed`; the lease expires and another worker picks the job up |

`JobWorker.getActiveHandlers()` lists handlers currently executing, and
`stop()` returns a `ShutdownReport` (`drained`, `released`, `releaseFailed`).

Handlers performing long work should honour the `signal` argument of
`handle(job, signal)` and stop early when it aborts.

## Retry budgets (#1066)

Each job class has a retry budget in `src/jobs/retryBudget.ts`
(`JOB_RETRY_BUDGETS`, default `DEFAULT_RETRY_BUDGET`):

| Job type | Max attempts | Max elapsed since enqueue | Backoff base → cap |
|---|---|---|---|
| `delayed_transaction.submit` | 4 | 15 min | 5s → 2 min |
| `funding.auto_deploy` | 8 | 6 h | 15s → 30 min |
| `workflow.expire_cleanup` | 3 | 30 min | 10s → 5 min |
| `progress.monitor` | 5 | 2 h | 10s → 10 min |
| any other | 5 | 1 h | 5s → 5 min |

When a handler throws or returns `{ outcome: "retry" }`:

- **Transient failure within budget:** rescheduled with exponential backoff (or the handler's `delayMs`).
- **Permanent failure** (`NonRetryableJobError` or `{ outcome: "dead_letter" }`): dead-lettered immediately, no retry.
- **Cancelled while running:** not retried.
- **Budget exhausted:** the attempt count is reached, or the next retry would start after the elapsed budget. The job is never retried again. It moves to `dead_letter` with `metadata.retryBudget = { reason: "attempts_exhausted" | "elapsed_exhausted", attempts, elapsedMs, maxAttempts, maxElapsedMs, exhaustedAt }`.

Exhausted jobs are listed for operators by `GET /admin/jobs/dead-letter`.
New jobs default `maxAttempts` to their class budget; a lower per-job
`maxAttempts` still wins.

## Dead-letter workflow (#1068)

A job that cannot complete ends in `status = 'dead_letter'` with:

| Field | Meaning |
|---|---|
| `failureClass` | `attempts_exhausted`, `retry_budget_exhausted`, `non_retryable`, `authorization_denied`, `no_handler`, `handler_dead_letter` |
| `attempts` | Attempts consumed, including the one that dead-lettered it |
| `lastError` | Last error message |
| `disposition` | `pending_review` → `replayed` or `discarded` |
| `dispositionBy` / `dispositionAt` / `dispositionNote` | Operator who acted, when, and an optional note |
| `replayedAsJobId` / `replayOfJobId` | Links between a dead job and its replay |

Migration `1790200000000-AddDeadLetterWorkflow` adds these columns. It marks
existing dead-lettered jobs `pending_review`.

### Operator API (admin only)

- `GET /admin/jobs/dead-letter?disposition=pending_review&limit=25`: list.
- `POST /admin/jobs/dead-letter/:jobId/replay`: `201 { replayJobId }` creates a
  new job. Repeating the call returns `200 { status: "already_replayed",
  replayJobId }` and creates no new job. Returns `409` for discarded or
  not-dead-lettered jobs and `404` for unknown ids.
- `POST /admin/jobs/dead-letter/:jobId/discard` with body `{ "note": "..." }`:
  closes the job without replay. Returns `409` unless it is pending review.

### Replay guarantees

- **Exactly one new attempt chain:** the dead row is locked in the replay
  transaction, and a unique index on `replayOfJobId` backs this up. The new job
  starts at `attempts = 0`, and earlier retry-budget and interruption markers
  are dropped.
- **No authorization bypass:** the replay keeps the original `userId` and
  stored auth context. The worker re-authorizes it as that user under the
  current policy before the handler runs. If the user is no longer allowed, it
  is dead-lettered again with `failureClass = authorization_denied`. The
  operator is recorded in `metadata.replay.requestedBy` only.
