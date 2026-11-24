import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * #1067: one row per scheduled-task occurrence. The primary key makes the
 * claim atomic; fencing_token increases on every takeover of an expired lease.
 */
export class CreateScheduledTaskLease1790100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "scheduled_task_lease" (
        "task_key" varchar(128) NOT NULL,
        "occurrence_key" varchar(128) NOT NULL,
        "owner" varchar(255) NOT NULL,
        "fencing_token" bigint NOT NULL DEFAULT 1,
        "acquired_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "completed_at" timestamptz NULL,
        CONSTRAINT "PK_scheduled_task_lease" PRIMARY KEY ("task_key", "occurrence_key")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_scheduled_task_lease_expires_at" ON "scheduled_task_lease" ("expires_at")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_scheduled_task_lease_expires_at"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "scheduled_task_lease"`);
  }
}
