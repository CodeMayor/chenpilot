/**
 * Durable leases for scheduled-task occurrences (#1067).
 *
 * Every occurrence of a scheduled task (e.g. "retention" on "2026-11-23") is
 * claimed through an atomic lease with an owner, an expiry and a fencing token:
 *
 *  - Only one worker can hold an unexpired lease for an occurrence.
 *  - A crashed worker's lease expires and another worker may take over; each
 *    takeover increments the fencing token.
 *  - Completion is accepted only from the current owner with the current
 *    token, so a stale worker that resumes after losing its lease cannot mark
 *    the occurrence done (and should treat its result as discarded).
 *  - A completed occurrence is never claimed again.
 */
import { DataSource } from "typeorm";
import os from "os";
import crypto from "crypto";
import logger from "../config/logger";

export interface TaskLease {
  taskKey: string;
  occurrenceKey: string;
  owner: string;
  fencingToken: number;
  expiresAt: Date;
}

export interface TaskLeaseStore {
  /** Atomically claim the occurrence; null if another live lease exists or it is completed. */
  tryAcquire(taskKey: string, occurrenceKey: string, owner: string, ttlMs: number): Promise<TaskLease | null>;
  /** Extend a lease still held by this owner/token; null if it was lost. */
  renew(lease: TaskLease, ttlMs: number): Promise<TaskLease | null>;
  /** Mark done; false if the lease was superseded (stale fencing token) or already completed. */
  complete(lease: TaskLease): Promise<boolean>;
}

export type LeasedRunResult<T> =
  | { status: "completed"; lease: TaskLease; result: T }
  | { status: "skipped"; reason: "held_or_completed" }
  | { status: "stale"; lease: TaskLease; result: T };

