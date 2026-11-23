# Scheduled Task Leases (#1067)

Every service instance runs the same timers, so each scheduled-task
**occurrence** (a task key plus an occurrence key such as the UTC date) is
claimed through a durable lease before it runs.

| Field | Meaning |
|---|---|
| `task_key`, `occurrence_key` | Primary key; one row per occurrence (`retention.daily` / `2026-11-23`) |
| `owner` | Worker id (`hostname:pid:random`) |
| `expires_at` | Lease expiry, computed with the **database** clock |
| `fencing_token` | Starts at 1, incremented on every takeover of an expired lease |
| `completed_at` | Set once; a completed occurrence is never claimed again |

Table: `scheduled_task_lease` (migration `1790100000000-CreateScheduledTaskLease`).
Code: `src/Reliability/scheduledTaskLease.ts`.

## Rules

- **Claim** is a single `INSERT … ON CONFLICT DO UPDATE … WHERE completed_at IS NULL AND expires_at <= now()`. Competing workers race on the primary key; exactly one gets a row back.
- **Expiry:** a crashed or stalled worker's lease frees up after its TTL; the next claimer gets `fencing_token + 1`.
- **Completion** requires the same `owner` **and** `fencing_token`. A stale worker that resumes after a takeover is rejected (`status: "stale"`) and logged; its result must be treated as discarded.
- **Failure:** if the task throws, the lease is not completed and expires, so a later attempt can take over.
- **Renewal:** long tasks may call `renew()`; it fails once the lease is lost.

## Current users

- `RetentionEngine.runScheduledRetentionPass` — `retention.daily`, keyed by UTC date, 2-hour TTL.

Tests: `src/Reliability/__tests__/scheduledTaskLease.test.ts` (competing workers,
expiry takeover, stale completion, task failure) and the #1067 case in
`src/lifecycle/__tests__/lifecycle.test.ts`.
