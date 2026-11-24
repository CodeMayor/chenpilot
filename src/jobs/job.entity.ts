import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type JobStatus =
  | "pending"
  | "leased"
  | "completed"
  | "dead_letter"
  | "cancelled";

/** Why a job ended in dead-letter (#1068). */
export type FailureClass =
  | "attempts_exhausted"
  | "retry_budget_exhausted"
  | "non_retryable"
  | "authorization_denied"
  | "no_handler"
  | "handler_dead_letter";

/** Operator-visible state of a dead-lettered job (#1068). */
export type DeadLetterDisposition = "pending_review" | "replayed" | "discarded";

@Entity({ name: "job_queue" })
@Index(["queue", "status", "availableAt"])
@Index(["jobType", "status", "availableAt"])
@Index(["status", "leaseExpiresAt"])
@Index(["userId", "status"])
@Index(["status", "disposition"])
export class QueueJob {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 100 })
  queue!: string;

  @Column({ type: "varchar", length: 150 })
  jobType!: string;

  @Column({ type: "varchar", length: 32, default: "pending" })
  status!: JobStatus;

  @Column({ type: "uuid", nullable: true })
  userId?: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  correlationId?: string | null;

  @Column({ type: "jsonb" })
  payload!: Record<string, unknown>;

  @Column({ type: "jsonb", nullable: true })
  result?: Record<string, unknown> | null;

  @Column({ type: "jsonb", nullable: true })
  metadata?: Record<string, unknown> | null;

  @Column({ type: "timestamp", default: () => "now()" })
  availableAt!: Date;

  @Column({ type: "timestamp", nullable: true })
  leaseExpiresAt?: Date | null;

  @Column({ type: "varchar", length: 120, nullable: true })
  leasedBy?: string | null;

  @Column({ type: "int", default: 0 })
  attempts!: number;

  @Column({ type: "int", default: 5 })
  maxAttempts!: number;

  @Column({ type: "text", nullable: true })
  lastError?: string | null;

  @Column({ type: "timestamp", nullable: true })
  completedAt?: Date | null;

  @Column({ type: "timestamp", nullable: true })
  deadLetteredAt?: Date | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  failureClass?: FailureClass | null;

  @Column({ type: "varchar", length: 32, nullable: true })
  disposition?: DeadLetterDisposition | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  dispositionBy?: string | null;

  @Column({ type: "timestamp", nullable: true })
  dispositionAt?: Date | null;

  @Column({ type: "text", nullable: true })
  dispositionNote?: string | null;

  /** Set on a job created by replaying a dead-lettered job. */
  @Column({ type: "uuid", nullable: true })
  replayOfJobId?: string | null;

  /** Set on a dead-lettered job once it has been replayed. */
  @Column({ type: "uuid", nullable: true })
  replayedAsJobId?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