/** Default owner id: unique per process instance. */
export function defaultLeaseOwner(): string {
  return `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Run `fn` for one occurrence only if this worker wins the lease. A failure in
 * `fn` leaves the lease to expire so another worker (or a retry) can take over.
 */
export async function runLeasedOccurrence<T>(
  store: TaskLeaseStore,
  opts: { taskKey: string; occurrenceKey: string; owner: string; ttlMs: number },
  fn: (lease: TaskLease) => Promise<T>
): Promise<LeasedRunResult<T>> {
  const lease = await store.tryAcquire(opts.taskKey, opts.occurrenceKey, opts.owner, opts.ttlMs);
  if (!lease) {
    logger.info("Scheduled task occurrence skipped: lease held or completed", opts);
    return { status: "skipped", reason: "held_or_completed" };
  }

  const result = await fn(lease);

  if (await store.complete(lease)) {
    return { status: "completed", lease, result };
  }

  logger.warn("Scheduled task completion rejected: lease superseded (stale fencing token)", {
    taskKey: lease.taskKey,
    occurrenceKey: lease.occurrenceKey,
    owner: lease.owner,
    fencingToken: lease.fencingToken,
  });
  return { status: "stale", lease, result };
}

// ─── PostgreSQL store ──────────────────────────────────────────────────────────

type Row = { fencing_token: string | number; expires_at: Date | string };

/** TypeORM returns `[rows, rowCount]` for UPDATE and `rows` for INSERT on Postgres. */
function rowsOf<R>(raw: unknown): R[] {
  if (Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[0]) && typeof raw[1] === "number") {
    return raw[0] as R[];
  }
  return Array.isArray(raw) ? (raw as R[]) : [];
}

/**
 * Lease store backed by the `scheduled_task_lease` table. Expiry uses the
 * database clock so workers with skewed clocks agree on who holds a lease.
 */
export class PostgresTaskLeaseStore implements TaskLeaseStore {
  constructor(private readonly dataSource: DataSource) {}

  async tryAcquire(taskKey: string, occurrenceKey: string, owner: string, ttlMs: number): Promise<TaskLease | null> {
    const raw = await this.dataSource.query(
      `INSERT INTO "scheduled_task_lease"
         ("task_key", "occurrence_key", "owner", "fencing_token", "expires_at", "acquired_at")
       VALUES ($1, $2, $3, 1, now() + ($4::int * interval '1 millisecond'), now())
       ON CONFLICT ("task_key", "occurrence_key") DO UPDATE
         SET "owner" = EXCLUDED."owner",
             "expires_at" = EXCLUDED."expires_at",
             "acquired_at" = EXCLUDED."acquired_at",
             "fencing_token" = "scheduled_task_lease"."fencing_token" + 1
         WHERE "scheduled_task_lease"."completed_at" IS NULL
           AND "scheduled_task_lease"."expires_at" <= now()
       RETURNING "fencing_token", "expires_at"`,
      [taskKey, occurrenceKey, owner, ttlMs]
    );
    const row = rowsOf<Row>(raw)[0];
    if (!row) return null;
    return {
      taskKey,
      occurrenceKey,
      owner,
      fencingToken: Number(row.fencing_token),
      expiresAt: new Date(row.expires_at),
    };
  }

  async renew(lease: TaskLease, ttlMs: number): Promise<TaskLease | null> {
    const raw = await this.dataSource.query(
      `UPDATE "scheduled_task_lease"
         SET "expires_at" = now() + ($5::int * interval '1 millisecond')
       WHERE "task_key" = $1 AND "occurrence_key" = $2
         AND "owner" = $3 AND "fencing_token" = $4
         AND "completed_at" IS NULL AND "expires_at" > now()
       RETURNING "fencing_token", "expires_at"`,
      [lease.taskKey, lease.occurrenceKey, lease.owner, lease.fencingToken, ttlMs]
    );
    const row = rowsOf<Row>(raw)[0];
    return row ? { ...lease, expiresAt: new Date(row.expires_at) } : null;
  }

  async complete(lease: TaskLease): Promise<boolean> {
    const raw = await this.dataSource.query(
      `UPDATE "scheduled_task_lease"
         SET "completed_at" = now()
       WHERE "task_key" = $1 AND "occurrence_key" = $2
         AND "owner" = $3 AND "fencing_token" = $4
         AND "completed_at" IS NULL
       RETURNING "fencing_token", "expires_at"`,
      [lease.taskKey, lease.occurrenceKey, lease.owner, lease.fencingToken]
    );
    return rowsOf<Row>(raw).length > 0;
  }
}

// ─── In-memory store (single process / tests) ──────────────────────────────────

interface MemoryRecord {
  owner: string;
  fencingToken: number;
  expiresAt: number;
  completed: boolean;
}

/** Same semantics as the Postgres store; `now` is injectable for tests. */
export class InMemoryTaskLeaseStore implements TaskLeaseStore {
  private readonly records = new Map<string, MemoryRecord>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private key(taskKey: string, occurrenceKey: string): string {
    return `${taskKey}\u0000${occurrenceKey}`;
  }

  async tryAcquire(taskKey: string, occurrenceKey: string, owner: string, ttlMs: number): Promise<TaskLease | null> {
    const k = this.key(taskKey, occurrenceKey);
    const now = this.now();
    const existing = this.records.get(k);
    if (existing && (existing.completed || existing.expiresAt > now)) return null;

    const record: MemoryRecord = {
      owner,
      fencingToken: (existing?.fencingToken ?? 0) + 1,
      expiresAt: now + ttlMs,
      completed: false,
    };
    this.records.set(k, record);
    return { taskKey, occurrenceKey, owner, fencingToken: record.fencingToken, expiresAt: new Date(record.expiresAt) };
  }

  async renew(lease: TaskLease, ttlMs: number): Promise<TaskLease | null> {
    const r = this.records.get(this.key(lease.taskKey, lease.occurrenceKey));
    const now = this.now();
    if (!r || r.completed || r.owner !== lease.owner || r.fencingToken !== lease.fencingToken || r.expiresAt <= now) {
      return null;
    }
    r.expiresAt = now + ttlMs;
    return { ...lease, expiresAt: new Date(r.expiresAt) };
  }

  async complete(lease: TaskLease): Promise<boolean> {
    const r = this.records.get(this.key(lease.taskKey, lease.occurrenceKey));
    if (!r || r.completed || r.owner !== lease.owner || r.fencingToken !== lease.fencingToken) {
      return false;
    }
    r.completed = true;
    return true;
  }
}
