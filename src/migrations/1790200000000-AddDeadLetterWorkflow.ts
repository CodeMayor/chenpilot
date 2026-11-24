import { MigrationInterface, QueryRunner } from "typeorm";

/** #1068: failure class, operator disposition and replay links for dead-lettered jobs. */
export class AddDeadLetterWorkflow1790200000000 implements MigrationInterface {
  name = "AddDeadLetterWorkflow1790200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "job_queue"
        ADD COLUMN "failureClass" character varying(64),
        ADD COLUMN "disposition" character varying(32),
        ADD COLUMN "dispositionBy" character varying(255),
        ADD COLUMN "dispositionAt" TIMESTAMP,
        ADD COLUMN "dispositionNote" text,
        ADD COLUMN "replayOfJobId" uuid,
        ADD COLUMN "replayedAsJobId" uuid
    `);
    // Existing dead-lettered jobs become reviewable.
    await queryRunner.query(`
      UPDATE "job_queue"
         SET "disposition" = 'pending_review',
             "failureClass" = CASE WHEN "attempts" >= "maxAttempts" THEN 'attempts_exhausted' ELSE 'handler_dead_letter' END
       WHERE "status" = 'dead_letter'
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_job_queue_status_disposition" ON "job_queue" ("status", "disposition")`
    );
    // At most one replay per dead-lettered job.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_job_queue_replay_of" ON "job_queue" ("replayOfJobId") WHERE "replayOfJobId" IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_job_queue_replay_of"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_job_queue_status_disposition"`);
    await queryRunner.query(`
      ALTER TABLE "job_queue"
        DROP COLUMN "replayedAsJobId",
        DROP COLUMN "replayOfJobId",
        DROP COLUMN "dispositionNote",
        DROP COLUMN "dispositionAt",
        DROP COLUMN "dispositionBy",
        DROP COLUMN "disposition",
        DROP COLUMN "failureClass"
    `);
  }
}
