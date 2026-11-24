import { EntityManager, Repository } from "typeorm";
import AppDataSource from "../config/Datasource";
import { WebhookIdempotency } from "./webhookIdempotency.entity";

/**
 * Service for managing webhook idempotency across all platforms
 * Provides database-backed deduplication with automatic cleanup
 */
export class WebhookIdempotencyService {
  private readonly repository: Repository<WebhookIdempotency>;
  private readonly RETENTION_HOURS = 24; // Keep records for 24 hours

  constructor() {
    this.repository = AppDataSource.getRepository(WebhookIdempotency);
    this.scheduleCleanup();
  }

  /**
   * Check if a webhook has already been processed
   * @param webhookId Unique identifier for the webhook
   * @param platform Platform name (telegram, discord, etc.)
   * @returns true if webhook was already processed
   */
  async isDuplicate(webhookId: string, platform: string): Promise<boolean> {
    const existing = await this.repository.findOne({
      where: { webhookId, platform },
    });
    return !!existing;
  }

  /**
   * Mark a webhook as processed
   * @param webhookId Unique identifier for the webhook
   * @param platform Platform name (telegram, discord, etc.)
   * @param metadata Optional metadata to store with the record
   */
  async markProcessed(
    webhookId: string,
    platform: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const record = this.repository.create({
      webhookId,
      platform,
      metadata,
    });
    await this.repository.save(record);
  }

  /**
   * Check and mark in a single transaction
   * @returns true if webhook is new and was marked, false if duplicate
   */
  async checkAndMark(
    webhookId: string,
    platform: string,
    metadata?: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const record = this.repository.create({
        webhookId,
        platform,
        metadata,
      });
      await this.repository.save(record);
      return true;
    } catch (error) {
      // Unique constraint violation means duplicate
      const pgError = error as { code?: string; message?: string };
      if (
        pgError.code === "23505" ||
        (error instanceof Error && error.message.includes("duplicate"))
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Record a webhook inside the caller's transaction (#1065).
   *
   * Uses INSERT ... ON CONFLICT DO NOTHING so a duplicate never aborts the
   * surrounding Postgres transaction. A concurrent delivery of the same event
   * blocks on the unique index until the first transaction finishes: if it
   * commits, this returns false; if it rolls back, this one claims the event.
   *
   * @returns true if this transaction claimed the event, false if already recorded
   */
  async recordInTransaction(
    manager: EntityManager,
    webhookId: string,
    platform: string,
    metadata?: Record<string, unknown>
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .insert()
      .into(WebhookIdempotency)
      .values({ webhookId, platform, metadata })
      .orIgnore()
      .returning(["id"])
      .execute();
    const rows = Array.isArray(result.raw) ? result.raw : [];
    return rows.length > 0;
  }

  /**
   * Clean up old webhook records
   */
  private async cleanup(): Promise<void> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setHours(cutoffDate.getHours() - this.RETENTION_HOURS);

      const result = await this.repository
        .createQueryBuilder()
        .delete()
        .where("createdAt < :cutoffDate", { cutoffDate })
        .execute();

      if (result.affected && result.affected > 0) {
        console.log(
          `Cleaned up ${result.affected} old webhook idempotency records`
        );
      }
    } catch (error) {
      console.error("Error cleaning up webhook records:", error);
    }
  }

  /**
   * Schedule periodic cleanup of old records
   */
  private scheduleCleanup(): void {
    // Run cleanup every hour
    setInterval(
      () => {
        this.cleanup();
      },
      60 * 60 * 1000
    );

    // Run initial cleanup after 1 minute
    setTimeout(() => {
      this.cleanup();
    }, 60 * 1000);
  }
}

export const webhookIdempotencyService = new WebhookIdempotencyService();
