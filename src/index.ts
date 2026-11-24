import "reflect-metadata";
import http from "http";
import app from "./Gateway/api";
import config from "./config/config";
import AppDataSource from "./config/Datasource";
import logger from "./config/logger";
import { initializeSocketManager } from "./Gateway/socketManager";
import { horizonOperationStreamerService } from "./services/horizonOperationStreamer.service";
import { priceSpikeAlertService } from "./services/priceSpikeAlert.service";
import { durableRecoveryService } from "./Agents/planner/DurableRecoveryService";
import { idempotencyService } from "./Reliability/IdempotencyService";
import { adminWorkflowService } from "./Agents/admin/workflow.service";
import { identityVerificationService } from "./ContractIdentity/identityVerification.service";
import { retentionEngine } from "./lifecycle/retentionEngine";
import { JobWorker } from "./jobs/jobWorker";
import { buildDefaultJobHandlers } from "./jobs/jobHandlers";
import { jobQueueService } from "./jobs/jobQueue.service";
import { verifySecretConfiguration } from "./Security/secrets";

class Server {
  private server: http.Server;
  private port: number;
  private readonly jobWorker: JobWorker;

  constructor() {
    this.port = config.port || 3000;
    this.server = http.createServer(app);
    // Initialize Socket.io manager
    initializeSocketManager(this.server);
    this.jobWorker = new JobWorker(jobQueueService, {
      workerId: `api-${process.pid}`,
      queues: ["transactions", "side-effects", "admin"],
      concurrency: 3,
      leaseMs: 30000,
      pollIntervalMs: 2500,
    });
    for (const handler of buildDefaultJobHandlers()) {
      this.jobWorker.registerHandler(handler);
    }
  }

  public async start(): Promise<void> {
    try {
      horizonOperationStreamerService.onLargeOperation((alert) => {
        logger.info("Stellar large operation alert emitted", alert);
      });

      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info("Shutting down gracefully...");

        // 1. Stop accepting new work: no new HTTP connections, no new jobs,
        //    no new scheduled/streamed work.
        const serverClosed = new Promise<void>((resolve) =>
          this.server.close(() => {
            logger.info("Server closed");
            resolve();
          })
        );
        horizonOperationStreamerService.stop();
        priceSpikeAlertService.stop();
        retentionEngine.stop();

        // 2. Drain in-flight job handlers up to the deadline (#1069); jobs
        //    still running at the deadline are returned to the queue.
        const report = await this.jobWorker.stop();
        logger.info("Job worker drain finished", report);

        // 3. Release the database only after handlers are done or released.
        await Promise.race([
          serverClosed,
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
        await AppDataSource.destroy();
        process.exit(0);
      };
      // Refuse to boot a shared environment with placeholder, revoked or
      // mis-provisioned secrets.
      await verifySecretConfiguration();

      console.log("Attempting to connect to DB...");
      await AppDataSource.initialize();
      console.log("DB connection established!");
      logger.info("Database connected successfully");

      // Initialize model registry with certified models
      logger.info("Initializing model registry...");
      initializeModelRegistry();
      logger.info("Model registry initialized successfully");

      // Initialize default admin workflow policies
      await adminWorkflowService.initializeDefaultPolicies();

      // Schedule initial workflow expiry cleanup job
      await adminWorkflowService.scheduleExpiryCleanup(5);

      // Recover interrupted durable executions
      await durableRecoveryService.recoverInterruptedExecutions();

      // Verify signed deployment manifests against chain state (Issue #676).
      // This establishes contract identity before serving mutating traffic;
      // any mismatch is enforced by the runtime identity gate.
      await identityVerificationService.verifyAll();

      // Start unified idempotency background processor
      idempotencyService.startBackgroundProcessor();

      // Start data retention scheduler (runs daily at 02:00 UTC)
      retentionEngine.scheduleDaily(2);

      horizonOperationStreamerService.start();
      priceSpikeAlertService.start();
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);

      this.server.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          logger.warn(
            `Port ${this.port} in use, retrying on ${this.port + 1}...`
          );
          this.port += 1;
          this.start();
        } else {
          logger.error("Server error", {
            error: error.message,
            stack: error.stack,
          });
          process.exit(1);
        }
      });

      this.server.listen(this.port, () => {
        logger.info(`Server running on port ${this.port}`);
      });
    } catch (error) {
      logger.error("Error during server startup", { error });
      process.exit(1);
    }
  }
}

(async () => {
  const server = new Server();
  await server.start();
})();
