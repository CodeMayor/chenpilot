import { Request } from "express";
import { EntityManager } from "typeorm";
import crypto from "crypto";
import AppDataSource from "../config/Datasource";
import { User } from "../Auth/user.entity";
import logger from "../config/logger";
import { jobQueueService } from "../jobs/jobQueue.service";
import { webhookIdempotencyService } from "./webhookIdempotency.service";

/**
 * Stellar Horizon Webhook Payload Types
 */
export interface StellarWebhookPayload {
  id: string;
  type: string;
  source: string;
  created_at: string;
  data: {
    id: string;
    account: string;
    funder: string;
    amount: string;
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    transaction_hash: string;
    operation_index: number;
    transaction_successful: boolean;
  };
}

/**
 * Webhook Processing Result
 */
export interface WebhookResult {
  success: boolean;
  message: string;
  userId?: string;
  deploymentTriggered?: boolean;
}

/**
 * Service for handling Stellar funding webhooks
 */
export class StellarWebhookService {
  private readonly WEBHOOK_SECRET: string;

  constructor() {
    this.WEBHOOK_SECRET = process.env.STELLAR_WEBHOOK_SECRET || "";
    if (!this.WEBHOOK_SECRET) {
      console.warn(
        "STELLAR_WEBHOOK_SECRET not set. Signature verification will be disabled."
      );
    }
  }

  /**
   * Verify webhook signature from Stellar Horizon
   * Uses HMAC-SHA256 for signature verification
   */
  private verifySignature(
    payload: string,
    signature: string,
    timestamp: string
  ): boolean {
    if (!this.WEBHOOK_SECRET) {
      // If no secret is configured, skip verification (not recommended for production)
      console.warn(
        "Signature verification skipped - no webhook secret configured"
      );
      return true;
    }

    try {
      // Create HMAC using the secret
      const hmac = crypto.createHmac("sha256", this.WEBHOOK_SECRET);
      const signedPayload = `${timestamp}.${payload}`;
      hmac.update(signedPayload);
      const expectedSignature = hmac.digest("hex");

      // Use constant-time comparison to prevent timing attacks
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
      );
    } catch (error) {
      console.error("Signature verification error:", error);
      return false;
    }
  }

  /**
   * Validate the webhook payload structure
   */
  private validatePayload(payload: unknown): payload is StellarWebhookPayload {
    if (!payload || typeof payload !== "object") {
      return false;
    }

    // Type guard to ensure payload is a record
    const payloadRecord = payload as Record<string, unknown>;

    const { id, type, source, created_at, data } = payloadRecord;

    // Check required top-level fields
    if (
      typeof id !== "string" ||
      typeof type !== "string" ||
      typeof source !== "string" ||
      typeof created_at !== "string"
    ) {
      return false;
    }

    // Check required data fields
    if (!data || typeof data !== "object") {
      return false;
    }

    // Type guard to ensure data is a record
    const dataRecord = data as Record<string, unknown>;

    const {
      account,
      funder,
      amount,
      asset_type,
      transaction_hash,
      transaction_successful,
    } = dataRecord;

    if (
      typeof account !== "string" ||
      typeof funder !== "string" ||
      typeof amount !== "string" ||
      typeof asset_type !== "string" ||
      typeof transaction_hash !== "string" ||
      typeof transaction_successful !== "boolean"
    ) {
      return false;
    }

    // Validate Stellar address format (basic check)
    const stellarAddressRegex = /^G[A-Z0-9]{55}$/;
    if (
      !stellarAddressRegex.test(account) ||
      !stellarAddressRegex.test(funder)
    ) {
      return false;
    }

    // Ensure transaction was successful
    if (!transaction_successful) {
      return false;
    }

    return true;
  }

  /**
   * Transactional part of the funding webhook: every write goes through
   * `manager`, so the idempotency record and its side effects are atomic.
   * Any error thrown here rolls the whole transaction back.
   */
  private async applyFundingWebhook(
    manager: EntityManager,
    payload: StellarWebhookPayload
  ): Promise<WebhookResult> {
    const user = await manager.getRepository(User).findOne({
      where: { address: payload.data.account },
    });

    // Unknown address: record nothing so a later redelivery (after the user
    // exists) is still processed rather than treated as a duplicate.
    if (!user) {
      return { success: false, message: "User not found for this address" };
    }

    const isNewWebhook = await webhookIdempotencyService.recordInTransaction(
      manager,
      payload.id,
      "stellar_funding",
      {
        transactionHash: payload.data.transaction_hash,
        account: payload.data.account,
      }
    );

    if (!isNewWebhook) {
      return { success: true, message: "Webhook already processed (idempotent)" };
    }

    if (user.isFunded) {
      return { success: true, message: "User already funded", userId: user.id };
    }

    user.isFunded = true;
    user.updatedAt = new Date();
    const updatedUser = await manager.getRepository(User).save(user);

    await jobQueueService.enqueueWithContext(
      {
        queue: "side-effects",
        jobType: "funding.auto_deploy",
        userId: updatedUser.id,
        correlationId: payload.data.transaction_hash,
        maxAttempts: 5,
        payload: {
          userId: updatedUser.id,
          transactionHash: payload.data.transaction_hash,
          amount: payload.data.amount,
          stellarAccount: payload.data.account,
        },
      },
      manager
    );

    return {
      success: true,
      message: "Funding webhook processed successfully",
      userId: updatedUser.id,
      deploymentTriggered: true,
    };
  }

  /**
   * Process the funding webhook
   */
  public async processFundingWebhook(req: Request): Promise<WebhookResult> {
    try {
      // Extract headers
      const signature = req.headers["x-stellar-signature"] as string;
      const timestamp = req.headers["x-stellar-timestamp"] as string;

      // Get raw body for signature verification
      const rawBody = req.body;

      // Verify signature if secret is configured
      if (this.WEBHOOK_SECRET && (!signature || !timestamp)) {
        return {
          success: false,
          message: "Missing signature headers",
        };
      }

      if (this.WEBHOOK_SECRET && signature && timestamp) {
        const isValid = this.verifySignature(
          JSON.stringify(rawBody),
          signature,
          timestamp
        );

        if (!isValid) {
          return {
            success: false,
            message: "Invalid signature",
          };
        }
      }

      // Validate payload structure
      if (!this.validatePayload(rawBody)) {
        return {
          success: false,
          message: "Invalid payload structure",
        };
      }

      const payload: StellarWebhookPayload = rawBody;

      // Dedup record, funding update, and the side-effect job commit in one
      // transaction (#1065). A crash before commit leaves nothing behind, so a
      // provider retry re-runs the whole handler; after commit, retries are
      // recognised as duplicates and enqueue nothing.
      const result = await AppDataSource.transaction((manager) =>
        this.applyFundingWebhook(manager, payload)
      );

      if (result.deploymentTriggered) {
        logger.info("Queued funding auto-deployment", {
          userId: result.userId,
          webhookId: payload.id,
          transactionHash: payload.data.transaction_hash,
        });
      }
      return result;
    } catch (error) {
      logger.error("Error processing funding webhook", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        message:
          error instanceof Error ? error.message : "Internal server error",
      };
    }
  }
}

// Export singleton instance
export const stellarWebhookService = new StellarWebhookService();
