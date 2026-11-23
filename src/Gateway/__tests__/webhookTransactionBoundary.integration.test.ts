import type { Request } from "express";
import AppDataSource from "../../config/Datasource";
import { User } from "../../Auth/user.entity";
import { QueueJob } from "../../jobs/job.entity";
import { jobQueueService } from "../../jobs/jobQueue.service";
import { WebhookIdempotency } from "../webhookIdempotency.entity";
import type { StellarWebhookService } from "../webhook.service";

/**
 * #1065: the idempotency record, the funding state change, and the
 * auto-deploy job must commit atomically. These tests use a real database.
 */
describe("Funding webhook transaction boundary (#1065)", () => {
  let service: StellarWebhookService;
  let user: User;
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const address = `GTESTBOUNDARY${suffix}`;

  const payloadFor = (id: string, account = address) => ({
    id,
    type: "account_funded",
    source: "horizon",
    created_at: new Date().toISOString(),
    data: {
      id: `op_${id}`,
      account,
      funder: "GFUNDER",
      amount: "10.0000000",
      asset_type: "native",
      transaction_hash: `tx_${id}`,
      operation_index: 0,
      transaction_successful: true,
    },
  });

  const deliver = (body: unknown) =>
    service.processFundingWebhook({ headers: {}, body } as unknown as Request);

  const idempotencyRows = (webhookId: string) =>
    AppDataSource.getRepository(WebhookIdempotency).count({
      where: { webhookId, platform: "stellar_funding" },
    });

  const deployJobs = () =>
    AppDataSource.getRepository(QueueJob).count({
      where: { jobType: "funding.auto_deploy", userId: user.id },
    });

  beforeAll(async () => {
    delete process.env.STELLAR_WEBHOOK_SECRET;
    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }
    // Construct after clearing the secret so signature checks are off.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../webhook.service") as typeof import("../webhook.service");
    service = new mod.StellarWebhookService();
  });

  beforeEach(async () => {
    const repo = AppDataSource.getRepository(User);
    user = await repo.save(
      repo.create({
        name: `boundary_${suffix}_${Math.random().toString(36).slice(2)}`,
        address,
        encryptedPrivateKey: "test",
        isFunded: false,
      })
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await AppDataSource.getRepository(QueueJob).delete({ userId: user.id });
    await AppDataSource.getRepository(User).delete({ id: user.id });
    await AppDataSource.getRepository(WebhookIdempotency)
      .createQueryBuilder()
      .delete()
      .where("webhookId LIKE :p", { p: `%${suffix}%` })
      .execute();
  });

  afterAll(async () => {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  });

  it("crash before commit leaves nothing behind; the retry applies the side effect exactly once", async () => {
    const webhookId = `evt_crash_${suffix}`;
    const body = payloadFor(webhookId);

    // Simulate the process dying after the dedup row and user update were
    // written but before the side-effect job (and commit).
    jest
      .spyOn(jobQueueService, "enqueueWithContext")
      .mockRejectedValueOnce(new Error("simulated crash"));

    const crashed = await deliver(body);
    expect(crashed.success).toBe(false);
    expect(await idempotencyRows(webhookId)).toBe(0);
    expect(await deployJobs()).toBe(0);
    const afterCrash = await AppDataSource.getRepository(User).findOneByOrFail({ id: user.id });
    expect(afterCrash.isFunded).toBe(false);

    // Provider retry: processed normally.
    const retried = await deliver(body);
    expect(retried).toMatchObject({ success: true, deploymentTriggered: true });
    expect(await idempotencyRows(webhookId)).toBe(1);
    expect(await deployJobs()).toBe(1);

    // Further redelivery: recognised as a duplicate, no second job.
    const duplicate = await deliver(body);
    expect(duplicate.message).toMatch(/already processed/i);
    expect(await deployJobs()).toBe(1);
  });

  it("concurrent deliveries of the same event enqueue exactly one job", async () => {
    const body = payloadFor(`evt_race_${suffix}`);

    const results = await Promise.all([deliver(body), deliver(body)]);

    expect(results.filter((r) => r.deploymentTriggered)).toHaveLength(1);
    expect(await deployJobs()).toBe(1);
  });

  it("does not record the event when the address is unknown, so a later redelivery is processed", async () => {
    const webhookId = `evt_unknown_${suffix}`;

    const result = await deliver(payloadFor(webhookId, `GUNKNOWN${suffix}`));

    expect(result).toMatchObject({ success: false, message: "User not found for this address" });
    expect(await idempotencyRows(webhookId)).toBe(0);
  });
});
