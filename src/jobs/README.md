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
